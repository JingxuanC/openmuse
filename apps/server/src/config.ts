import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { defaultMaxConcurrentPerUser } from "./engine/scheduling.ts";

/** .env keys whose file value loses to a different value already set in the environment. */
export function shadowedEnvKeys(
  file: Record<string, string | undefined>,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return Object.keys(file).filter((key) => env[key] !== undefined && env[key] !== file[key]);
}

if (existsSync(".env")) {
  // loadEnvFile never overrides existing variables. A stale shell or system-wide value
  // (for example OPENAI_API_KEY) would otherwise silently replace the .env setting.
  const shadowed = shadowedEnvKeys(parseEnv(readFileSync(".env", "utf8")));
  process.loadEnvFile(".env");
  if (shadowed.length)
    console.warn(
      `[OpenMuse] Using ${shadowed.join(", ")} from the environment instead of .env. ` +
        (shadowed.length === 1
          ? "Unset it to use the .env value."
          : "Unset them to use the .env values."),
    );
}
process.env.DO_NOT_TRACK ??= "1";
process.env.COPILOTKIT_TELEMETRY_DISABLED ??= "true";

/**
 * A vertical agent OpenMuse delegates to over AG-UI. It is a tool, not a backend:
 * the conversation stays with OpenMuse's own agent and only the routed job leaves.
 */
export interface VerticalAgentSpec {
  /** Tool name the model calls; also the only name a run's task is reported under. */
  name: string;
  /** Doubles as the tool description the model routes on and the prompt's domain hint. */
  description: string;
  url: string;
  timeoutMs?: number;
  maxResultChars?: number;
}

/** Built-in ConversationAgent tools a vertical agent may not shadow. */
export const builtInToolNames = [
  "search_mail",
  "read_mail_thread",
  "browse_web",
  "delegate_task",
  "agent_status",
  "create_goal",
  "watch_page",
  "remember_fact",
  "present_choices",
  "open_workspace",
];

const verticalAgentName = /^[a-z][a-z0-9_]*$/;

function verticalAgentError(index: number, detail: string): Error {
  return new Error(`VERTICAL_AGENTS[${index}] ${detail}`);
}

/**
 * Parse `VERTICAL_AGENTS`. Every entry becomes a tool the model can call, so a
 * malformed or clashing entry fails at startup instead of surfacing as a tool
 * the model invents a name for.
 */
export function parseVerticalAgents(value = process.env.VERTICAL_AGENTS): VerticalAgentSpec[] {
  const trimmed = value?.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `VERTICAL_AGENTS must be a JSON array of {name, description, url}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!Array.isArray(parsed))
    throw new Error("VERTICAL_AGENTS must be a JSON array of {name, description, url}");
  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw verticalAgentError(index, "must be an object with name, description and url");
    const { name, description, url, timeoutMs, maxResultChars } = entry as Record<string, unknown>;
    if (typeof name !== "string" || !verticalAgentName.test(name))
      throw verticalAgentError(index, "name must match /^[a-z][a-z0-9_]*$/");
    if (seen.has(name)) throw verticalAgentError(index, `name "${name}" is already in use`);
    if (builtInToolNames.includes(name))
      throw verticalAgentError(index, `name "${name}" is reserved by a built-in tool`);
    seen.add(name);
    if (typeof description !== "string" || !description.trim())
      throw verticalAgentError(index, `"${name}" needs a nonblank description`);
    if (typeof url !== "string" || !/^https?:\/\//.test(url.trim()))
      throw verticalAgentError(index, `"${name}" needs an http(s) url`);
    for (const [key, limit] of [
      ["timeoutMs", timeoutMs],
      ["maxResultChars", maxResultChars],
    ] as const)
      if (
        limit !== undefined &&
        (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)
      )
        throw verticalAgentError(index, `"${name}" ${key} must be a positive integer`);
    return {
      name,
      description: description.trim(),
      url: url.trim(),
      ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
      ...(maxResultChars === undefined ? {} : { maxResultChars: maxResultChars as number }),
    };
  });
}

export interface Config {
  mode: "sample" | "live";
  /** Supabase verifies every request against the project JWKS; local keeps the dev access key. */
  authMode: "supabase" | "local";
  /** Optionally overridden for self-hosted Supabase; unused in local mode. */
  supabaseUrl?: string;
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  databaseUrl?: string;
  accessKey?: string;
  encryptionKey?: string;
  model?: string;
  jevMode?: "off" | "sample" | "live";
  typesafeApiKey?: string;
  jevModel?: string;
  agentBackend: "sample" | "model" | "agui" | "hybrid";
  agentUrl?: string;
  agentToken?: string;
  /** Pluggable delegates offered as tools when `agentBackend` is hybrid. */
  verticalAgents?: VerticalAgentSpec[];
  intelligenceBackend?: "local" | "copilotkit";
  intelligenceApiKey?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri: string;
  workerUrl?: string;
  workerToken?: string;
  taskWorkerEnabled?: boolean;
  /** Claim-side fairness: how many tasks one owner may run at once. */
  taskMaxConcurrentPerUser?: number;
  computerEnabled?: boolean;
  computerImage?: string;
  computerDeploymentId?: string;
  /** The per-user cloud computer (Daytona). Off unless CLOUD_ENABLED is true. */
  cloudEnabled?: boolean;
  daytonaApiKey?: string;
  daytonaApiUrl?: string;
  cloudCpu?: number;
  cloudMemoryGb?: number;
  cloudDiskGb?: number;
  cloudBaseImage?: string;
  /** Bumped when the baked-in cloud image changes, so the snapshot builds under a new name. */
  cloudImageVersion?: number;
  /** A full Dockerfile for the snapshot; unset builds the built-in cloud image. */
  cloudDockerfile?: string;
  cloudAutoStopMinutes?: number;
  cloudExecTimeoutMs?: number;
  allowedOrigins: string[];
}

/** Pinned so live rankings do not shift when TypeSafe moves the `jev-latest` alias. */
export const defaultJevModel = "jev-1.13.0";

/** Identity source shared with LangAlpha; `sub` is the same UUID on both sides. */
export const defaultSupabaseUrl = "https://veysvzfcyjxxbhvcfhuv.supabase.co";

export const intelligenceKeyRequiredMessage =
  "INTELLIGENCE_BACKEND=copilotkit requires CPK_INTELLIGENCE_API_KEY. " +
  "Run `npx copilotkit@latest login` and `npx copilotkit@latest project select`, " +
  "then set the generated server-only key. " +
  "See https://docs.copilotkit.ai/intelligence/connect-your-runtime";

export function required(name: string, message: string, value = process.env[name]): string {
  if (!value?.trim()) throw new Error(message);
  return value.trim();
}

/** Chat threads persist locally by default; a project key is only needed for the cloud opt-in. */
export function assertApiDeploymentConfig(config: Config): void {
  if (config.intelligenceBackend === "copilotkit")
    required(
      "CPK_INTELLIGENCE_API_KEY",
      intelligenceKeyRequiredMessage,
      config.intelligenceApiKey ?? "",
    );
}

/**
 * A cap below one would starve every queued task and a fractional one is meaningless, so both fail
 * at startup rather than silently degrading the queue.
 */
export function maxConcurrentPerUser(value = process.env.TASK_MAX_CONCURRENT_PER_USER): number {
  const trimmed = value?.trim();
  if (!trimmed) return defaultMaxConcurrentPerUser;
  const limit = Number(trimmed);
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("TASK_MAX_CONCURRENT_PER_USER must be a positive integer");
  return limit;
}

/**
 * Documented cloud-computer defaults. `readConfig` fills the Config from CLOUD_* and the provider
 * falls back to the same values, so a config built by hand (tests) sizes a sandbox identically.
 */
export const cloudDefaults = {
  apiUrl: "https://app.daytona.io/api",
  cpu: 4,
  memoryGb: 8,
  /** The hosted account caps a sandbox disk at 10 GB (probe-verified). */
  diskGb: 10,
  /** The stock toolbox image: a raw OS image has no toolbox to execute against. */
  baseImage: "daytonaio/sandbox:0.8.0",
  /** v2 is the first image built from a Dockerfile (Chromium and the om-browser CLI baked in). */
  imageVersion: 3,
  autoStopMinutes: 30,
  execTimeoutMs: 600000,
} as const;

/** A malformed size would silently mis-provision a billed sandbox, so it fails at startup instead. */
export function positiveInt(name: string, value: string | undefined, fallback: number): number {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

/** Accept a full worker URL, or host:port from a platform that omits the scheme. */
export function browserWorkerUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.includes("://") ? trimmed : `http://${trimmed}`;
}

// Provider SDKs retry transient failures before the response starts, with
// exponential backoff: OpenAI and Anthropic retry HTTP 408, 409, 429, 5xx and
// connection errors and honor retry-after; Gemini retries 408, 429, 500, 502,
// 503 and 504. Other 4xx responses such as 400, 401 and 403 fail on the first
// attempt, and a stream that fails after it starts is not retried. External
// writes never re-fire here: they are dispatched outside the model loop through
// reviewed, idempotency-keyed actions.
export const MODEL_MAX_RETRIES = 2;
export function readConfig(): Config {
  const mode = process.env.WORKSPACE_MODE ?? "sample";
  if (mode !== "sample" && mode !== "live")
    throw new Error("WORKSPACE_MODE must be sample or live");
  // Supabase is the default so a deployment that forgets AUTH_MODE is never the permissive one.
  const authMode = process.env.AUTH_MODE ?? "supabase";
  if (authMode !== "supabase" && authMode !== "local")
    throw new Error("AUTH_MODE must be supabase or local");
  const backend = process.env.AGENT_BACKEND ?? (mode === "sample" ? "sample" : "model");
  if (backend !== "sample" && backend !== "model" && backend !== "agui" && backend !== "hybrid")
    throw new Error("AGENT_BACKEND must be sample, model, agui or hybrid");
  if (mode === "live" && backend === "sample")
    throw new Error("Live workspaces cannot use the sample agent");
  const intelligenceBackend = process.env.INTELLIGENCE_BACKEND ?? "local";
  if (intelligenceBackend !== "local" && intelligenceBackend !== "copilotkit")
    throw new Error("INTELLIGENCE_BACKEND must be local or copilotkit");
  const jevMode = process.env.JEV_MODE ?? "off";
  if (jevMode !== "off" && jevMode !== "sample" && jevMode !== "live")
    throw new Error("JEV_MODE must be off, sample or live");
  const typesafeApiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (jevMode === "live" && !typesafeApiKey)
    throw new Error("JEV_MODE=live requires a nonblank TYPESAFE_API_KEY");
  const port = Number(process.env.PORT ?? 8787);
  const publicUrl = process.env.PUBLIC_API_URL ?? `http://localhost:${port}`;
  // The API key stays server-side: it never reaches a sandbox, which is why a missing one
  // fails here rather than at the first tool call.
  const cloudEnabled = process.env.CLOUD_ENABLED === "true";
  const daytonaApiKey = process.env.DAYTONA_API_KEY?.trim() || undefined;
  if (cloudEnabled && !daytonaApiKey)
    throw new Error("CLOUD_ENABLED=true requires a nonblank DAYTONA_API_KEY");
  const config: Config = {
    mode,
    authMode,
    supabaseUrl: (process.env.SUPABASE_URL?.trim() || defaultSupabaseUrl).replace(/\/+$/, ""),
    port,
    host: process.env.HOST ?? "127.0.0.1",
    publicUrl,
    dataDir: resolve(process.env.DATA_DIR ?? ".openmuse"),
    databaseUrl: process.env.DATABASE_URL,
    accessKey: process.env.OPENMUSE_ACCESS_KEY,
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
    model: process.env.MODEL,
    jevMode,
    typesafeApiKey,
    jevModel: process.env.JEV_MODEL?.trim() || defaultJevModel,
    agentBackend: backend,
    agentUrl: process.env.AGENT_URL,
    agentToken: process.env.AGENT_TOKEN,
    verticalAgents: parseVerticalAgents(),
    intelligenceBackend,
    intelligenceApiKey:
      intelligenceBackend === "copilotkit"
        ? required("CPK_INTELLIGENCE_API_KEY", intelligenceKeyRequiredMessage)
        : process.env.CPK_INTELLIGENCE_API_KEY?.trim() || undefined,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: `${publicUrl}/api/google/callback`,
    workerUrl: browserWorkerUrl(process.env.BROWSER_WORKER_URL),
    workerToken: process.env.WORKER_TOKEN,
    taskWorkerEnabled: process.env.TASK_WORKER_ENABLED !== "false",
    taskMaxConcurrentPerUser: maxConcurrentPerUser(),
    computerEnabled: process.env.COMPUTER_ENABLED === "true",
    computerImage: process.env.COMPUTER_IMAGE ?? "openmuse-computer:local",
    computerDeploymentId: process.env.COMPUTER_DEPLOYMENT_ID,
    cloudEnabled,
    daytonaApiKey,
    daytonaApiUrl: (process.env.DAYTONA_API_URL?.trim() || cloudDefaults.apiUrl).replace(
      /\/+$/,
      "",
    ),
    cloudCpu: positiveInt("CLOUD_CPU", process.env.CLOUD_CPU, cloudDefaults.cpu),
    cloudMemoryGb: positiveInt(
      "CLOUD_MEMORY_GB",
      process.env.CLOUD_MEMORY_GB,
      cloudDefaults.memoryGb,
    ),
    cloudDiskGb: positiveInt("CLOUD_DISK_GB", process.env.CLOUD_DISK_GB, cloudDefaults.diskGb),
    cloudBaseImage: process.env.CLOUD_BASE_IMAGE?.trim() || cloudDefaults.baseImage,
    cloudImageVersion: positiveInt(
      "CLOUD_IMAGE_VERSION",
      process.env.CLOUD_IMAGE_VERSION,
      cloudDefaults.imageVersion,
    ),
    cloudDockerfile: process.env.CLOUD_DOCKERFILE?.trim() || undefined,
    cloudAutoStopMinutes: positiveInt(
      "CLOUD_AUTO_STOP_MINUTES",
      process.env.CLOUD_AUTO_STOP_MINUTES,
      cloudDefaults.autoStopMinutes,
    ),
    cloudExecTimeoutMs: positiveInt(
      "CLOUD_EXEC_TIMEOUT_MS",
      process.env.CLOUD_EXEC_TIMEOUT_MS,
      cloudDefaults.execTimeoutMs,
    ),
    allowedOrigins: (
      process.env.ALLOWED_ORIGINS ?? "http://localhost:8081,http://127.0.0.1:8081"
    ).split(","),
  };
  if (
    mode === "live" &&
    (!config.accessKey || config.accessKey.length < 24 || !config.encryptionKey)
  )
    throw new Error(
      "Live mode requires OPENMUSE_ACCESS_KEY (24+ characters) and TOKEN_ENCRYPTION_KEY (32-byte base64)",
    );
  if (mode === "sample" && !["127.0.0.1", "localhost", "::1"].includes(config.host))
    throw new Error("Sample workspace is local-only. HOST must be a loopback address.");
  return config;
}
