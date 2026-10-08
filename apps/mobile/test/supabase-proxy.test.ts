import assert from "node:assert/strict";
import test from "node:test";
import { proxiedAuthUrl, supabaseFetch } from "../src/supabase-proxy.ts";

const SUPABASE = "https://project.supabase.co";
const API = "http://localhost:8787";

test("only Supabase Auth calls are rewritten onto our own API", () => {
  assert.equal(
    proxiedAuthUrl(`${SUPABASE}/auth/v1/token?grant_type=password`, SUPABASE, API),
    `${API}/api/supa/auth/v1/token?grant_type=password`,
  );
  assert.equal(
    proxiedAuthUrl(`${SUPABASE}/auth/v1/user`, SUPABASE, API),
    `${API}/api/supa/auth/v1/user`,
  );
  for (const untouched of [
    `${SUPABASE}/storage/v1/object/public/notes.pdf`,
    `${SUPABASE}/realtime/v1/websocket?apikey=anon-key`,
    "https://another-project.supabase.co/auth/v1/token",
  ])
    assert.equal(proxiedAuthUrl(untouched, SUPABASE, API), undefined, untouched);
});

test("the client fetch sends Auth to our API and everything else to Supabase", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; method: string; headers: Headers; body: string | undefined }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // Recorded the way fetch resolves them, so a rebuilt Request reports its own method and body.
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
      body: (init?.body as string | undefined) ?? undefined,
    });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const client = supabaseFetch(SUPABASE, API);
    await client(`${SUPABASE}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: "anon-key", Authorization: "Bearer anon-key" },
      body: JSON.stringify({ email: "student@example.com", password: "secret" }),
    });
    await client(`${SUPABASE}/realtime/v1/websocket`);
    await client(new Request(`${SUPABASE}/auth/v1/logout`, { method: "POST" }));
    assert.deepEqual(
      calls.map((call) => call.url),
      [
        `${API}/api/supa/auth/v1/token?grant_type=password`,
        `${SUPABASE}/realtime/v1/websocket`,
        `${API}/api/supa/auth/v1/logout`,
      ],
    );
    // The rewrite moves the URL only: method, headers and body are the client's own.
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.get("apikey"), "anon-key");
    assert.equal(calls[0].headers.get("authorization"), "Bearer anon-key");
    assert.equal(
      calls[0].body,
      JSON.stringify({ email: "student@example.com", password: "secret" }),
    );
    assert.equal(calls[2].method, "POST");
  } finally {
    globalThis.fetch = original;
  }
});
