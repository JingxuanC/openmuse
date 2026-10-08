import { createRemoteJWKSet, jwtVerify } from "jose";
import { AppError } from "./errors.ts";

/** Supabase rotates signing keys without notice, so the JWKS is re-read on this cadence. */
const JWKS_CACHE_MS = 10 * 60 * 1000;
/** Floor between refreshes so a stream of unknown-`kid` tokens cannot stampede the project. */
const JWKS_COOLDOWN_MS = 30 * 1000;
const JWKS_TIMEOUT_MS = 10 * 1000;
const JWKS_PATH = "/auth/v1/.well-known/jwks.json";

/** The subset of the Supabase user that OpenMuse needs; `id` is the token `sub`, shared with LangAlpha. */
export interface SupabaseUser {
  id: string;
  email?: string;
}

const jwksUrl = (supabaseUrl: string) => new URL(JWKS_PATH, supabaseUrl);

export class SupabaseJwt {
  private readonly keySet: ReturnType<typeof createRemoteJWKSet>;
  constructor(supabaseUrl: string) {
    this.keySet = createRemoteJWKSet(jwksUrl(supabaseUrl), {
      cacheMaxAge: JWKS_CACHE_MS,
      cooldownDuration: JWKS_COOLDOWN_MS,
      timeoutDuration: JWKS_TIMEOUT_MS,
    });
  }
  /** Every failure collapses to one 401: telling a caller which part of its token was wrong helps only forgers. */
  async user(authorization?: string): Promise<SupabaseUser> {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!token) throw new AppError("Sign in to OpenMuse", 401);
    try {
      // The JWKS is this project's own, so a valid signature already proves provenance — which is
      // why `iss` is not asserted here. LangAlpha's jwt_bearer.py verifies the same three facts.
      const { payload } = await jwtVerify(token, this.keySet, {
        algorithms: ["RS256", "ES256"],
        audience: "authenticated",
      });
      if (!payload.sub) throw new Error("token carries no subject");
      return {
        id: payload.sub,
        email: typeof payload.email === "string" ? payload.email : undefined,
      };
    } catch {
      throw new AppError("Sign in to OpenMuse", 401);
    }
  }
}

/** Fail closed: a boot that cannot reach the project JWKS must not start serving requests it cannot authenticate. */
export async function createSupabaseJwt(supabaseUrl: string): Promise<SupabaseJwt> {
  const url = jwksUrl(supabaseUrl);
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(
      `Supabase JWKS at ${url} is unreachable: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!response.ok)
    throw new Error(`Supabase JWKS at ${url} is unreachable (HTTP ${response.status})`);
  const document = (await response.json()) as { keys?: unknown[] };
  if (!document.keys?.length) throw new Error(`Supabase JWKS at ${url} published no signing keys`);
  return new SupabaseJwt(supabaseUrl);
}
