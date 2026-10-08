/**
 * Paired tool results and paged seq ranges in `recall` (P5c).
 *
 * A tool call and its result are two durable events, so restoring the call
 * alone used to force a second call before the agent could see what its own
 * command printed; and a wide range could only be read up to the token budget.
 * @module dsh-compaction-instant/test/recall-page-pair
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PAIRED_RESULT_CHARS, recallSession } from "../src/recall.js";
import { defineRecallTool, resolveConfig as resolveToolConfig } from "../src/tool.js";

/** Minimal session shape recall reads: the log plus a message projector. */
function sessionOf(events) {
  return { snapshotEvents: () => events, deriveEventMessage: (event) => event.data?.message ?? null };
}

const callEvent = (seq, id, command) => ({
  seq,
  type: "assistant/message",
  data: { message: { role: "assistant", content: [{ type: "tool-call", id, name: "bash", arguments: JSON.stringify({ command }) }] } }
});
const resultEvent = (seq, id, text, isError = false) => ({
  seq,
  type: "tool/result",
  data: { message: { role: "user", content: [{ type: "tool-result", toolCallId: id, isError, content: [{ type: "text", text }] }] } }
});
const assistantEvent = (seq, text) => ({
  seq,
  type: "assistant/message",
  data: { message: { role: "assistant", content: [{ type: "text", text }] } }
});
const userEvent = (seq, text) => ({
  seq,
  type: "user/message",
  data: { message: { role: "user", content: [{ type: "text", text }] }, source: { kind: "user" } }
});

test("recalling a tool call brings back the result it produced", () => {
  const session = sessionOf([callEvent(1, "c1", "pnpm test"), resultEvent(2, "c1", "all green"), assistantEvent(3, "done")]);
  const result = recallSession(session, [{ start: 1, end: 1 }], { maxRecallTokens: 16000 });
  assert.equal(result.pairedResults, 1);
  assert.match(result.text, /\[paired tool result seq 2 — recall type:"result" id:"2" for all of it\]/);
  assert.match(result.text, /all green/);
});

test("a result that arrives after the next assistant message is not paired", () => {
  // It belongs to a later call group, so pairing it would misattribute it.
  const session = sessionOf([callEvent(1, "c1", "pnpm test"), assistantEvent(2, "waiting"), resultEvent(3, "c1", "late output")]);
  const result = recallSession(session, [{ start: 1, end: 1 }], { maxRecallTokens: 16000 });
  assert.equal(result.pairedResults, 0);
  assert.ok(!result.text.includes("late output"));
});

test("a paired result is clipped, and says where the rest is", () => {
  const big = "z".repeat(PAIRED_RESULT_CHARS + 1000);
  const session = sessionOf([callEvent(1, "c1", "cat big.log"), resultEvent(2, "c1", big)]);
  const result = recallSession(session, [{ start: 1, end: 1 }], { maxRecallTokens: 16000 });
  assert.equal(result.pairedResults, 1);
  assert.match(result.text, new RegExp(`clipped at ${PAIRED_RESULT_CHARS} chars`));
  assert.match(result.text, /\(1000 more chars\)/);
  assert.ok(result.text.length < big.length, "the clip is real");
});

test("an errored paired result is labelled as such", () => {
  const session = sessionOf([callEvent(1, "c1", "pnpm test"), resultEvent(2, "c1", "Error: boom", true)]);
  const result = recallSession(session, [{ start: 1, end: 1 }], { maxRecallTokens: 16000 });
  assert.match(result.text, /\[paired tool result seq 2 \(errored\)/);
});

test("a result the caller asked for is not paired again", () => {
  const session = sessionOf([callEvent(1, "c1", "pnpm test"), resultEvent(2, "c1", "all green")]);
  const result = recallSession(session, [{ start: 1, end: 2 }], { maxRecallTokens: 16000 });
  assert.equal(result.pairedResults, 0);
  assert.match(result.text, /all green/);
});

test("a wide seq range is read one page at a time", () => {
  const events = Array.from({ length: 45 }, (_, i) => userEvent(i + 1, `entry number ${i + 1}`));
  const session = sessionOf(events);
  const first = recallSession(session, [{ start: 1, end: 45 }], { maxRecallTokens: 16000, page: 1 });
  assert.equal(first.seqs[0], 1);
  assert.equal(first.seqs.length, 20);
  assert.equal(first.totalPages, 3);
  assert.equal(first.totalRequested, 45);
  assert.match(first.text, /\[page 1\/3 of 45 requested seq\(s\) — use page:2 for the next 20 entr\(y\|ies\)\]/);

  const second = recallSession(session, [{ start: 1, end: 45 }], { maxRecallTokens: 16000, page: 2 });
  assert.equal(second.seqs[0], 21);
  assert.equal(second.seqs.length, 20);
  assert.ok(!second.text.includes("entry number 1\n"), "page 2 does not repeat page 1");

  const last = recallSession(session, [{ start: 1, end: 45 }], { maxRecallTokens: 16000, page: 3 });
  assert.deepEqual(last.seqs, [41, 42, 43, 44, 45]);
  assert.match(last.text, /\[page 3\/3 of 45 requested seq\(s\)\]/);
});

test("a page past the end clamps to the last page", () => {
  const events = Array.from({ length: 45 }, (_, i) => userEvent(i + 1, `entry number ${i + 1}`));
  const result = recallSession(sessionOf(events), [{ start: 1, end: 45 }], { maxRecallTokens: 16000, page: 99 });
  assert.equal(result.seqs[0], 41);
  assert.equal(result.totalPages, 3);
});

test("the tool names a page parameter the reference cannot use", async () => {
  const session = sessionOf([callEvent(1, "c1", "pnpm test"), resultEvent(2, "c1", "all green")]);
  const tool = defineRecallTool(resolveToolConfig({}));
  const value = await tool.execute({ type: "result", id: "2", page: 3 }, { agent: { session } });
  assert.match(value.text, /^Ignored: page 3 — this reference expands to 1 entry \(one page of 20\)/);
  assert.match(value.text, /all green/);
  assert.equal(value.page, 1);
  assert.equal(value.totalPages, 1);
});
