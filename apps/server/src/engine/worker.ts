import { randomUUID } from "node:crypto";
import type { AgentTask, RunEvent } from "../../../../packages/domain/src/agent.ts";
import type { Store } from "../db.ts";
import { backgroundFailure } from "../log.ts";
import { defaultMaxConcurrentPerUser, type OwnedTask, selectEligible } from "./scheduling.ts";

export class LostLeaseError extends Error {
  constructor() {
    super("Task was paused, cancelled or taken over by another worker");
    this.name = "LostLeaseError";
  }
}
export interface TaskContext {
  signal: AbortSignal;
  guard(): Promise<void>;
  checkpoint(patch: Partial<AgentTask>): Promise<AgentTask>;
  event(kind: RunEvent["kind"], title: string, detail?: string): Promise<void>;
}
export type TaskHandler = (
  owner: string,
  task: AgentTask,
  context: TaskContext,
) => Promise<Partial<AgentTask>>;
export class TaskWorker {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private stopping = false;
  private active = new Map<string, AbortController>();
  lastTickAt?: string;
  constructor(
    private readonly db: Store,
    private readonly execute: TaskHandler,
    private readonly options: {
      now?: () => number;
      leaseMs?: number;
      pollMs?: number;
      /** Tasks one owner may run at once; see TASK_MAX_CONCURRENT_PER_USER. */
      maxConcurrentPerUser?: number;
      settled?: (owner: string, task: AgentTask) => Promise<void>;
    } = {},
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  get running() {
    return Boolean(this.timer);
  }
  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => {
      // Timer callbacks cannot await runs; each run owns its durable error state.
      void this.tick().catch((error) => backgroundFailure("task worker tick", error));
    }, this.options.pollMs ?? 1000);
    void this.tick().catch((error) => backgroundFailure("initial task worker tick", error));
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.active.values()) controller.abort();
    while (this.active.size || this.ticking) await new Promise((r) => setTimeout(r, 10));
  }
  abort(taskId: string) {
    this.active.get(taskId)?.abort();
  }
  async tick() {
    if (this.stopping) return;
    // Deliberately global, never a tenant: a tick claims tasks for every owner, so it runs outside
    // any request's user transaction. Under RLS its Postgres role is expected to hold BYPASSRLS
    // (infra/migrations/0001_records_rls.sql) — running it as one user would hide every other owner.
    // The approval sweep below is cross-owner for that same reason and is meant to be: it settles
    // expired reviews for every tenant in one pass, and every action it reads or writes is still
    // addressed by that task's own owner, never by the sweep's.
    await this.db.withoutUser(() => this.tickAll());
  }
  private async tickAll() {
    if (this.running)
      await this.db.put("system", "worker-status", {
        id: "tasks",
        lastTickAt: new Date(this.now()).toISOString(),
      });
    if (this.ticking) return;
    this.ticking = true;
    this.lastTickAt = new Date(this.now()).toISOString();
    try {
      const records = await this.db.scan<AgentTask>("tasks");
      const due = records.filter(
        ({ value: t }) =>
          !this.active.has(t.id) &&
          (t.status === "queued" ||
            (t.status === "scheduled" && Date.parse(t.nextRunAt ?? "") <= this.now()) ||
            (t.status === "running" && Date.parse(t.leaseUntil ?? "") <= this.now()) ||
            t.status === "waiting_approval"),
      );
      // A task holding a live lease is already running somewhere — this worker, or another one
      // sharing the database — so it occupies one of its owner's slots. An expired lease does not:
      // that task sits in `due` and is about to be reclaimed below.
      const runningByOwner = new Map<string, number>();
      for (const { owner, value } of records) {
        if (value.status !== "running") continue;
        if (Date.parse(value.leaseUntil ?? "") > this.now())
          runningByOwner.set(owner, (runningByOwner.get(owner) ?? 0) + 1);
      }
      const candidates: OwnedTask<AgentTask>[] = [];
      for (const record of due) {
        if (record.value.status === "waiting_approval") {
          const action = record.value.actionId
            ? await this.db.get<{ status: string; expiresAt?: string }>(
                record.owner,
                "actions",
                record.value.actionId,
              )
            : null;
          if (
            record.value.actionId &&
            action?.status === "awaiting_review" &&
            Date.parse(action.expiresAt ?? "") <= this.now()
          )
            await this.db.compareAndSwap(
              record.owner,
              "actions",
              record.value.actionId,
              { status: "awaiting_review", expiresAt: action.expiresAt },
              { status: "expired" },
            );
          else if (action && ["awaiting_review", "executing"].includes(action.status)) continue;
        }
        candidates.push(record);
      }
      const eligible = selectEligible(
        candidates,
        runningByOwner,
        this.options.maxConcurrentPerUser ?? defaultMaxConcurrentPerUser,
      );
      await Promise.all(eligible.map(({ owner, value }) => this.run(owner, value)));
    } finally {
      this.ticking = false;
    }
  }
  private async run(owner: string, previous: AgentTask) {
    if (this.stopping) return;
    const leaseId = randomUUID(),
      leaseMs = this.options.leaseMs ?? 60000;
    const expected: Record<string, unknown> = {
      status: previous.status,
      leaseId: previous.leaseId ?? null,
    };
    if (previous.status === "running") expected.leaseUntil = previous.leaseUntil;
    let task = await this.db.compareAndSwap<AgentTask>(owner, "tasks", previous.id, expected, {
      status: "running",
      leaseId,
      leaseUntil: new Date(this.now() + leaseMs).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
      attempts: previous.attempts + 1,
    });
    if (!task) return;
    const controller = new AbortController();
    this.active.set(task.id, controller);
    const taskId = task.id;
    const guard = async () => {
      const latest = await this.db.get<AgentTask>(owner, "tasks", taskId);
      if (controller.signal.aborted || latest?.leaseId !== leaseId || latest.status !== "running")
        throw new LostLeaseError();
    };
    const checkpoint = async (patch: Partial<AgentTask>) => {
      if (controller.signal.aborted) throw new LostLeaseError();
      const next = await this.db.compareAndSwap<AgentTask>(
        owner,
        "tasks",
        taskId,
        { leaseId, status: "running" },
        { ...patch, updatedAt: new Date(this.now()).toISOString() },
      );
      if (!next) throw new LostLeaseError();
      task = next;
      return next;
    };
    const event = async (kind: RunEvent["kind"], title: string, detail = "") => {
      await guard();
      await this.db.put(owner, "run-events", {
        id: randomUUID(),
        taskId,
        date: new Date(this.now()).toISOString(),
        kind,
        title,
        detail,
      });
    };
    const startedAt = new Date(this.now()).toISOString();
    const heartbeat = setInterval(
      () => {
        void this.db
          .compareAndSwap(
            owner,
            "tasks",
            taskId,
            { leaseId, status: "running" },
            { leaseUntil: new Date(this.now() + leaseMs).toISOString() },
          )
          .then((value) => {
            if (!value) controller.abort();
          })
          .catch(() => controller.abort());
      },
      Math.max(10, Math.floor(leaseMs / 3)),
    );
    try {
      await this.db.put(owner, "runs", {
        id: leaseId,
        taskId,
        startedAt,
        status: "running",
      });
      const result = await this.execute(owner, task, {
        signal: controller.signal,
        guard,
        checkpoint,
        event,
      });
      await checkpoint({ ...result, leaseId: null, leaseUntil: null });
      await this.db.put(owner, "runs", {
        id: leaseId,
        taskId,
        startedAt,
        finishedAt: new Date(this.now()).toISOString(),
        status: result.status ?? task.status,
      });
    } catch (error) {
      if (error instanceof LostLeaseError || controller.signal.aborted) {
        await this.db.compareAndSwap(
          owner,
          "tasks",
          taskId,
          { leaseId, status: "running" },
          { status: "queued", leaseId: null, leaseUntil: null },
        );
      } else {
        const detail = error instanceof Error ? error.message : "Task execution failed";
        await event("error", "Task needs attention", detail).catch((error) =>
          backgroundFailure("record task error", error),
        );
        await this.db.compareAndSwap(
          owner,
          "tasks",
          taskId,
          { leaseId, status: "running" },
          {
            status: "failed",
            error: detail,
            leaseId: null,
            leaseUntil: null,
            updatedAt: new Date(this.now()).toISOString(),
          },
        );
      }
      await this.db.compareAndSwap(
        owner,
        "runs",
        leaseId,
        { status: "running" },
        {
          status: controller.signal.aborted ? "interrupted" : "failed",
          finishedAt: new Date(this.now()).toISOString(),
        },
      );
    } finally {
      clearInterval(heartbeat);
      this.active.delete(taskId);
    }
    const settled = await this.db.get<AgentTask>(owner, "tasks", taskId);
    if (settled && this.options.settled) await this.options.settled(owner, settled);
  }
}
