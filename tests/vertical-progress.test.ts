import assert from "node:assert/strict";
import test from "node:test";
import { EventType } from "@ag-ui/core";
import { VerticalProgressTracker } from "../apps/server/src/engine/vertical-progress.ts";

/**
 * A delegated run is minutes with nothing in the transcript to show for it. The
 * delegate's own stream is the only evidence in between, and this is what turns
 * it into a handful of one-line notes the chat can show as they arrive.
 */

const custom = (name: string, value: unknown) => ({ type: EventType.CUSTOM, name, value });

const artifactFrame = {
  artifact_type: "file_operation",
  artifact_id: "c-1",
  payload: { file_path: "reports/aapl.md" },
};

test("a delegate's steps become lines the chat can show", () => {
  const tracker = new VerticalProgressTracker();
  assert.deepEqual(
    [
      tracker.collect({ type: EventType.RUN_STARTED, threadId: "t-1", runId: "r-1" }),
      tracker.collect({ type: EventType.THINKING_START }),
      // Reasoning deltas are not steps of their own; only the block's start is.
      tracker.collect({ type: EventType.THINKING_TEXT_MESSAGE_CONTENT, delta: "weighing sources" }),
      tracker.collect({ type: EventType.TOOL_CALL_START, toolCallId: "c-1", toolCallName: "quote" }),
      // Arguments say nothing a person watching the run needs, and they are the
      // part that can be arbitrarily large.
      tracker.collect({ type: EventType.TOOL_CALL_ARGS, toolCallId: "c-1", delta: "{}" }),
      tracker.collect(
        custom("langalpha.agent_text", { agent: "task:1", content: "pulled the filing" }),
      ),
      tracker.collect(custom("langalpha.artifact", artifactFrame)),
      tracker.collect(
        custom("langalpha.interrupt", {
          interrupt_id: "int-1",
          action_requests: [{ type: "ask_user_question", question: "要看哪一家？" }],
        }),
      ),
      tracker.collect({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "r-1:1", delta: "AAPL" }),
    ],
    [
      undefined,
      { kind: "thinking", text: "思考中…" },
      undefined,
      { kind: "tool", text: "调用工具 quote" },
      undefined,
      { kind: "note", text: "task:1: pulled the filing" },
      { kind: "artifact", text: "产出 reports/aapl.md" },
      { kind: "question", text: "等待你的回答…" },
      undefined,
    ],
  );
});

test("the same line twice in a row is shown once", () => {
  const tracker = new VerticalProgressTracker();
  assert.deepEqual(tracker.thinking(), { kind: "thinking", text: "思考中…" });
  // A delegate that emits thinking blocks without end would otherwise fill the list.
  assert.equal(tracker.thinking(), undefined);
  assert.deepEqual(tracker.tool("quote"), { kind: "tool", text: "调用工具 quote" });
  // A different line in between makes the repeat a line again.
  assert.deepEqual(tracker.thinking(), { kind: "thinking", text: "思考中…" });
});

test("a run that emits without bound is capped at fifty lines", () => {
  const tracker = new VerticalProgressTracker();
  const lines = Array.from({ length: 60 }, (_, index) => tracker.tool(`tool-${index}`)).filter(
    (line) => line !== undefined,
  );
  // The fifty-first is dropped rather than evicting one already shown.
  assert.equal(lines.length, 50);
  assert.deepEqual(lines.at(-1), { kind: "tool", text: "调用工具 tool-49" });
});

test("a line longer than a line's worth is cut", () => {
  const tracker = new VerticalProgressTracker();
  // A sub-agent's excerpt is bounded on its own; a long name is what pushes the
  // assembled line past the limit.
  const note = tracker.note({ agent: "t".repeat(200), content: "b".repeat(500) });
  assert.equal(note?.text.length, 140);
  const excerpted = tracker.note({ agent: "task:1", content: "b".repeat(500) });
  assert.equal(excerpted?.text, `task:1: ${"b".repeat(120)}`);
});

test("frames that cannot be read show nothing rather than failing the run", () => {
  const tracker = new VerticalProgressTracker();
  for (const value of ["not a frame", null, [], {}, { artifact_type: 1 }, 3])
    assert.equal(tracker.artifact(value), undefined, JSON.stringify(value));
  for (const value of [undefined, {}, { agent: "task:1" }, { agent: "  ", content: "said" }])
    assert.equal(tracker.note(value), undefined, JSON.stringify(value));
  // Bookkeeping the person has no use for is not a step.
  assert.equal(tracker.collect(custom("langalpha.credit_usage", { credits: 3 })), undefined);
  assert.equal(tracker.collect(custom("langalpha.provenance", { title: "AAPL quote" })), undefined);
});

test("a resume's own frames feed the same lines", () => {
  const tracker = new VerticalProgressTracker();
  assert.deepEqual(tracker.artifact(artifactFrame), {
    kind: "artifact",
    text: "产出 reports/aapl.md",
  });
  // Unlike AG-UI's TOOL_CALL_START, the resume's frame names no tool, so the
  // line says only that one ran.
  assert.deepEqual(tracker.tool(), { kind: "tool", text: "调用工具" });
  assert.deepEqual(tracker.question(), { kind: "question", text: "等待你的回答…" });
});
