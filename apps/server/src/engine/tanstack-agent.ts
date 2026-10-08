import { randomUUID } from "node:crypto";
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/core";
import {
  BuiltInAgent,
  convertInputToTanStackAI,
  defineTool,
  type ToolDefinition,
} from "@copilotkit/runtime/v2";
import { chat, maxIterations, type SchemaInput, toolDefinition } from "@tanstack/ai";
import { type AnthropicChatModel, anthropicText } from "@tanstack/ai-anthropic";
import { type GeminiTextModel, geminiText } from "@tanstack/ai-gemini";
import { type OpenAIChatModel, openaiText } from "@tanstack/ai-openai";
import { map, mergeMap, type Observable } from "rxjs";
import { z } from "zod";
import { MODEL_MAX_RETRIES } from "../config.ts";

// Same "provider/model" strings, env vars and base URL formats as the AI SDK resolver in
// @copilotkit/runtime. Each provider SDK retries transient failures up to MODEL_MAX_RETRIES times.
function adapter(spec: string) {
  const [, provider = "", model = ""] = spec.trim().match(/^([^/:]*)[/:](.*)$/) ?? [];
  if (!provider || !model.trim())
    throw new Error(
      `Invalid model string "${spec}". Use "openai/gpt-5", "anthropic/claude-sonnet-4.5", or "google/gemini-2.5-pro".`,
    );
  const id = model.trim();
  switch (provider.toLowerCase()) {
    case "openai":
      return withResponsesAdjacency(
        openaiText(id as OpenAIChatModel, {
          baseURL: process.env.OPENAI_BASE_URL,
          maxRetries: MODEL_MAX_RETRIES,
        }),
      );
    case "anthropic":
      // The AI SDK base URL ends in /v1; the Anthropic SDK adds /v1 itself.
      return anthropicText(id as AnthropicChatModel, {
        baseURL: process.env.ANTHROPIC_BASE_URL?.replace(/\/v1\/?$/, ""),
        maxRetries: MODEL_MAX_RETRIES,
      });
    case "google":
    case "gemini":
    case "google-gemini":
      // The AI SDK base URL ends in /v1beta; @google/genai adds the API version itself.
      return geminiText(id as GeminiTextModel, {
        httpOptions: {
          baseUrl: process.env.GOOGLE_GENERATIVE_AI_BASE_URL?.replace(/\/v1beta\/?$/, ""),
          // @google/genai counts the first call in `attempts`.
          retryOptions: { attempts: MODEL_MAX_RETRIES + 1 },
        },
      });
    default:
      throw unknownProvider(provider, spec);
  }
}

/**
 * Responses-style backends (DeepSeek verified by probe) reject a `function_call` item unless
 * its `function_call_output` follows immediately. The stock converter expands an assistant
 * message into function_call items and THEN its text, so any reply that mixes text with tool
 * calls — including ones the model produces mid-loop — 400s on the next request. Split such
 * messages before conversion so text lands first and call → output stay adjacent.
 */
export function withResponsesAdjacency<T>(textAdapter: T): T {
  const target = textAdapter as {
    convertMessagesToInput?: (messages: unknown[]) => unknown[];
  };
  if (typeof target.convertMessagesToInput !== "function") return textAdapter;
  const original = target.convertMessagesToInput.bind(textAdapter);
  target.convertMessagesToInput = (messages: unknown[]) => {
    const split = (
      messages as { role?: string; toolCalls?: unknown[]; content?: unknown }[]
    ).flatMap((message) =>
      message.role === "assistant" &&
      message.toolCalls?.length &&
      ((typeof message.content === "string" && message.content.trim()) ||
        (Array.isArray(message.content) && message.content.length))
        ? [
            { ...message, toolCalls: undefined },
            { ...message, content: "" },
          ]
        : [message],
    );
    return original(split);
  };
  return textAdapter;
}

/** With OPENAI_BASE_URL set, a gateway model ID most likely needs the openai/ prefix. */
export function unknownProvider(
  provider: string,
  spec: string,
  baseUrl = process.env.OPENAI_BASE_URL,
) {
  const hint = baseUrl?.trim()
    ? ` For a model on your OPENAI_BASE_URL gateway, use "openai/${spec.trim()}".`
    : "";
  return new Error(
    `Unknown provider "${provider}" in "${spec}". Supported: openai, anthropic, google (gemini).${hint}`,
  );
}

// The classic BuiltInAgent always offers these two state tools. The converter turns their
// results into STATE_SNAPSHOT / STATE_DELTA events.
const stateTools = [
  defineTool({
    name: "AGUISendStateSnapshot",
    description: "Replace the entire application state with a new snapshot",
    parameters: z.object({ snapshot: z.any().describe("The complete new state object") }),
    execute: async ({ snapshot }) => ({ success: true, snapshot }),
  }),
  defineTool({
    name: "AGUISendStateDelta",
    description: "Apply incremental updates to application state using JSON Patch operations",
    parameters: z.object({
      delta: z
        .array(
          z.object({
            op: z.enum(["add", "replace", "remove"]).describe("The operation to perform"),
            path: z.string().describe("JSON Pointer path (e.g., '/foo/bar')"),
            value: z
              .any()
              .optional()
              .describe(
                "The value to set. Required for 'add' and 'replace' operations, ignored for 'remove'.",
              ),
          }),
        )
        .describe("Array of JSON Patch operations"),
    }),
    execute: async ({ delta }) => ({ success: true, delta }),
  }),
];

/**
 * DeepSeek's Responses endpoint rejects the whole request ("No tool output found for tool
 * call ...") unless every `function_call` item is immediately followed by its
 * `function_call_output` — a controlled probe showed adjacent = 200, separated = 400. The
 * TanStack converter expands one assistant message into function_call item(s) and THEN its
 * text content, so any assistant message with both text and tool calls replays as
 * call → text → output and 400s; a run killed mid call also leaves resultless calls.
 *
 * Normalize replayed history into the shape DeepSeek accepts: assistant text is split into
 * its own message first, then a calls-only message, then each call's result immediately
 * after. Resultless (interrupted) calls are dropped, results without a surviving call are
 * dropped, and duplicate call ids keep only their first occurrence.
 */
export function sanitizeOrphanToolCalls(
  messages: RunAgentInput["messages"],
): RunAgentInput["messages"] {
  type Msg = RunAgentInput["messages"][number];
  const results = new Map<string, Msg>();
  for (const message of messages)
    if (message.role === "tool" && message.toolCallId && !results.has(message.toolCallId))
      results.set(message.toolCallId, message);

  const sanitized: RunAgentInput["messages"] = [];
  const emittedCalls = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") continue; // re-inserted right after its call, or dropped
    if (message.role !== "assistant" || !message.toolCalls?.length) {
      sanitized.push(message);
      continue;
    }
    const content = typeof message.content === "string" ? message.content.trim() : "";
    if (content) sanitized.push({ ...message, toolCalls: undefined });
    const calls = message.toolCalls.filter(
      (call) => !emittedCalls.has(call.id) && results.has(call.id),
    );
    for (const call of calls) emittedCalls.add(call.id);
    if (!calls.length) continue;
    sanitized.push({ ...message, content: "", toolCalls: calls });
    for (const call of calls) sanitized.push(results.get(call.id) as Msg);
  }
  return sanitized;
}

/** A BuiltInAgent in TanStack factory mode with the options of the classic AI SDK mode. */
export function tanstackAgent(options: {
  model: string;
  maxSteps: number;
  tools: ToolDefinition[];
  prompt: string;
  /** Said when the step limit, not the model, ends a run; otherwise the reply just stops. */
  stepLimitNote?: string;
}) {
  const agent = new BuiltInAgent({
    type: "tanstack",
    factory: ({ input, abortController }) => {
      const converted = convertInputToTanStackAI(input);
      // Build the system prompt like the classic mode. It does not forward system messages.
      let system = options.prompt;
      if (input.context.length) {
        system += "\n## Context from the application\n";
        for (const ctx of input.context) system += `${ctx.description}:\n${ctx.value}\n`;
      }
      if (
        input.state !== undefined &&
        input.state !== null &&
        !(typeof input.state === "object" && Object.keys(input.state).length === 0)
      )
        system += `\n## Application State\nThis is state from the application that you can edit by calling AGUISendStateSnapshot or AGUISendStateDelta.\n\`\`\`json\n${JSON.stringify(input.state, null, 2)}\n\`\`\`\n`;
      return chat({
        adapter: adapter(options.model),
        messages: converted.messages,
        systemPrompts: system ? [system] : [],
        tools: [
          ...converted.tools,
          ...[...options.tools, ...stateTools].map((tool) =>
            toolDefinition({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.parameters as SchemaInput,
            }).server((args) => (tool.execute as (args: unknown) => Promise<unknown>)(args)),
          ),
        ],
        agentLoopStrategy: maxIterations(options.maxSteps),
        abortController,
      });
    },
  });
  const run = agent.run.bind(agent);
  agent.run = (input: RunAgentInput) => {
    const events = splitTextAtToolCalls(
      run({ ...input, messages: sanitizeOrphanToolCalls(input.messages) }),
    );
    return options.stepLimitNote
      ? reportStepLimit(events, options.maxSteps, options.stepLimitNote)
      : events;
  };
  return agent;
}

/**
 * maxIterations ends the loop after the last allowed tool step without a final model reply.
 * When a run ends that way, add a short assistant message so it does not stop silently.
 */
export function reportStepLimit(events: Observable<BaseEvent>, maxSteps: number, note: string) {
  let steps = 0;
  let phase: "text" | "calling" | "results" = "text";
  return events.pipe(
    mergeMap((event): BaseEvent[] => {
      if (event.type === EventType.TOOL_CALL_START) {
        // Parallel calls of one model step arrive together; results end the step.
        if (phase !== "calling") steps++;
        phase = "calling";
      } else if (event.type === EventType.TOOL_CALL_RESULT) phase = "results";
      else if (event.type === EventType.TEXT_MESSAGE_CHUNK) phase = "text";
      else if (event.type === EventType.RUN_FINISHED && phase === "results" && steps >= maxSteps)
        return [
          {
            type: EventType.TEXT_MESSAGE_CHUNK,
            messageId: randomUUID(),
            role: "assistant",
            delta: note,
          } as BaseEvent,
          event,
        ];
      return [event];
    }),
  );
}

// ponytail: the TanStack converter in @copilotkit/runtime 1.70.1 uses one message ID for the
// whole run. Remove this when it starts a new ID for each step, like the classic mode does.
// Text after a tool call gets a new message ID, so each step's text is a separate message.
function splitTextAtToolCalls(events: Observable<BaseEvent>) {
  let messageId: string | undefined;
  let afterToolCall = false;
  return events.pipe(
    map((event) => {
      if (event.type === EventType.TEXT_MESSAGE_CHUNK) {
        if (!messageId || afterToolCall) messageId = randomUUID();
        afterToolCall = false;
        return { ...event, messageId };
      }
      if (event.type === EventType.TOOL_CALL_START) {
        afterToolCall = true;
        return messageId ? { ...event, parentMessageId: messageId } : event;
      }
      if (event.type === EventType.TOOL_CALL_RESULT) afterToolCall = true;
      return event;
    }),
  );
}
