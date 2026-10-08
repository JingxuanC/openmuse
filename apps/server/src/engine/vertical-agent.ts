import { randomUUID } from "node:crypto";
import type { HttpAgentFetchFn } from "@ag-ui/client";
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/core";
import { defineTool, type ToolDefinition } from "@copilotkit/runtime/v2";
import { z } from "zod";
import { createLangAlphaAgent } from "../agui.ts";
import type { VerticalAgentSpec } from "../config.ts";
import {
  type VerticalInterruptResult,
  VerticalRichEvents,
  type VerticalRichResult,
} from "./vertical-events.ts";
import { sweepDeliverables } from "./vertical-files.ts";
import { type VerticalProgress, VerticalProgressTracker } from "./vertical-progress.ts";
import { resumeVerticalAgent } from "./vertical-resume.ts";

/**
 * A vertical agent as a tool rather than as a backend. The conversation stays
 * with OpenMuse's own agent, which owns the prompt, memory and the rest of the
 * tools; only the routed job leaves, over the same AG-UI wire `agui.ts`
 * already speaks, so LangAlpha needs no new endpoint for it.
 *
 * The delegate runs under the caller's own token and the chat's thread id, so
 * whatever it reads or writes stays inside that person's workspace.
 */

/**
 * Fifteen minutes, matching the delegate's own turn ceiling (LangAlpha's
 * AGUI_TURN_TIMEOUT_SEC): production runs that ask questions and then write a
 * full report take 5–10 minutes, and the old five minutes cut the writing
 * phase off after the Q&A had already succeeded.
 */
export const defaultVerticalTimeoutMs = 900_000;
/** Reports are read by a model, not scrolled by a person, so this bounds context. */
export const defaultMaxResultChars = 20_000;

export interface VerticalAgentResult extends VerticalRichResult {
  /** The delegate's own words, already truncated to `maxResultChars`. */
  report?: string;
  error?: string;
  /** The run was cut short but had said something worth keeping. */
  aborted?: boolean;
  truncated?: boolean;
  toolCalls?: number;
  /** Thinking blocks, counted at THINKING_START: the delegate's own reasoning steps. */
  thinkingEvents?: number;
  /** Set when the delegate stopped to ask the user something; read `guidance` next. */
  status?: "awaiting_input";
  /** The delegate's question, prepared by `vertical-events.ts`. */
  interrupt?: VerticalInterruptResult;
  /** The delegate's own thread: an answer has to be resumed there, not on the chat's. */
  delegateThreadId?: string;
  /** How to put the question to the user and how to send the answer back. */
  guidance?: string;
}

export interface VerticalAgentRunOptions {
  task: string;
  context?: string;
  /** The chat thread, so the delegate's history stays with the conversation. */
  threadId: string;
  /** The caller's bearer token without its prefix; absent runs unauthenticated. */
  token?: string;
  /** The chat turn's own signal; aborting the turn aborts the delegate. */
  signal: AbortSignal;
  /** Called as the run goes on, so the chat can show work it has no result for yet. */
  onProgress?: (item: VerticalProgress) => void;
  /** Overridden by tests; production always adapts the real network fetch. */
  fetch?: HttpAgentFetchFn;
}

/**
 * Run one job on a delegate and collect its answer.
 *
 * Failures are returned, never thrown: this runs inside a tool the model called,
 * and a thrown error would end the whole chat turn instead of feeding the
 * failure back as a tool result the model can report or retry.
 */
export async function runVerticalAgent(
  spec: VerticalAgentSpec,
  options: VerticalAgentRunOptions,
): Promise<VerticalAgentResult> {
  const maxChars = spec.maxResultChars ?? defaultMaxResultChars;
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(spec.timeoutMs ?? defaultVerticalTimeoutMs),
  ]);
  const inner = options.fetch ?? fetch;
  const agent = createLangAlphaAgent({
    url: spec.url,
    token: options.token,
    // HttpAgent posts with its own AbortController. The caller's signal has to
    // reach the socket through here, or a timeout would only stop the reading
    // while the delegate kept working.
    fetch: (url, init) => inner(url, { ...init, signal }),
  });
  const input: RunAgentInput = {
    threadId: options.threadId,
    runId: randomUUID(),
    state: {},
    messages: [
      {
        id: randomUUID(),
        role: "user",
        content: options.context ? `${options.task}\n\n上下文：\n${options.context}` : options.task,
      },
    ],
    tools: [],
    context: [],
    forwardedProps: {},
  };
  const tracker = options.onProgress ? new VerticalProgressTracker() : undefined;
  return new Promise<VerticalAgentResult>((resolve) => {
    let report = "";
    let toolCalls = 0;
    let thinkingEvents = 0;
    let failure: string | undefined;
    const rich = new VerticalRichEvents();
    let subscription: { unsubscribe(): void } | undefined;
    let settled = false;
    const settle = (result: VerticalAgentResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      subscription?.unsubscribe();
      resolve(result);
    };
    // A report written by running a builder script emits no artifact frame of
    // its own; the sweep recovers it from the directories the run touched. It
    // rides the same fetch as the run, so a test's mock covers both.
    const finish = (build: () => VerticalAgentResult) => {
      if (!options.token) return settle(build());
      void sweepDeliverables(spec, `Bearer ${options.token}`, rich, {
        fetch: inner as typeof fetch,
      }).then(
        () => settle(build()),
        () => settle(build()),
      );
    };
    // Partial text beats nothing: a delegate that was cut off mid-answer has
    // usually already found the part the person asked about.
    const onAbort = () =>
      finish(() =>
        report
          ? {
              report: report.slice(0, maxChars),
              aborted: true,
              toolCalls,
              thinkingEvents,
              ...rich.summary(),
            }
          : { error: `The ${spec.name} run stopped before it produced a result` },
      );
    signal.addEventListener("abort", onAbort, { once: true });
    subscription = agent.run(input).subscribe({
      next: (event: BaseEvent) => {
        const item = tracker?.collect(event);
        if (item) options.onProgress?.(item);
        switch (event.type) {
          case EventType.TEXT_MESSAGE_CONTENT:
            report += event.delta;
            break;
          case EventType.TOOL_CALL_START:
            toolCalls++;
            break;
          case EventType.THINKING_START:
            thinkingEvents++;
            break;
          case EventType.CUSTOM:
            // Artifacts, sources and sub-agent text, which the AG-UI vocabulary
            // has no event for and the delegate's report cannot carry.
            rich.collect(event.name, event.value);
            break;
          case EventType.RUN_ERROR:
            // The client validates frames against EventSchemas before they get
            // here, so this string check never takes its fallback branch; it is
            // what BaseEvent's passthrough index signature leaves us to type on.
            failure = typeof event.message === "string" ? event.message : "The run failed";
            break;
          default:
            break;
        }
      },
      error: (error: unknown) =>
        settle({
          error: error instanceof Error ? error.message : `The ${spec.name} agent failed`,
        }),
      complete: () =>
        finish(() =>
          failure
            ? { error: failure }
            : {
                report: report.slice(0, maxChars),
                truncated: report.length > maxChars,
                toolCalls,
                thinkingEvents,
                ...rich.summary(),
                // An interrupted run ends like any other, so the question has to
                // be read off what it collected rather than off how it ended.
                ...rich.pendingInput(),
              },
        ),
    });
    // A signal that had already fired would never reach the listener above.
    if (signal.aborted) onAbort();
  });
}

/**
 * The delegate as a tool the conversation model can call.
 *
 * The description is the spec's, verbatim: routing is the prompt's job, and a
 * rewritten description would be a second, quieter place to encode it.
 */
export function verticalAgentTool(
  spec: VerticalAgentSpec,
  options: {
    threadId: string;
    /** The caller's raw `Authorization` header, read per call rather than captured. */
    getToken: () => string | undefined;
    signal: AbortSignal;
    /** Called as the delegated run goes on, so the chat is not blank until it ends. */
    onProgress?: (item: VerticalProgress) => void;
  },
): ToolDefinition {
  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: z.object({
      task: z.string().min(1).max(8000),
      context: z.string().max(8000).optional(),
      resumeInterruptId: z
        .string()
        .max(300)
        .optional()
        .describe(
          "The interrupt.interruptId from a previous result whose status was awaiting_input. Answers that question instead of starting a new job.",
        ),
      resumeAnswer: z
        .string()
        .max(8000)
        .optional()
        .describe(
          "The user's answer to that interrupt, verbatim. Only meaningful together with resumeInterruptId.",
        ),
      delegateThreadId: z
        .string()
        .max(300)
        .optional()
        .describe(
          "The delegateThreadId from that same awaiting_input result. Only meaningful together with resumeInterruptId.",
        ),
      resumeKind: z
        .string()
        .max(100)
        .optional()
        .describe(
          "The interrupt.kind from that same result. An approval (order_approval) cannot be answered without it.",
        ),
      resumeAttemptId: z
        .string()
        .max(300)
        .optional()
        .describe(
          "The interrupt.attemptId from that same result, when it carries one. Approvals are keyed by it.",
        ),
    }),
    execute: async ({
      task,
      context,
      resumeInterruptId,
      resumeAnswer,
      delegateThreadId,
      resumeKind,
      resumeAttemptId,
    }) => {
      const authorization = options.getToken();
      // The delegate would answer as its own anonymous user, in the wrong
      // workspace or in none, so an unauthenticated call is refused here.
      if (!authorization) return { error: "该能力需要登录后使用" };
      const token = authorization.replace(/^Bearer\s+/i, "");
      // Resuming carries no task of its own: the delegate already has the job,
      // and what it is missing is only the answer.
      if (resumeInterruptId) {
        if (!delegateThreadId) return { error: "缺少 delegateThreadId，无法回到上次提问的会话" };
        if (!resumeAnswer) return { error: "缺少 resumeAnswer，没有用户回答无法继续" };
        return resumeVerticalAgent(spec, {
          threadId: delegateThreadId,
          interruptId: resumeInterruptId,
          answer: resumeAnswer,
          kind: resumeKind,
          attemptId: resumeAttemptId,
          token,
          signal: options.signal,
          onProgress: options.onProgress,
        });
      }
      return runVerticalAgent(spec, {
        task,
        context,
        threadId: options.threadId,
        token,
        signal: options.signal,
        onProgress: options.onProgress,
      });
    },
  });
}
