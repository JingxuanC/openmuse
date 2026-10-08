import { posix } from "node:path";
import type { CloudDirectory } from "../../../../packages/domain/src/cloud.ts";
import { type Config, cloudDefaults } from "../config.ts";
import { AppError } from "../errors.ts";
import { DaytonaClient, type SandboxSummary } from "./daytona-client.ts";
import { cloudDockerfile } from "./image.ts";
import {
  type CloudProvider,
  cloudEnv,
  cloudFileLimit,
  cloudIdentity,
  cloudOutputLimit,
  type ExecReceipt,
} from "./provider.ts";

const asleep = new Set(["stopped", "destroyed"]);
/** States a start call resumes; anything else transitional is only waited on. */
const resumable = new Set(["stopped", "paused", "archived"]);

export interface DaytonaOptions {
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
}

/** Maps Daytona's sandbox states onto the coarse set the service reasons about. */
function cloudState(state: string): "running" | "stopped" | "error" | "absent" {
  if (state === "started" || state === "starting" || state === "resuming") return "running";
  if (state === "destroyed") return "absent";
  if (state === "error" || state === "build_failed" || state === "unknown") return "error";
  // Everything else — creating, pulling_snapshot, paused, archived — is not usable yet.
  return "stopped";
}

export class DaytonaProvider implements CloudProvider {
  /** Absent while the tier is off: the app builds the provider unconditionally. */
  private readonly client?: DaytonaClient;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly startTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  /** When each owner's sandbox was last confirmed started; drives the status grace window. */
  private readonly runningSince = new Map<string, number>();
  constructor(
    private readonly config: Config,
    options: DaytonaOptions = {},
  ) {
    this.client =
      config.cloudEnabled && config.daytonaApiKey
        ? new DaytonaClient({
            apiKey: config.daytonaApiKey,
            apiUrl: config.daytonaApiUrl ?? cloudDefaults.apiUrl,
            fetch: options.fetch,
          })
        : undefined;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pollMs = options.pollMs ?? 1000;
    this.startTimeoutMs = options.startTimeoutMs ?? 120000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 60000;
  }
  private connection() {
    if (!this.client)
      throw new AppError(
        "The cloud computer is not configured. Enable CLOUD_ENABLED and set DAYTONA_API_KEY.",
        503,
      );
    return this.client;
  }
  /** Attaches only to this deployment's sandbox: a name collision must never cross owners. */
  private async find(owner: string, signal?: AbortSignal): Promise<SandboxSummary | undefined> {
    const identity = cloudIdentity(this.config, owner);
    if (signal?.aborted) throw new AppError("Cloud computer operation was interrupted", 409);
    const found = (await this.connection().list(identity.sandbox)).find(
      (sandbox) => sandbox.name === identity.sandbox,
    );
    if (!found) return undefined;
    for (const [key, value] of Object.entries(identity.labels))
      if (found.labels?.[key] !== value)
        throw new AppError(
          "A cloud sandbox with this name belongs to another deployment; refusing to attach",
          409,
        );
    return found;
  }
  private async active(owner: string, signal?: AbortSignal): Promise<SandboxSummary> {
    const found = await this.find(owner, signal);
    if (!found || cloudState(found.state) !== "running")
      throw new AppError("Start the cloud computer before using its terminal or files", 409);
    return found;
  }
  private async waitFor(id: string, states: string[], timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const sandbox = await this.connection().get(id);
      if (states.includes(sandbox.state)) return;
      if (sandbox.state === "error" || sandbox.state === "build_failed")
        throw new AppError(`Daytona reported the sandbox as ${sandbox.state}`, 502);
      if (Date.now() >= deadline)
        throw new AppError(
          `Daytona did not reach ${states.join(" or ")} in time. Check the sandbox in Daytona.`,
          502,
        );
      await this.sleep(this.pollMs);
    }
  }
  /**
   * The tier-sized snapshot this deployment creates sandboxes from, built once
   * and reused. Hosted Daytona rejects per-sandbox resources ("Cannot specify
   * Sandbox resources when using a snapshot", probe-verified), so cpu/memory/
   * disk are baked here, and the image is built from a Dockerfile rather than
   * named: the browser and its CLI have to be inside the image, since a sandbox
   * cannot install them from the closed env it executes under. The Dockerfile's
   * base is still a toolbox image, which is what exec and file access run through.
   */
  private async ensureSnapshot(name: string): Promise<void> {
    let existing = await this.connection().findSnapshot(name);
    if (existing && (existing.state === "error" || existing.state === "build_failed")) {
      // A failed build never recovers on its own and would block every start;
      // replace it so the next create gets a fresh attempt.
      await this.connection().deleteSnapshot(existing.id);
      // The delete is server-side async: the name stays reserved until it
      // completes, and an immediate recreate answers 409 (probe-verified).
      existing = await this.waitForSnapshotGone(name);
    }
    if (!existing) {
      const dockerfile =
        this.config.cloudDockerfile ??
        cloudDockerfile(this.config.cloudBaseImage ?? cloudDefaults.baseImage);
      const created = await this.connection().createSnapshot({
        name,
        buildInfo: { dockerfileContent: dockerfile },
        cpu: this.config.cloudCpu ?? cloudDefaults.cpu,
        memory: this.config.cloudMemoryGb ?? cloudDefaults.memoryGb,
        disk: this.config.cloudDiskGb ?? cloudDefaults.diskGb,
      });
      await this.waitForSnapshot(created.id);
      return;
    }
    if (existing.state !== "active") await this.waitForSnapshot(existing.id);
  }
  private async waitForSnapshotGone(name: string): Promise<undefined> {
    const deadline = Date.now() + 2 * 60 * 1000;
    for (;;) {
      const snapshot = await this.connection().findSnapshot(name);
      if (!snapshot) return undefined;
      if (Date.now() >= deadline)
        throw new AppError("Daytona did not finish removing the failed cloud snapshot.", 502);
      await this.sleep(Math.max(this.pollMs, 2000));
    }
  }
  /** A first build also downloads Chromium and its libraries, which alone runs for minutes. */
  private async waitForSnapshot(id: string): Promise<void> {
    const deadline = Date.now() + 25 * 60 * 1000;
    for (;;) {
      const snapshot = await this.connection().getSnapshot(id);
      if (snapshot.state === "active") return;
      if (snapshot.state === "build_failed" || snapshot.state === "error")
        throw new AppError(
          "Daytona could not build the cloud snapshot. Check the base image and account limits.",
          502,
        );
      if (Date.now() >= deadline)
        throw new AppError("Daytona did not finish building the cloud snapshot in time.", 502);
      await this.sleep(Math.max(this.pollMs, 5000));
    }
  }
  async status(owner: string): Promise<"running" | "stopped" | "absent" | "error"> {
    const found = await this.find(owner);
    if (!found) return "absent";
    const state = cloudState(found.state);
    // Daytona's state flickers to "stopped" inside the create/resume window even
    // though waitFor already confirmed "started" (probe-verified). Trust a recent
    // confirmation for a grace period and double-check before reporting stopped.
    const confirmed = this.runningSince.get(owner);
    if (state === "stopped" && confirmed !== undefined && Date.now() - confirmed < 90_000) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await this.sleep(Math.max(this.pollMs, 2000));
        const fresh = await this.connection().get(found.id);
        if (cloudState(fresh.state) === "running") return "running";
      }
      this.runningSince.delete(owner);
    }
    return state;
  }
  async start(owner: string): Promise<void> {
    const identity = cloudIdentity(this.config, owner);
    const existing = await this.find(owner);
    if (!existing) {
      // The idle deadline comes from config; env stays the closed three-variable set.
      await this.ensureSnapshot(identity.snapshot);
      const created = await this.connection().create({
        name: identity.sandbox,
        snapshot: identity.snapshot,
        env: { ...cloudEnv },
        labels: identity.labels,
        autoStopInterval: this.config.cloudAutoStopMinutes ?? cloudDefaults.autoStopMinutes,
      });
      await this.waitFor(created.id, ["started"], this.startTimeoutMs);
      this.runningSince.set(owner, Date.now());
      return;
    }
    if (existing.state === "started") {
      this.runningSince.set(owner, Date.now());
      return;
    }
    if (resumable.has(existing.state)) await this.connection().start(existing.id);
    await this.waitFor(existing.id, ["started"], this.startTimeoutMs);
    this.runningSince.set(owner, Date.now());
  }
  async stop(owner: string): Promise<void> {
    this.runningSince.delete(owner);
    const existing = await this.find(owner);
    if (!existing || asleep.has(existing.state)) return;
    if (existing.state !== "stopping" && existing.state !== "destroying")
      await this.connection().stop(existing.id);
    await this.waitFor(existing.id, ["stopped", "destroyed"], this.stopTimeoutMs);
  }
  async exec(
    owner: string,
    command: string,
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ExecReceipt> {
    const sandbox = await this.active(owner, signal);
    // A client that gives up cannot cancel a remote process, so the caller must stop the sandbox.
    const deadline = AbortSignal.timeout(timeoutMs + 5000);
    try {
      const result = await this.connection().execute(
        sandbox.id,
        command,
        cwd,
        timeoutMs,
        signal ? AbortSignal.any([signal, deadline]) : deadline,
      );
      const truncated = Buffer.byteLength(result.result) > cloudOutputLimit;
      return {
        stdout: truncated
          ? Buffer.from(result.result, "utf8").subarray(0, cloudOutputLimit).toString("utf8")
          : result.result,
        // The toolbox merges stderr into `result`; there is no separate stream to report.
        stderr: "",
        exitCode: result.exitCode,
        timedOut: false,
        interrupted: false,
        truncated,
      };
    } catch (error) {
      if (deadline.aborted)
        return {
          stdout: "",
          stderr: "",
          exitCode: null,
          timedOut: true,
          interrupted: false,
          truncated: false,
        };
      if (signal?.aborted)
        return {
          stdout: "",
          stderr: "",
          exitCode: null,
          timedOut: false,
          interrupted: true,
          truncated: false,
        };
      throw error;
    }
  }
  async readFile(owner: string, path: string) {
    const sandbox = await this.active(owner);
    const bytes = await this.connection().download(sandbox.id, path);
    if (bytes.length > cloudFileLimit) throw new AppError("Files must be 256 KB or smaller", 413);
    return { path, text: bytes.toString("utf8") };
  }
  async writeFile(owner: string, path: string, text: string) {
    const sandbox = await this.active(owner);
    await this.connection().upload(sandbox.id, path, text);
    return { path };
  }
  async listDir(owner: string, path: string): Promise<CloudDirectory> {
    const sandbox = await this.active(owner);
    const entries = await this.connection().listFiles(sandbox.id, path);
    return {
      path,
      entries: entries.map((file) => ({
        name: file.name,
        path: file.path ?? posix.join(path, file.name),
        type: file.isDir ? ("directory" as const) : ("file" as const),
        size: file.size,
      })),
    };
  }
}
