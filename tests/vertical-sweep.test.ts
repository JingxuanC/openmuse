import assert from "node:assert/strict";
import test from "node:test";

import type { VerticalAgentSpec } from "../apps/server/src/config.ts";
import { runVerticalAgent } from "../apps/server/src/engine/vertical-agent.ts";
import { VerticalRichEvents } from "../apps/server/src/engine/vertical-events.ts";
import { sweepDeliverables } from "../apps/server/src/engine/vertical-files.ts";

/**
 * The deliverable sweep: a report the delegate wrote by *running* a builder
 * script has no artifact frame, so the card could not offer it. The sweep lists
 * the directories the run touched and recovers the files a person would open.
 */

const financeAgent: VerticalAgentSpec = {
  name: "finance_agent",
  description: "live market quotes, financial statements and filings",
  url: "http://127.0.0.1:8000/api/v1/agui/run",
};

const encode = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`;

function streamed(body: string): Response {
  const bytes = new TextEncoder().encode(body);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const WORKSPACE_FILES = [
  "work/plan/build.py",
  "work/plan/report.html",
  "work/plan/data.csv",
  "work/plan/chart.png",
  "work/plan/notes.txt",
  "work/plan/.cache.md",
  "work/plan/_internal/trace.html",
];

/** One fetch for the whole delegate: the run, the workspace lookup, the listing. */
function gateway(turn: string, files: unknown = WORKSPACE_FILES) {
  const requests: string[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    requests.push(`${init?.method ?? "GET"} ${href}`);
    if (href.includes("/api/v1/agui/run")) return streamed(turn);
    if (href.includes("/api/v1/workspaces?"))
      return json({ workspaces: [{ workspace_id: "ws-1" }] });
    if (href.includes("/files?")) return json({ files });
    return json({ detail: "unexpected" }, 404);
  };
  return { requests, fetch };
}

test("the sweep adds deliverables from touched directories and skips the rest", async () => {
  const rich = new VerticalRichEvents();
  rich.collect("langalpha.artifact", {
    artifact_type: "file_operation",
    artifact_id: "a1",
    status: "completed",
    payload: { file_path: "work/plan/build.py" },
  });
  const { requests, fetch } = gateway("");
  await sweepDeliverables(financeAgent, "Bearer caller-jwt", rich, { fetch });
  const paths = (rich.summary().artifacts ?? []).map((artifact) => artifact.path);
  assert.deepEqual(paths.sort(), [
    "work/plan/build.py",
    "work/plan/chart.png",
    "work/plan/data.csv",
    "work/plan/report.html",
  ]);
  // The listing went to the run's own API root, under the caller's token.
  assert.ok(
    requests.some((line) => line.startsWith("GET http://127.0.0.1:8000/api/v1/workspaces?")),
  );
  assert.ok(
    requests.some((line) => line.includes("/api/v1/workspaces/ws-1/files?path=work%2Fplan")),
  );
});

test("the sweep is a no-op when the workspace or the listing fails", async () => {
  const rich = new VerticalRichEvents();
  rich.collect("langalpha.artifact", {
    artifact_type: "file_operation",
    artifact_id: "a1",
    status: "completed",
    payload: { file_path: "work/plan/build.py" },
  });
  const failing = (async () => json({ detail: "down" }, 500)) as typeof fetch;
  await sweepDeliverables(financeAgent, "Bearer caller-jwt", rich, { fetch: failing });
  assert.equal(rich.summary().artifacts?.length, 1);
  // No artifact directories at all: not even the workspace lookup is attempted.
  const empty = new VerticalRichEvents();
  let called = false;
  await sweepDeliverables(financeAgent, "Bearer caller-jwt", empty, {
    fetch: (async () => {
      called = true;
      return json({});
    }) as typeof fetch,
  });
  assert.equal(called, false);
});

test("a run whose report came from a builder script still offers the report", async () => {
  const turn = [
    { type: "RUN_STARTED", threadId: "t-1", runId: "r-1" },
    { type: "TEXT_MESSAGE_START", messageId: "m-1", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "m-1", delta: "done, report saved" },
    { type: "TEXT_MESSAGE_END", messageId: "m-1" },
    {
      type: "CUSTOM",
      name: "langalpha.artifact",
      value: {
        artifact_type: "file_operation",
        artifact_id: "a1",
        status: "completed",
        payload: { file_path: "work/plan/build.py" },
      },
    },
    { type: "RUN_FINISHED", threadId: "t-1", runId: "r-1", outcome: "success" },
  ]
    .map(encode)
    .join("");
  const { fetch } = gateway(turn);
  const result = await runVerticalAgent(financeAgent, {
    task: "write the plan",
    threadId: "thread-1",
    token: "caller-jwt",
    signal: new AbortController().signal,
    fetch,
  });
  const paths = (result.artifacts ?? []).map((artifact) => artifact.path);
  assert.ok(paths.includes("work/plan/report.html"));
  assert.ok(paths.includes("work/plan/data.csv"));
  assert.equal(paths.filter((path) => path === "work/plan/build.py").length, 1);
});
