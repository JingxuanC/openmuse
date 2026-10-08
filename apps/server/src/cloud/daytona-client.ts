import { z } from "zod";
import { AppError } from "../errors.ts";

/**
 * The thin REST client the provider is layered on. Kept apart from CloudProvider semantics so the
 * HTTP layer is one mockable seam: `fetch` is injected, every response is validated, and every
 * failure becomes an AppError instead of a raw rejection.
 */
export const sandboxSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  labels: z.record(z.string(), z.string()).nullish(),
});
export type SandboxSummary = z.infer<typeof sandboxSchema>;

const fileInfoSchema = z.object({
  name: z.string(),
  path: z.string().optional(),
  isDir: z.boolean(),
  size: z.number(),
});
export type RemoteFile = z.infer<typeof fileInfoSchema>;

const executeSchema = z.object({
  exitCode: z.number().nullish(),
  result: z.string().nullish(),
});
const toolboxSchema = z.object({ url: z.string() });

export interface SandboxSpec {
  name: string;
  /** The org snapshot created by `createSnapshot`; per-sandbox resources are rejected with one. */
  snapshot: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  autoStopInterval: number;
}

export interface SnapshotSpec {
  name: string;
  cpu: number;
  memory: number;
  disk: number;
  /**
   * The snapshot's source: exactly one of the two. A Dockerfile under `buildInfo` is how
   * the tier bakes its browser in (probe-verified: hosted Daytona accepts
   * `buildInfo.dockerfileContent`); `imageName` builds from an image that already exists.
   */
  imageName?: string;
  buildInfo?: { dockerfileContent: string };
}

const snapshotSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  state: z.string(),
});
export type SnapshotSummary = z.infer<typeof snapshotSchema>;

export class DaytonaClient {
  private readonly fetch: typeof globalThis.fetch;
  constructor(
    private readonly options: {
      apiKey: string;
      apiUrl: string;
      fetch?: typeof globalThis.fetch;
    },
  ) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  private async call(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    try {
      return await this.fetch(url, {
        ...init,
        signal,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
          ...init.headers,
        },
      });
    } catch (error) {
      // An abort is the caller's own interruption and keeps its meaning; anything else is transport.
      if (signal?.aborted) throw error;
      throw new AppError("Daytona did not respond. Check DAYTONA_API_URL and the network.", 502);
    }
  }
  private async failure(response: Response, action: string): Promise<never> {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    if (response.status === 401 || response.status === 403)
      throw new AppError("Daytona rejected the API key. Check DAYTONA_API_KEY.", 503);
    if (response.status === 404)
      throw new AppError(`Daytona could not find the sandbox to ${action}`, 404);
    throw new AppError(
      `Daytona could not ${action} (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
      502,
    );
  }
  private async json<T>(response: Response, schema: z.ZodType<T>, action: string): Promise<T> {
    if (!response.ok) await this.failure(response, action);
    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success)
      throw new AppError(`Daytona returned an unexpected response to ${action}`, 502);
    return parsed.data;
  }
  private url(path: string) {
    return `${this.options.apiUrl}${path}`;
  }
  async list(name: string): Promise<SandboxSummary[]> {
    const query = new URLSearchParams({ name, limit: "20" });
    const response = await this.call(this.url(`/sandbox?${query}`));
    return (
      await this.json(response, z.object({ items: z.array(sandboxSchema) }), "list sandboxes")
    ).items;
  }
  async create(spec: SandboxSpec): Promise<SandboxSummary> {
    const response = await this.call(this.url("/sandbox"), {
      method: "POST",
      body: JSON.stringify({ ...spec, public: false }),
    });
    return this.json(response, sandboxSchema, "create the sandbox");
  }
  async findSnapshot(name: string): Promise<SnapshotSummary | undefined> {
    // The list filter is loose on purpose: snapshot listings are org-wide and
    // large, so an unpaged `name` query may not include ours. An exact-id GET
    // 404s for names; the name match below is what decides.
    const response = await this.call(this.url(`/snapshots/${encodeURIComponent(name)}`));
    if (response.status === 404) return undefined;
    const snapshot = await this.json(response, snapshotSchema, "read the snapshot");
    return snapshot.name === name ? snapshot : undefined;
  }
  async createSnapshot(spec: SnapshotSpec): Promise<SnapshotSummary> {
    const response = await this.call(this.url("/snapshots"), {
      method: "POST",
      body: JSON.stringify(spec),
    });
    return this.json(response, snapshotSchema, "create the snapshot");
  }
  async getSnapshot(id: string): Promise<SnapshotSummary> {
    return this.json(
      await this.call(this.url(`/snapshots/${encodeURIComponent(id)}`)),
      snapshotSchema,
      "read the snapshot",
    );
  }
  async deleteSnapshot(id: string): Promise<void> {
    const response = await this.call(this.url(`/snapshots/${encodeURIComponent(id)}`), {
      method: "DELETE",
    });
    if (!response.ok && response.status !== 404) await this.failure(response, "delete the snapshot");
  }
  async get(id: string): Promise<SandboxSummary> {
    return this.json(
      await this.call(this.url(`/sandbox/${encodeURIComponent(id)}`)),
      sandboxSchema,
      "read the sandbox",
    );
  }
  async start(id: string): Promise<void> {
    const response = await this.call(this.url(`/sandbox/${encodeURIComponent(id)}/start`), {
      method: "POST",
    });
    if (!response.ok) await this.failure(response, "start the sandbox");
  }
  async stop(id: string): Promise<void> {
    const response = await this.call(this.url(`/sandbox/${encodeURIComponent(id)}/stop`), {
      method: "POST",
    });
    if (!response.ok) await this.failure(response, "stop the sandbox");
  }
  /** Sandboxes execute and expose files through their own toolbox host, not the control plane. */
  private async toolbox(id: string, signal?: AbortSignal): Promise<string> {
    const response = await this.call(
      this.url(`/sandbox/${encodeURIComponent(id)}/toolbox-proxy-url`),
      {},
      signal,
    );
    const { url } = await this.json(response, toolboxSchema, "reach the sandbox toolbox");
    if (!/^https?:\/\//.test(url))
      throw new AppError("Daytona returned an unexpected toolbox URL", 502);
    return `${url.replace(/\/+$/, "")}/${encodeURIComponent(id)}`;
  }
  async execute(
    id: string,
    command: string,
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number | null; result: string }> {
    const base = await this.toolbox(id, signal);
    const response = await this.call(
      `${base}/process/execute`,
      {
        method: "POST",
        body: JSON.stringify({ command, cwd, timeout: Math.ceil(timeoutMs / 1000) }),
      },
      signal,
    );
    const parsed = await this.json(response, executeSchema, "run the command");
    return { exitCode: parsed.exitCode ?? 0, result: parsed.result ?? "" };
  }
  async download(id: string, path: string): Promise<Buffer> {
    const query = new URLSearchParams({ path });
    const response = await this.call(`${await this.toolbox(id)}/files/download?${query}`);
    if (!response.ok) await this.failure(response, "read the file");
    return Buffer.from(await response.arrayBuffer());
  }
  async upload(id: string, path: string, text: string): Promise<void> {
    const query = new URLSearchParams({ path });
    const form = new FormData();
    form.append("file", new Blob([text], { type: "text/plain" }), path.split("/").pop() || "file");
    const response = await this.call(`${await this.toolbox(id)}/files/upload?${query}`, {
      method: "POST",
      body: form,
    });
    if (!response.ok) await this.failure(response, "write the file");
  }
  async listFiles(id: string, path: string): Promise<RemoteFile[]> {
    const query = new URLSearchParams({ path });
    const response = await this.call(`${await this.toolbox(id)}/files?${query}`);
    return this.json(response, z.array(fileInfoSchema), "list the directory");
  }
}
