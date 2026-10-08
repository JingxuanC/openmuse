import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { HttpAgentFetchFn } from "@ag-ui/client";
import { EventSchemas, EventType, type RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import {
  type Config,
  parseVerticalAgents,
  readConfig,
  type VerticalAgentSpec,
} from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { runVerticalAgent, verticalAgentTool } from "../apps/server/src/engine/vertical-agent.ts";
import { VerticalRichEvents } from "../apps/server/src/engine/vertical-events.ts";
import {
  delegateProgressEvent,
  type VerticalProgress,
} from "../apps/server/src/engine/vertical-progress.ts";
import { modelFixture } from "./helpers/model.ts";

/**
 * The delegate half of hybrid mode: a vertical agent is reached as a tool, over
 * the wire `agui.ts` already speaks, under the caller's own token. The frames
 * below are the ones `agui.test.ts` builds from `gateway/agui/events.py`,
 * including the bare-string RUN_FINISHED outcome that has to be adapted.
 */

const financeAgent: VerticalAgentSpec = {
  name: "finance_agent",
  description: "live market quotes, financial statements and filings",
  url: "http://127.0.0.1:8000/api/v1/agui/run",
};

const TURN = [
  { type: "RUN_STARTED", threadId: "t-1", runId: "r-1" },
  { type: "THINKING_START" },
  { type: "THINKING_TEXT_MESSAGE_START" },
  { type: "THINKING_TEXT_MESSAGE_CONTENT", delta: "weighing sources" },
  { type: "THINKING_TEXT_MESSAGE_END" },
  { type: "THINKING_END" },
  { type: "TEXT_MESSAGE_START", messageId: "r-1:1", role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "r-1:1", delta: "AAPL " },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "r-1:1", delta: "is up" },
  { type: "TEXT_MESSAGE_END", messageId: "r-1:1" },
  { type: "TOOL_CALL_START", toolCallId: "c-1", toolCallName: "quote" },
  { type: "TOOL_CALL_ARGS", toolCallId: "c-1", delta: "{}" },
  { type: "TOOL_CALL_END", toolCallId: "c-1" },
  { type: "RUN_FINISHED", threadId: "t-1", runId: "r-1", outcome: "success" },
];

/** `events.encode`. */
const encode = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`;
const turn = TURN.map(encode).join("");

function streamed(body: string, close: boolean): Response {
  const bytes = new TextEncoder().encode(body);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        // Never closing leaves the run open, so only an abort can settle it.
        if (close) controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** A delegate endpoint that records what it was asked and replays one body. */
function delegate(response = () => streamed(turn, true)) {
  const requests: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fetch: HttpAgentFetchFn = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return response();
  };
  return { requests, fetch };
}

function runOptions(fetch: HttpAgentFetchFn, overrides: Record<string, unknown> = {}) {
  return {
    task: "how is AAPL doing",
    threadId: "thread-1",
    token: "caller-jwt",
    signal: new AbortController().signal,
    fetch,
    ...overrides,
  };
}

const message = (body: Record<string, unknown>) =>
  (body.messages as { id: string; role: string; content: string }[])[0];

test("VERTICAL_AGENTS accepts a well-formed array and defaults to none", () => {
  assert.deepEqual(parseVerticalAgents(undefined), []);
  assert.deepEqual(parseVerticalAgents("  "), []);
  assert.deepEqual(parseVerticalAgents("[]"), []);
  assert.deepEqual(parseVerticalAgents(JSON.stringify([financeAgent])), [financeAgent]);
  assert.deepEqual(
    parseVerticalAgents(JSON.stringify([{ ...financeAgent, timeoutMs: 1000, maxResultChars: 10 }])),
    [{ ...financeAgent, timeoutMs: 1000, maxResultChars: 10 }],
  );
  // The description is the routing surface, so surrounding space is not part of it.
  assert.equal(
    parseVerticalAgents(JSON.stringify([{ ...financeAgent, description: " quotes " }]))[0]
      .description,
    "quotes",
  );
});

test("VERTICAL_AGENTS refuses anything that would silently become the wrong tool", () => {
  const rejects = (value: string, pattern: RegExp) =>
    assert.throws(
      () => parseVerticalAgents(value),
      (error: Error) => pattern.test(error.message),
      value,
    );
  rejects("{not json", /VERTICAL_AGENTS must be a JSON array/);
  rejects('{"name":"finance_agent"}', /must be a JSON array/);
  rejects(JSON.stringify([{ ...financeAgent, name: "Finance" }]), /name must match/);
  rejects(JSON.stringify([{ ...financeAgent, name: "1finance" }]), /name must match/);
  rejects(JSON.stringify([{ ...financeAgent, name: "delegate_task" }]), /reserved by a built-in/);
  rejects(JSON.stringify([financeAgent, financeAgent]), /already in use/);
  rejects(JSON.stringify([{ ...financeAgent, description: " " }]), /nonblank description/);
  rejects(JSON.stringify([{ ...financeAgent, url: "127.0.0.1:8000/run" }]), /http\(s\) url/);
  rejects(JSON.stringify([financeAgent, { ...financeAgent, url: "mailto:x@y.z" }]), /already/);
  rejects(JSON.stringify([{ ...financeAgent, timeoutMs: 0 }]), /timeoutMs must be a positive/);
  rejects(JSON.stringify([{ ...financeAgent, maxResultChars: 1.5 }]), /must be a positive/);
  rejects(JSON.stringify(["finance_agent"]), /must be an object/);
});

test("hybrid mode reads the delegates from the environment", async () => {
  const old = {
    AGENT_BACKEND: process.env.AGENT_BACKEND,
    VERTICAL_AGENTS: process.env.VERTICAL_AGENTS,
  };
  try {
    process.env.AGENT_BACKEND = "hybrid";
    delete process.env.VERTICAL_AGENTS;
    assert.equal(readConfig().agentBackend, "hybrid");
    assert.deepEqual(readConfig().verticalAgents, []);
    process.env.VERTICAL_AGENTS = JSON.stringify([financeAgent]);
    assert.deepEqual(readConfig().verticalAgents, [financeAgent]);
    process.env.AGENT_BACKEND = "hybrid-ish";
    assert.throws(() => readConfig(), /AGENT_BACKEND/);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a delegate turn is aggregated into a report", async () => {
  const fixture = delegate();
  const result = await runVerticalAgent(financeAgent, runOptions(fixture.fetch));

  // The report also proves the RUN_FINISHED adaptation ran: unadapted, the
  // bare-string outcome fails EventSchemas.parse and the run errors instead.
  assert.deepEqual(result, {
    report: "AAPL is up",
    truncated: false,
    toolCalls: 1,
    thinkingEvents: 1,
  });
  const request = fixture.requests[0];
  assert.equal(request.url, financeAgent.url);
  assert.equal((request.init.headers as Record<string, string>).Authorization, "Bearer caller-jwt");
  assert.equal(request.body.threadId, "thread-1");
  assert.deepEqual(request.body.tools, []);
  assert.deepEqual(request.body.context, []);
  assert.equal(message(request.body).role, "user");
  assert.equal(message(request.body).content, "how is AAPL doing");
});

test("context rides along after the task and a long report is truncated", async () => {
  const fixture = delegate();
  const result = await runVerticalAgent(
    { ...financeAgent, maxResultChars: 5 },
    runOptions(fixture.fetch, { context: "the owner holds 10 shares" }),
  );

  assert.deepEqual(result, { report: "AAPL ", truncated: true, toolCalls: 1, thinkingEvents: 1 });
  assert.equal(
    message(fixture.requests[0].body).content,
    "how is AAPL doing\n\n上下文：\nthe owner holds 10 shares",
  );
});

/** One `langalpha.*` custom frame, the shape `translate.Translator` forwards. */
const custom = (name: string, value: unknown) => ({ type: "CUSTOM", name, value });

test("a delegate's artifacts, sources and sub-agent text come back structured", async () => {
  const fixture = delegate(() =>
    streamed(
      [
        encode({ type: "RUN_STARTED", threadId: "t-1", runId: "r-1" }),
        encode({ type: "TEXT_MESSAGE_START", messageId: "r-1:1", role: "assistant" }),
        encode({ type: "TEXT_MESSAGE_CONTENT", messageId: "r-1:1", delta: "AAPL is up" }),
        encode({ type: "TEXT_MESSAGE_END", messageId: "r-1:1" }),
        encode(
          custom("langalpha.artifact", {
            artifact_type: "file_operation",
            artifact_id: "c-1",
            agent: "ptc",
            status: "completed",
            payload: { operation: "Write", file_path: "reports/aapl.md" },
          }),
        ),
        encode(
          custom("langalpha.artifact", {
            artifact_type: "chart_annotation",
            artifact_id: "c-2",
            payload: { title: "AAPL vs peers" },
          }),
        ),
        encode(
          custom("langalpha.provenance", {
            record_id: "p-1",
            source_type: "web",
            identifier: "https://example.com/aapl",
            title: "AAPL quote",
            agent: "main",
          }),
        ),
        encode(custom("langalpha.agent_text", { agent: "task:1", content: "pulled the filing" })),
        // Bookkeeping the app has no use for, and unreadable values: neither
        // may reach the result nor fail the run.
        encode(custom("langalpha.credit_usage", { credits: 3 })),
        encode(custom("langalpha.artifact", "not a frame")),
        encode(custom("langalpha.artifact", null)),
        encode(custom("langalpha.provenance", { detail: "   " })),
        encode(custom("langalpha.agent_text", { agent: "task:2" })),
        encode({ type: "TOOL_CALL_START", toolCallId: "c-3", toolCallName: "quote" }),
        encode({ type: "RUN_FINISHED", threadId: "t-1", runId: "r-1", outcome: "success" }),
      ].join(""),
      true,
    ),
  );
  const result = await runVerticalAgent(financeAgent, runOptions(fixture.fetch));

  assert.deepEqual(result, {
    report: "AAPL is up",
    truncated: false,
    toolCalls: 1,
    thinkingEvents: 0,
    artifacts: [
      {
        type: "file_operation",
        title: "reports/aapl.md",
        id: "c-1",
        status: "completed",
        path: "reports/aapl.md",
      },
      { type: "chart_annotation", title: "AAPL vs peers", id: "c-2" },
    ],
    sources: [{ title: "AAPL quote", url: "https://example.com/aapl" }],
    subagentNotes: [{ agent: "task:1", excerpt: "pulled the filing" }],
  });
});

test("a delegate that sends nothing rich leaves the result exactly as it was", async () => {
  const fixture = delegate(() =>
    streamed(
      [
        encode({ type: "RUN_STARTED", threadId: "t-1", runId: "r-1" }),
        encode({ type: "TEXT_MESSAGE_CONTENT", messageId: "r-1:1", delta: "AAPL is up" }),
        encode(custom("langalpha.artifact", [])),
        encode(custom("langalpha.provenance", { identifier: "not-a-url", title: "  " })),
        encode({ type: "RUN_FINISHED", threadId: "t-1", runId: "r-1", outcome: "success" }),
      ].join(""),
      true,
    ),
  );
  assert.deepEqual(await runVerticalAgent(financeAgent, runOptions(fixture.fetch)), {
    report: "AAPL is up",
    truncated: false,
    toolCalls: 0,
    thinkingEvents: 0,
  });
});

test("a delegate's steps are reported while it is still running", async () => {
  const fixture = delegate(() =>
    streamed(
      [
        encode({ type: "RUN_STARTED", threadId: "t-1", runId: "r-1" }),
        encode({ type: "THINKING_START" }),
        encode({ type: "TOOL_CALL_START", toolCallId: "c-1", toolCallName: "quote" }),
        encode({ type: "TOOL_CALL_ARGS", toolCallId: "c-1", delta: "{}" }),
        encode({ type: "TOOL_CALL_END", toolCallId: "c-1" }),
        encode(custom("langalpha.agent_text", { agent: "task:1", content: "pulled the filing" })),
        encode(
          custom("langalpha.artifact", {
            artifact_type: "file_operation",
            payload: { file_path: "reports/aapl.md" },
          }),
        ),
        encode({ type: "TEXT_MESSAGE_CONTENT", messageId: "r-1:1", delta: "AAPL is up" }),
        encode({ type: "RUN_FINISHED", threadId: "t-1", runId: "r-1", outcome: "success" }),
      ].join(""),
      true,
    ),
  );
  const progress: VerticalProgress[] = [];
  const result = await runVerticalAgent(financeAgent, {
    ...runOptions(fixture.fetch),
    onProgress: (item: VerticalProgress) => progress.push(item),
  });

  assert.deepEqual(progress, [
    { kind: "thinking", text: "思考中…" },
    { kind: "tool", text: "调用工具 quote" },
    { kind: "note", text: "task:1: pulled the filing" },
    { kind: "artifact", text: "产出 reports/aapl.md" },
  ]);
  // Progress is a side channel: it adds nothing to what the model reads — the
  // rich artifacts and notes below come from the run's CUSTOM frames as before.
  assert.deepEqual(result, {
    report: "AAPL is up",
    truncated: false,
    toolCalls: 1,
    thinkingEvents: 1,
    artifacts: [{ type: "file_operation", title: "reports/aapl.md", path: "reports/aapl.md" }],
    subagentNotes: [{ agent: "task:1", excerpt: "pulled the filing" }],
  });
});

test("a delegate that stops to ask something reports the question as it happens", async () => {
  const fixture = delegate(() =>
    streamed(
      [
        encode({ type: "RUN_STARTED", threadId: "t-1", runId: "r-1" }),
        encode(
          custom("langalpha.interrupt", {
            thread_id: "la-th-1",
            interrupt_id: "int-1",
            action_requests: [
              { type: "ask_user_question", question: "要看哪一家？", options: ["AAPL"] },
            ],
          }),
        ),
        encode({ type: "RUN_FINISHED", threadId: "t-1", runId: "r-1", outcome: "success" }),
      ].join(""),
      true,
    ),
  );
  const progress: VerticalProgress[] = [];
  const result = await runVerticalAgent(financeAgent, {
    ...runOptions(fixture.fetch),
    onProgress: (item: VerticalProgress) => progress.push(item),
  });

  assert.deepEqual(progress, [{ kind: "question", text: "等待你的回答…" }]);
  // The question still reaches the model as the interrupt it has to put across.
  assert.equal(result.status, "awaiting_input");
});

test("rich events are capped, and a sub-agent keeps the last thing it said", () => {
  const events = new VerticalRichEvents();
  for (let index = 0; index < 60; index++)
    events.collect("langalpha.artifact", {
      artifact_type: "file_operation",
      artifact_id: `c-${index}`,
      payload: { file_path: `reports/${index}.md` },
    });
  for (let index = 0; index < 25; index++)
    events.collect("langalpha.provenance", { identifier: `https://example.com/${index}` });
  for (let index = 0; index < 12; index++)
    events.collect("langalpha.agent_text", { agent: `task:${index}`, content: "first" });
  events.collect("langalpha.agent_text", { agent: "task:0", content: "last" });

  const summary = events.summary();
  assert.equal(summary.artifacts?.length, 50);
  assert.equal(summary.artifacts?.[49].id, "c-49");
  assert.equal(summary.sources?.length, 20);
  // The eleventh sub-agent is dropped rather than evicting one already reported.
  assert.deepEqual(
    summary.subagentNotes?.map((note) => note.agent),
    Array.from({ length: 10 }, (_, index) => `task:${index}`),
  );
  assert.equal(summary.subagentNotes?.[0].excerpt, "last");
});

test("a long artifact title and sub-agent excerpt are bounded", () => {
  const events = new VerticalRichEvents();
  events.collect("langalpha.artifact", {
    artifact_type: "file_operation",
    payload: { file_path: `reports/${"a".repeat(500)}.md` },
  });
  events.collect("langalpha.agent_text", { agent: "task:1", content: "b".repeat(500) });
  const summary = events.summary();
  assert.equal(summary.artifacts?.[0].title.length, 200);
  assert.equal(summary.subagentNotes?.[0].excerpt.length, 300);
});

test("a delegate run error comes back as a result rather than a throw", async () => {
  const fixture = delegate(() =>
    streamed(
      [
        encode({ type: "RUN_STARTED", threadId: "t-1", runId: "r-1" }),
        encode({ type: "RUN_ERROR", message: "run failed: sandbox gone", code: "sandbox" }),
      ].join(""),
      true,
    ),
  );
  assert.deepEqual(await runVerticalAgent(financeAgent, runOptions(fixture.fetch)), {
    error: "run failed: sandbox gone",
  });
});

test("a delegate that outruns its timeout keeps whatever it had already said", async () => {
  const fixture = delegate(() =>
    streamed(
      [
        encode({ type: "RUN_STARTED", threadId: "t-1", runId: "r-1" }),
        encode({ type: "TEXT_MESSAGE_START", messageId: "r-1:1", role: "assistant" }),
        encode({ type: "TEXT_MESSAGE_CONTENT", messageId: "r-1:1", delta: "AAPL is " }),
      ].join(""),
      false,
    ),
  );
  const result = await runVerticalAgent(
    { ...financeAgent, timeoutMs: 20 },
    runOptions(fixture.fetch),
  );

  assert.deepEqual(result, { report: "AAPL is ", aborted: true, toolCalls: 0, thinkingEvents: 0 });
  // The timeout has to reach the socket, not just stop the reading.
  assert.equal(fixture.requests[0].init.signal?.aborted, true);
});

test("a delegate that times out silently reports an error instead of an empty report", async () => {
  const fixture = delegate(() =>
    streamed(encode({ type: "RUN_STARTED", threadId: "t-1", runId: "r-1" }), false),
  );
  const result = await runVerticalAgent(
    { ...financeAgent, timeoutMs: 20 },
    runOptions(fixture.fetch),
  );
  assert.deepEqual(result, { error: "The finance_agent run stopped before it produced a result" });
});

test("the tool refuses an unauthenticated call instead of running as nobody", async () => {
  const fixture = delegate();
  const tool = verticalAgentTool(financeAgent, {
    threadId: "thread-1",
    getToken: () => undefined,
    signal: new AbortController().signal,
  });
  assert.deepEqual(await tool.execute?.({ task: "how is AAPL doing" }), {
    error: "该能力需要登录后使用",
  });
  assert.deepEqual(fixture.requests, []);
});

test("the tool spends the caller's own token and reports what the delegate found", async (t) => {
  const gateway = await aguiGateway(t, turn);
  const tool = verticalAgentTool(
    { ...financeAgent, url: gateway.url },
    {
      threadId: "thread-1",
      getToken: () => "Bearer caller-jwt",
      signal: new AbortController().signal,
    },
  );
  assert.deepEqual(await tool.execute?.({ task: "how is AAPL doing" }), {
    report: "AAPL is up",
    truncated: false,
    toolCalls: 1,
    thinkingEvents: 1,
  });
  // The tool never takes a fetch override: production goes to the real socket.
  assert.equal(gateway.requests[0].authorization, "Bearer caller-jwt");
  assert.equal(gateway.requests[0].body.threadId, "thread-1");
  assert.equal(message(gateway.requests[0].body).content, "how is AAPL doing");
});

/** A minimal AG-UI gateway, so the hybrid chat reaches a real socket. */
async function aguiGateway(t: TestContext, body: string) {
  const requests: { authorization?: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    let received = "";
    for await (const chunk of request) received += chunk;
    // The post-run deliverable sweep GETs the workspaces/files API on the same
    // host with no body; answer it with an empty list instead of crashing.
    if (!received) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ workspaces: [] }));
      return;
    }
    requests.push({
      authorization: request.headers.authorization,
      body: JSON.parse(received) as Record<string, unknown>,
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { requests, url: `http://127.0.0.1:${address.port}/api/v1/agui/run` };
}

async function hybridChat(t: TestContext, verticalAgents: VerticalAgentSpec[]) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-vertical-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    authMode: "local",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "hybrid",
    model: "openai/fixture",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    verticalAgents,
  };
  const server = await createApp(db, config);
  t.after(() => server.agent.stop());
  return new ConversationAgent(config, server.agent, "local-user", undefined, "Bearer caller-jwt");
}

function chatInput(): RunAgentInput {
  return {
    threadId: "vertical-chat",
    runId: randomUUID(),
    messages: [
      { id: randomUUID(), role: "user", content: "How is AAPL doing today, with sources?" },
    ],
    tools: [],
    context: [],
    state: {},
  };
}

test("a hybrid chat offers the delegate as a tool and routes one job to it", async (t) => {
  const gateway = await aguiGateway(t, turn);
  const { requests: modelRequests } = await modelFixture(t, (index) =>
    index === 0 ? { name: "finance_agent", arguments: { task: "quote AAPL" } } : undefined,
  );
  const conversation = await hybridChat(t, [
    { name: "finance_agent", description: financeAgent.description, url: gateway.url },
  ]);

  const events = (await lastValueFrom(conversation.run(chatInput()).pipe(toArray()))).map((event) =>
    EventSchemas.parse(event),
  );

  // The model was given the delegate, and the prompt points at it — while the
  // sentence that used to deny finance connectors is gone.
  assert.match(modelRequests[0].body, /"finance_agent"/);
  assert.match(modelRequests[0].body, /Do not invent market or financial data from memory/);
  assert.doesNotMatch(modelRequests[0].body, /Health\/finance connectors beyond Google/);

  // The call left under the caller's own token and the chat's own thread.
  assert.equal(gateway.requests.length, 1);
  assert.equal(gateway.requests[0].authorization, "Bearer caller-jwt");
  assert.equal(gateway.requests[0].body.threadId, "vertical-chat");
  assert.equal(message(gateway.requests[0].body).content, "quote AAPL");

  // The report came back as the tool result the model then answered from.
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(result && result.type === EventType.TOOL_CALL_RESULT);
  assert.equal(JSON.parse(result.content).report, "AAPL is up");
  assert.ok(modelRequests[1].body.includes("AAPL is up"));
});

test("a delegated chat streams the delegate's steps beside the run, and still ends", async (t) => {
  const gateway = await aguiGateway(
    t,
    [
      encode({ type: "RUN_STARTED", threadId: "t-1", runId: "r-1" }),
      encode({ type: "THINKING_START" }),
      encode({ type: "TOOL_CALL_START", toolCallId: "c-1", toolCallName: "quote" }),
      encode(
        custom("langalpha.artifact", {
          artifact_type: "file_operation",
          payload: { file_path: "reports/aapl.md" },
        }),
      ),
      encode({ type: "TEXT_MESSAGE_CONTENT", messageId: "r-1:1", delta: "AAPL is up" }),
      encode({ type: "RUN_FINISHED", threadId: "t-1", runId: "r-1", outcome: "success" }),
    ].join(""),
  );
  const { requests: modelRequests } = await modelFixture(t, (index) =>
    index === 0 ? { name: "finance_agent", arguments: { task: "quote AAPL" } } : undefined,
  );
  const conversation = await hybridChat(t, [
    { name: "finance_agent", description: financeAgent.description, url: gateway.url },
  ]);

  // The progress stream is a second source of this run, so a merge that never
  // sees it end would leave this waiting for as long as the socket lives: the
  // timer is what turns that hang into a failure.
  const events = await Promise.race([
    lastValueFrom(conversation.run(chatInput()).pipe(toArray())),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("the delegated chat never finished")), 5000).unref(),
    ),
  ]);

  const progress: unknown[] = [];
  for (const event of events.map((raw) => EventSchemas.parse(raw))) {
    if (event.type !== EventType.CUSTOM) continue;
    if (event.name !== delegateProgressEvent) continue;
    progress.push(event.value);
  }
  assert.deepEqual(progress, [
    { agent: "finance_agent", kind: "thinking", text: "思考中…" },
    { agent: "finance_agent", kind: "tool", text: "调用工具 quote" },
    { agent: "finance_agent", kind: "artifact", text: "产出 reports/aapl.md" },
  ]);
  // The frames are for the person watching, not for the model: they are not
  // messages, so nothing about them reaches the next request.
  assert.doesNotMatch(modelRequests[1].body, /delegate_progress/);
});

test("a hybrid chat hands the model the delegate's question instead of a dead run", async (t) => {
  const gateway = await aguiGateway(
    t,
    [
      encode({ type: "RUN_STARTED", threadId: "t-1", runId: "r-1" }),
      encode(
        custom("langalpha.interrupt", {
          thread_id: "la-th-1",
          interrupt_id: "int-1",
          role: "assistant",
          finish_reason: "interrupt",
          action_requests: [
            {
              type: "ask_user_question",
              question: "要看哪一家？",
              options: ["AAPL", "TSLA"],
              allow_multiple: false,
            },
          ],
        }),
      ),
      encode({ type: "RUN_FINISHED", threadId: "t-1", runId: "r-1", outcome: "success" }),
    ].join(""),
  );
  const { requests: modelRequests } = await modelFixture(t, (index) =>
    index === 0 ? { name: "finance_agent", arguments: { task: "quote AAPL" } } : undefined,
  );
  const conversation = await hybridChat(t, [
    { name: "finance_agent", description: financeAgent.description, url: gateway.url },
  ]);

  const events = (await lastValueFrom(conversation.run(chatInput()).pipe(toArray()))).map((event) =>
    EventSchemas.parse(event),
  );

  const toolResult = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(toolResult && toolResult.type === EventType.TOOL_CALL_RESULT);
  const content = JSON.parse(toolResult.content) as Record<string, unknown>;
  assert.equal(content.status, "awaiting_input");
  assert.equal(content.delegateThreadId, "la-th-1");
  assert.deepEqual(content.interrupt, {
    interruptId: "int-1",
    question: "要看哪一家？",
    options: ["AAPL", "TSLA"],
    allowMultiple: false,
  });
  // The turn is not over: the model is told how to resume once the user answers.
  assert.match(String(content.guidance), /resumeInterruptId/);
  assert.match(modelRequests[1].body, /resumeInterruptId/);
});

test("a model-only chat keeps the connectors sentence and offers no delegate", async (t) => {
  const { requests } = await modelFixture(t, () => undefined);
  const directory = await mkdtemp(join(tmpdir(), "openmuse-vertical-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    authMode: "local",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    model: "openai/fixture",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    verticalAgents: [financeAgent],
  };
  const server = await createApp(db, config);
  t.after(() => server.agent.stop());

  await lastValueFrom(
    new ConversationAgent(config, server.agent, "local-user").run(chatInput()).pipe(toArray()),
  );

  assert.doesNotMatch(requests[0].body, /"finance_agent"/);
  assert.match(requests[0].body, /Health\/finance connectors beyond Google/);
});
