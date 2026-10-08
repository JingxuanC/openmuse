import assert from "node:assert/strict";
import test from "node:test";
import { previewKind } from "../src/vertical-preview.ts";

test("reports and images preview inline, everything else downloads", () => {
  assert.equal(previewKind("work/plan/A股投资计划.html"), "html");
  assert.equal(previewKind("work/plan/page.HTM"), "html");
  assert.equal(previewKind("work/plan/chart.png"), "image");
  assert.equal(previewKind("work/plan/fig.SVG"), "image");
  assert.equal(previewKind("work/plan/photo.jpeg"), "image");
  assert.equal(previewKind("work/plan/data.csv"), undefined);
  assert.equal(previewKind("work/plan/build.py"), undefined);
  assert.equal(previewKind("work/plan/model.json"), undefined);
  assert.equal(previewKind("work/plan/README"), undefined);
});
