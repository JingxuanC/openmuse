import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Config, defaultSupabaseUrl } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import { createSupabaseJwt, type SupabaseJwt, type SupabaseUser } from "./supabase-jwt.ts";

const digest = (value: string) => createHash("sha256").update(value).digest();

export class Auth {
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly signingKey: string,
    private readonly jwt?: SupabaseJwt,
  ) {}
  private verifier() {
    // createAuth always passes one in supabase mode; this only catches a hand-built Auth.
    if (!this.jwt) throw new AppError("Supabase authentication is not configured", 503);
    return this.jwt;
  }
  /** Supabase mints and refreshes the token on the client; the server only verifies it. */
  async supabaseSession(
    accessToken?: string,
  ): Promise<{ mode: Config["mode"]; user: SupabaseUser }> {
    const token = accessToken?.trim();
    return { mode: this.config.mode, user: await this.verifier().user(token && `Bearer ${token}`) };
  }
  /** Local dev sign-in: the access key buys a session token, and every session belongs to one user. */
  async session(accessKey?: string) {
    if (
      this.config.mode === "live" &&
      (!accessKey ||
        !this.config.accessKey ||
        !timingSafeEqual(digest(accessKey), digest(this.config.accessKey)))
    )
      throw new AppError("Access key is incorrect", 401);
    const token = randomBytes(32).toString("base64url");
    await this.db.put("system", "sessions", {
      id: digest(token).toString("hex"),
      owner: "local-user",
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });
    return { token, mode: this.config.mode };
  }
  async owner(authorization?: string) {
    if (this.config.authMode === "supabase") return (await this.verifier().user(authorization)).id;
    if (!authorization?.startsWith("Bearer ")) throw new AppError("Sign in to OpenMuse", 401);
    const session = await this.db.get<{ owner: string; expiresAt: number }>(
      "system",
      "sessions",
      digest(authorization.slice(7)).toString("hex"),
    );
    if (!session || session.expiresAt < Date.now())
      throw new AppError("Session expired. Sign in again.", 401);
    return session.owner;
  }
  sign(owner: string, path: string) {
    const expires = String(Date.now() + 15 * 60 * 1000);
    const signature = createHmac("sha256", this.signingKey)
      .update(`${owner}\n${path}\n${expires}`)
      .digest("hex");
    return `${this.config.publicUrl}${path}?owner=${encodeURIComponent(owner)}&expires=${expires}&signature=${signature}`;
  }
  verify(url: URL) {
    const owner = url.searchParams.get("owner") ?? "";
    const expires = url.searchParams.get("expires") ?? "";
    const signature = url.searchParams.get("signature") ?? "";
    if (
      !owner ||
      !/^\d+$/.test(expires) ||
      Number(expires) < Date.now() ||
      !/^\w{64}$/.test(signature)
    )
      throw new AppError("Document link expired; refresh the workspace", 401);
    const expected = createHmac("sha256", this.signingKey)
      .update(`${owner}\n${url.pathname}\n${expires}`)
      .digest("hex");
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature)))
      throw new AppError("Invalid access link", 403);
    return owner;
  }
}
export async function createAuth(db: Store, config: Config) {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const path = join(config.dataDir, "session-signing-key");
  let key: string;
  try {
    key = await readFile(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    key = randomBytes(32).toString("base64");
    await writeFile(path, key, { mode: 0o600, flag: "wx" });
  }
  // Reachability is checked here so an unreachable JWKS stops the boot rather than every request.
  const jwt =
    config.authMode === "supabase"
      ? await createSupabaseJwt(config.supabaseUrl ?? defaultSupabaseUrl)
      : undefined;
  return new Auth(db, config, key, jwt);
}
