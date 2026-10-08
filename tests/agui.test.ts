import assert from "node:assert/strict";
import test from "node:test";
import type { HttpAgentFetchFn } from "@ag-ui/client";
import { adaptAguiFrame, createLangAlphaAgent } from "../apps/server/src/agui.ts";

/**
 * The wire contract with LangAlpha's AG-UI gateway. Everything below is built
 * from `src/gateway/agui/events.py` — `encode` frames one event as
 * `data: <json>\n\n` with the type *inside* the payload, and `_event` drops
 * fields that carry no value rather than serializing a null — so a change on
 * that side shows up here as a failing test rather than as an empty screen.
 */

/** `events.encode`. */
function encode(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** One turn as `translate.Translator` emits it, plus the gateway's own CUSTOM. */
const TURN = [
  { type: "RUN_STARTED", threadId: "t-1", runId: "r-1" },
  { type: "CUSTOM", name: "langalpha.thread", value: { threadId: "la-thread-9" } },
  { type: "THINKING_START" },
  { type: "THINKING_TEXT_MESSAGE_START" },
  { type: "THINKING_TEXT_MESSAGE_CONTENT", delta: "weighing options" },
  { type: "THINKING_TEXT_MESSAGE_END" },
  { type: "THINKING_END" },
  { type: "STEP_STARTED", stepName: "model:gpt-5" },
  { type: "TEXT_MESSAGE_START", messageId: "r-1:1", role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "r-1:1", delta: "Hello " },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "r-1:1", delta: "世界" },
  { type: "TEXT_MESSAGE_END", messageId: "r-1:1" },
  { type: "STEP_FINISHED", stepName: "model:gpt-5" },
  // The one frame that needs adapting: `events.run_finished` defaults outcome
  // to the string AG-UI's schema does not accept.
  { type: "RUN_FINISHED", threadId: "t-1", runId: "r-1", outcome: "success" },
];

/** An SSE response, optionally delivered in `chunkSize`-byte pieces. */
function sseResponse(body: string, chunkSize = Number.POSITIVE_INFINITY): Response {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize)
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function fixture(respond: (url: string, init: RequestInit) => Response) {
  const requests: { url: string; init: RequestInit }[] = [];
  const agent = createLangAlphaAgent({
    url: "http://127.0.0.1:8000/api/v1/agui/run",
    token: "test-token",
    fetch: (async (url, init) => {
      requests.push({ url, init });
      return respond(url, init);
    }) as HttpAgentFetchFn,
  });
  const events: { type: string }[] = [];
  agent.subscribe({
    onEvent: ({ event }) => {
      events.push(event);
    },
  });
  agent.setMessages([{ id: "m-user", role: "user", content: "hi" }]);
  return { agent, requests, events };
}

test("the request body is RunAgentInput in camelCase, with the runtime's thread id", async () => {
  const { agent, requests } = fixture(() => sseResponse(TURN.map(encode).join("")));
  agent.threadId = "t-1";
  await agent.runAgent({ runId: "r-1" });

  assert.equal(requests.length, 1);
  const { url, init } = requests[0];
  assert.equal(url, "http://127.0.0.1:8000/api/v1/agui/run");
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, {
    Authorization: "Bearer test-token",
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  });

  // Every field the gateway's `RunAgentInput` models, spelled the way it models
  // them. `context` is not among them but rides through `extra="allow"`.
  const body = JSON.parse(String(init.body));
  assert.deepEqual(body, {
    threadId: "t-1",
    runId: "r-1",
    tools: [],
    context: [],
    forwardedProps: {},
    state: {},
    messages: [{ id: "m-user", role: "user", content: "hi" }],
  });
});

test("a LangAlpha turn is consumed: text, thinking, steps and completion", async () => {
  const { agent, events } = fixture(() => sseResponse(TURN.map(encode).join("")));
  const { newMessages } = await agent.runAgent({ runId: "r-1" });

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "RUN_STARTED",
      "CUSTOM",
      "THINKING_START",
      "THINKING_TEXT_MESSAGE_START",
      "THINKING_TEXT_MESSAGE_CONTENT",
      "THINKING_TEXT_MESSAGE_END",
      "THINKING_END",
      "STEP_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "STEP_FINISHED",
      "RUN_FINISHED",
    ],
  );
  assert.deepEqual(newMessages, [{ id: "r-1:1", role: "assistant", content: "Hello 世界" }]);
});

test("frames survive being split across chunk boundaries", async () => {
  const body = TURN.map(encode).join("");
  // A multi-byte character straddles the boundary at 3-byte reads, which is the
  // case a byte-level re-framer would corrupt.
  const { agent, events } = fixture(() => sseResponse(body, 3));
  const { newMessages } = await agent.runAgent({ runId: "r-1" });

  assert.deepEqual(events.at(-1), {
    type: "RUN_FINISHED",
    threadId: "t-1",
    runId: "r-1",
    outcome: { type: "success" },
  });
  assert.equal(newMessages[0].content, "Hello 世界");
});

test("a trailing frame with no blank line after it is still consumed", async () => {
  const { agent, events } = fixture(() => sseResponse(TURN.map(encode).join("").trimEnd()));
  await agent.runAgent({ runId: "r-1" });
  assert.equal(events.at(-1)?.type, "RUN_FINISHED");
});

test("an error turn surfaces as RUN_ERROR rather than a thrown run", async () => {
  const { agent, events } = fixture(() =>
    sseResponse(
      [
        encode({ type: "RUN_STARTED", threadId: "t-1", runId: "r-1" }),
        encode({ type: "RUN_ERROR", message: "run failed: sandbox gone", code: "sandbox" }),
      ].join(""),
    ),
  );
  await agent.runAgent({ runId: "r-1" });
  assert.deepEqual(events.at(-1), {
    type: "RUN_ERROR",
    message: "run failed: sandbox gone",
    code: "sandbox",
  });
});

test("a non-ok response keeps its status and body for the caller to read", async () => {
  const { agent } = fixture(
    () =>
      new Response(JSON.stringify({ detail: "agui gateway is disabled" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
  );
  await assert.rejects(agent.runAgent({ runId: "r-1" }), (error: Error & { status?: number }) => {
    assert.equal(error.status, 503);
    assert.match(error.message, /agui gateway is disabled/);
    return true;
  });
});

test("only RUN_FINISHED with a string outcome is rewritten", () => {
  const finish = (outcome: unknown) =>
    adaptAguiFrame(encode({ type: "RUN_FINISHED", threadId: "t-1", runId: "r-1", outcome }));
  assert.equal(
    finish("success"),
    encode({
      type: "RUN_FINISHED",
      threadId: "t-1",
      runId: "r-1",
      outcome: { type: "success" },
    }),
  );
  // An interrupt would need the `interrupts` array the gateway never sends, so
  // it is left intact to fail loudly instead of reading as a clean finish.
  assert.equal(
    finish("interrupt"),
    encode({ type: "RUN_FINISHED", threadId: "t-1", runId: "r-1", outcome: "interrupt" }),
  );
  // An already-correct object outcome, and an absent one, pass through untouched.
  assert.equal(
    finish({ type: "success" }),
    encode({ type: "RUN_FINISHED", threadId: "t-1", runId: "r-1", outcome: { type: "success" } }),
  );
  assert.equal(finish(undefined), encode({ type: "RUN_FINISHED", threadId: "t-1", runId: "r-1" }));
  // Frames with nothing to adapt come back byte-identical.
  for (const frame of [
    "data: not json\n\n",
    ": keep-alive comment\n\n",
    "event: ping\ndata: {}\n\n",
    "",
  ])
    assert.equal(adaptAguiFrame(frame), frame);
});
