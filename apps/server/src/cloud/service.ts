import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { CloudCommand, CloudSnapshot } from "../../../../packages/domain/src/cloud.ts";
import { type Config, cloudDefaults } from "../config.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import {
  type CloudProvider,
  cloudFileLimit,
  cloudPath,
  cloudRoot,
  type ExecReceipt,
} from "./provider.ts";
import {
  acquireLease,
  cloudCommands,
  exclusiveLease,
  heartbeatMs,
  interruptRunningCommands,
  type Lease,
  leaseDuration,
  quarantineSandbox,
  releaseStoppedLease,
  renewLease,
} from "./state.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const cloudCommandSchema = z.object({
  command: z.string().trim().min(1).max(16000),
  cwd: z.string().default(cloudRoot),
});
export const cloudPathSchema = z.object({ path: z.string().min(1).max(2048) });
export const cloudWriteSchema = cloudPathSchema.extend({ text: z.string().max(cloudFileLimit) });

/**
 * The per-user cloud computer. Lifetime, lease and receipt semantics are the ones ComputerService
 * already proved, so both tiers behave the same way under a concurrent command, a lost client or
 * a stop that races an executor; only the provider differs.
 */
export class CloudComputerService {
  constructor(
    readonly db: Store,
    readonly config: Config,
    private readonly provider: CloudProvider,
  ) {}
  private enabled() {
    if (!this.config.cloudEnabled)
      throw new AppError(
        "The cloud computer is not configured. Enable CLOUD_ENABLED and set DAYTONA_API_KEY.",
        503,
      );
  }
  async snapshot(owner: string): Promise<CloudSnapshot> {
    const base = {
      enabled: Boolean(this.config.cloudEnabled),
      provider: "daytona" as const,
      workspacePath: cloudRoot as CloudSnapshot["workspacePath"],
      network: "enabled" as const,
      spec: {
        cpu: this.config.cloudCpu ?? cloudDefaults.cpu,
        memoryGb: this.config.cloudMemoryGb ?? cloudDefaults.memoryGb,
        diskGb: this.config.cloudDiskGb ?? cloudDefaults.diskGb,
      },
      commands: await cloudCommands(this.db, owner),
    };
    if (!base.enabled)
      return {
        ...base,
        status: "unconfigured",
        message: "Enable the cloud computer on the server to use its terminal and files.",
      };
    try {
      const status = await this.provider.status(owner);
      return {
        ...base,
        // An absent sandbox is one nobody has started yet, which is what stopped means here.
        status: status === "running" ? "running" : status === "error" ? "error" : "stopped",
      };
    } catch (error) {
      return {
        ...base,
        status: "error",
        message: error instanceof AppError ? error.message : "Cloud computer inspection failed.",
      };
    }
  }
  async start(owner: string) {
    this.enabled();
    await exclusiveLease(this.db, owner, async () => {
      await this.provider.start(owner);
    });
    return this.snapshot(owner);
  }
  async stop(owner: string) {
    this.enabled();
    let lease = await this.db.get<Lease>(owner, "cloud-state", "lease");
    if (!lease || lease.expiresAt <= Date.now()) lease = await acquireLease(this.db, owner);
    else if ((lease.operation !== "command" && !lease.stopping) || lease.stopInFlight)
      throw new AppError(
        "Cloud computer is busy with another operation. Try Stop again shortly.",
        409,
      );
    const attempt = randomUUID();
    const stopping = await this.db.compareAndSwap<Lease>(
      owner,
      "cloud-state",
      "lease",
      {
        token: lease.token,
        stopping: lease.stopping,
        ...(lease.stopAttempt !== undefined ? { stopAttempt: lease.stopAttempt } : {}),
      },
      {
        stopping: true,
        stopInFlight: true,
        stopAttempt: attempt,
        stopConfirmed: false,
        expiresAt: Date.now() + leaseDuration,
      },
    );
    if (!stopping) throw new AppError("Cloud computer is busy with another Stop request", 409);
    try {
      // Record intent before the provider call so a concurrently exiting command cannot report
      // success over the user's interruption.
      await interruptRunningCommands(
        this.db,
        owner,
        "Stopped by the user. Inspect the sandbox files before repeating this command.",
      );
      if ((await this.provider.status(owner)) === "running") await this.provider.stop(owner);
      await this.db.compareAndSwap(
        owner,
        "cloud-state",
        "lease",
        { token: lease.token, stopAttempt: attempt },
        { stopInFlight: false, stopConfirmed: true },
      );
      await releaseStoppedLease(this.db, owner, lease.token);
    } catch (error) {
      // Keep the command quarantine, but allow an explicit retry after a transient failure.
      await this.db.compareAndSwap(
        owner,
        "cloud-state",
        "lease",
        { token: lease.token, stopAttempt: attempt },
        { stopInFlight: false, stopConfirmed: false },
      );
      throw error;
    }
    return this.snapshot(owner);
  }
  private async running(owner: string) {
    this.enabled();
    if ((await this.provider.status(owner)) !== "running")
      throw new AppError("Start the cloud computer before using its terminal or files", 409);
  }
  async execute(
    owner: string,
    raw: unknown,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<CloudCommand> {
    this.enabled();
    const args = cloudCommandSchema.parse(raw),
      cwd = cloudPath(args.cwd);
    const id = options.idempotencyKey
      ? hash(`cloud-command:${options.idempotencyKey}`)
      : randomUUID();
    const previous = await this.db.get<CloudCommand>(owner, "cloud-commands", id);
    if (previous) {
      if (previous.command !== args.command || previous.cwd !== cwd)
        throw new AppError("This operation ID already belongs to a different command", 409);
      await cloudCommands(this.db, owner);
      return (await this.db.get<CloudCommand>(owner, "cloud-commands", id)) ?? previous;
    }
    return exclusiveLease(
      this.db,
      owner,
      async (lease) => {
        await this.running(owner);
        if (options.signal?.aborted)
          throw new AppError("Cloud command was interrupted before execution", 409);
        const command: CloudCommand = {
          id,
          command: args.command,
          cwd,
          status: "running",
          stdout: "",
          stderr: "",
          truncated: false,
          startedAt: new Date().toISOString(),
        };
        const saved = await this.db.insertIfAbsent(owner, "cloud-commands", command);
        if (!saved) {
          const existing = await this.db.get<CloudCommand>(owner, "cloud-commands", id);
          if (existing) return existing;
          throw new AppError("Cloud receipt could not be saved", 500);
        }
        const active = await this.db.get<Lease>(owner, "cloud-state", "lease");
        if (
          !active ||
          active.token !== lease.token ||
          active.stopping ||
          active.expiresAt <= Date.now()
        )
          return this.db.put(owner, "cloud-commands", {
            ...command,
            status: "interrupted",
            stderr: "Stopped before execution",
            completedAt: new Date().toISOString(),
          });
        const timeoutMs = this.config.cloudExecTimeoutMs ?? cloudDefaults.execTimeoutMs;
        // A ten-minute command outlives a fixed lease, so it renews until it reports an outcome.
        const heartbeat = setInterval(() => {
          void renewLease(this.db, owner, lease.token).catch(() => {});
        }, heartbeatMs);
        let result: ExecReceipt;
        try {
          result = await this.provider.exec(owner, args.command, cwd, timeoutMs, options.signal);
        } catch {
          result = {
            stdout: "",
            stderr:
              "The sandbox did not report an outcome; treat the command as still unknown and inspect its files.",
            exitCode: null,
            timedOut: false,
            interrupted: true,
            truncated: false,
          };
        } finally {
          clearInterval(heartbeat);
        }
        if (result.timedOut || result.interrupted) {
          const note = await quarantineSandbox(this.db, this.provider, owner, lease);
          if (note) result.stderr += note;
        }
        const final: CloudCommand = {
          ...command,
          status: result.interrupted
            ? "interrupted"
            : result.timedOut
              ? "timed_out"
              : result.exitCode === 0
                ? "succeeded"
                : "failed",
          ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
          completedAt: new Date().toISOString(),
        };
        const finished = await this.db.compareAndSwap<CloudCommand>(
          owner,
          "cloud-commands",
          id,
          { status: "running" },
          { ...final },
        );
        if (finished) return finished;
        const interrupted = await this.db.get<CloudCommand>(owner, "cloud-commands", id);
        return this.db.put(owner, "cloud-commands", {
          ...final,
          status: "interrupted",
          stderr: [result.stderr, interrupted?.stderr].filter(Boolean).join("\n"),
        });
      },
      "command",
    );
  }
  private async file<T>(
    owner: string,
    operation: "list" | "read" | "write",
    rawPath: string,
    text?: string,
  ): Promise<T> {
    this.enabled();
    const path = cloudPath(rawPath);
    if (text !== undefined && Buffer.byteLength(text) > cloudFileLimit)
      throw new AppError("Text files must be 256 KB or smaller", 413);
    return exclusiveLease(this.db, owner, async () => {
      await this.running(owner);
      if (operation === "list") return (await this.provider.listDir(owner, path)) as T;
      if (operation === "read") return (await this.provider.readFile(owner, path)) as T;
      return (await this.provider.writeFile(owner, path, text ?? "")) as T;
    });
  }
  list(owner: string, path = cloudRoot) {
    return this.file<Awaited<ReturnType<CloudProvider["listDir"]>>>(owner, "list", path);
  }
  read(owner: string, path: string) {
    return this.file<{ path: string; text: string }>(owner, "read", path);
  }
  write(owner: string, path: string, text: string) {
    return this.file<{ path: string }>(owner, "write", path, text);
  }
}
