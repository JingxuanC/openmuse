import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import { createApp } from "../apps/server/src/app.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { LocalIntelligence } from "../apps/server/src/intelligence/local-intelligence.ts";
import { RealtimeGateway } from "../apps/server/src/intelligence/realtime-gateway.ts";

/**
 * End-to-end proof that chat runs without CopilotKit Intelligence: the runtime
 * streams AG-UI events through the local realtime gateway, the gateway persists
 * them, history reads fold them back, and a reconnecting client replays the
 * thread from the durable log.
 */

let db: Store, directory: string, token: string, baseUrl: string, gateway: RealtimeGateway;
let intelligence: LocalIntelligence;
let server: ReturnType<typeof serve>;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-local-realtime-"));
  db = await createStore();
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const created = (await createApp(db, {
    mode: "sample",
    authMode: "local",
    port,
    host: "127.0.0.1",
    publicUrl: baseUrl,
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: `${baseUrl}/api/google/callback`,
    allowedOrigins: ["http://localhost:8081"],
  })) as Awaited<ReturnType<typeof createApp>> & { intelligence: LocalIntelligence };
  intelligence = created.intelligence;
  server = serve({ fetch: created.app.fetch, port, hostname: "127.0.0.1" });
  gateway = new RealtimeGateway(intelligence);
  gateway.attach(server);
  const session = await fetch(`${baseUrl}/api/session`, { method: "POST", body: "{}" });
  token = (await session.json()).token;
});

after(async () => {
  gateway.close();
  server.close();
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

type PhoenixMessage = [string | null, string | null, string, string, unknown];

/** Minimal Phoenix v2 client: joins one topic and collects channel events. */
class PhoenixProbe {
  private readonly socket: WebSocket;
  readonly received: { event: string; payload: unknown }[] = [];
  readonly joined: Promise<unknown>;

  constructor(url: string, topic: string, params: Record<string, unknown>) {
    this.socket = new WebSocket(url);
    let resolveJoin: (value: unknown) => void, rejectJoin: (value: unknown) => void;
    this.joined = new Promise((resolve, reject) => {
      resolveJoin = resolve;
      rejectJoin = reject;
    });
    this.joined.catch(() => {});
    this.socket.on("open", () => {
      this.send(["1", "1", topic, "phx_join", params]);
    });
    this.socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as PhoenixMessage;
      const [, , , event, payload] = message;
      if (event === "phx_reply") {
        const response = payload as { status: string; response: unknown };
        if (response.status === "ok") resolveJoin(response.response);
        else rejectJoin(response.response);
        return;
      }
      this.received.push({ event, payload });
    });
    this.socket.on("error", (error) => rejectJoin(error));
  }

  private send(message: PhoenixMessage) {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for realtime events");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  close() {
    this.socket.close();
  }
}

/**
 * The runner plane the runtime's `IntelligenceAgentRunner` speaks: a bearer subprotocol and
 * raw `event`/`events` pushes whose replies are the run's durability barrier.
 */
class RunnerProbe {
  private readonly socket: WebSocket;
  private ref = 1;
  readonly replies: { status: string; response: Record<string, unknown> }[] = [];
  readonly joined: Promise<void>;

  constructor(topic: string) {
    const token = Buffer.from(intelligence.runnerAuthToken()).toString("base64url");
    this.socket = new WebSocket(`${intelligence.ɵgetRunnerWsUrl()}/websocket`, [
      "phoenix",
      `base64url.bearer.phx.${token}`,
    ]);
    let resolveJoin: () => void, rejectJoin: (value: unknown) => void;
    this.joined = new Promise((resolve, reject) => {
      resolveJoin = resolve;
      rejectJoin = reject;
    });
    this.joined.catch(() => {});
    this.socket.on("open", () =>
      this.send(["1", String(this.ref++), topic, "phx_join", { thread_id: null, run_id: null }]),
    );
    this.socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as PhoenixMessage;
      if (message[3] !== "phx_reply") return;
      const { status, response } = message[4] as {
        status: string;
        response: Record<string, unknown>;
      };
      this.replies.push({ status, response });
      resolveJoin();
    });
    this.socket.on("error", (error) => rejectJoin(error));
  }

  private send(message: PhoenixMessage) {
    this.socket.send(JSON.stringify(message));
  }

  push(topic: string, event: string, payload: unknown) {
    this.send(["1", String(this.ref++), topic, event, payload]);
  }

  /** A push whose reply never arrives is the production symptom; prove it did or did not. */
  async replied(count: number, timeoutMs = 750) {
    const deadline = Date.now() + timeoutMs;
    while (this.replies.length < count && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    return this.replies[count - 1];
  }

  close() {
    this.socket.close();
  }
}

async function pollUntil(assertion: () => Promise<void>, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

test("a chat run streams through the local gateway, persists, and replays on reconnect", async () => {
  const threadId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const run = await fetch(`${baseUrl}/api/copilotkit/agent/default/run`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      threadId,
      runId,
      state: {},
      messages: [{ id: "user-1", role: "user", content: "hello" }],
      tools: [],
      context: [],
      forwardedProps: {},
    }),
  });
  assert.equal(run.status, 200, await run.clone().text());
  const credentials = await run.json();
  assert.equal(credentials.threadId, threadId);
  assert.ok(credentials.joinToken);
  assert.equal(credentials.realtime.topic, `thread:${threadId}`);

  // Live stream: the client sees the run's events over the realtime socket.
  const live = new PhoenixProbe(
    `${credentials.realtime.clientUrl}/websocket?vsn=2.0.0&join_token=${credentials.joinToken}`,
    credentials.realtime.topic,
    { stream_mode: "run", run_id: runId },
  );
  await live.joined;
  await live.waitFor(() =>
    live.received.some(
      ({ event, payload }) =>
        event === "ag_ui_event" && (payload as { type?: string }).type === "RUN_FINISHED",
    ),
  );
  const liveTypes = live.received
    .filter(({ event }) => event === "ag_ui_event")
    .map(({ payload }) => (payload as { type: string }).type);
  assert.ok(liveTypes.includes("RUN_STARTED"));
  assert.ok(liveTypes.includes("TEXT_MESSAGE_CONTENT"));
  assert.ok(liveTypes.includes("RUN_FINISHED"));
  live.close();

  // History is durable: messages folded from the persisted event log.
  await pollUntil(async () => {
    const history = await fetch(`${baseUrl}/api/copilotkit/threads/${threadId}/messages`, {
      headers: headers(),
    });
    assert.equal(history.status, 200);
    const { messages } = await history.json();
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[0], { id: "user-1", role: "user", content: "hello" });
    assert.equal(messages[1].role, "assistant");
    assert.ok(String(messages[1].content).length > 0);
  });

  // Reconnect replay: a fresh client with no cursor receives the full log plus
  // the replay_complete/stream_idle control events the RN client waits for.
  const reconnect = await fetch(`${baseUrl}/api/copilotkit/agent/default/connect`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      threadId,
      runId: crypto.randomUUID(),
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {},
    }),
  });
  assert.equal(reconnect.status, 200);
  const reconnectCredentials = await reconnect.json();
  const replay = new PhoenixProbe(
    `${reconnectCredentials.realtime.clientUrl}/websocket?vsn=2.0.0&join_token=${reconnectCredentials.joinToken}`,
    reconnectCredentials.realtime.topic,
    { stream_mode: "connect" },
  );
  await replay.joined;
  await replay.waitFor(
    () =>
      replay.received.some(({ event }) => event === "replay_complete") &&
      replay.received.some(({ event }) => event === "stream_idle"),
  );
  const replayedTypes = replay.received
    .filter(({ event }) => event === "ag_ui_event")
    .map(({ payload }) => (payload as { type: string }).type);
  assert.ok(replayedTypes.includes("RUN_STARTED"));
  assert.ok(replayedTypes.includes("RUN_FINISHED"));
  replay.close();

  // A forged join token is rejected.
  const forged = new PhoenixProbe(
    `${credentials.realtime.clientUrl}/websocket?vsn=2.0.0&join_token=forged`,
    credentials.realtime.topic,
    { stream_mode: "connect" },
  );
  await assert.rejects(forged.joined);
  forged.close();

  // The thread landed in the local store, named by the run, not by a cloud service.
  const thread = await intelligence.getThread({ threadId, userId: "local-user" });
  assert.equal(thread.agentId, "default");
  assert.ok(thread.lastRunAt);
});

test("an event for a thread no run owns is rejected, not left unanswered", async () => {
  const threadId = crypto.randomUUID();
  const topic = `ingestion:${crypto.randomUUID()}`;
  const runner = new RunnerProbe(topic);
  await runner.joined;

  runner.push(topic, "event", { type: "RUN_STARTED", threadId, runId: topic.slice(10) });

  // Silence here is what makes the runtime retry into its 60s durability deadline.
  const reply = await runner.replied(2);
  assert.ok(reply, "the gateway never answered the push");
  assert.equal(reply.status, "error");
  // Permanent, so the runner fails the run immediately instead of retrying a 404.
  assert.equal(reply.response.retryable, false);
  assert.match(String(reply.response.reason), /not found/);
  assert.deepEqual(await intelligence.threadEvents(threadId), []);
  runner.close();
});

test("a run's events rebuild a missing thread record, owned by the run's authenticated user", async () => {
  const threadId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const topic = `ingestion:${runId}`;
  // The runtime takes this lock — with the identity it verified — before the runner starts.
  const lock = await intelligence.ɵacquireThreadLock({
    threadId,
    runId,
    userId: "local-user",
    agentId: "default",
  });
  const subscriber = new PhoenixProbe(
    `${intelligence.ɵgetClientWsUrl()}/websocket?vsn=2.0.0&join_token=${lock.joinToken}`,
    `thread:${threadId}`,
    { stream_mode: "connect" },
  );
  await subscriber.joined;

  const runner = new RunnerProbe(topic);
  await runner.joined;
  runner.push(topic, "event", {
    type: "RUN_STARTED",
    threadId,
    runId,
    metadata: { cpki_event_id: "e-1" },
  });

  const reply = await runner.replied(2);
  assert.ok(reply, "the gateway never answered the push");
  assert.equal(reply.status, "ok");
  assert.equal((await intelligence.threadEvents(threadId)).length, 1);
  await subscriber.waitFor(() =>
    subscriber.received.some(
      ({ event, payload }) =>
        event === "ag_ui_event" && (payload as { type?: string }).type === "RUN_STARTED",
    ),
  );
  // The owner came from the lock, not from the runner socket: nobody else can claim the thread.
  const thread = await intelligence.getThread({ threadId, userId: "local-user" });
  assert.equal(thread.agentId, "default");
  await assert.rejects(intelligence.getThread({ threadId, userId: "someone-else" }));
  subscriber.close();
  runner.close();
});

test("a run cannot resurrect a thread another run holds", async () => {
  const threadId = crypto.randomUUID();
  const heldRunId = crypto.randomUUID();
  const topic = `ingestion:${crypto.randomUUID()}`;
  await intelligence.ɵacquireThreadLock({
    threadId,
    runId: heldRunId,
    userId: "local-user",
    agentId: "default",
  });

  const runner = new RunnerProbe(topic);
  await runner.joined;
  runner.push(topic, "event", { type: "RUN_STARTED", threadId, runId: topic.slice(10) });

  const reply = await runner.replied(2);
  assert.ok(reply, "the gateway never answered the push");
  assert.equal(reply.status, "error");
  assert.equal(reply.response.retryable, false);
  assert.deepEqual(await intelligence.threadEvents(threadId), []);
  await assert.rejects(intelligence.getThread({ threadId, userId: "local-user" }));
  runner.close();
});

test("a batched runner push persists in one round trip and streams in order", async () => {
  const threadId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const topic = `ingestion:${runId}`;
  const lock = await intelligence.ɵacquireThreadLock({
    threadId,
    runId,
    userId: "local-user",
    agentId: "default",
  });
  const subscriber = new PhoenixProbe(
    `${intelligence.ɵgetClientWsUrl()}/websocket?vsn=2.0.0&join_token=${lock.joinToken}`,
    `thread:${threadId}`,
    { stream_mode: "connect" },
  );
  await subscriber.joined;

  const runner = new RunnerProbe(topic);
  await runner.joined;
  // The join advertises batching so the runtime switches from `event` to `events` pushes.
  assert.ok(
    (runner.replies[0].response.capabilities as string[]).includes("runner_event_batch_v1"),
  );

  const events = [
    { type: "RUN_STARTED", threadId, runId, metadata: { cpki_event_id: "b-1" } },
    {
      type: "TEXT_MESSAGE_START",
      threadId,
      runId,
      messageId: "m-1",
      metadata: { cpki_event_id: "b-2" },
    },
    ...Array.from({ length: 30 }, (_, i) => ({
      type: "TEXT_MESSAGE_CONTENT",
      threadId,
      runId,
      messageId: "m-1",
      delta: `chunk-${i}`,
      metadata: { cpki_event_id: `b-${i + 3}` },
    })),
    {
      type: "TEXT_MESSAGE_END",
      threadId,
      runId,
      messageId: "m-1",
      metadata: { cpki_event_id: "b-33" },
    },
    { type: "RUN_FINISHED", threadId, runId, metadata: { cpki_event_id: "b-34" } },
  ];
  runner.push(topic, "events", { events });

  const reply = await runner.replied(2);
  assert.ok(reply, "the gateway never answered the batch push");
  assert.equal(reply.status, "ok");

  // One round trip persisted the whole batch, in order.
  const persisted = await intelligence.threadEvents(threadId);
  assert.equal(persisted.length, events.length);
  assert.equal(persisted[0].type, "RUN_STARTED");
  assert.equal(persisted[persisted.length - 1].type, "RUN_FINISHED");
  const thread = await intelligence.getThread({ threadId, userId: "local-user" });
  assert.ok(thread.lastRunAt);

  // Subscribers still see every event, in order.
  await subscriber.waitFor(() =>
    subscriber.received.some(
      ({ event, payload }) =>
        event === "ag_ui_event" && (payload as { type?: string }).type === "RUN_FINISHED",
    ),
  );
  const streamed = subscriber.received
    .filter(({ event }) => event === "ag_ui_event")
    .map(({ payload }) => (payload as { type: string }).type);
  assert.deepEqual(
    streamed,
    events.map((event) => event.type),
  );

  subscriber.close();
  runner.close();
});

test("a historical RUN_ERROR is not replayed to a reconnecting client", async () => {
  const threadId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const lock = await intelligence.ɵacquireThreadLock({
    threadId,
    runId,
    userId: "local-user",
    agentId: "default",
  });
  await intelligence.appendThreadEvents(
    threadId,
    [
      { type: "RUN_STARTED", threadId, runId },
      { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "partial" },
      { type: "TEXT_MESSAGE_END", messageId: "m1" },
      { type: "RUN_ERROR", message: "400 No tool output found for tool call call_x" },
    ],
    runId,
  );

  const probe = new PhoenixProbe(
    `${intelligence.ɵgetClientWsUrl()}/websocket?vsn=2.0.0&join_token=${lock.joinToken}`,
    `thread:${threadId}`,
    { stream_mode: "connect" },
  );
  await probe.joined;
  await probe.waitFor(() => probe.received.some(({ event }) => event === "replay_complete"));
  const replayedTypes = probe.received
    .filter(({ event }) => event === "ag_ui_event")
    .map(({ payload }) => (payload as { type: string }).type);
  assert.ok(replayedTypes.includes("RUN_STARTED"));
  assert.ok(replayedTypes.includes("TEXT_MESSAGE_CONTENT"));
  assert.ok(!replayedTypes.includes("RUN_ERROR"), "stale errors must not break the connect");
  probe.close();
});
