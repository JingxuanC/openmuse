/**
 * Supabase Auth through OpenMuse: networks that cannot open supabase.co keep working
 * because the browser only ever talks to our own API, which forwards /auth/v1/ upstream.
 * Everything else Supabase offers (Realtime, Storage) is left alone — those need a
 * WebSocket or a signed URL, not a proxy hop.
 */
const authPath = "/auth/v1/";

const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, "");

/** The OpenMuse URL for a Supabase Auth call, or undefined when the call is not one. */
export function proxiedAuthUrl(
  target: string,
  supabaseUrl: string,
  apiUrl: string,
): string | undefined {
  const prefix = `${withoutTrailingSlash(supabaseUrl)}${authPath}`;
  if (!target.startsWith(prefix)) return undefined;
  return `${withoutTrailingSlash(apiUrl)}/api/supa${authPath}${target.slice(prefix.length)}`;
}

/** `createClient`'s `global.fetch`: Auth is rewritten, every other Supabase call is untouched. */
export function supabaseFetch(supabaseUrl: string, apiUrl: string): typeof fetch {
  return (input, init) => {
    const target =
      input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    const proxied = proxiedAuthUrl(target, supabaseUrl, apiUrl);
    if (!proxied) return fetch(input, init);
    // A Request carries its own method, headers and body, so it is rebuilt around the new URL.
    return input instanceof Request
      ? fetch(new Request(proxied, input), init)
      : fetch(proxied, init);
  };
}
