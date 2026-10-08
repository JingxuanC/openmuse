import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createStore, type Store } from "../apps/server/src/db.ts";
import {
  LocalIntelligence,
  LocalIntelligenceError,
} from "../apps/server/src/intelligence/local-intelligence.ts";
import { applyJsonPatch } from "../apps/server/src/intelligence/thread-events.ts";

let db: Store, intelligence: LocalIntelligence;
before(async () => {
  db = await createStore();
  intelligence = new LocalIntelligence(db, {
    wsBaseUrl: "ws://localhost:8787/api/intelligence/realtime",
  });
});
after(async () => {
  await db.close();
});

test("threads are created once, scoped by owner, and summarized", async () => {
  const { thread, created } = await intelligence.getOrCreateThread({
    threadId: "t-1",
    userId: "user-a",
    agentId: "default",
  });
  assert.equal(created, true);
  assert.equal(thread.name, null);
  const again = await intelligence.getOrCreateThread({
    threadId: "t-1",
    userId: "user-a",
    agentId: "default",
  });
  assert.equal(again.created, false);
  await assert.rejects(
    intelligence.createThread({ threadId: "t-1", userId: "user-a", agentId: "default" }),
    (error) => error instanceof LocalIntelligenceError && error.status === 409,
  );
  await assert.rejects(
    intelligence.getThread({ threadId: "t-1", userId: "user-b" }),
    (error) => error instanceof LocalIntelligenceError && error.status === 404,
  );
  const listeners: string[] = [];
  intelligence.onThreadCreated((created) => listeners.push(`created:${created.id}`));
  intelligence.onThreadUpdated((updated) => listeners.push(`updated:${updated.id}`));
  intelligence.onThreadDeleted((deleted) => listeners.push(`deleted:${deleted.threadId}`));
  await intelligence.createThread({ threadId: "t-2", userId: "user-a", agentId: "default" });
  await intelligence.updateThread({
    threadId: "t-2",
    userId: "user-a",
    agentId: "default",
    updates: { name: "Renamed" },
  });
  await intelligence.archiveThread({ threadId: "t-2", userId: "user-a", agentId: "default" });
  await intelligence.deleteThread({ threadId: "t-2", userId: "user-a", agentId: "default" });
  assert.deepEqual(listeners, ["created:t-2", "updated:t-2", "updated:t-2", "deleted:t-2"]);
});

test("listing filters archived threads and pages with an opaque cursor", async () => {
  for (let i = 0; i < 5; i += 1)
    await intelligence.createThread({
      threadId: `page-${i}`,
      userId: "user-b",
      agentId: "default",
    });
  await intelligence.archiveThread({ threadId: "page-4", userId: "user-b", agentId: "default" });
  const first = await intelligence.listThreads({ userId: "user-b", agentId: "default", limit: 2 });
  assert.equal(first.threads.length, 2);
  assert.ok(first.nextCursor);
  const rest = await intelligence.listThreads({
    userId: "user-b",
    agentId: "default",
    limit: 10,
    cursor: first.nextCursor as string,
  });
  assert.equal(rest.threads.length, 2);
  assert.equal(rest.nextCursor, null);
  const withArchived = await intelligence.listThreads({
    userId: "user-b",
    agentId: "default",
    includeArchived: true,
  });
  assert.equal(withArchived.threads.length, 5);
  const otherUser = await intelligence.listThreads({ userId: "user-c", agentId: "default" });
  assert.equal(otherUser.threads.length, 0);
});

test("deleting a thread also removes its event log", async () => {
  await intelligence.createThread({ threadId: "t-events", userId: "user-a", agentId: "default" });
  await intelligence.appendThreadEvent("t-events", {
    type: "RUN_STARTED",
    threadId: "t-events",
    runId: "r-1",
  });
  assert.equal((await intelligence.threadEvents("t-events")).length, 1);
  await intelligence.deleteThread({ threadId: "t-events", userId: "user-a", agentId: "default" });
  assert.equal((await intelligence.threadEvents("t-events")).length, 0);
  assert.equal(
    await intelligence.ɵconnectThread({
      threadId: "t-events",
      userId: "user-a",
      agentId: "default",
    }),
    null,
  );
});

test("run locks exclude other runs, renew, and release", async () => {
  const lock = await intelligence.ɵacquireThreadLock({
    threadId: "t-1",
    runId: "run-a",
    userId: "user-a",
    agentId: "default",
    ttlSeconds: 20,
  });
  assert.equal(lock.threadId, "t-1");
  assert.ok(lock.joinToken);
  assert.ok(intelligence.validateJoinToken("t-1", lock.joinToken));
  assert.ok(!intelligence.validateJoinToken("t-1", "forged-token"));
  await assert.rejects(
    intelligence.ɵacquireThreadLock({
      threadId: "t-1",
      runId: "run-b",
      userId: "user-a",
      agentId: "default",
    }),
    (error) => error instanceof LocalIntelligenceError && error.status === 409,
  );
  const renewed = await intelligence.ɵrenewThreadLock({
    threadId: "t-1",
    runId: "run-a",
    ttlSeconds: 20,
  });
  assert.equal(renewed.ttlSeconds, 20);
  await intelligence.ɵcleanupThreadLock({ threadId: "t-1", runId: "run-a" });
  const reacquired = await intelligence.ɵacquireThreadLock({
    threadId: "t-1",
    runId: "run-b",
    userId: "user-a",
    agentId: "default",
  });
  assert.equal(reacquired.runId, "run-b");
});

test("thread state folds snapshots and JSON-patch deltas", async () => {
  await intelligence.createThread({ threadId: "t-state", userId: "user-a", agentId: "default" });
  assert.deepEqual(await intelligence.getThreadState({ threadId: "t-state" }), {
    kind: "no-snapshot",
  });
  await intelligence.appendThreadEvent("t-state", {
    type: "STATE_SNAPSHOT",
    snapshot: { items: ["a"], count: 1 },
  });
  await intelligence.appendThreadEvent("t-state", {
    type: "STATE_DELTA",
    delta: [
      { op: "replace", path: "/count", value: 2 },
      { op: "add", path: "/items/-", value: "b" },
    ],
  });
  const state = await intelligence.getThreadState({ threadId: "t-state" });
  assert.deepEqual(state, {
    kind: "snapshot",
    state: { items: ["a", "b"], count: 2 },
    skippedDeltas: 0,
  });
});

test("JSON patch application handles nested paths and removals", () => {
  const state = { a: { b: [1, 2, 3] }, c: "x" };
  const patched = applyJsonPatch(state, [
    { op: "replace", path: "/a/b/1", value: 9 },
    { op: "remove", path: "/c" },
    { op: "add", path: "/a/d", value: true },
  ]);
  assert.deepEqual(patched, { a: { b: [1, 9, 3], d: true } });
});

test("platform diagnostics stay local and report a ready self-hosted entitlement", async () => {
  assert.equal(await intelligence.getInspectorMetadata(), undefined);
  const entitlements = await intelligence.getRuntimeEntitlements();
  assert.equal(entitlements.status, "ready");
  assert.equal(entitlements.entitlement.active, true);
  const annotation = await intelligence.annotate({
    userId: "user-a",
    threadId: "t-1",
    type: "user_action",
  });
  assert.equal(annotation.duplicate, false);
  assert.equal(
    intelligence.ɵgetRunnerWsUrl(),
    "ws://localhost:8787/api/intelligence/realtime/runner",
  );
  assert.equal(
    intelligence.ɵgetClientWsUrl(),
    "ws://localhost:8787/api/intelligence/realtime/client",
  );
});
