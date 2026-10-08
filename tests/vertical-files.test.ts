import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { isWorkspacePath, verticalApiBase } from "../apps/server/src/engine/vertical-files.ts";

/**
 * The artifact proxy: a delegate's workspace files reach the app through
 * OpenMuse, which spends the caller's own token on LangAlpha so the credential
 * never has to leave the server or be accepted from a bare URL.
 */

const fileBody = "ticker,price\nAAPL,230.1\n";

/** LangAlpha's two hops: the caller's workspace list, then the file bytes. */
function langAlpha(t: TestContext) {
  const requests: { url: string; authorization?: string }[] = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? "", authorization: request.headers.authorization });
    if (request.url === "/api/v1/workspaces?limit=1&sort_by=custom") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ workspaces: [{ workspace_id: "ws-1" }], total: 1 }));
      return;
    }
    if (request.url?.startsWith("/api/v1/workspaces/ws-1/files/download")) {
      if (request.url.includes("missing")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ detail: "File not found" }));
        return;
      }
      response.writeHead(200, {
        "content-type": "text/csv",
        "content-disposition": 'inline; filename="aapl.csv"',
        etag: '"abc"',
      });
      response.end(fileBody);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ detail: "Not found" }));
  });
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return { requests, origin: `http://127.0.0.1:${address.port}` };
  });
}

async function verticalApp(t: TestContext, url: string) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-vertical-files-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    authMode: "local",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "hybrid",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    verticalAgents: [{ name: "finance_agent", description: "market data", url }],
  };
  const server = await createApp(db, config);
  t.after(() => server.agent.stop());
  return server;
}

test("the workspace path gate refuses absolutes and traversal", () => {
  assert.equal(isWorkspacePath("reports/aapl.md"), true);
  assert.equal(isWorkspacePath(""), false);
  assert.equal(isWorkspacePath("/etc/passwd"), false);
  assert.equal(isWorkspacePath("../secrets.env"), false);
  assert.equal(isWorkspacePath("reports/../../secrets.env"), false);
});

test("the delegate's API root is read from the configured run endpoint", () => {
  assert.equal(
    verticalApiBase("https://langalpha.example/api/v1/agui/run"),
    "https://langalpha.example",
  );
  // A gateway behind a path prefix keeps it, which an origin alone would drop.
  assert.equal(
    verticalApiBase("https://example.com/langalpha/api/v1/agui/run"),
    "https://example.com/langalpha",
  );
  assert.equal(verticalApiBase("http://127.0.0.1:8000/agui/run"), "http://127.0.0.1:8000");
});

test("the proxy spends the caller's token and passes the file through", async (t) => {
  const upstream = await langAlpha(t);
  const server = await verticalApp(t, `${upstream.origin}/api/v1/agui/run`);
  const session = await server.auth.session();
  const headers = { Authorization: `Bearer ${session.token}` };

  const response = await server.app.request(
    "/api/vertical/finance_agent/file?path=reports/aapl.csv",
    { headers },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv");
  assert.equal(response.headers.get("content-disposition"), 'inline; filename="aapl.csv"');
  assert.equal(await response.text(), fileBody);

  // Both hops carried the caller's own bearer, so LangAlpha answered for the
  // right account — and the app never sees that token.
  assert.deepEqual(
    upstream.requests.map((request) => request.authorization),
    [`Bearer ${session.token}`, `Bearer ${session.token}`],
  );
  assert.equal(upstream.requests[0].url, "/api/v1/workspaces?limit=1&sort_by=custom");
  assert.equal(
    upstream.requests[1].url,
    "/api/v1/workspaces/ws-1/files/download?path=reports%2Faapl.csv",
  );
});

test("the proxy reports the delegate's own answer for a file it cannot serve", async (t) => {
  const upstream = await langAlpha(t);
  const server = await verticalApp(t, `${upstream.origin}/api/v1/agui/run`);
  const session = await server.auth.session();
  const response = await server.app.request(
    "/api/vertical/finance_agent/file?path=reports/missing.csv",
    { headers: { Authorization: `Bearer ${session.token}` } },
  );
  assert.equal(response.status, 404);
});

test("the proxy refuses what it cannot serve before it calls the delegate", async (t) => {
  const upstream = await langAlpha(t);
  const server = await verticalApp(t, `${upstream.origin}/api/v1/agui/run`);
  const session = await server.auth.session();
  const headers = { Authorization: `Bearer ${session.token}` };

  assert.equal(
    (await server.app.request("/api/vertical/finance_agent/file?path=reports/aapl.csv")).status,
    401,
  );
  assert.equal(
    (
      await server.app.request("/api/vertical/finance_agent/file?path=reports/aapl.csv", {
        headers: { Authorization: "Bearer not-a-session" },
      })
    ).status,
    401,
  );
  assert.equal(
    (await server.app.request("/api/vertical/other_agent/file?path=reports/aapl.csv", { headers }))
      .status,
    404,
  );
  for (const path of ["", "/etc/passwd", "../secrets.env"]) {
    const response = await server.app.request(
      `/api/vertical/finance_agent/file?path=${encodeURIComponent(path)}`,
      { headers },
    );
    assert.equal(response.status, 400, path);
  }
  assert.equal(
    (await server.app.request("/api/vertical/finance_agent/file", { headers })).status,
    400,
  );
  assert.deepEqual(upstream.requests, []);
});
