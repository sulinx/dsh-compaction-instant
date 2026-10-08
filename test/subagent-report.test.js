/**
 * Attribution of other agents' reports in compiled regions.
 *
 * WHY THIS EXISTS: a background subagent's result is delivered to the
 * orchestrator as an ordinary USER-role message. Compiled as user text it
 * reads as if the agent itself had concluded what a worker merely claimed —
 * and because a checkpoint is re-read by the model, that promotes an
 * unverified report to established fact.
 * @module dsh-compaction-instant/test/subagent-report
 */
import assert from "node:assert/strict";
import test from "node:test";
import { compileNodes, fenceSubagentReport, subagentReportOf } from "../src/compiler.js";

const CONFIG = {
  maxTokens: 8192,
  textTokens: 512,
  userTextTokens: 1024,
  toolCallTokens: 128,
  toolResultExcerptTokens: 256,
  includeReasoning: false,
  stripNoiseXml: true,
  noisePatterns: [],
  toolKeyFields: {},
  toolArgTools: [],
  hideTools: []
};

const SETTLED = {
  kind: "subagent-settled",
  form: "notice",
  summary: "Background subagent 6a89b0e0-fa87-4f7f-988f-1658a1bfd88d finished and will do no further work unless you send it more.",
  senderSessionId: "6a89b0e0-fa87-4f7f-988f-1658a1bfd88d"
};

test("the host's settlement stamp is recognised as a report", () => {
  const report = subagentReportOf(SETTLED, "Background subagent 6a89b0e0-fa87-4f7f-988f-1658a1bfd88d finished and will do no further work unless you send it more.\n\nIts closing message:\n\nVerdict: PASS");
  assert.equal(report?.agentId, "6a89b0e0-fa87-4f7f-988f-1658a1bfd88d");
  assert.equal(report?.kind, "settled");
  assert.match(report.body, /Verdict: PASS/);
});

test("a relayed agent message is recognised too", () => {
  const report = subagentReportOf({ kind: "agent-message", form: "relay", senderSessionId: "child-7" }, "found the bug in region.js");
  assert.equal(report?.agentId, "child-7");
  assert.equal(report?.kind, "relayed");
  assert.equal(report?.body, "found the bug in region.js");
});

test("the legacy delivery shape is recognised without a stamp", () => {
  const reported = subagentReportOf({ kind: "user" }, "Background subagent 6a89b0e0-fa87-4f7f-988f-1658a1bfd88d reported:\n\nPatch at /tmp/x.");
  assert.equal(reported?.kind, "reported");
  assert.equal(reported?.agentId, "6a89b0e0-fa87-4f7f-988f-1658a1bfd88d");
  assert.equal(reported?.body, "Patch at /tmp/x.");

  const finished = subagentReportOf({ kind: "user" }, "Background subagent 956d50df-2d61-4358-ad41-9ee3c94cb515 finished and will do no further work unless you send it more.Its closing message:\n\nVerdict: PASS");
  assert.equal(finished?.kind, "finished");
  assert.equal(finished?.body, "Verdict: PASS");
});

test("ordinary user text is NOT treated as a report", () => {
  // The failure direction matters: mislabelling the human as a subagent is
  // worse than missing a report, so anything unrecognised stays user text.
  assert.equal(subagentReportOf({ kind: "user" }, "Background subagent work is going well"), null);
  assert.equal(subagentReportOf({ kind: "user" }, "can you review the diff?"), null);
  assert.equal(subagentReportOf({ kind: "user" }, ""), null);
  assert.equal(subagentReportOf({ kind: "user" }, undefined), null);
  // A stamped report with no body at all is not worth a row of its own.
  assert.equal(subagentReportOf(SETTLED, "   "), null);
});

test("the fence grows past any backtick run in the body", () => {
  assert.equal(fenceSubagentReport({ agentId: "a1", kind: "settled" }, "plain body"), "```subagent a1 settled\nplain body\n```");
  const withFence = fenceSubagentReport({ agentId: "a1", kind: "settled" }, "code:\n```js\nx\n```");
  assert.match(withFence, /^````subagent a1 settled\n/);
  assert.match(withFence, /\n````$/);
  const withFour = fenceSubagentReport({ agentId: "a1", kind: "settled" }, "````");
  assert.match(withFour, /^`````subagent a1 settled\n/);
});

test("compileNodes gives a report its own role header and fence", () => {
  const { entries, stats } = compileNodes([
    { seq: 1, message: { role: "user", content: [{ type: "text", text: "run the audit" }], source: { kind: "user" } } },
    { seq: 2, message: { role: "user", content: [{ type: "text", text: "Background subagent child-1 finished and will do no further work unless you send it more.\n\nIts closing message:\n\nVerdict: PASS" }], source: SETTLED } }
  ], CONFIG);
  assert.equal(stats.subagentReports, 1);
  assert.match(entries[0].text, /^\[user\]\nrun the audit/);
  assert.match(entries[1].text, /^\[subagent\]\n```subagent 6a89b0e0-fa87-4f7f-988f-1658a1bfd88d settled\n/);
  assert.match(entries[1].text, /Verdict: PASS/);
  assert.match(entries[1].text, /```$/);
});

test("a report whose body is truncated still closes its fence", () => {
  const long = "x".repeat(20000);
  const { entries } = compileNodes([
    { seq: 1, message: { role: "user", content: [{ type: "text", text: long }], source: SETTLED } }
  ], { ...CONFIG, userTextTokens: 64 });
  assert.match(entries[0].text, /```$/);
  assert.match(entries[0].text, /\.\.\.\(truncated from seq 1\)/);
});
