import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

interface UpstreamCall {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let db: Store,
  app: Awaited<ReturnType<typeof createApp>>["app"],
  config: Config,
  upstream: Server,
  directory: string;
const calls: UpstreamCall[] = [];

before(async () => {
  // Stands in for Supabase: it records what reached it and answers like GoTrue does.
  upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    calls.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString(),
    });
    if (request.url?.startsWith("/auth/v1/otp")) {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "over_email_send_rate_limit" }));
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      "x-upstream": "supabase",
      "set-cookie": "sb-refresh-token=secret; Path=/",
    });
    response.end(JSON.stringify({ access_token: "upstream-token" }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert(address && typeof address !== "string");
  directory = await mkdtemp(join(tmpdir(), "openmuse-supa-proxy-"));
  db = await createStore();
  config = {
    mode: "sample",
    authMode: "local",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
    supabaseUrl: `http://127.0.0.1:${address.port}`,
  };
  ({ app } = await createApp(db, config));
});
after(async () => {
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("a sign-in forwards method, path, query, headers and body to Supabase Auth", async () => {
  const response = await app.request("/api/supa/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      apikey: "anon-key",
      Authorization: "Bearer anon-key",
      "X-Client-Info": "supabase-js-web/2.117.2",
      "X-Supabase-Api-Version": "2024-01-01",
    },
    body: JSON.stringify({ email: "student@example.com", password: "secret" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { access_token: "upstream-token" });
  // Upstream headers come back, except the cookie: the session is the token in the body.
  assert.equal(response.headers.get("x-upstream"), "supabase");
  assert.equal(response.headers.get("set-cookie"), null);
  const forwarded = calls.at(-1);
  assert.equal(forwarded?.method, "POST");
  assert.equal(forwarded?.url, "/auth/v1/token?grant_type=password");
  assert.equal(forwarded?.headers.apikey, "anon-key");
  assert.equal(forwarded?.headers.authorization, "Bearer anon-key");
  assert.equal(forwarded?.headers["x-client-info"], "supabase-js-web/2.117.2");
  assert.equal(forwarded?.headers["x-supabase-api-version"], "2024-01-01");
  assert.equal(forwarded?.headers["content-type"], "application/json;charset=UTF-8");
  assert.deepEqual(JSON.parse(forwarded?.body ?? ""), {
    email: "student@example.com",
    password: "secret",
  });
});
test("a GET forwards without a body and keeps the upstream status", async () => {
  const user = await app.request("/api/supa/auth/v1/user", {
    headers: { apikey: "anon-key", Authorization: "Bearer access-token" },
  });
  assert.equal(user.status, 200);
  const forwarded = calls.at(-1);
  assert.equal(forwarded?.method, "GET");
  assert.equal(forwarded?.url, "/auth/v1/user");
  assert.equal(forwarded?.body, "");
  const limited = await app.request("/api/supa/auth/v1/otp", { method: "POST", body: "{}" });
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: "over_email_send_rate_limit" });
});
test("only /auth/v1/ is proxied, so this cannot be used as an open proxy", async () => {
  const before = calls.length;
  for (const path of [
    "/api/supa/storage/v1/object/public/notes.pdf",
    "/api/supa/rest/v1/notes",
    "/api/supa/auth/v1",
    "/api/supa/auth/v1/%2e%2e%2fstorage/v1/object/notes.pdf",
    "/api/supa/auth/v1/..%2f..%2frest%2fv1%2fnotes",
  ])
    assert.equal((await app.request(path)).status, 404, path);
  assert.equal(calls.length, before);
});
test("the proxy stays behind the origin allowlist and lets the Supabase headers preflight", async () => {
  const preflight = await app.request("/api/supa/auth/v1/token", {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:8081",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers":
        "apikey,authorization,content-type,x-client-info,x-supabase-api-version",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "http://localhost:8081");
  const allowHeaders = (preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase();
  for (const header of [
    "apikey",
    "authorization",
    "content-type",
    "x-client-info",
    "x-supabase-api-version",
  ])
    assert.ok(allowHeaders.includes(header), `${header} is not allowed`);
  // The deployment's own PUBLIC_API_URL origin is allowed too, without being listed in ALLOWED_ORIGINS.
  assert.equal(
    (
      await app.request("/api/supa/auth/v1/token", {
        method: "POST",
        headers: { Origin: "http://localhost:8787", "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await app.request("/api/supa/auth/v1/token", {
        method: "OPTIONS",
        headers: { Origin: "https://unrelated.example", "Access-Control-Request-Method": "POST" },
      })
    ).status,
    403,
  );
});
