/**
 * P2b: the shared reference space.
 *
 * Port of upstream pi-vcc `core/global-indices.ts` (k0valik/pi-blackhole
 * f82e07a, issue #28). Upstream's rule: recall and compaction summaries must
 * number by ONE definition, so a pointer a summary prints resolves to the row
 * recall reads. In DSH the durable seq already is that global number, so the
 * port is the single definition itself — one seq lookup, one checkpoint
 * counting rule, one reference parser — plus the two emitter/resolver
 * asymmetries it exposes:
 *
 *   - the touched-files renderer prints `#N`, which `recall` refused to parse;
 *   - a `[N entries elided: seqs A-B]` marker wider than the expansion chunk
 *     was rejected, so the marker the engine printed could not be pasted back.
 *
 * @module dsh-compaction-instant/test/p2b-refs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { checkpointOrdinals, createEventIndex, isCheckpointSource, parseRefToken, splitSeqSpan } from "../src/indices.js";
import { compileNodes, FOREIGN_SEQ_NOTE, isForeignCheckpointText, RECALL_GUIDE } from "../src/compiler.js";
import { expandSelections, findCheckpointSeqs, MAX_RECALL_SEQS, MAX_RECALL_SPAN, parseSeqSpec, recallSession, resolveRecallReference } from "../src/recall.js";
import { describeTail, selectCompactableRange } from "../src/region.js";

// ── the parser ──────────────────────────────────────────────────────────────

test("parseRefToken normalizes every form the engine prints", () => {
  assert.deepEqual(parseRefToken("12"), { body: "12", kind: undefined, hashed: false });
  assert.deepEqual(parseRefToken("#12"), { body: "12", kind: undefined, hashed: true });
  assert.deepEqual(parseRefToken("#3-7"), { body: "3-7", kind: undefined, hashed: true });
  assert.deepEqual(parseRefToken("(seq 12)"), { body: "12", kind: "seq", hashed: false });
  assert.deepEqual(parseRefToken("seqs 3-7"), { body: "3-7", kind: "seq", hashed: false });
  assert.deepEqual(parseRefToken("result 4"), { body: "4", kind: "result", hashed: false });
  assert.deepEqual(parseRefToken("checkpoint 2"), { body: "2", kind: "checkpoint", hashed: false });
  // The `#` sits inside the printed form only when it is the outer marker.
  assert.deepEqual(parseRefToken("(seq 12 -> result 13)"), { body: "12 -> result 13", kind: "seq", hashed: false });
  assert.deepEqual(parseRefToken(""), { body: "", kind: undefined, hashed: false });
});

// ── wide ranges stay pasteable ──────────────────────────────────────────────

test("splitSeqSpan chunks a wide span without losing or reordering a seq", () => {
  const chunks = splitSeqSpan(5, 12, 3);
  assert.deepEqual(chunks, [{ start: 5, end: 7 }, { start: 8, end: 10 }, { start: 11, end: 12 }]);
  const single = splitSeqSpan(9, 9, 3);
  assert.deepEqual(single, [{ start: 9, end: 9 }]);
});

test("expandSelections expands past the chunk width, deduplicated and ordered", () => {
  const width = MAX_RECALL_SPAN + 25;
  const seqs = expandSelections([{ start: 0, end: width - 1 }, { start: 3, end: 5 }]);
  assert.equal(seqs.length, width);
  assert.equal(seqs[0], 0);
  assert.equal(seqs[seqs.length - 1], width - 1);
  assert.equal(new Set(seqs).size, width);
});

test("a range wider than the expansion chunk is accepted, an unbounded one is not", () => {
  const wide = parseSeqSpec(`1-${MAX_RECALL_SPAN + 500}`);
  assert.equal(wide.errors.length, 0);
  const huge = parseSeqSpec(`1-${MAX_RECALL_SEQS + 1}`);
  assert.ok(huge.errors.some((error) => error.includes(`${MAX_RECALL_SEQS}-seq limit`)));
});

// ── the shared checkpoint counting rule ─────────────────────────────────────

/** A landed checkpoint node in either host generation's source shape. */
function checkpointEvent(seq, source) {
  return { seq, type: "user/message", data: { content: [{ type: "text", text: `checkpoint ${seq}` }], source } };
}

function checkpointSession() {
  const events = [
    { seq: 0, type: "user/message", data: { content: [{ type: "text", text: "hello" }], source: { kind: "user" } } },
    checkpointEvent(1, { kind: "plugin", plugin: "compact", compactionId: "a" }), // dsh ≤ 0.1.6
    { seq: 2, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "ok" }] } } },
    checkpointEvent(3, { kind: "compact-checkpoint", compactionId: "b" }), // dsh 0.1.7
    checkpointEvent(4, { kind: "plugin", plugin: "compact", compactionId: "c" })
  ];
  return { events, deriveEventMessage: (event) => event.data?.message ?? null };
}

test("checkpoint ordinals are counted once, session-wide, for both host generations", () => {
  const session = checkpointSession();
  assert.deepEqual(findCheckpointSeqs(session), [1, 3, 4]);
  const ordinals = checkpointOrdinals(session);
  assert.deepEqual([...ordinals.entries()], [[1, 1], [3, 2], [4, 3]]);
  // The printer's map and the resolver's list are the same rule by construction.
  assert.equal(ordinals.size, findCheckpointSeqs(session).length);
});

test("checkpoint markers the compiler prints resolve to the same checkpoint", () => {
  const session = checkpointSession();
  for (const [ordinal, expected] of [[1, 1], [2, 3], [3, 4]]) {
    const resolved = resolveRecallReference(session, "checkpoint", `[checkpoint ${ordinal}]`.replace(/^\[|\]$/gu, ""));
    assert.deepEqual(resolved.selections, [{ start: expected, end: expected }], `checkpoint ${ordinal}`);
    // The `#N` and bare forms agree with the bracketed marker form.
    assert.deepEqual(resolveRecallReference(session, "checkpoint", String(ordinal)).selections, resolved.selections);
    assert.deepEqual(resolveRecallReference(session, "checkpoint", `#${ordinal}`).selections, resolved.selections);
  }
});

// ── every printed pointer parses back ───────────────────────────────────────

test("the resolver accepts the #N form its own renderers print", () => {
  const session = {
    events: [
      { seq: 0, type: "user/message", data: { content: [{ type: "text", text: "hi" }], source: { kind: "user" } } },
      { seq: 1, type: "tool/result", data: { message: { role: "user", content: [{ type: "tool-result", toolCallId: "t1", content: [{ type: "text", text: "out" }] }] } } },
      checkpointEvent(2, { kind: "plugin", plugin: "compact", compactionId: "x" })
    ],
    deriveEventMessage: (event) => event.data?.message ?? null
  };
  assert.deepEqual(resolveRecallReference(session, "seq", "#0").selections, [{ start: 0, end: 0 }]);
  assert.deepEqual(resolveRecallReference(session, "result", "#1").selections, [{ start: 1, end: 1 }]);
  assert.deepEqual(resolveRecallReference(session, "result", "result 1").selections, [{ start: 1, end: 1 }]);
  assert.deepEqual(resolveRecallReference(session, "checkpoint", "#1").selections, [{ start: 2, end: 2 }]);
  // Still fail-closed on genuinely unusable references.
  assert.ok(resolveRecallReference(session, "result", "#0").errors[0].includes("not a tool result"));
  assert.ok(resolveRecallReference(session, "checkpoint", "#9").errors[0].includes("has 1 checkpoint(s)"));
});

test("the recall guide documents the forms the engine actually prints", () => {
  assert.match(RECALL_GUIDE, /\(seq N\)/);
  assert.match(RECALL_GUIDE, /#N/);
  assert.match(RECALL_GUIDE, /-> result N/);
  assert.match(RECALL_GUIDE, /\[checkpoint N\]/);
});

// ── a non-dense host array must not silently miss ───────────────────────────

test("a non-dense event array still resolves seqs by pointer", () => {
  const header = { type: "session", version: 3, id: "s" };
  const events = [header, { seq: 0, type: "user/message", data: { content: [{ type: "text", text: "first" }], source: { kind: "user" } } }, { seq: 1, type: "user/message", data: { content: [{ type: "text", text: "second" }], source: { kind: "user" } } }];
  const session = { events, deriveEventMessage: (event) => event.data?.message ?? null };
  const index = createEventIndex(session);
  assert.equal(index.dense, false);
  assert.equal(index.at(1).seq, 1);
  assert.equal(index.at(9), undefined);
  // The array path would have answered `events[1]` with seq 0; the index path
  // answers with the event that actually carries seq 1.
  const recalled = recallSession(session, [{ start: 1, end: 1 }], { maxRecallTokens: 1000 });
  assert.equal(recalled.missing, 0);
  assert.match(recalled.text, /second/);
});

test("the dense fast path is still taken for a normal host array", () => {
  const events = [{ seq: 0, type: "x" }, { seq: 1, type: "y" }];
  const index = createEventIndex({ events });
  assert.equal(index.dense, true);
  assert.equal(index.at(1), events[1]);
});

// ── retained-tail provenance (upstream `budgetCut`) ─────────────────────────

function makeSession(events) {
  return {
    events,
    snapshotEvents: () => events,
    eventAt: (seq) => events.find((event) => event.seq === seq),
    surface: { nodes: events.map((event) => event.seq), replaceGeneration: 0 }
  };
}

function closedTurn(startSeq, turn) {
  return [
    { seq: startSeq, type: "turn/start", data: { turn } },
    { seq: startSeq + 1, type: "user/message", data: { content: [{ type: "text", text: "hi" }], source: { kind: "user" } } },
    { seq: startSeq + 2, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "ok" }] } } },
    { seq: startSeq + 3, type: "turn/end", data: { turn } }
  ];
}

function measurementFor(events, oversizedSeq, tokens = 10) {
  return { nodes: events.map((event) => ({ seq: event.seq, tokens: event.seq === oversizedSeq ? 999_999 : tokens })) };
}

test("selectCompactableRange reports which rule kept the tail", () => {
  const events = [...closedTurn(0, 1), ...closedTurn(4, 2)];
  const session = makeSession(events);
  // retainTokens = 0 → the preferred-turn rule decides the tail.
  const byTurns = selectCompactableRange(session, measurementFor(events, -1), 1, 0);
  assert.deepEqual([byTurns.start, byTurns.end], [0, 3]);
  assert.deepEqual(byTurns.tail, { policy: "retain-turns", keptNodes: 4, keptTokens: 40, ceiling: 0, receded: false });
  // A ceiling that still fits the newest whole turn.
  const byCeiling = selectCompactableRange(session, measurementFor(events, -1), 1, 40);
  assert.deepEqual([byCeiling.start, byCeiling.end], [0, 3]);
  assert.equal(byCeiling.tail.policy, "whole-turns");
  assert.equal(byCeiling.tail.keptTokens, 40);
  // A ceiling smaller than the newest whole turn → node suffix.
  const bySuffix = selectCompactableRange(session, measurementFor(events, -1), 1, 10);
  assert.deepEqual([bySuffix.start, bySuffix.end], [0, 6]);
  assert.equal(bySuffix.tail.policy, "node-suffix");
  assert.equal(bySuffix.tail.keptNodes, 1);
  // A newest node that alone exceeds the ceiling: retained whole, and the
  // tool-pair guard has to recede to keep the pairing balanced.
  const oversized = [...events, { seq: 8, type: "user/message", data: { content: [{ type: "text", text: "big" }], source: { kind: "plugin", plugin: "recall", form: "recall" } } }];
  const byGuard = selectCompactableRange(makeSession(oversized), measurementFor(oversized, 8), 1, 5120);
  assert.equal(byGuard.tail.policy, "node-suffix");
  assert.equal(byGuard.tail.ceiling, 5120);
  assert.equal(byGuard.tail.keptNodes, 1);
  assert.equal(byGuard.tail.receded, true);
});

test("describeTail names the rule, the ceiling, and a pair-guard recede", () => {
  assert.match(describeTail({ policy: "retain-turns", receded: false }), /按保留回合数/);
  assert.match(describeTail({ policy: "whole-turns", receded: false }), /整回合不超上限/);
  assert.match(describeTail({ policy: "node-suffix", ceiling: 5120, receded: true }), /最新回合超过 5120 token 上限/);
  assert.match(describeTail({ policy: "node-suffix", ceiling: 5120, receded: true }), /已为工具配对回退/);
  assert.match(describeTail(undefined), /未被压缩/);
});

test("isCheckpointSource recognizes both host generations and nothing else", () => {
  assert.equal(isCheckpointSource({ kind: "plugin", plugin: "compact" }), true);
  assert.equal(isCheckpointSource({ kind: "compact-checkpoint", compactionId: "x" }), true);
  assert.equal(isCheckpointSource({ kind: "plugin", plugin: "recall" }), false);
  assert.equal(isCheckpointSource(undefined), false);
  assert.equal(isCheckpointSource("compact"), false);
});

// ── checkpoint text carried in from a parent (seeded) session ───────────────

const foreignText = [
  "* read \"a.js\" (seq 10 -> result 11)",
  "* pwsh (seq 20 -> result 21)",
  "* grep x (seq 30 -> result 31)",
  "* glob y (seq 40 -> result 41)"
].join("\n");

test("a nested checkpoint whose pointers resolve here is not marked foreign", () => {
  const types = new Map([[11, "tool/result"], [21, "tool/result"], [31, "tool/result"], [41, "tool/result"]]);
  assert.equal(isForeignCheckpointText(foreignText, (seq) => types.get(seq)), false);
  // Fail-open: no resolver, or too few samples, never annotates.
  assert.equal(isForeignCheckpointText(foreignText, undefined), false);
  assert.equal(isForeignCheckpointText("(seq 1 -> result 2)", () => "user/message"), false);
  // A minority of odd pointers is not enough evidence.
  const mostlyGood = new Map([[11, "tool/result"], [21, "tool/result"], [31, "tool/result"], [41, "step/end"]]);
  assert.equal(isForeignCheckpointText(foreignText, (seq) => mostlyGood.get(seq)), false);
});

test("a nested checkpoint from another log is marked, with its text kept verbatim", () => {
  const types = new Map([[11, "assistant/message"], [21, "tool/call"], [31, "step/end"], [41, "web/request"]]);
  assert.equal(isForeignCheckpointText(foreignText, (seq) => types.get(seq)), true);
});

test("compileNodes annotates a foreign nested checkpoint and leaves a local one alone", () => {
  const checkpoint = (seq, text) => ({
    seq,
    message: { role: "user", content: [{ type: "text", text }], source: { kind: "plugin", plugin: "compact", compactionId: "c" } }
  });
  const config = {
    textTokens: 256, userTextTokens: 256, toolCallTokens: 64, toolResultExcerptTokens: 96,
    maxTokens: 65536, noisePatterns: [], toolKeyFields: {}, toolArgTools: [], hideTools: [], skipInjectTypes: []
  };
  const foreignTypes = (seq) => (seq === 11 || seq === 21 || seq === 31 ? "tool/call" : undefined);
  const foreignRun = compileNodes([checkpoint(5, foreignText)], { ...config, seqTypeOf: foreignTypes });
  assert.equal(foreignRun.stats.foreignCheckpoints, 1);
  assert.match(foreignRun.entries[0].text, /came from another session's log/);
  assert.ok(foreignRun.entries[0].text.includes(foreignText), "the nested text stays verbatim");

  const localRun = compileNodes([checkpoint(5, foreignText)], { ...config, seqTypeOf: () => "tool/result" });
  assert.equal(localRun.stats.foreignCheckpoints, 0);
  assert.doesNotMatch(localRun.entries[0].text, /came from another session's log/);
});
