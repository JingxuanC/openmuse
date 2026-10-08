import assert from "node:assert/strict";
import { test } from "node:test";
import { openaiText } from "@tanstack/ai-openai";
import { withResponsesAdjacency } from "../apps/server/src/engine/tanstack-agent.ts";

process.env.OPENAI_API_KEY ||= "test-key";

type Item = { type?: string; role?: string; call_id?: string };

test("assistant text converts before its function calls so outputs stay adjacent", () => {
  const adapter = withResponsesAdjacency(
    openaiText("deepseek-chat" as never, { baseURL: "https://api.deepseek.com" }),
  ) as unknown as { convertMessagesToInput(messages: unknown[]): Item[] };

  const items = adapter.convertMessagesToInput([
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "on it",
      toolCalls: [{ id: "c1", function: { name: "finance_agent", arguments: "{}" } }],
    },
    { role: "tool", toolCallId: "c1", content: "done" },
  ]);

  assert.deepEqual(
    items.map((item) => item.type ?? item.role),
    ["message", "message", "function_call", "function_call_output"],
  );
  assert.equal(items[2]?.call_id, "c1");
  assert.equal(items[3]?.call_id, "c1");
});

test("call-only assistant messages convert unchanged", () => {
  const adapter = withResponsesAdjacency(
    openaiText("deepseek-chat" as never, { baseURL: "https://api.deepseek.com" }),
  ) as unknown as { convertMessagesToInput(messages: unknown[]): Item[] };

  const items = adapter.convertMessagesToInput([
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", function: { name: "finance_agent", arguments: "{}" } }],
    },
    { role: "tool", toolCallId: "c1", content: "done" },
  ]);

  assert.deepEqual(
    items.map((item) => item.type ?? item.role),
    ["message", "function_call", "function_call_output"],
  );
});
