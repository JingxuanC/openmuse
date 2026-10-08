import { randomUUID } from "node:crypto";
import type { CloudCommand } from "../../../../packages/domain/src/cloud.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { CloudProvider } from "./provider.ts";

export const leaseDuration = 180000;
export const heartbeatMs = 60000;
export type Lease = {
  id: string;
  token: string;
  expiresAt: number;
  stopping: boolean;
  stopInFlight: boolean;
  stopAttempt: string;
  stopConfirmed: boolean;
  executorDone: boolean;
  operation: "command" | "operation";
};

/**
 * One owner, one operation. These are the sandbox tier's semantics with the provider lifted out:
 * a CAS lease keeps concurrent clients out, Stop and a lost client both hand the lease back only
 * after the provider confirmed the sandbox is gone.
 */
export async function acquireLease(
  db: Store,
  owner: string,
  operation: Lease["operation"] = "operation",
) {
  const previous = await db.get<Lease>(owner, "cloud-state", "lease");
  const lease = {
    id: "lease",
    token: randomUUID(),
    expiresAt: Date.now() + leaseDuration,
    stopping: false,
    stopInFlight: false,
    stopAttempt: "",
    stopConfirmed: false,
    executorDone: operation !== "command",
    operation,
  };
  if (previous && previous.expiresAt > Date.now())
    throw new AppError("Cloud computer is busy. Wait for the current operation to finish.", 409);
  const claimed = previous
    ? await db.compareAndSwap<Lease>(
        owner,
        "cloud-state",
        "lease",
        { token: previous.token, expiresAt: previous.expiresAt },
        lease,
      )
    : await db.insertIfAbsent(owner, "cloud-state", lease);
  if (!claimed)
    throw new AppError("Cloud computer is busy. Wait for the current operation to finish.", 409);
  return lease;
}
export async function exclusiveLease<T>(
  db: Store,
  owner: string,
  operation: (lease: Lease) => Promise<T>,
  kind: Lease["operation"] = "operation",
) {
  const lease = await acquireLease(db, owner, kind);
  try {
    return await operation(lease);
  } finally {
    // A stopped command acknowledges completion before a new lifecycle begins, so a delayed
    // client cannot exec into a restarted sandbox.
    if (kind === "command")
      await db.compareAndSwap(
        owner,
        "cloud-state",
        "lease",
        { token: lease.token },
        { executorDone: true },
      );
    await db.compareAndSwap(
      owner,
      "cloud-state",
      "lease",
      { token: lease.token, stopping: false },
      { expiresAt: 0 },
    );
    await releaseStoppedLease(db, owner, lease.token);
  }
}
export function releaseStoppedLease(db: Store, owner: string, token: string) {
  return db.compareAndSwap(
    owner,
    "cloud-state",
    "lease",
    { token, stopping: true, stopConfirmed: true, executorDone: true, stopInFlight: false },
    { expiresAt: 0 },
  );
}
/** Never extends a lease Stop already owns: a stopping lease must expire, not persist. */
export function renewLease(db: Store, owner: string, token: string) {
  return db.compareAndSwap(
    owner,
    "cloud-state",
    "lease",
    { token, stopping: false },
    { expiresAt: Date.now() + leaseDuration },
  );
}
export async function interruptRunningCommands(db: Store, owner: string, stderr: string) {
  for (const command of await db.list<CloudCommand>(owner, "cloud-commands"))
    if (command.status === "running")
      await db.compareAndSwap(
        owner,
        "cloud-commands",
        command.id,
        { status: "running" },
        { status: "interrupted", completedAt: new Date().toISOString(), stderr },
      );
}
export async function cloudCommands(db: Store, owner: string) {
  const commands = await db.list<CloudCommand>(owner, "cloud-commands");
  const lease = await db.get<Lease>(owner, "cloud-state", "lease");
  // A lease that expired without its process returning means the executor will never report:
  // reconcile the receipts so a later reader is not told a dead command is still running.
  if (!lease || lease.expiresAt <= Date.now()) {
    for (const command of commands)
      if (command.status === "running") {
        const saved = await db.compareAndSwap<CloudCommand>(
          owner,
          "cloud-commands",
          command.id,
          { status: "running" },
          {
            status: "interrupted",
            completedAt: new Date().toISOString(),
            stderr:
              "Execution was interrupted. Its outcome is unknown; inspect the sandbox files before running it again.",
          },
        );
        if (saved) Object.assign(command, saved);
      }
  }
  return commands.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 100);
}
/**
 * A client that lost the command cannot cancel it remotely, so the sandbox is stopped rather than
 * left running a process nobody is waiting for. Returns a note when the stop could not be
 * confirmed, which is when the lease stays locked and only an explicit Stop clears it.
 */
export async function quarantineSandbox(
  db: Store,
  provider: CloudProvider,
  owner: string,
  lease: Lease,
): Promise<string | undefined> {
  const attempt = randomUUID();
  const cleanup = await db.compareAndSwap<Lease>(
    owner,
    "cloud-state",
    "lease",
    { token: lease.token, stopping: false },
    {
      stopping: true,
      stopInFlight: true,
      stopAttempt: attempt,
      stopConfirmed: false,
      expiresAt: Date.now() + leaseDuration,
    },
  );
  // An explicit Stop may already own cleanup. Either way the lease cannot release until cleanup
  // is confirmed and the executor is done.
  if (!cleanup) return undefined;
  try {
    await provider.stop(owner);
    await db.compareAndSwap(
      owner,
      "cloud-state",
      "lease",
      { token: lease.token, stopAttempt: attempt },
      { stopInFlight: false, stopConfirmed: true },
    );
    return undefined;
  } catch {
    await db.compareAndSwap(
      owner,
      "cloud-state",
      "lease",
      { token: lease.token, stopAttempt: attempt },
      { stopInFlight: false, stopConfirmed: false },
    );
    return "\nCould not confirm the sandbox stopped. The cloud computer remains locked; retry Stop after checking Daytona.";
  }
}
