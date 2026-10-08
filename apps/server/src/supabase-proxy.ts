import type { Context } from "hono";

/**
 * Supabase Auth reached through OpenMuse: a browser that cannot open supabase.co
 * signs in against our own API instead. Only /auth/v1/ is forwarded — that prefix
 * check is what keeps this from becoming an open proxy for the rest of Supabase.
 */
export const supaProxyPrefix = "/api/supa/";
/** `/api/supa/` already ends in a slash, so what follows it is the bare segment. */
const authPrefix = "auth/v1/";
const upstreamTimeoutMs = 15_000;

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1) plus the ones the runtime owns: undici sets Host
 * and Content-Length itself, and it decodes the body while leaving Content-Encoding in
 * place, so forwarding those would describe the bytes twice. Origin is left behind too —
 * this hop is server-to-server, and the upstream's CORS answer must not be replayed at a
 * browser our own CORS middleware already answered for.
 */
const droppedRequestHeaders = new Set([
  "host",
  "content-length",
  "connection",
  "accept-encoding",
  "origin",
]);
const droppedResponseHeaders = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  // Deliberately not forwarded: the session lives in the tokens we return to the client.
  "set-cookie",
]);

export async function supabaseProxy(c: Context, supabaseUrl: string): Promise<Response> {
  const rest = c.req.path.slice(supaProxyPrefix.length);
  // `..` and its encoded forms are rejected outright: a segment that decodes later still
  // resolves to another Kong route upstream, even though the path we forward looks tame.
  if (!rest.startsWith(authPrefix) || /\.\.|%2e/i.test(rest))
    return c.json({ error: "Not found" }, 404);
  const base = `${supabaseUrl}/${authPrefix}`;
  const upstream = new URL(rest.slice(authPrefix.length), base);
  // Relative resolution escapes through `//host` and absolute paths, so the resolved href
  // decides — not the string this function was handed.
  if (!upstream.href.startsWith(base)) return c.json({ error: "Not found" }, 404);
  upstream.search = new URL(c.req.url).search;

  // The client's own headers carry through as they are — apikey included, and never a
  // service key: the server does not hold one and does not add one.
  const headers = new Headers();
  c.req.raw.headers.forEach((value, key) => {
    if (!droppedRequestHeaders.has(key)) headers.set(key, value);
  });
  const method = c.req.method;
  let response: Response;
  try {
    response = await fetch(upstream, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer(),
      signal: AbortSignal.timeout(upstreamTimeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return c.json(
      { error: timedOut ? "Supabase Auth timed out" : "Supabase Auth is unreachable" },
      timedOut ? 504 : 502,
    );
  }
  const forwarded = new Headers();
  response.headers.forEach((value, key) => {
    if (!droppedResponseHeaders.has(key) && !key.startsWith("access-control-"))
      forwarded.set(key, value);
  });
  // Upstream rejections pass through with their own status, so the client shows Supabase's message.
  return new Response(response.body, { status: response.status, headers: forwarded });
}
