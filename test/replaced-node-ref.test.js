/**
 * Replacement provenance: a surface node that landed as `op: "replace"` (the
 * 0.2 tool-result pruner) is a shadow copy, so the checkpoint prints
 * `(seq R <- original S)` and the pointer still parses back verbatim.
 * @module dsh-compaction-instant/test/replaced-node-ref
 */
import assert from "node:assert/strict";
import test from "node:test";
import { compileNodes, originalRef } from "../src/compiler.js";
import { parseRefToken, replacementSourcesOf } from "../src/indices.js";
import { parseSeqSpec, resolveRecallReference } from "../src/recall.js";

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
  toolArgTools: ["read"],
  hideTools: []
};

const call = (seq, id) => ({
  seq,
  message: { role: "assistant", content: [{ type: "tool-call", id, name: "read", arguments: '{"file_path":"a.js"}' }] }
});

const result = (seq, id, text, originalSeqs) => ({
  seq,
  message: { role: "user", content: [{ type: "tool-result", toolCallId: id, content: [{ type: "text", text }] }] },
  ...originalSeqs === undefined ? {} : { originalSeqs }
});

test("originalRef only annotates a single-source replacement", () => {
  assert.equal(originalRef({ seq: 40, originalSeqs: [12] }), " <- original 12");
  assert.equal(originalRef({ seq: 40, originalSeqs: [12, 13] }), "", "checkpoint-span replacements stay plain");
  assert.equal(originalRef({ seq: 40, originalSeqs: [40] }), "", "a self-reference adds nothing");
  assert.equal(originalRef({ seq: 40, originalSeqs: [-1] }), "", "negative seqs are not pointers");
  assert.equal(originalRef({ seq: 40 }), "");
  assert.equal(originalRef(undefined), "");
});

test("originalRef leaves checkpoint nodes alone", () => {
  const node = { seq: 40, originalSeqs: [12], message: { source: { kind: "compact-checkpoint" } } };
  assert.equal(originalRef(node), "");
});

test("only a replacement leaves provenance to print", () => {
  // Both shapes are real: a `tool/result` append cites its own call seq (dsh-session
  // writes that for every result), while the pruner lands an `op: "replace"` node
  // citing the result it pruned. Only the second one has an earlier original.
  const appended = { seq: 27, type: "tool/result", surfaceOp: "append", sourceEventSeqs: [26] };
  assert.equal(replacementSourcesOf(appended), undefined, "an appended result shadows nothing");
  const replaced = { seq: 512, type: "tool/result", surfaceOp: { op: "replace", startSeq: 7, endSeq: 7 }, sourceEventSeqs: [7] };
  assert.deepEqual(replacementSourcesOf(replaced), [7]);
  assert.equal(replacementSourcesOf({ seq: 1, surfaceOp: { op: "replace", startSeq: 1, endSeq: 1 } }), undefined);
  assert.equal(replacementSourcesOf(undefined), undefined);
  // A checkpoint replacement shadows a whole span: many sources, so the pointer
  // stays the checkpoint marker it already carries.
  assert.deepEqual(replacementSourcesOf({ surfaceOp: { op: "replace", startSeq: 1, endSeq: 9 }, sourceEventSeqs: [1, 2, 3] }), [1, 2, 3]);
  assert.equal(originalRef({ seq: 40, originalSeqs: [1, 2, 3], message: { source: { kind: "user" } } }), "");
});

test("an appended result prints exactly as before", () => {
  const nodes = [
    call(26, "c1"),
    { ...result(27, "c1", "plain text"), originalSeqs: replacementSourcesOf({ surfaceOp: "append", sourceEventSeqs: [26] }) }
  ];
  const { entries } = compileNodes(nodes, CONFIG);
  const text = entries.map((entry) => entry.text).join("\n");
  assert.match(text, /\(seq 26 -> result 27\)/);
  assert.doesNotMatch(text, /original/);
});

test("a pruned tool result keeps its pre-prune seq addressable", () => {
  const nodes = [
    { seq: 1, message: { role: "user", content: [{ type: "text", text: "failing build" }] } },
    call(2, "c1"),
    result(512, "c1", "head\n...(pruned)\ntail", [7])
  ];
  const { entries } = compileNodes(nodes, CONFIG);
  const text = entries.map((entry) => entry.text).join("\n");
  // Results never occupy an entry: the call row carries the whole pointer, and
  // its `<- original 7` is the address of the text the prune cut down.
  assert.match(text, /\(seq 2 -> result 512 <- original 7\)/);
});

test("an unpruned result prints exactly as before", () => {
  const nodes = [call(2, "c1"), result(3, "c1", "plain text")];
  const { entries } = compileNodes(nodes, CONFIG);
  const text = entries.map((entry) => entry.text).join("\n");
  assert.match(text, /\(seq 2 -> result 3\)/);
  assert.doesNotMatch(text, /original/);
});

test("a replaced user node carries the annotation on its own pointer", () => {
  const nodes = [
    { seq: 9, message: { role: "user", content: [{ type: "text", text: "long prose ".repeat(20) }] }, originalSeqs: [4] }
  ];
  // A user row prints its pointer only when the text has to be cut, which is
  // exactly the case where the reader needs the pre-replacement address.
  const { entries } = compileNodes(nodes, CONFIG, { textTokens: 8, userTextTokens: 8, toolCallTokens: 8, toolResultExcerptTokens: 8 });
  assert.match(entries[0].text, /truncated from seq 9 <- original 4/);
});

test("the printed annotation parses back verbatim", () => {
  assert.deepEqual(parseRefToken("seq 340 <- original 12"), { body: "340", kind: "seq", hashed: false });
  assert.deepEqual(parseRefToken("(seq 340 <- original 12)"), { body: "340", kind: "seq", hashed: false });
  assert.deepEqual(parseRefToken("seq 2 -> result 512 <- original 7"), { body: "512", kind: "result", hashed: false, head: "2" });
  assert.deepEqual(parseRefToken("seq 2 -> result 512"), { body: "512", kind: "result", hashed: false, head: "2" });
  assert.deepEqual(parseRefToken("seq 12"), { body: "12", kind: "seq", hashed: false });
});

test("recall resolves every printed pointer form", () => {
  assert.deepEqual(parseSeqSpec("(seq 340 <- original 12)"), { selections: [{ start: 340, end: 340 }], errors: [] });
  assert.deepEqual(parseSeqSpec("(seq 2 -> result 512 <- original 7)"), { selections: [{ start: 2, end: 2 }], errors: [] });
  assert.deepEqual(parseSeqSpec("(seq 12)"), { selections: [{ start: 12, end: 12 }], errors: [] });
  assert.deepEqual(parseSeqSpec("seqs 3-7"), { selections: [{ start: 3, end: 7 }], errors: [] });
  assert.equal(parseSeqSpec("(seq 2 -> result 512)").errors.length, 0, "the call end is what a seq recall asks for");
  assert.equal(parseSeqSpec("nonsense").errors.length, 1);
});

test("a result reference accepts the tool-call one-liner", () => {
  const session = { snapshotEvents: () => [{ seq: 512, type: "tool/result" }] };
  assert.deepEqual(resolveRecallReference(session, "result", "seq 2 -> result 512 <- original 7"), {
    selections: [{ start: 512, end: 512 }],
    errors: []
  });
});
