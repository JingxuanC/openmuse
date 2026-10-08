import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { LocalIntelligence } from "../apps/server/src/intelligence/local-intelligence.ts";

let db: Store, directory: string, token: string, intelligence: LocalIntelligence;
let app: Awaited<ReturnType<typeof createApp>>["app"];
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-rich-threads-"));
  db = await createStore();
  ({ app, intelligence } = (await createApp(db, {
    mode: "sample",
    authMode: "local",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  })) as Awaited<ReturnType<typeof createApp>> & { intelligence: LocalIntelligence });
  const session = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  token = (await session.json()).token;
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("main chat is provisioned for the authenticated owner before the first run", async () => {
  const first = await (await app.request("/api/main-thread", { headers: headers() })).json();
  const reopened = await (await app.request("/api/main-thread", { headers: headers() })).json();
  assert.equal(first.existing, true);
  assert.equal(reopened.threadId, first.threadId);
  const thread = await intelligence.getThread({ threadId: first.threadId, userId: "local-user" });
  assert.equal(thread.agentId, "default");
  assert.equal(thread.createdById, "local-user");
});

test("a failed main-thread connection remains an error and does not create another id", async (t) => {
  const before = await db.get("local-user", "conversation-settings", "main");
  t.mock.method(LocalIntelligence.prototype, "getOrCreateThread", async () => {
    throw new Error("Platform unavailable");
  });
  assert.equal((await app.request("/api/main-thread", { headers: headers() })).status, 502);
  assert.deepEqual(await db.get("local-user", "conversation-settings", "main"), before);
});

test("Rich Threads lists through the local store, scopes by authenticated owner and paginates", async () => {
  await intelligence.createThread({
    threadId: "thread-1",
    userId: "local-user",
    agentId: "default",
    name: "Trip planning",
  });
  await intelligence.createThread({
    threadId: "thread-2",
    userId: "local-user",
    agentId: "default",
  });
  await intelligence.createThread({
    threadId: "thread-other-agent",
    userId: "local-user",
    agentId: "other",
  });
  assert.equal((await app.request("/api/copilotkit/threads?agentId=default")).status, 401);
  const firstPage = await app.request(
    "/api/copilotkit/threads?agentId=default&userId=forged&limit=1",
    { headers: headers() },
  );
  assert.equal(firstPage.status, 200, await firstPage.clone().text());
  const page1 = await firstPage.json();
  assert.equal(page1.threads.length, 1);
  assert.ok(page1.nextCursor);
  const secondPage = await app.request(
    `/api/copilotkit/threads?agentId=default&limit=1&cursor=${page1.nextCursor}`,
    { headers: headers() },
  );
  const page2 = await secondPage.json();
  assert.equal(page2.threads.length, 1);
  assert.notEqual(page2.threads[0].id, page1.threads[0].id);
  const everything = await (
    await app.request("/api/copilotkit/threads?agentId=default&limit=20", { headers: headers() })
  ).json();
  const ids = everything.threads.map((thread: { id: string }) => thread.id);
  assert.ok(ids.includes("thread-1") && ids.includes("thread-2"));
  assert.ok(!ids.includes("thread-other-agent"));
  assert.equal(everything.nextCursor, null);
});

test("archived threads are hidden by default and visible on request", async () => {
  await intelligence.archiveThread({
    threadId: "thread-2",
    userId: "local-user",
    agentId: "default",
  });
  const visible = await (
    await app.request("/api/copilotkit/threads?agentId=default&limit=50", { headers: headers() })
  ).json();
  assert.ok(!visible.threads.some((thread: { id: string }) => thread.id === "thread-2"));
  const withArchived = await (
    await app.request("/api/copilotkit/threads?agentId=default&includeArchived=true&limit=50", {
      headers: headers(),
    })
  ).json();
  const archived = withArchived.threads.find((thread: { id: string }) => thread.id === "thread-2");
  assert.equal(archived.archived, true);
});

test("native and web thread rename persists without accepting a forged owner", async () => {
  const preflight = await app.request("/api/copilotkit/threads/thread-1", {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:8081",
      "Access-Control-Request-Method": "PATCH",
      "Access-Control-Request-Headers": "authorization,content-type",
    },
  });
  assert.match(preflight.headers.get("Access-Control-Allow-Methods") || "", /PATCH/);
  const response = await app.request("/api/copilotkit/threads/thread-1", {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ agentId: "default", userId: "forged", name: "Weekend plans" }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const renamed = await intelligence.getThread({ threadId: "thread-1", userId: "local-user" });
  assert.equal(renamed.name, "Weekend plans");
});

test("archive is authenticated and routed to the local store", async () => {
  const response = await app.request("/api/copilotkit/threads/thread-1/archive", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ agentId: "default" }),
  });
  assert.equal(response.status, 200);
  const thread = await intelligence.getThread({ threadId: "thread-1", userId: "local-user" });
  assert.equal(thread.archived, true);
});

test("history folds persisted run events into rich tool messages and failures remain errors", async (t) => {
  const runId = "run-1";
  const events: Record<string, unknown>[] = [
    {
      type: "RUN_STARTED",
      threadId: "thread-1",
      runId,
      input: {
        threadId: "thread-1",
        runId,
        messages: [{ id: "user-1", role: "user", content: "Fill this form" }],
      },
    },
    { type: "TEXT_MESSAGE_START", messageId: "assistant-1", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "assistant-1", delta: "Working on " },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "assistant-1", delta: "the form" },
    { type: "TEXT_MESSAGE_END", messageId: "assistant-1" },
    {
      type: "TOOL_CALL_START",
      toolCallId: "call-1",
      toolCallName: "delegate_task",
      parentMessageId: "assistant-1",
    },
    { type: "TOOL_CALL_ARGS", toolCallId: "call-1", delta: "{}" },
    { type: "TOOL_CALL_END", toolCallId: "call-1" },
    {
      type: "TOOL_CALL_RESULT",
      toolCallId: "call-1",
      messageId: "tool-1",
      content: '{"taskId":"task-1"}',
    },
    { type: "RUN_FINISHED", threadId: "thread-1", runId },
  ];
  for (const event of events) await intelligence.appendThreadEvent("thread-1", event);
  const history = await app.request("/api/copilotkit/threads/thread-1/messages?userId=forged", {
    headers: headers(),
  });
  assert.equal(history.status, 200);
  assert.deepEqual((await history.json()).messages, [
    { id: "user-1", role: "user", content: "Fill this form" },
    {
      id: "assistant-1",
      role: "assistant",
      content: "Working on the form",
      toolCalls: [{ id: "call-1", name: "delegate_task", args: "{}" }],
    },
    { id: "tool-1", role: "tool", toolCallId: "call-1", content: '{"taskId":"task-1"}' },
  ]);
  const stored = await app.request("/api/copilotkit/threads/thread-1/events", {
    headers: headers(),
  });
  assert.equal(stored.status, 200);
  assert.equal((await stored.json()).events.length, events.length);
  t.mock.method(LocalIntelligence.prototype, "listThreads", async () => {
    throw new Error("Store unavailable");
  });
  assert.equal(
    (await app.request("/api/copilotkit/threads?agentId=default", { headers: headers() })).status,
    500,
  );
});

test("workspace reports Rich Threads configuration", async () => {
  const response = await app.request("/api/workspace", { headers: headers() });
  assert.equal(JSON.parse(await response.text()).runtime.richThreads, true);
});
