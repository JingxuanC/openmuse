import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

const JWKS_PATH = "/auth/v1/.well-known/jwks.json";

/** Stubs the only Supabase endpoint OpenMuse touches: the project's public signing keys. */
function jwksServer(document: unknown, status = 200) {
  const server = createServer((request, response) => {
    if (request.url !== JWKS_PATH) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(status, { "Content-Type": "application/json" })
      .end(JSON.stringify(document));
  });
  return new Promise<{ base: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((closed) => server.close(() => closed())),
      });
    });
  });
}

interface TokenOptions {
  audience?: string;
  expiration?: string | number;
  subjectless?: boolean;
}

let db: Store,
  app: Awaited<ReturnType<typeof createApp>>["app"],
  config: Config,
  mint: (subject: string, options?: TokenOptions) => Promise<string>,
  mintForeign: (subject: string) => Promise<string>,
  directory: string,
  closeJwks: () => Promise<void>;

const bearer = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-auth-"));
  db = await createStore();
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true }),
    foreign = await generateKeyPair("ES256", { extractable: true });
  const { base, close } = await jwksServer({
    keys: [{ ...(await exportJWK(publicKey)), kid: "test-key", alg: "ES256", use: "sig" }],
  });
  closeJwks = close;
  const signed = (token: SignJWT, options: TokenOptions) =>
    token
      .setProtectedHeader({ alg: "ES256", kid: "test-key" })
      .setAudience(options.audience ?? "authenticated")
      .setIssuedAt()
      .setExpirationTime(options.expiration ?? "5m");
  mint = (subject, options = {}) => {
    const token = new SignJWT({ email: `${subject}@example.com` });
    if (!options.subjectless) token.setSubject(subject);
    return signed(token, options).sign(privateKey);
  };
  mintForeign = (subject) =>
    signed(new SignJWT({}).setSubject(subject), {}).sign(foreign.privateKey);
  config = {
    mode: "sample",
    authMode: "supabase",
    supabaseUrl: base,
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: join(directory, "supabase"),
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  ({ app } = await createApp(db, config));
});
after(async () => {
  await closeJwks();
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

const signIn = (token?: string) =>
  app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(token ? { accessToken: token } : {}),
  });

test("supabase mode rejects requests that carry no usable token", async () => {
  assert.equal((await app.request("/api/workspace")).status, 401);
  assert.equal(
    (await app.request("/api/workspace", { headers: { Authorization: "Basic abc" } })).status,
    401,
  );
  assert.equal((await signIn()).status, 401);
});

test("supabase mode rejects tokens it cannot verify", async () => {
  const attempts = [
    "not-a-jwt",
    await mintForeign("user-a"),
    await mint("user-a", { expiration: Math.floor(Date.now() / 1000) - 60 }),
    await mint("user-a", { audience: "anon" }),
    await mint("user-a", { subjectless: true }),
  ];
  for (const token of attempts) {
    assert.equal((await signIn(token)).status, 401, `expected 401 for ${token}`);
    assert.equal((await app.request("/api/workspace", { headers: bearer(token) })).status, 401);
  }
});

test("supabase sign-in returns the account the token belongs to and issues no session token", async () => {
  const response = await signIn(await mint("d0f5a4a2-0000-4000-8000-00000000a001"));
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.equal(session.mode, "sample");
  assert.equal(session.user.id, "d0f5a4a2-0000-4000-8000-00000000a001");
  assert.equal(session.user.email, "d0f5a4a2-0000-4000-8000-00000000a001@example.com");
  assert.equal(session.token, undefined);
});

test("one tenant cannot read another tenant's records", async () => {
  const [alice, bob] = [await mint("user-alice"), await mint("user-bob")];
  const created = await app.request("/api/drafts", {
    method: "POST",
    headers: bearer(alice),
    body: JSON.stringify({
      to: ["alice@example.com"],
      subject: "Alice only",
      body: "Private.",
    }),
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const mine = await (await app.request("/api/drafts", { headers: bearer(alice) })).json();
  assert.deepEqual(
    mine.map((draft: { id: string }) => draft.id),
    [id],
  );
  // Bob's workspace is seeded and empty of Alice's data; the same URL with his token sees nothing.
  const theirs = await (await app.request("/api/drafts", { headers: bearer(bob) })).json();
  assert.deepEqual(theirs, []);
});

test("one tenant's approvals stay invisible and undecidable to another", async () => {
  const [alice, bob] = [await mint("user-alice"), await mint("user-bob")];
  const draft = (subject: string) => ({
    kind: "email.send" as const,
    data: {
      to: ["alex@example.com"],
      cc: [],
      bcc: [],
      subject,
      body: "Waiting for a decision.",
      attachmentIds: [],
    },
  });
  const propose = async (token: string, subject: string) => {
    const response = await app.request("/api/actions", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify(draft(subject)),
    });
    assert.equal(response.status, 201);
    return response.json();
  };
  const alices = await propose(alice, "Alice only");
  // Bob owns an approval of his own, so an empty list cannot be what hides Alice's.
  const bobs = await propose(bob, "Bob only");
  const bobActions = async () =>
    (await (await app.request("/api/workspace", { headers: bearer(bob) })).json()) as {
      actions: { id: string }[];
      activity: { actionId: string }[];
      mail: { subject: string }[];
    };
  const before = await bobActions();
  assert.deepEqual(
    before.actions.map(({ id }) => id),
    [bobs.id],
  );
  assert.deepEqual(
    before.activity.map(({ actionId }) => actionId),
    [bobs.id],
  );
  // Alice's exact id and hash buy Bob nothing: the lookup is scoped to his own owner domain.
  const denied = await app.request(`/api/actions/${alices.id}/decide`, {
    method: "POST",
    headers: bearer(bob),
    body: JSON.stringify({ hash: alices.hash, decision: "approve" }),
  });
  assert.equal(denied.status, 404);
  assert.equal((await denied.json()).error, "Action not found");
  // Alice's own decision still flows end to end, and lands in her mailbox alone.
  const approved = await app.request(`/api/actions/${alices.id}/decide`, {
    method: "POST",
    headers: bearer(alice),
    body: JSON.stringify({ hash: alices.hash, decision: "approve" }),
  });
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).status, "succeeded");
  const mine = (await (await app.request("/api/workspace", { headers: bearer(alice) })).json()) as {
    actions: { id: string; status: string }[];
    mail: { subject: string }[];
  };
  const after = await bobActions();
  assert.deepEqual(
    mine.actions.map(({ id, status }) => [id, status]),
    [[alices.id, "succeeded"]],
  );
  assert.deepEqual(
    mine.mail.map(({ subject }) => subject),
    ["Alice only"],
  );
  assert.deepEqual(
    after.actions.map(({ id }) => id),
    [bobs.id],
  );
  assert.deepEqual(after.mail, []);
});

test("local mode keeps the access-key session flow and its single owner", async () => {
  const local = await createApp(db, {
    ...config,
    authMode: "local",
    dataDir: join(directory, "local"),
  });
  const response = await local.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.equal(session.mode, "sample");
  assert.ok(session.token);
  const workspace = await local.app.request("/api/workspace", { headers: bearer(session.token) });
  assert.equal(workspace.status, 200);
  // The sample workspace still belongs to the one local owner.
  assert.equal((await workspace.json()).mail.length, 4);
});

test("a bootstrap that cannot obtain signing keys refuses to start", async () => {
  const broken = { ...config, dataDir: join(directory, "broken") };
  await assert.rejects(
    createApp(db, { ...broken, supabaseUrl: "http://127.0.0.1:1" }),
    /is unreachable/,
  );
  const empty = await jwksServer({ keys: [] });
  try {
    await assert.rejects(
      createApp(db, { ...broken, supabaseUrl: empty.base }),
      /published no signing keys/,
    );
  } finally {
    await empty.close();
  }
  const failing = await jwksServer({}, 503);
  try {
    await assert.rejects(
      createApp(db, { ...broken, supabaseUrl: failing.base }),
      /is unreachable \(HTTP 503\)/,
    );
  } finally {
    await failing.close();
  }
});
