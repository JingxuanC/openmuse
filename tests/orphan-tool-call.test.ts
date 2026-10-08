import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunAgentInput } from "@ag-ui/core";
import { sanitizeOrphanToolCalls } from "../apps/server/src/engine/tanstack-agent.ts";

type Messages = RunAgentInput["messages"];

const user = (id: string): Messages[number] => ({ id, role: "user", content: "hi" });
const assistant = (id: string, ids: string[], content = ""): Messages[number] => ({
  id,
  role: "assistant",
  content,
  toolCalls: ids.map((callId) => ({
    id: callId,
    type: "function",
    function: { name: "search", arguments: "{}" },
  })),
});
const tool = (callId: string): Messages[number] => ({
  id: `m-${callId}`,
  role: "tool",
  toolCallId: callId,
  content: "result",
});

test("an orphan tool call is dropped; answered calls keep their result right after", () => {
  const poisoned: Messages = [
    user("u1"),
    assistant("a1", ["call_1", "call_2"]),
    tool("call_2"),
    user("u2"),
  ];

  const sanitized = sanitizeOrphanToolCalls(poisoned);

  assert.deepEqual(
    sanitized.map((message) => message.id),
    ["u1", "a1", "m-call_2", "u2"],
  );
  const callsMessage = sanitized[1] as { toolCalls: { id: string }[] };
  assert.deepEqual(
    callsMessage.toolCalls.map((call) => call.id),
    ["call_2"],
  );

  // The input array and its messages are untouched.
  assert.equal(poisoned.length, 4);
  assert.equal((poisoned[1] as { toolCalls: unknown[] }).toolCalls.length, 2);
});

test("assistant text is split ahead of its calls so outputs stay adjacent to calls", () => {
  const history: Messages = [
    user("u1"),
    assistant("a1", ["call_1"], "on it"),
    tool("call_1"),
    user("u2"),
  ];

  const sanitized = sanitizeOrphanToolCalls(history);

  assert.deepEqual(
    sanitized.map((message) => `${message.role}:${message.id}`),
    ["user:u1", "assistant:a1", "assistant:a1", "tool:m-call_1", "user:u2"],
  );
  const textMessage = sanitized[1] as { content: string; toolCalls?: unknown };
  assert.equal(textMessage.content, "on it");
  assert.equal(textMessage.toolCalls, undefined);
  const callsMessage = sanitized[2] as { content: string; toolCalls: { id: string }[] };
  assert.equal(callsMessage.content, "");
  assert.equal(callsMessage.toolCalls[0]?.id, "call_1");
});

test("an assistant message left with neither calls nor content is dropped", () => {
  const poisoned: Messages = [user("u1"), assistant("a1", ["call_1"]), user("u2")];

  const sanitized = sanitizeOrphanToolCalls(poisoned);

  assert.deepEqual(
    sanitized.map((message) => message.id),
    ["u1", "u2"],
  );
});

test("a result whose call never appears is dropped", () => {
  const poisoned: Messages = [user("u1"), tool("call_ghost"), user("u2")];

  const sanitized = sanitizeOrphanToolCalls(poisoned);

  assert.deepEqual(
    sanitized.map((message) => message.id),
    ["u1", "u2"],
  );
});

test("a result displaced far from its call is moved right after it", () => {
  const displaced: Messages = [
    user("u1"),
    assistant("a1", ["call_1"]),
    { id: "a2", role: "assistant", content: "still thinking" },
    user("u2"),
    tool("call_1"),
    user("u3"),
  ];

  const sanitized = sanitizeOrphanToolCalls(displaced);

  assert.deepEqual(
    sanitized.map((message) => message.id),
    ["u1", "a1", "m-call_1", "a2", "u2", "u3"],
  );
});

test("history with no orphans is passed through unchanged", () => {
  const clean: Messages = [
    user("u1"),
    assistant("a1", ["call_1"]),
    tool("call_1"),
    { id: "a2", role: "assistant", content: "done" },
  ];

  assert.deepEqual(sanitizeOrphanToolCalls(clean), clean);
});
