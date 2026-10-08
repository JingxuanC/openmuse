import { randomUUID } from "node:crypto";
import { CopilotKitIntelligence, type ThreadSummary } from "@copilotkit/runtime/v2";
import type { Store } from "../db.ts";
import { deriveMessages, deriveState, type ThreadMessage } from "./thread-events.ts";

/**
 * Local, Postgres-backed replacement for the CopilotKit Intelligence cloud
 * service. The runtime only talks to `CopilotKitIntelligence` through its
 * public method surface, so subclassing and overriding every method that would
 * otherwise call the managed API removes the cloud dependency without touching
 * the runtime or the RN client. Thread metadata and AG-UI event logs live in
 * the existing `records` table under `intelligence-*` kinds, scoped by owner.
 *
 * Two parts of the surface are deliberately in-process: run locks (the server
 * is single-process and a lock's lifetime never exceeds a run) and minted
 * realtime join tokens (validated by the local gateway in the same process).
 */
export class LocalIntelligenceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "LocalIntelligenceError";
  }
}

interface ThreadRecord {
  id: string;
  name: string | null;
  agentId: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  createdById: string;
  latestEventId?: string;
}

interface ThreadEventLog {
  id: string;
  events: { seq: number; event: Record<string, unknown> }[];
}

const THREADS = "intelligence-threads";
const EVENTS = "intelligence-events";
const INDEX = "intelligence-thread-index";
const INDEX_OWNER = "system";
const LOCAL_RUNNER_TOKEN = "local-intelligence-runner";
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function summarize(thread: ThreadRecord): ThreadSummary {
  return {
    id: thread.id,
    name: thread.name,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    ...(thread.lastRunAt ? { lastRunAt: thread.lastRunAt } : {}),
    archived: thread.archived,
    agentId: thread.agentId,
    createdById: thread.createdById,
  };
}

export interface LocalIntelligenceOptions {
  /** Base URL of the local realtime gateway, e.g. `ws://localhost:8787/api/intelligence/realtime`. */
  wsBaseUrl: string;
}

export class LocalIntelligence extends CopilotKitIntelligence {
  private wsBase: string;
  /**
   * Live runs by thread. `userId`/`agentId` are the runtime's verified identity from
   * `ɵacquireThreadLock`, kept so a missing thread record can be rebuilt from a run that
   * is still in flight instead of failing on an index the runner plane cannot vouch for.
   */
  private readonly locks = new Map<
    string,
    { runId: string; userId?: string; agentId?: string; expiresAt: number }
  >();
  private readonly joinTokens = new Map<string, Set<string>>();
  private readonly createdListeners = new Set<(thread: ThreadSummary) => void>();
  private readonly updatedListeners = new Set<(thread: ThreadSummary) => void>();
  private readonly deletedListeners = new Set<
    (params: { threadId: string; userId: string; agentId: string }) => void
  >();
  private annotationCounter = 0;

  constructor(
    private readonly db: Store,
    options: LocalIntelligenceOptions,
  ) {
    super({ apiKey: "local-intelligence" });
    this.wsBase = options.wsBaseUrl.replace(/\/$/, "");
  }

  /** Point the runtime and clients at the gateway actually listening (tests bind ephemeral ports). */
  setRealtimeBase(wsBaseUrl: string) {
    this.wsBase = wsBaseUrl.replace(/\/$/, "");
  }

  // Lifecycle listeners — the base class wires these to platform notifications;
  // locally they fire from the mutating methods below.
  override onThreadCreated(callback: (thread: ThreadSummary) => void): () => void {
    this.createdListeners.add(callback);
    return () => this.createdListeners.delete(callback);
  }
  override onThreadUpdated(callback: (thread: ThreadSummary) => void): () => void {
    this.updatedListeners.add(callback);
    return () => this.updatedListeners.delete(callback);
  }
  override onThreadDeleted(
    callback: (params: { threadId: string; userId: string; agentId: string }) => void,
  ): () => void {
    this.deletedListeners.add(callback);
    return () => this.deletedListeners.delete(callback);
  }

  private async thread(userId: string, threadId: string): Promise<ThreadRecord> {
    const thread = await this.db.get<ThreadRecord>(userId, THREADS, threadId);
    if (!thread) throw new LocalIntelligenceError(`Thread ${threadId} not found`, 404);
    return thread;
  }

  private async saveThread(userId: string, thread: ThreadRecord): Promise<ThreadRecord> {
    thread.updatedAt = new Date().toISOString();
    await this.db.put(userId, THREADS, thread);
    return thread;
  }

  override async createThread(params: {
    threadId: string;
    userId: string;
    agentId: string;
    name?: string;
    learningContainerId?: string;
  }): Promise<ThreadSummary> {
    const now = new Date().toISOString();
    const thread: ThreadRecord = {
      id: params.threadId,
      name: params.name ?? null,
      agentId: params.agentId,
      archived: false,
      createdAt: now,
      updatedAt: now,
      createdById: params.userId,
    };
    const created = await this.db.insertIfAbsent(params.userId, THREADS, thread);
    if (!created) throw new LocalIntelligenceError(`Thread ${params.threadId} already exists`, 409);
    await this.db.put(INDEX_OWNER, INDEX, { id: params.threadId, owner: params.userId });
    const summary = summarize(created);
    for (const listener of this.createdListeners) listener(summary);
    return summary;
  }

  override async getThread(params: { threadId: string; userId: string }): Promise<ThreadSummary> {
    return summarize(await this.thread(params.userId, params.threadId));
  }

  override async getOrCreateThread(params: {
    threadId: string;
    userId: string;
    agentId: string;
    name?: string;
    learningContainerId?: string;
  }): Promise<{ thread: ThreadSummary; created: boolean }> {
    try {
      return { thread: await this.createThread(params), created: true };
    } catch (error) {
      if (error instanceof LocalIntelligenceError && error.status === 409)
        return { thread: await this.getThread(params), created: false };
      throw error;
    }
  }

  override async listThreads(params: {
    userId: string;
    agentId: string;
    includeArchived?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<{
    threads: ThreadSummary[];
    joinCode: string;
    joinToken?: string;
    nextCursor?: string | null;
  }> {
    const all = (await this.db.list<ThreadRecord>(params.userId, THREADS)).filter(
      (thread) =>
        thread.agentId === params.agentId && (params.includeArchived === true || !thread.archived),
    );
    const offset = params.cursor ? Math.max(0, Number(params.cursor) || 0) : 0;
    const limit = Math.min(Math.max(1, params.limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
    const page = all.slice(offset, offset + limit);
    return {
      threads: page.map(summarize),
      // The client skips the realtime metadata subscription when no join code is
      // issued; thread mutations already refresh its store over REST.
      joinCode: "",
      nextCursor: offset + limit < all.length ? String(offset + limit) : null,
    };
  }

  override async updateThread(params: {
    threadId: string;
    userId: string;
    agentId: string;
    updates: { name?: string; [key: string]: unknown };
  }): Promise<ThreadSummary> {
    const thread = await this.thread(params.userId, params.threadId);
    if (params.updates.name !== undefined) thread.name = params.updates.name;
    const summary = summarize(await this.saveThread(params.userId, thread));
    for (const listener of this.updatedListeners) listener(summary);
    return summary;
  }

  override async archiveThread(params: {
    threadId: string;
    userId: string;
    agentId: string;
  }): Promise<void> {
    const thread = await this.thread(params.userId, params.threadId);
    thread.archived = true;
    const summary = summarize(await this.saveThread(params.userId, thread));
    for (const listener of this.updatedListeners) listener(summary);
  }

  override async deleteThread(params: {
    threadId: string;
    userId: string;
    agentId: string;
  }): Promise<void> {
    await this.thread(params.userId, params.threadId);
    await this.db.remove(params.userId, THREADS, params.threadId);
    await this.db.remove(params.userId, EVENTS, params.threadId);
    await this.db.remove(INDEX_OWNER, INDEX, params.threadId);
    for (const listener of this.deletedListeners)
      listener({ threadId: params.threadId, userId: params.userId, agentId: params.agentId });
  }

  override async getThreadMessages(params: {
    threadId: string;
    userId: string;
    channelDeliveryId?: string;
  }): Promise<{ messages: ThreadMessage[] }> {
    return { messages: deriveMessages(await this.threadEvents(params.threadId)) };
  }

  override async getThreadEvents(params: { threadId: string }): Promise<{
    events: (Record<string, unknown> & { type: string })[];
    decodeErrorRowIds: string[];
    truncated: boolean;
  }> {
    return {
      events: await this.threadEvents(params.threadId),
      decodeErrorRowIds: [],
      truncated: false,
    };
  }

  override async getThreadState(params: { threadId: string }) {
    return deriveState(await this.threadEvents(params.threadId));
  }

  // --- Run locks (in-process; a lock never outlives its run) ---

  override async ɵacquireThreadLock(params: {
    threadId: string;
    runId: string;
    userId: string;
    agentId: string;
    learningContainerId?: string;
    channelDeliveryId?: string;
    lockKeyPrefix?: string;
    ttlSeconds?: number;
  }) {
    const existing = this.locks.get(params.threadId);
    if (existing && existing.expiresAt > Date.now() && existing.runId !== params.runId)
      throw new LocalIntelligenceError(
        `Thread ${params.threadId} is locked by run ${existing.runId}`,
        409,
      );
    const ttlSeconds = params.ttlSeconds ?? 20;
    this.locks.set(params.threadId, {
      runId: params.runId,
      userId: params.userId,
      agentId: params.agentId,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    return {
      threadId: params.threadId,
      runId: params.runId,
      joinToken: this.mintJoinToken(params.threadId),
      lock: { key: `thread:${params.threadId}`, ttlSeconds },
    };
  }

  override async ɵrenewThreadLock(params: {
    threadId: string;
    runId: string;
    ttlSeconds: number;
    lockKeyPrefix?: string;
  }) {
    const existing = this.locks.get(params.threadId);
    if (existing && existing.runId === params.runId)
      existing.expiresAt = Date.now() + params.ttlSeconds * 1000;
    else
      this.locks.set(params.threadId, {
        runId: params.runId,
        expiresAt: Date.now() + params.ttlSeconds * 1000,
      });
    return { ttlSeconds: params.ttlSeconds };
  }

  override async ɵcleanupThreadLock(params: { threadId: string; runId: string }): Promise<void> {
    const existing = this.locks.get(params.threadId);
    if (existing?.runId === params.runId) this.locks.delete(params.threadId);
  }

  // --- Realtime credentials consumed by the local gateway ---

  private mintJoinToken(threadId: string): string {
    const token = randomUUID();
    const tokens = this.joinTokens.get(threadId) ?? new Set<string>();
    tokens.add(token);
    this.joinTokens.set(threadId, tokens);
    return token;
  }

  /** Called by the realtime gateway before accepting a client `thread:` join. */
  validateJoinToken(threadId: string, token: string | null): boolean {
    return token !== null && (this.joinTokens.get(threadId)?.has(token) ?? false);
  }

  /** Called by the realtime gateway to authenticate the server-side runner plane. */
  runnerAuthToken(): string {
    return LOCAL_RUNNER_TOKEN;
  }

  override async ɵconnectThread(params: { threadId: string; userId: string; agentId: string }) {
    const existing = await this.db.get<ThreadRecord>(params.userId, THREADS, params.threadId);
    if (!existing) return null;
    return { threadId: params.threadId, joinToken: this.mintJoinToken(params.threadId) };
  }

  override async ɵgetActiveJoinCode(params: { threadId: string; userId: string }) {
    return { threadId: params.threadId, joinToken: this.mintJoinToken(params.threadId) };
  }

  override async ɵsubscribeToThreads(_params: { userId: string }) {
    return { joinToken: "local" };
  }

  // --- Event log used by the realtime gateway ---

  /**
   * Rebuild a thread's record and index from the lock of the run writing to it.
   *
   * The runner plane carries no identity of its own, so it is never allowed to name an owner:
   * the only accepted source is the lock the runtime took for this exact run, whose `userId`
   * is the identity `createThread` was given. A stale lock, or one belonging to a different
   * run, proves nothing and leaves the thread missing.
   */
  private async adoptThreadFromRun(threadId: string, runId: string | undefined) {
    const lock = this.locks.get(threadId);
    if (
      !runId ||
      !lock ||
      lock.runId !== runId ||
      !lock.userId ||
      !lock.agentId ||
      lock.expiresAt <= Date.now()
    )
      return null;
    const now = new Date().toISOString();
    await this.db.insertIfAbsent(lock.userId, THREADS, {
      id: threadId,
      name: null,
      agentId: lock.agentId,
      archived: false,
      createdAt: now,
      updatedAt: now,
      createdById: lock.userId,
    } satisfies ThreadRecord);
    const index = { id: threadId, owner: lock.userId };
    await this.db.put(INDEX_OWNER, INDEX, index);
    return index;
  }

  /** Append one AG-UI event to a thread's durable log; returns the owner for broadcast bookkeeping. */
  async appendThreadEvent(
    threadId: string,
    event: Record<string, unknown>,
    runId?: string,
  ): Promise<{ owner: string; latestEventId?: string }> {
    return this.appendThreadEvents(threadId, [event], runId);
  }

  /**
   * Batch variant of appendThreadEvent: one read-modify-write of the event log
   * per call instead of per event. The runner's batch mode (advertised via the
   * runner_event_batch_v1 join capability) depends on this to keep ingestion
   * throughput ahead of streaming agents — per-event round trips cap the
   * gateway at a few events per second and long runs hit the runner's 60s
   * durability deadline.
   */
  async appendThreadEvents(
    threadId: string,
    events: Record<string, unknown>[],
    runId?: string,
  ): Promise<{ owner: string; latestEventId?: string }> {
    const index =
      (await this.db.get<{ owner: string }>(INDEX_OWNER, INDEX, threadId)) ??
      (await this.adoptThreadFromRun(threadId, runId));
    if (!index) throw new LocalIntelligenceError(`Thread ${threadId} not found`, 404);
    const log = (await this.db.get<ThreadEventLog>(index.owner, EVENTS, threadId)) ?? {
      id: threadId,
      events: [],
    };
    for (const event of events) log.events.push({ seq: log.events.length, event });
    await this.db.put(index.owner, EVENTS, log);
    const thread = await this.db.get<ThreadRecord>(index.owner, THREADS, threadId);
    if (thread) {
      for (const event of events) {
        if (event.type === "RUN_STARTED") thread.lastRunAt = new Date().toISOString();
        const metadata = event.metadata as { cpki_event_id?: unknown } | undefined;
        if (typeof metadata?.cpki_event_id === "string")
          thread.latestEventId = metadata.cpki_event_id;
      }
      await this.saveThread(index.owner, thread);
    }
    return { owner: index.owner, latestEventId: thread?.latestEventId };
  }

  async threadEvents(threadId: string): Promise<(Record<string, unknown> & { type: string })[]> {
    const index = await this.db.get<{ owner: string }>(INDEX_OWNER, INDEX, threadId);
    if (!index) return [];
    const log = await this.db.get<ThreadEventLog>(index.owner, EVENTS, threadId);
    return (log?.events ?? []).map(
      (entry) => entry.event as Record<string, unknown> & { type: string },
    );
  }

  // --- Platform endpoints without a local equivalent ---

  override ɵgetApiUrl(): string {
    return this.wsBase;
  }
  override ɵgetRunnerWsUrl(): string {
    return `${this.wsBase}/runner`;
  }
  override ɵgetClientWsUrl(): string {
    return `${this.wsBase}/client`;
  }
  override ɵgetChannelsWsUrl(): string {
    return `${this.wsBase}/channels`;
  }
  override ɵgetRunnerAuthToken(): string {
    return LOCAL_RUNNER_TOKEN;
  }
  override ɵgetApiKey(): string {
    return "local-intelligence";
  }

  override async getInspectorMetadata() {
    return undefined;
  }

  override async getRuntimeEntitlements() {
    // A ready, active self-hosted entitlement keeps `/info` from reporting the
    // runtime as unlicensed now that no managed backend is consulted.
    return {
      status: "ready" as const,
      entitlement: {
        active: true,
        source: "selfHostedDeploymentLicense" as const,
        features: {},
        limits: {},
      },
    };
  }

  override async annotate(_params: {
    userId: string;
    threadId: string;
    type: string;
    payload?: unknown;
    clientEventId?: string;
    occurredAt?: string;
  }) {
    return { id: String(++this.annotationCounter), duplicate: false };
  }

  override async ɵgetManagedChannelAsset(_assetId: string): Promise<{
    bytes: Uint8Array;
    mimeType?: string;
  }> {
    throw new LocalIntelligenceError("Managed channels are not supported locally", 501);
  }

  // Memory routes stay disabled (`runtime.memory` is unset and
  // `exposeMemoryRoutes` defaults to false), so these exist only to keep the
  // surface total; the cloud endpoints are never reachable here.
  override async listMemories(_params: {
    userId: string;
    memoryGrant?: { readonly user: string; readonly project: string };
    includeInvalidated?: boolean;
  }) {
    return { memories: [] };
  }
  override async recallMemories(_params: {
    userId: string;
    memoryGrant?: { readonly user: string; readonly project: string };
    query: string;
    limit?: number;
    scope?: string;
  }) {
    return { memories: [] };
  }
  override async createMemory(): Promise<never> {
    throw new LocalIntelligenceError("Intelligence Memory is not supported locally", 501);
  }
  override async updateMemory(): Promise<never> {
    throw new LocalIntelligenceError("Intelligence Memory is not supported locally", 501);
  }
  override async removeMemory(): Promise<void> {
    throw new LocalIntelligenceError("Intelligence Memory is not supported locally", 501);
  }
  override async ɵsubscribeToMemories(_params: {
    userId: string;
    memoryGrant?: { readonly user: string; readonly project: string };
  }) {
    return { joinToken: "local", joinCode: "" };
  }
}
