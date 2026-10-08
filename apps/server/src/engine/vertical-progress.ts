import { type BaseEvent, EventType } from "@ag-ui/core";
import { artifactOf, noteOf } from "./vertical-events.ts";

/**
 * What a delegate is doing, while it is doing it.
 *
 * A delegated run is minutes of silence: the conversation model called a tool,
 * and the chat has nothing to show until that tool returns. The delegate's own
 * stream is the only evidence in between, but it is far too detailed — and far
 * too long — to forward as it stands. This reduces it to a handful of one-line
 * notes the person can watch arrive.
 */

/** The CUSTOM frame the chat listens for; its value is a `VerticalProgress`. */
export const delegateProgressEvent = "openmuse.delegate_progress";

export interface VerticalProgress {
  kind: "tool" | "thinking" | "note" | "artifact" | "question" | "status";
  text: string;
}

/** One line's worth: a delegate that narrates every step cannot fill the screen. */
const textLimit = 140;
/** A run that emits without bound would otherwise stream without bound either. */
const lineLimit = 50;
/** Enough of a sub-agent's remark to see what it is about. */
const excerptLimit = 120;

/**
 * The delegate's stream, in the shape the chat can show.
 *
 * Both halves of a delegation feed it: a first run as AG-UI events, a resume as
 * LangAlpha's own SSE frames. They carry the same payloads under different
 * names, so the payload parsers are shared and only the envelopes differ.
 */
export class VerticalProgressTracker {
  private last: string | undefined;
  private emitted = 0;

  /** One AG-UI event from the delegate's run. */
  collect(event: BaseEvent): VerticalProgress | undefined {
    switch (event.type) {
      case EventType.TOOL_CALL_START:
        return this.tool(event.toolCallName);
      case EventType.THINKING_START:
        return this.thinking();
      case EventType.CUSTOM:
        return this.custom(event.name, event.value);
      default:
        return undefined;
    }
  }

  /**
   * A tool call. AG-UI names the tool; a resume's frame does not, and a line
   * that says less is still better than no line at all.
   */
  tool(name?: unknown): VerticalProgress | undefined {
    const named = typeof name === "string" ? name.trim() : "";
    return this.add("tool", named ? `调用工具 ${named}` : "调用工具");
  }

  /** Consecutive starts collapse into one line through the dedupe in `add`. */
  thinking(): VerticalProgress | undefined {
    return this.add("thinking", "思考中…");
  }

  /** A `langalpha.artifact` frame, titled by the parser the result already uses. */
  artifact(value: unknown): VerticalProgress | undefined {
    const artifact = artifactOf(value);
    return artifact ? this.add("artifact", `产出 ${artifact.title}`) : undefined;
  }

  /** A `langalpha.agent_text` frame: the last thing one sub-agent said. */
  note(value: unknown): VerticalProgress | undefined {
    const note = noteOf(value);
    return note
      ? this.add("note", `${note.agent}: ${note.excerpt.slice(0, excerptLimit)}`)
      : undefined;
  }

  /** A `langalpha.interrupt` frame: the delegate has stopped to ask something. */
  question(): VerticalProgress | undefined {
    return this.add("question", "等待你的回答…");
  }

  private custom(name: unknown, value: unknown): VerticalProgress | undefined {
    switch (name) {
      case "langalpha.artifact":
        return this.artifact(value);
      case "langalpha.agent_text":
        return this.note(value);
      case "langalpha.interrupt":
        return this.question();
      default:
        return undefined;
    }
  }

  /**
   * The one gate every line passes: identical neighbours collapse, nothing past
   * the cap is shown, and what is shown fits on a line.
   */
  private add(kind: VerticalProgress["kind"], text: string): VerticalProgress | undefined {
    const line = text.slice(0, textLimit);
    if (!line || line === this.last || this.emitted >= lineLimit) return undefined;
    this.last = line;
    this.emitted++;
    return { kind, text: line };
  }
}
