import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactFileName, parseVerticalResult, verticalFilePath } from "../src/vertical-result.ts";

const rich = {
  report: "AAPL closed at 230.10",
  truncated: false,
  toolCalls: 1,
  artifacts: [
    { type: "file_operation", id: "c-1", title: "reports/aapl.md", path: "reports/aapl.md" },
    { type: "chart_annotation", title: "AAPL vs peers", status: "completed" },
  ],
  sources: [{ title: "AAPL quote", url: "https://example.com/aapl" }],
};

test("reads a delegated result from JSON or an already-parsed object", () => {
  for (const value of [rich, JSON.stringify(rich)]) {
    const parsed = parseVerticalResult(value);
    assert.equal(parsed?.report, "AAPL closed at 230.10");
    assert.equal(parsed?.artifacts.length, 2);
    assert.equal(parsed?.sources[0].url, "https://example.com/aapl");
  }
});

test("a result with nothing to open falls through to the normal renderer", () => {
  // The shape, not the tool name, is what claims the card: any other tool
  // result — a plain report, an error, unrelated JSON — keeps its own renderer.
  assert.equal(parseVerticalResult({ report: "AAPL is up", toolCalls: 1 }), undefined);
  assert.equal(parseVerticalResult(JSON.stringify({ error: "该能力需要登录后使用" })), undefined);
  assert.equal(parseVerticalResult("{broken"), undefined);
  assert.equal(parseVerticalResult(""), undefined);
  assert.equal(parseVerticalResult("AAPL is up"), undefined);
  assert.equal(parseVerticalResult(undefined), undefined);
  assert.equal(parseVerticalResult({ artifacts: [], sources: [] }), undefined);
});

test("an artifact survives a missing title while a broken list does not", () => {
  const parsed = parseVerticalResult({
    artifacts: [{ type: "file_operation", path: "reports/aapl.md" }],
  });
  assert.equal(parsed?.artifacts[0].title, "reports/aapl.md");
  assert.equal(parseVerticalResult({ artifacts: [{ path: "a.md" }] }), undefined);
  assert.equal(parseVerticalResult({ artifacts: "not a list" }), undefined);
});

test("the proxy path carries the tool name and the artifact's own path", () => {
  assert.equal(
    verticalFilePath("finance_agent", "reports/aapl summary.md"),
    "/api/vertical/finance_agent/file?path=reports%2Faapl%20summary.md",
  );
  assert.equal(
    verticalFilePath("finance agent", "a/b.csv"),
    "/api/vertical/finance%20agent/file?path=a%2Fb.csv",
  );
});

test("an artifact is saved under its leaf name and never a path", () => {
  assert.equal(artifactFileName("reports/aapl.md"), "aapl.md");
  assert.equal(artifactFileName("a/b/chart.png"), "chart.png");
  assert.equal(artifactFileName(""), "artifact");
  assert.equal(artifactFileName("reports/"), "artifact");
});
