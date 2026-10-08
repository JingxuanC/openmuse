import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import type { VerticalAgentSpec } from "../apps/server/src/config.ts";
import { runVerticalAgent, verticalAgentTool } from "../apps/server/src/engine/vertical-agent.ts";
import {
  awaitingInputGuidance,
  VerticalRichEvents,
} from "../apps/server/src/engine/vertical-events.ts";
import {
  buildResumeBody,
  resumeVerticalAgent,
  SseParser,
} from "../apps/server/src/engine/vertical-resume.ts";

/**
 * The answer half of a delegated run: LangAlpha interrupts the AG-UI stream to
 * ask the user something, and the answer goes back over its threads API, whose
 * reply is plain SSE rather than AG-UI frames. The frames below are the ones
 * `gateway/agui/sse.py` and the threads endpoint produce.
 */

const financeAgent: VerticalAgentSpec = {
  name: "finance_agent",
  description: "live market quotes, financial statements and filings",
  url: "http://127.0.0.1:8000/api/v1/agui/run",
};

/** A plain-SSE frame, the shape the threads API writes. */
const frame = (event: string, data: unknown) =>
  `id: 1\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function sse(body: string, close = true): Response {
  const bytes = new TextEncoder().encode(body);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        // Never closing leaves the stream open, so only an abort can settle it.
        if (close) controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** The same body, delivered in two reads that split a frame down the middle. */
function sseSplit(body: string, at: number): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body.slice(0, at)));
        controller.enqueue(encoder.encode(body.slice(at)));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** A threads endpoint that records what it was asked and replays one body. */
function endpoint(response: () => Response) {
  const requests: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) });
    return response();
  };
  return { requests, fetch };
}

function resumeOptions(fetch: typeof globalThis.fetch, overrides: Record<string, unknown> = {}) {
  return {
    threadId: "la-thread-1",
    interruptId: "int-1",
    answer: "AAPL",
    token: "caller-jwt",
    signal: new AbortController().signal,
    fetch,
    ...overrides,
  };
}

test("the SSE reader frames a stream whether or not it arrives whole", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push('id: 1\nevent: message_chunk\ndata: {"content":"hi"}\n\n'), [
    { event: "message_chunk", data: '{"content":"hi"}' },
  ]);
  // A frame split mid-payload yields nothing until its boundary arrives.
  assert.deepEqual(parser.push('event: artifact\ndata: {"a"'), []);
  assert.deepEqual(parser.push(":1}\n\nevent: finish\ndata: {}\n\n"), [
    { event: "artifact", data: '{"a":1}' },
    { event: "finish", data: "{}" },
  ]);
  // A sender may wrap one payload across several data lines.
  assert.deepEqual(parser.push("event: x\ndata: one\ndata: two\n\n"), [
    { event: "x", data: "one\ntwo" },
  ]);
  // Comment, id and retry lines, and a frame with no payload, carry nothing.
  assert.deepEqual(parser.push("id: 2\nretry: 100\nevent: ping\n\n"), []);
  // The last frame of a stream may end without its blank line.
  assert.deepEqual(parser.push("event: interrupt\ndata: {}"), []);
  assert.deepEqual(parser.flush(), { event: "interrupt", data: "{}" });
  assert.equal(parser.flush(), undefined);
});

test("an answer is posted as a decision the delegate can match to its question", () => {
  assert.deepEqual(buildResumeBody({ interruptId: "int-1", answer: "AAPL" }), {
    messages: [{ role: "user", content: "AAPL" }],
    hitl_response: { "int-1": { decisions: [{ type: "approve", message: "AAPL" }] } },
  });
  // An approval is keyed by the attempt the delegate proposed, not by a bare list.
  assert.deepEqual(
    buildResumeBody({
      interruptId: "int-2",
      answer: "买入",
      kind: "order_approval",
      attemptId: "att-7",
    }),
    {
      messages: [{ role: "user", content: "买入" }],
      hitl_response: {
        "int-2": { order_decisions: { "att-7": { type: "approve", message: "买入" } } },
      },
    },
  );
  // Refusing is a decision, not prose the delegate would read as an answer.
  for (const answer of ["reject", "拒绝", "跳过", " REJECT "]) {
    const body = buildResumeBody({ interruptId: "int-3", answer });
    const response = body.hitl_response as Record<string, { decisions: { type: string }[] }>;
    assert.equal(response["int-3"].decisions[0].type, "reject", answer);
  }
});

test("an interrupt becomes the question the model has to put to the user", () => {
  const ask = new VerticalRichEvents();
  ask.collect("langalpha.interrupt", {
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
  });
  assert.deepEqual(ask.pendingInput(), {
    status: "awaiting_input",
    interrupt: {
      interruptId: "int-1",
      question: "要看哪一家？",
      options: ["AAPL", "TSLA"],
      allowMultiple: false,
    },
    delegateThreadId: "la-th-1",
    guidance: awaitingInputGuidance,
  });
  // The interrupt is the model's next move, not an artifact of the run.
  assert.deepEqual(ask.summary(), {});

  const approval = new VerticalRichEvents();
  approval.collect("langalpha.interrupt", {
    thread_id: "la-th-2",
    interrupt_id: "int-2",
    kind: "order_approval",
    action_requests: [
      {
        name: "place_order",
        args: { symbol: "AAPL", quantity: 10 },
        description: "以市价买入 10 股 AAPL",
        tool_call_id: "c-9",
        attempt_id: "att-7",
        order: { symbol: "AAPL", quantity: 10 },
      },
    ],
    review_configs: [{ action_name: "place_order", allowed_decisions: ["approve", "reject"] }],
  });
  assert.deepEqual(approval.pendingInput(), {
    status: "awaiting_input",
    interrupt: {
      interruptId: "int-2",
      kind: "order_approval",
      question: "以市价买入 10 股 AAPL",
      options: ["approve", "reject"],
      attemptId: "att-7",
    },
    delegateThreadId: "la-th-2",
    guidance: awaitingInputGuidance,
  });

  // A shape this app has never seen still has to reach the person somehow, and
  // an approval with no description falls back to what it would call.
  const unknown = new VerticalRichEvents();
  unknown.collect("langalpha.interrupt", {
    interrupt_id: "int-3",
    action_requests: [{ message: "something else entirely" }],
  });
  assert.equal(unknown.pendingInput()?.interrupt.question, "something else entirely");
  assert.equal(unknown.pendingInput()?.interrupt.options, undefined);

  const unreadable = new VerticalRichEvents();
  unreadable.collect("langalpha.interrupt", { interrupt_id: "int-4", action_requests: [] });
  assert.equal(unreadable.pendingInput()?.interrupt.question, "[]");

  const named = new VerticalRichEvents();
  named.collect("langalpha.interrupt", {
    interrupt_id: "int-5",
    kind: "order_approval",
    action_requests: [{ name: "place_order", args: { symbol: "AAPL" } }],
  });
  assert.equal(named.pendingInput()?.interrupt.question, 'place_order {"symbol":"AAPL"}');
});

test("the delegate's own thread is kept from whichever frame reported it", () => {
  const thread = new VerticalRichEvents();
  thread.collect("langalpha.thread", { threadId: "la-th-9" });
  thread.collect("langalpha.interrupt", {
    interrupt_id: "int-1",
    action_requests: [{ type: "ask_user_question", question: "问一句" }],
  });
  assert.equal(thread.pendingInput()?.delegateThreadId, "la-th-9");
  assert.deepEqual(thread.summary(), {});

  // A frame that carries no id cannot be answered, so it is not an interrupt.
  const unanswerable = new VerticalRichEvents();
  unanswerable.collect("langalpha.interrupt", { action_requests: [] });
  assert.equal(unanswerable.pendingInput(), undefined);

  // Within one run only the newest question is still open.
  const twice = new VerticalRichEvents();
  for (const id of ["int-1", "int-2"])
    twice.collect("langalpha.interrupt", {
      thread_id: "la-th-1",
      interrupt_id: id,
      action_requests: [{ type: "ask_user_question", question: id }],
    });
  assert.equal(twice.pendingInput()?.interrupt.interruptId, "int-2");
});

test("a run that interrupts comes back as a question rather than a report", async () => {
  const interrupt = {
    type: "CUSTOM",
    name: "langalpha.interrupt",
    value: {
      thread_id: "la-thread-1",
      interrupt_id: "int-1",
      kind: "order_approval",
      action_requests: [
        { name: "place_order", description: "以市价买入 10 股 AAPL", attempt_id: "att-7" },
      ],
      role: "assistant",
      finish_reason: "interrupt",
    },
  };
  const fixture = endpoint(() =>
    sse(
      [
        `data: ${JSON.stringify({ type: "RUN_STARTED", threadId: "t-1", runId: "r-1" })}\n\n`,
        `data: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", messageId: "r-1:1", delta: "正在下单" })}\n\n`,
        `data: ${JSON.stringify(interrupt)}\n\n`,
        // LangAlpha also names the thread it minted, on the first delegation.
        `data: ${JSON.stringify({ type: "CUSTOM", name: "langalpha.thread", value: { threadId: "la-th-9" } })}\n\n`,
        `data: ${JSON.stringify({ type: "RUN_FINISHED", threadId: "t-1", runId: "r-1", outcome: "success" })}\n\n`,
      ].join(""),
    ),
  );
  const result = await runVerticalAgent(financeAgent, {
    task: "buy 10 AAPL",
    threadId: "thread-1",
    token: "caller-jwt",
    signal: new AbortController().signal,
    fetch: fixture.fetch,
  });

  assert.deepEqual(result, {
    report: "正在下单",
    truncated: false,
    toolCalls: 0,
    thinkingEvents: 0,
    status: "awaiting_input",
    interrupt: {
      interruptId: "int-1",
      kind: "order_approval",
      question: "以市价买入 10 股 AAPL",
      options: ["approve", "reject"],
      attemptId: "att-7",
    },
    delegateThreadId: "la-thread-1",
    guidance: awaitingInputGuidance,
  });
});

test("a resume posts the answer to the delegate's thread and collects the rest", async () => {
  const artifact = {
    artifact_type: "file_operation",
    artifact_id: "a-1",
    payload: { file_path: "reports/aapl.md" },
  };
  const body = [
    frame("message_chunk", { thread_id: "la-thread-1", role: "assistant", content: "AAPL " }),
    // Reasoning and compaction deltas are not the answer.
    frame("message_chunk", { content: "weighing sources", content_type: "reasoning" }),
    frame("compaction_chunk", { content: "compacted" }),
    frame("message_chunk", { content: "is up" }),
    frame("artifact", artifact),
    frame("provenance", { identifier: "https://example.com/aapl", title: "AAPL quote" }),
    frame("tool_calls", { id: "c-1" }),
    frame("metadata", { anything: true }),
    frame("finish", { ok: true }),
  ].join("");
  // Split inside the first payload, so the reader has to carry a partial frame.
  const fixture = endpoint(() => sseSplit(body, 30));
  const result = await resumeVerticalAgent(financeAgent, resumeOptions(fixture.fetch));

  assert.deepEqual(result, {
    report: "AAPL is up",
    truncated: false,
    toolCalls: 1,
    artifacts: [
      { type: "file_operation", title: "reports/aapl.md", id: "a-1", path: "reports/aapl.md" },
    ],
    sources: [{ title: "AAPL quote", url: "https://example.com/aapl" }],
  });
  assert.equal(
    fixture.requests[0].url,
    "http://127.0.0.1:8000/api/v1/threads/la-thread-1/messages",
  );
  assert.equal(
    (fixture.requests[0].init.headers as Record<string, string>).Authorization,
    "Bearer caller-jwt",
  );
  assert.deepEqual(fixture.requests[0].body, {
    messages: [{ role: "user", content: "AAPL" }],
    hitl_response: { "int-1": { decisions: [{ type: "approve", message: "AAPL" }] } },
  });
});

test("a resume can be interrupted again, and still points at its own thread", async () => {
  const fixture = endpoint(() =>
    sse(
      [
        frame("message_chunk", { content: "先确认一下" }),
        // No thread_id here: the resume already knows which thread it posted to.
        frame("interrupt", {
          interrupt_id: "int-2",
          action_requests: [
            { type: "ask_user_question", question: "确认要下单吗？", options: ["是"] },
          ],
        }),
      ].join(""),
    ),
  );
  const result = await resumeVerticalAgent(financeAgent, resumeOptions(fixture.fetch));

  assert.deepEqual(result, {
    report: "先确认一下",
    truncated: false,
    toolCalls: 0,
    status: "awaiting_input",
    interrupt: { interruptId: "int-2", question: "确认要下单吗？", options: ["是"] },
    delegateThreadId: "la-thread-1",
    guidance: awaitingInputGuidance,
  });
});

test("a resume failure is reported as it arrived and never thrown", async () => {
  const rejected = endpoint(
    () => new Response("hitl_response does not match any pending interrupt", { status: 400 }),
  );
  assert.deepEqual(await resumeVerticalAgent(financeAgent, resumeOptions(rejected.fetch)), {
    error: "resume 请求被拒绝 (400)：hitl_response does not match any pending interrupt",
  });

  const broken = endpoint(() => sse(frame("error", { error_message: "thread not found" })));
  assert.deepEqual(await resumeVerticalAgent(financeAgent, resumeOptions(broken.fetch)), {
    error: "thread not found",
  });

  // An unreadable frame is dropped rather than failing the run around it.
  const noise = endpoint(() =>
    sse(`event: message_chunk\ndata: {not json\n\n${frame("message_chunk", { content: "ok" })}`),
  );
  assert.deepEqual(await resumeVerticalAgent(financeAgent, resumeOptions(noise.fetch)), {
    report: "ok",
    truncated: false,
    toolCalls: 0,
  });
});

test("a resume that outruns its timeout keeps whatever it had already said", async () => {
  const fixture = endpoint(() => sse(frame("message_chunk", { content: "AAPL " }), false));
  const result = await resumeVerticalAgent(
    { ...financeAgent, timeoutMs: 20 },
    resumeOptions(fixture.fetch),
  );
  assert.deepEqual(result, { report: "AAPL ", aborted: true, toolCalls: 0 });
  // The timeout has to reach the socket, not just stop the reading.
  assert.equal(fixture.requests[0].init.signal?.aborted, true);

  const silent = endpoint(() => sse(frame("metadata", {}), false));
  assert.deepEqual(
    await resumeVerticalAgent({ ...financeAgent, timeoutMs: 20 }, resumeOptions(silent.fetch)),
    { error: "The finance_agent resume stopped before it produced a result" },
  );
});

test("the tool refuses a resume it cannot complete instead of guessing", async () => {
  const fixture = endpoint(() => sse(frame("finish", {})));
  const tool = verticalAgentTool(financeAgent, {
    threadId: "thread-1",
    getToken: () => "Bearer caller-jwt",
    signal: new AbortController().signal,
  });
  const base = { task: "buy 10 AAPL", resumeInterruptId: "int-1" };
  assert.deepEqual(await tool.execute?.({ ...base, resumeAnswer: "AAPL" }), {
    error: "缺少 delegateThreadId，无法回到上次提问的会话",
  });
  assert.deepEqual(await tool.execute?.({ ...base, delegateThreadId: "la-thread-1" }), {
    error: "缺少 resumeAnswer，没有用户回答无法继续",
  });

  const anonymous = verticalAgentTool(financeAgent, {
    threadId: "thread-1",
    getToken: () => undefined,
    signal: new AbortController().signal,
  });
  assert.deepEqual(
    await anonymous.execute?.({
      task: "buy 10 AAPL",
      resumeInterruptId: "int-1",
      resumeAnswer: "AAPL",
      delegateThreadId: "la-thread-1",
    }),
    { error: "该能力需要登录后使用" },
  );
  assert.deepEqual(fixture.requests, []);
});

test("the tool answers an interrupt over the delegate's own endpoint", async (t) => {
  const gateway = await threadsServer(t, frame("message_chunk", { content: "AAPL is up" }));
  const tool = verticalAgentTool(
    { ...financeAgent, url: gateway.url },
    {
      threadId: "thread-1",
      getToken: () => "Bearer caller-jwt",
      signal: new AbortController().signal,
    },
  );
  assert.deepEqual(
    await tool.execute?.({
      task: "buy 10 AAPL",
      resumeInterruptId: "int-1",
      resumeAnswer: "AAPL",
      delegateThreadId: "la-thread-1",
    }),
    { report: "AAPL is up", truncated: false, toolCalls: 0 },
  );
  // The run endpoint only names the origin; the answer goes to the threads API.
  assert.equal(gateway.requests[0].url, "/api/v1/threads/la-thread-1/messages");
  assert.equal(gateway.requests[0].authorization, "Bearer caller-jwt");
  assert.deepEqual(gateway.requests[0].body.messages, [{ role: "user", content: "AAPL" }]);
});

test("the tool answers an approval keyed by its attempt, not by a bare decision", async (t) => {
  const gateway = await threadsServer(t, frame("finish", {}));
  const tool = verticalAgentTool(
    { ...financeAgent, url: gateway.url },
    {
      threadId: "thread-1",
      getToken: () => "Bearer caller-jwt",
      signal: new AbortController().signal,
    },
  );
  await tool.execute?.({
    task: "buy 10 AAPL",
    resumeInterruptId: "int-9",
    resumeAnswer: "approve",
    delegateThreadId: "la-thread-1",
    resumeKind: "order_approval",
    resumeAttemptId: "attempt-3",
  });
  assert.deepEqual(gateway.requests[0].body.hitl_response, {
    "int-9": { order_decisions: { "attempt-3": { type: "approve", message: "approve" } } },
  });
});

/** A minimal threads endpoint, so the tool's resume branch reaches a real socket. */
async function threadsServer(t: TestContext, body: string) {
  const requests: { url: string; authorization?: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    let received = "";
    for await (const chunk of request) received += chunk;
    requests.push({
      url: request.url ?? "",
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
