import type { VerticalAgentSpec } from "../config.ts";
import {
  defaultMaxResultChars,
  defaultVerticalTimeoutMs,
  type VerticalAgentResult,
} from "./vertical-agent.ts";
import { VerticalRichEvents } from "./vertical-events.ts";
import { sweepDeliverables, verticalApiBase } from "./vertical-files.ts";
import { type VerticalProgress, VerticalProgressTracker } from "./vertical-progress.ts";

/**
 * The answer half of a delegated run.
 *
 * An interrupt ends the AG-UI stream: the delegate asked the user something and
 * is waiting. The answer goes back through LangAlpha's own threads API rather
 * than the AG-UI gateway, and the reply to *that* is a plain SSE stream — the
 * type lives in an `event:` line instead of inside the payload, which is why
 * `@ag-ui/client` and `agui.ts` cannot read it. It is parsed here instead.
 */

export interface VerticalResumeOptions {
  /** The delegate's own thread, echoed back in the interrupt's result. */
  threadId: string;
  /** The interrupt being answered; the delegate keys its decisions by it. */
  interruptId: string;
  /** The user's answer, verbatim. */
  answer: string;
  /** LangAlpha's classification of the interrupt, when the caller still knows it. */
  kind?: string;
  /** Which proposed action an approval decides; absent outside approvals. */
  attemptId?: string;
  /** The caller's bearer token without its prefix; absent resumes unauthenticated. */
  token?: string;
  /** The chat turn's own signal; aborting the turn abandons the resume. */
  signal: AbortSignal;
  /** Called as the resume goes on, so the chat is not blank until it ends. */
  onProgress?: (item: VerticalProgress) => void;
  /** Overridden by tests; production always uses the network fetch. */
  fetch?: typeof fetch;
}

/** The user typed a refusal instead of an answer, and the delegate expects a decision. */
const rejection = /^(reject|拒绝|跳过)$/i;

export interface ResumeDecision {
  interruptId: string;
  answer: string;
  kind?: string;
  attemptId?: string;
}

/**
 * The body LangAlpha's threads API expects. An approval carries one decision per
 * proposed action, keyed by the attempt id the delegate minted, so it can tell
 * which action was accepted; anything else is a single decision the delegate
 * reads as the user's answer.
 */
export function buildResumeBody(decision: ResumeDecision): Record<string, unknown> {
  const type = rejection.test(decision.answer.trim()) ? "reject" : "approve";
  const messages = [{ role: "user", content: decision.answer }];
  const entry = { type, message: decision.answer };
  if (decision.kind === "order_approval" && decision.attemptId)
    return {
      messages,
      hitl_response: {
        [decision.interruptId]: { order_decisions: { [decision.attemptId]: entry } },
      },
    };
  return { messages, hitl_response: { [decision.interruptId]: { decisions: [entry] } } };
}

export interface SseFrame {
  event: string;
  data: string;
}

/**
 * A reader for LangAlpha's own framing. Chunks arrive mid-frame — a JSON payload
 * splits across reads routinely — so the partial tail has to survive between
 * them, and the last frame of a stream may have no blank line to end it.
 */
export class SseParser {
  private buffer = "";

  /** Decoded chunks in; complete frames out, in order. */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const parts = this.buffer.split("\n\n");
    // The trailing element is a partial frame, or "" on an exact boundary.
    this.buffer = parts.pop() ?? "";
    return parts.map(frameOf).filter((frame): frame is SseFrame => frame !== undefined);
  }

  /** The frame left over when the stream ended without its blank line. */
  flush(): SseFrame | undefined {
    const rest = this.buffer;
    this.buffer = "";
    return rest ? frameOf(rest) : undefined;
  }
}

function frameOf(raw: string): SseFrame | undefined {
  // `id:`, `retry:` and comments carry nothing this needs; a frame with no data
  // has no payload to route, whatever its event name says.
  const lines = raw.split("\n");
  const event = lines.find((line) => line.startsWith("event:"));
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  if (!data.length) return undefined;
  // Multi-line data is one payload the sender wrapped: joining it back is what
  // the SSE spec asks a reader to do.
  return { event: event?.slice(6).trim() ?? "", data: data.join("\n") };
}

/** A failed resume in the delegate's own words, whichever field carries them. */
function failureOf(value: Record<string, unknown>): string {
  for (const candidate of [value.error, value.message, value.error_message])
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  return "The resume failed";
}

/**
 * Read one SSE body to its end, handing each frame to `onFrame`. A handler
 * returning false stops the read: a stream that reported a failure may never
 * close, and the answer is already known.
 */
async function pump(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onFrame: (frame: SseFrame) => boolean,
): Promise<void> {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  // A real fetch errors its body when the run is aborted, but a body that never
  // does would hold this read open for as long as the socket stays up, so the
  // abort is raced against every read. The trailing catch keeps the loser of
  // that race from surfacing as an unhandled rejection.
  const ended = new Promise<never>((_, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  ended.catch(() => {});
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), ended]);
      if (done) break;
      // `stream: true` holds back a payload's trailing partial character.
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        if (!onFrame(frame)) return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const tail = parser.flush();
  if (tail) onFrame(tail);
}

/**
 * Answer one interrupt and collect what the delegate says next.
 *
 * Failures are returned, never thrown, for the same reason `runVerticalAgent`
 * returns them: this runs inside a tool the model called, and a thrown error
 * would end the whole chat turn instead of feeding the failure back as a result
 * the model can report to the person.
 */
export async function resumeVerticalAgent(
  spec: VerticalAgentSpec,
  options: VerticalResumeOptions,
): Promise<VerticalAgentResult> {
  const maxChars = spec.maxResultChars ?? defaultMaxResultChars;
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(spec.timeoutMs ?? defaultVerticalTimeoutMs),
  ]);
  const request = options.fetch ?? fetch;
  const rich = new VerticalRichEvents();
  const tracker = options.onProgress ? new VerticalProgressTracker() : undefined;
  const track = (item: VerticalProgress | undefined) => {
    if (item) options.onProgress?.(item);
  };
  let report = "";
  let toolCalls = 0;
  let failure: string | undefined;
  const onFrame = (frame: SseFrame): boolean => {
    let payload: unknown;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      // One unreadable frame is dropped: it must not fail the run around it.
      return true;
    }
    const value = (typeof payload === "object" && payload !== null ? payload : {}) as Record<
      string,
      unknown
    >;
    switch (frame.event) {
      case "message_chunk":
        // Reasoning and compaction deltas carry a content_type; the answer does not.
        if (value.content_type === undefined && typeof value.content === "string")
          report += value.content;
        return true;
      case "artifact":
        rich.collect("langalpha.artifact", payload);
        track(tracker?.artifact(payload));
        return true;
      case "provenance":
        rich.collect("langalpha.provenance", payload);
        return true;
      case "tool_calls":
        toolCalls++;
        // Unlike AG-UI's TOOL_CALL_START, this frame names no tool.
        track(tracker?.tool());
        return true;
      case "tool_call_result":
        toolCalls++;
        return true;
      case "interrupt":
        // A resumed run can interrupt again, and the second question is a new one.
        rich.collect("langalpha.interrupt", payload);
        track(tracker?.question());
        return true;
      case "error":
        failure = failureOf(value);
        return false;
      default:
        return true; // finish, metadata, compaction_chunk, …: nothing to collect.
    }
  };
  try {
    const response = await request(
      // The API root is read off the run endpoint, the same way the file proxy
      // reads it, so a gateway mounted under a prefix still resolves.
      `${verticalApiBase(spec.url)}/api/v1/threads/${encodeURIComponent(options.threadId)}/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        body: JSON.stringify(
          buildResumeBody({
            interruptId: options.interruptId,
            answer: options.answer,
            kind: options.kind,
            attemptId: options.attemptId,
          }),
        ),
        signal,
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { error: `resume 请求被拒绝 (${response.status})：${body.slice(0, 200)}` };
    }
    if (response.body) await pump(response.body, signal, onFrame);
  } catch (error) {
    // Partial text beats nothing: a resume cut off mid-answer has usually
    // already found the part the person asked about.
    if (signal.aborted) {
      if (report && options.token)
        await sweepDeliverables(spec, `Bearer ${options.token}`, rich, { fetch: request }).catch(
          () => {},
        );
      return report
        ? { report: report.slice(0, maxChars), aborted: true, toolCalls, ...rich.summary() }
        : { error: `The ${spec.name} resume stopped before it produced a result` };
    }
    return {
      error: error instanceof Error ? error.message : `The ${spec.name} resume failed`,
    };
  }
  if (failure) return { error: failure };
  // The same sweep as the first run: a report built by a script the delegate
  // ran is found in the touched directories, not in any frame.
  if (options.token)
    await sweepDeliverables(spec, `Bearer ${options.token}`, rich, { fetch: request }).catch(
      () => {},
    );
  return {
    report: report.slice(0, maxChars),
    truncated: report.length > maxChars,
    toolCalls,
    ...rich.summary(),
    // The thread is known here even when the frame omits it, so a second
    // question can always be answered.
    ...rich.pendingInput(options.threadId),
  };
}
