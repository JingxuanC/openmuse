import { EventType } from "@ag-ui/core";

/**
 * CopilotKit Intelligence derives thread messages from the persisted AG-UI event
 * stream platform-side. The local implementation keeps the same contract: the
 * realtime gateway persists raw events, and reads fold them back into the
 * ThreadMessage shape the runtime and client expect.
 */
export interface ThreadMessage {
  id: string;
  role: string;
  content?: unknown;
  activityType?: string;
  toolCalls?: { id: string; name: string; args: string }[];
  toolCallId?: string;
}

type EventRecord = Record<string, unknown> & { type?: string };

interface AgUiToolCall {
  id: string;
  function?: { name?: string; arguments?: string };
}

interface AgUiMessage {
  id: string;
  role: string;
  content?: unknown;
  toolCalls?: AgUiToolCall[];
  toolCallId?: string;
  activityType?: string;
}

function fromAgUiMessage(message: AgUiMessage): ThreadMessage {
  const result: ThreadMessage = { id: message.id, role: message.role };
  if (message.content !== undefined) result.content = message.content;
  if (message.activityType !== undefined) result.activityType = message.activityType;
  if (message.toolCallId !== undefined) result.toolCallId = message.toolCallId;
  if (message.toolCalls?.length)
    result.toolCalls = message.toolCalls.map((call) => ({
      id: call.id,
      name: call.function?.name ?? "",
      args: call.function?.arguments ?? "",
    }));
  return result;
}

/** Fold one thread's persisted events (in seq order) into its message history. */
export function deriveMessages(events: EventRecord[]): ThreadMessage[] {
  let messages: ThreadMessage[] = [];
  const byId = new Map<string, ThreadMessage>();
  const push = (message: ThreadMessage) => {
    if (byId.has(message.id)) return;
    byId.set(message.id, message);
    messages.push(message);
  };
  for (const event of events) {
    switch (event.type) {
      case EventType.RUN_STARTED: {
        // The runner stamps the not-yet-persisted input messages onto RUN_STARTED.
        const input = event.input as { messages?: AgUiMessage[] } | undefined;
        for (const message of input?.messages ?? []) push(fromAgUiMessage(message));
        break;
      }
      case EventType.MESSAGES_SNAPSHOT: {
        const snapshot = event.messages as AgUiMessage[] | undefined;
        if (!Array.isArray(snapshot)) break;
        messages = [];
        byId.clear();
        for (const message of snapshot) push(fromAgUiMessage(message));
        break;
      }
      case EventType.TEXT_MESSAGE_START: {
        push({ id: String(event.messageId), role: String(event.role ?? "assistant"), content: "" });
        break;
      }
      case EventType.TEXT_MESSAGE_CONTENT: {
        const message = byId.get(String(event.messageId));
        if (message) message.content = String(message.content ?? "") + String(event.delta ?? "");
        break;
      }
      case EventType.TOOL_CALL_START: {
        const parent = byId.get(String(event.parentMessageId));
        if (!parent) break;
        parent.toolCalls ??= [];
        if (!parent.toolCalls.some((call) => call.id === event.toolCallId))
          parent.toolCalls.push({
            id: String(event.toolCallId),
            name: String(event.toolCallName ?? ""),
            args: "",
          });
        break;
      }
      case EventType.TOOL_CALL_ARGS: {
        for (const message of messages) {
          const call = message.toolCalls?.find((candidate) => candidate.id === event.toolCallId);
          if (call) call.args += String(event.delta ?? "");
        }
        break;
      }
      case EventType.TOOL_CALL_RESULT: {
        push({
          id: String(event.messageId),
          role: "tool",
          toolCallId: String(event.toolCallId),
          content: event.content,
        });
        break;
      }
    }
  }
  return messages;
}

function pointerSegments(path: string): string[] {
  return path
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function resolvePointer(root: unknown, segments: string[]): unknown {
  let current = root;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    current = Array.isArray(current)
      ? current[Number(segment)]
      : (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Minimal RFC 6902 apply for the add/remove/replace ops STATE_DELTA uses. */
export function applyJsonPatch(state: unknown, delta: unknown): unknown {
  if (!Array.isArray(delta)) return state;
  let result = state;
  for (const operation of delta as { op?: string; path?: string; value?: unknown }[]) {
    if (typeof operation.path !== "string") continue;
    const segments = pointerSegments(operation.path);
    if (!segments.length) {
      if (operation.op === "add" || operation.op === "replace") result = operation.value;
      continue;
    }
    const parent = resolvePointer(result, segments.slice(0, -1));
    if (parent === null || typeof parent !== "object") continue;
    const key = segments.at(-1) as string;
    if (Array.isArray(parent)) {
      const index = key === "-" ? parent.length : Number(key);
      if (!Number.isInteger(index) || index < 0) continue;
      if (operation.op === "add") parent.splice(index, 0, operation.value);
      else if (operation.op === "replace" && index < parent.length) parent[index] = operation.value;
      else if (operation.op === "remove" && index < parent.length) parent.splice(index, 1);
    } else {
      const record = parent as Record<string, unknown>;
      if (operation.op === "add" || operation.op === "replace") record[key] = operation.value;
      else if (operation.op === "remove") delete record[key];
    }
  }
  return result;
}

export type ThreadStateFold =
  | { kind: "no-snapshot" }
  | { kind: "snapshot"; state: unknown; skippedDeltas: number };

/** Fold STATE_SNAPSHOT/STATE_DELTA events into the thread's current agent state. */
export function deriveState(events: EventRecord[]): ThreadStateFold {
  let state: unknown;
  let hasSnapshot = false;
  let skippedDeltas = 0;
  for (const event of events) {
    if (event.type === EventType.STATE_SNAPSHOT) {
      state = event.snapshot;
      hasSnapshot = true;
    } else if (event.type === EventType.STATE_DELTA) {
      if (hasSnapshot) state = applyJsonPatch(state, event.delta);
      else skippedDeltas += 1;
    }
  }
  return hasSnapshot ? { kind: "snapshot", state, skippedDeltas } : { kind: "no-snapshot" };
}
