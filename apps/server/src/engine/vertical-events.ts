/**
 * The parts of a delegate's run that AG-UI has no vocabulary for.
 *
 * LangAlpha sends its artifacts, the sources it read and what each sub-agent
 * said as CUSTOM frames (`langalpha.*`). They used to fall through the switch in
 * `runVerticalAgent` unread, so a person got a report with no way to open the
 * files it was built from. Everything here is best-effort: a frame shaped
 * differently than expected is dropped, never thrown, because one unreadable
 * artifact must not fail the run that produced it.
 */

const artifactEvent = "langalpha.artifact";
const provenanceEvent = "langalpha.provenance";
const agentTextEvent = "langalpha.agent_text";
const interruptEvent = "langalpha.interrupt";
const threadEvent = "langalpha.thread";

/** A run that emits these without bound would otherwise carry them into the model's context. */
const artifactLimit = 50;
const sourceLimit = 20;
const agentLimit = 10;
const titleLimit = 200;
const pathLimit = 300;
const excerptLimit = 300;
const questionLimit = 1000;
const rawQuestionLimit = 500;
const optionLimit = 20;
const optionTextLimit = 300;

export interface VerticalArtifact {
  /** LangAlpha's own classification: file_operation, chart_annotation, html_widget, … */
  type: string;
  id?: string;
  title: string;
  status?: string;
  /** Workspace-relative path, when this artifact is a file the proxy can serve. */
  path?: string;
}

export interface VerticalSource {
  title?: string;
  url?: string;
}

export interface VerticalSubagentNote {
  agent: string;
  excerpt: string;
}

/**
 * The rich fields of a result. Every one is optional and present only when the
 * delegate actually sent something, so the tool result the model reads is
 * unchanged for a delegate that emits nothing.
 */
export interface VerticalRichResult {
  artifacts?: VerticalArtifact[];
  sources?: VerticalSource[];
  subagentNotes?: VerticalSubagentNote[];
}

/**
 * A delegate that stopped to ask the user something. Both a first run and every
 * resume end on one of these, so it is parsed once here rather than twice.
 */
export interface VerticalInterrupt {
  interruptId: string;
  /** The delegate's own thread, which the interrupt frame carries when it has one. */
  threadId?: string;
  /** LangAlpha's classification; only approvals have one today. */
  kind?: string;
  question: string;
  options?: string[];
  allowMultiple?: boolean;
  /** Which proposed action an approval decides; absent on everything else. */
  attemptId?: string;
}

/** The interrupt as the model sees it: the thread a resume needs rides beside it. */
export type VerticalInterruptResult = Omit<VerticalInterrupt, "threadId">;

/**
 * The result fields a delegate leaves behind when it interrupts. `guidance` is
 * written for the model, not the person: the delegate reaches the user through
 * OpenMuse's own agent, which owns the reply and the resume call.
 */
export interface VerticalAwaitingInput {
  status: "awaiting_input";
  interrupt: VerticalInterruptResult;
  delegateThreadId?: string;
  guidance: string;
}

export const awaitingInputGuidance =
  "这不是错误，也不是任务失败：金融 agent 需要用户先回答一个问题才能继续。" +
  "请把 interrupt.question 原样转达给用户；若它带有 options 且你有 present_choices 工具，就用它呈现这些选项，否则在回复里逐条列出，请用户用文字回答。" +
  "拿到用户回答后，再次调用本工具，传 task（可简述原任务）、resumeInterruptId（本次的 interrupt.interruptId）、resumeAnswer（用户回答原文）和 delegateThreadId（本次结果里的值），即可在同一会话里继续。" +
  "若 interrupt 带有 kind 或 attemptId（审批类提问），必须原样带上 resumeKind 和 resumeAttemptId，否则审批无法对应到具体动作。";

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function fields(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The first of `values` that carries non-blank text. */
function firstText(limit: number, ...values: unknown[]): string | undefined {
  for (const value of values) {
    const found = text(value, limit);
    if (found) return found;
  }
  return undefined;
}

/** Exported so a progress line is titled by the same parser the result uses. */
export function artifactOf(value: unknown): VerticalArtifact | undefined {
  const frame = fields(value);
  const type = text(frame?.artifact_type, 100);
  if (!frame || !type) return undefined;
  const payload = fields(frame.payload) ?? {};
  // Artifact types spell the same thing differently: a file operation reports
  // file_path, a widget or chart reports its own name.
  const path = firstText(pathLimit, payload.file_path, payload.path);
  const id = text(frame.artifact_id, 200);
  const status = text(frame.status, 40);
  return {
    type,
    title:
      firstText(
        titleLimit,
        path,
        payload.filename,
        payload.file_name,
        payload.title,
        payload.name,
      ) ?? type,
    ...(id ? { id } : {}),
    ...(status ? { status } : {}),
    ...(path ? { path } : {}),
  };
}

function sourceOf(value: unknown): VerticalSource | undefined {
  const frame = fields(value);
  if (!frame) return undefined;
  const identifier = text(frame.identifier, 2048);
  // A provenance record carries no `url` field: for a web source the identifier
  // *is* the address, while other source types use it as a path or an id.
  const url =
    firstText(2048, frame.url) ??
    (identifier && /^https?:\/\//i.test(identifier) ? identifier : undefined);
  const title = firstText(titleLimit, frame.title, frame.detail, frame.provider);
  if (!url && !title) return undefined;
  return { ...(title ? { title } : {}), ...(url ? { url } : {}) };
}

/** Exported for the same reason as `artifactOf`: one parse, two readers. */
export function noteOf(value: unknown): VerticalSubagentNote | undefined {
  const frame = fields(value);
  const agent = text(frame?.agent, 100);
  const excerpt = text(frame?.content, excerptLimit);
  return agent && excerpt ? { agent, excerpt } : undefined;
}

/**
 * A path the sweep may offer for download: workspace-relative, and outside the
 * delegate's own bookkeeping (`.agents/` memory, `_internal/` machinery), which
 * a person has no use for.
 */
function isWorkspaceRelative(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= pathLimit &&
    !path.startsWith("/") &&
    !path.includes("..") &&
    !path.split("/").some((part) => part.startsWith(".") || part === "_internal")
  );
}

function optionsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options: string[] = [];
  for (const entry of value) {
    const option = text(entry, optionTextLimit);
    if (option && options.length < optionLimit) options.push(option);
  }
  return options.length ? options : undefined;
}

/**
 * Nothing readable arrived, and a question the model cannot see at all would
 * leave it with an interrupt it can neither report nor explain: the raw request
 * is still better than that.
 */
function rawQuestion(requests: unknown[]): string {
  return JSON.stringify(requests).slice(0, rawQuestionLimit);
}

/**
 * One interrupt frame, in whichever of its shapes arrived. Both are keyed by
 * `interrupt_id` — without it the delegate has no way to match an answer to the
 * question, so a frame lacking one is not actionable and is dropped.
 */
function interruptOf(value: unknown): VerticalInterrupt | undefined {
  const frame = fields(value);
  const interruptId = firstText(200, frame?.interrupt_id, frame?.interruptId);
  if (!frame || !interruptId) return undefined;
  const requests = Array.isArray(frame.action_requests) ? frame.action_requests : [];
  const request = fields(requests[0]);
  const threadId = firstText(200, frame.thread_id, frame.threadId);
  const kind = text(frame.kind, 100);
  const attemptId = firstText(200, request?.attempt_id, request?.attemptId);
  const shared = { interruptId, ...(threadId ? { threadId } : {}), ...(kind ? { kind } : {}) };

  if (request?.type === "ask_user_question") {
    const options = optionsOf(request.options);
    return {
      ...shared,
      question: firstText(questionLimit, request.question) ?? rawQuestion(requests),
      ...(options ? { options } : {}),
      // A single-select question and an unstated one are not the same thing.
      ...(typeof request.allow_multiple === "boolean"
        ? { allowMultiple: request.allow_multiple }
        : {}),
    };
  }
  // An approval asks the user to accept one proposed action, and the attempt id
  // is what tells the delegate which action the answer decides.
  if (kind === "order_approval" || attemptId) {
    const name = text(request?.name, 100);
    const args = request?.args === undefined ? undefined : text(JSON.stringify(request.args), 200);
    return {
      ...shared,
      question:
        firstText(questionLimit, request?.description, request?.question) ??
        firstText(questionLimit, name && args ? `${name} ${args}` : name) ??
        rawQuestion(requests),
      options: ["approve", "reject"],
      ...(attemptId ? { attemptId } : {}),
    };
  }
  return {
    ...shared,
    question:
      firstText(questionLimit, request?.question, request?.description, request?.message) ??
      rawQuestion(requests),
  };
}

/** `langalpha.thread`, which the delegate sends when it had to mint the thread itself. */
function threadOf(value: unknown): string | undefined {
  const frame = fields(value);
  return firstText(200, frame?.threadId, frame?.thread_id);
}

export class VerticalRichEvents {
  private readonly artifacts: VerticalArtifact[] = [];
  private readonly sources: VerticalSource[] = [];
  /** One excerpt per sub-agent: the last thing it said is the most complete. */
  private readonly notes = new Map<string, string>();
  /** The last interrupt seen: an earlier one in the same run is already answered. */
  private interrupt: VerticalInterrupt | undefined;
  /** The thread the delegate minted for itself, when it had to. */
  private thread: string | undefined;

  /** Feed one CUSTOM frame. Unknown names and malformed values are ignored. */
  collect(name: unknown, value: unknown): void {
    if (name === interruptEvent) {
      const interrupt = interruptOf(value);
      if (interrupt) this.interrupt = interrupt;
      return;
    }
    if (name === threadEvent) {
      const thread = threadOf(value);
      if (thread) this.thread = thread;
      return;
    }
    if (name === artifactEvent) {
      const artifact = artifactOf(value);
      if (artifact && this.artifacts.length < artifactLimit) this.artifacts.push(artifact);
      return;
    }
    if (name === provenanceEvent) {
      const source = sourceOf(value);
      if (source && this.sources.length < sourceLimit) this.sources.push(source);
      return;
    }
    if (name === agentTextEvent) {
      const note = noteOf(value);
      // An eleventh sub-agent is dropped rather than evicting one already reported.
      if (note && (this.notes.has(note.agent) || this.notes.size < agentLimit))
        this.notes.set(note.agent, note.excerpt);
    }
  }

  /**
   * What the model has to act on when the delegate stopped to ask something.
   * `fallbackThreadId` is for a resume, which already knows the thread it posted
   * to: the interrupt usually repeats it, but continuing must not depend on that.
   */
  pendingInput(fallbackThreadId?: string): VerticalAwaitingInput | undefined {
    if (!this.interrupt) return undefined;
    const { threadId, ...interrupt } = this.interrupt;
    const delegateThreadId = threadId ?? fallbackThreadId ?? this.thread;
    return {
      status: "awaiting_input",
      interrupt,
      ...(delegateThreadId ? { delegateThreadId } : {}),
      guidance: awaitingInputGuidance,
    };
  }

  /** Only what arrived: a delegate that sent nothing leaves the result as it was. */
  summary(): VerticalRichResult {
    return {
      ...(this.artifacts.length ? { artifacts: this.artifacts } : {}),
      ...(this.sources.length ? { sources: this.sources } : {}),
      ...(this.notes.size
        ? { subagentNotes: [...this.notes].map(([agent, excerpt]) => ({ agent, excerpt })) }
        : {}),
    };
  }

  /**
   * The directories the delegate worked in, read off artifact paths. A report
   * written by running a builder script emits no artifact frame of its own, so
   * the directories are how a post-run sweep finds it.
   */
  directories(): string[] {
    const dirs: string[] = [];
    for (const artifact of this.artifacts) {
      const index = artifact.path?.lastIndexOf("/") ?? -1;
      if (index <= 0) continue;
      const dir = artifact.path?.slice(0, index) ?? "";
      if (!dirs.includes(dir) && dirs.length < 5) dirs.push(dir);
    }
    return dirs;
  }

  /**
   * A file the post-run sweep found in a touched directory. Deduplicated against
   * everything already collected, because the same file may well have a frame.
   */
  collectPath(path: string): void {
    if (!isWorkspaceRelative(path) || this.artifacts.length >= artifactLimit) return;
    if (this.artifacts.some((artifact) => artifact.path === path)) return;
    const title = path.slice(path.lastIndexOf("/") + 1);
    this.artifacts.push({ type: "file", title, status: "completed", path });
  }
}
