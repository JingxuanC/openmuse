import { z } from "zod";

/**
 * A delegated run's progress, as the server streams it.
 *
 * A vertical agent is reached as a tool, so the chat has nothing to show until
 * that tool returns — which for a finance job takes minutes. The server forwards
 * the delegate's steps as CUSTOM frames beside the run; this reads them into the
 * one-line notes the chat shows while the run is still going on.
 */

/** The CUSTOM frame name the server sends. Frames are ephemeral: never messages. */
export const delegateProgressEvent = "openmuse.delegate_progress";

/** Only the newest lines are still true, so the older ones are dropped. */
export const maxDelegateProgressLines = 8;

const lineSchema = z.object({ agent: z.string(), text: z.string() });

export interface DelegateProgress {
  /** Assigned by the caller: the same line twice is still two list entries. */
  id: number;
  /** Which delegate is reporting; the server names it. */
  agent: string;
  text: string;
}

/**
 * Read one frame's value as a progress line, or `undefined` for anything else —
 * another frame's value, or a shape this app does not know. The line has no id
 * yet: whether it is shown at all is the caller's decision, not the frame's.
 */
export function parseDelegateProgress(value: unknown): Omit<DelegateProgress, "id"> | undefined {
  const parsed = lineSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Append a line, keeping only the most recent ones. */
export function addDelegateProgress(
  lines: DelegateProgress[],
  line: DelegateProgress,
): DelegateProgress[] {
  return [...lines, line].slice(-maxDelegateProgressLines);
}
