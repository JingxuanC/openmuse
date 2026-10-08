import { HttpAgent, type HttpAgentFetchFn } from "@ag-ui/client";

/**
 * Wire adaptation for LangAlpha's AG-UI gateway (`POST /api/v1/agui/run`).
 *
 * The request half needs no translation. @ag-ui/client already posts camelCase
 * `threadId`/`runId`/`messages`/`tools`/`context`/`state`/`forwardedProps`, and
 * the gateway's `RunAgentInput` accepts exactly those — `extra="allow"` absorbs
 * the two it does not model (`context`, and `parentRunId` which the client
 * never sends). `toolCalls` on a message is the alias of its `tool_calls`.
 *
 * The response half has one incompatibility, and it has to be corrected below
 * the client rather than around it: @ag-ui/client validates every frame against
 * @ag-ui/core's zod `EventSchemas` before a subscriber sees it, so a frame that
 * fails to parse errors the whole run rather than degrading to a dropped event.
 *
 * `RUN_FINISHED.outcome` is that frame. AG-UI 0.0.59 types it as a
 * discriminated object (`{type: "success"}`); LangAlpha's `events.run_finished`
 * emits the bare string `"success"` and `translate.Translator` never passes
 * another value. Unadapted, a run streams its entire answer and then fails on
 * the final event.
 *
 * Everything else LangAlpha emits validates as written: `events.encode` frames
 * as `data: <json>\n\n` with the type inside the payload — which is what the
 * client's SSE reader expects, since it never reads an `event:` line — and
 * THINKING_*, TOOL_CALL_*, STEP_*, CUSTOM, RAW and RUN_ERROR all match.
 */

const FRAME_SEPARATOR = "\n\n";
const DATA_PREFIX = "data:";

/**
 * Rewrite one SSE frame, or return it untouched when there is nothing to adapt.
 *
 * Only a single-`data:`-line frame is considered: that is the shape `encode`
 * produces, and refusing multi-line frames keeps this from re-joining a payload
 * the client would have joined itself.
 */
export function adaptAguiFrame(frame: string): string {
  const lines = frame.split("\n");
  const dataLines = lines.filter((line) => line.startsWith(DATA_PREFIX));
  if (dataLines.length !== 1) return frame;
  const payload = dataLines[0].slice(DATA_PREFIX.length).replace(/^ /, "");
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    // Not JSON we can speak for; hand it to the client's own parser to report.
    return frame;
  }
  if (event.type !== "RUN_FINISHED" || event.outcome !== "success") return frame;
  // Only "success" is rewritten. An interrupt outcome would need the
  // `interrupts` array this server has no way to supply, so anything else is
  // left to fail loudly rather than be papered over into a false completion.
  const rewritten = `${DATA_PREFIX} ${JSON.stringify({ ...event, outcome: { type: "success" } })}`;
  return lines.map((line) => (line === dataLines[0] ? rewritten : line)).join("\n");
}

/** Re-frame an SSE body, leaving every other response untouched. */
async function adaptAguiResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.body || !contentType.includes("text/event-stream")) return response;
  const decoder = new TextDecoder();
  let buffered = "";
  const frames = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true });
      const complete = buffered.split(FRAME_SEPARATOR);
      // The trailing element is a partial frame, or "" on an exact boundary.
      buffered = complete.pop() ?? "";
      for (const frame of complete)
        controller.enqueue(new TextEncoder().encode(adaptAguiFrame(frame) + FRAME_SEPARATOR));
    },
    flush(controller) {
      if (buffered) controller.enqueue(new TextEncoder().encode(adaptAguiFrame(buffered)));
    },
  });
  return new Response(response.body.pipeThrough(frames), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** A fetch that adapts LangAlpha's frames, for `HttpAgent`'s `fetch` option. */
export function aguiFetch(inner: HttpAgentFetchFn = fetch): HttpAgentFetchFn {
  return async (url, requestInit) => adaptAguiResponse(await inner(url, requestInit));
}

export interface LangAlphaAgentOptions {
  /** The gateway's run endpoint, i.e. `AGENT_URL`. */
  url: string;
  /** Sent as a bearer token; see `.env.example` for what the gateway accepts. */
  token?: string;
  /** Overridden by tests; production always adapts the real network fetch. */
  fetch?: HttpAgentFetchFn;
}

/**
 * The AG-UI agent OpenMuse routes to when `AGENT_BACKEND=agui`.
 *
 * Built per request by `makeRuntime`, which is what lets CopilotKit stamp the
 * thread id and the conversation history onto it before the run.
 */
export function createLangAlphaAgent(options: LangAlphaAgentOptions): HttpAgent {
  return new HttpAgent({
    url: options.url,
    headers: options.token ? { Authorization: `Bearer ${options.token}` } : {},
    fetch: aguiFetch(options.fetch),
  });
}
