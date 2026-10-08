/**
 * Ranked-search hot path: each query term is compiled once per search, not once
 * per term per event. The counts must not change — only the cost.
 * @module dsh-compaction-instant/test/search-compile-once
 */
import assert from "node:assert/strict";
import test from "node:test";
import { searchSession } from "../src/search.js";

/** A stub session whose log is the given events (search only reads the log). */
function sessionOf(events) {
  return { snapshotEvents: () => events };
}

/** `count` events, each a user message repeating the three terms. */
function makeEvents(count) {
  return Array.from({ length: count }, (_, i) => ({
    seq: i,
    type: "user/message",
    time: i,
    data: { message: { role: "user", content: [{ type: "text", text: `alpha beta gamma payload number ${i}` }] }, source: { kind: "user" } }
  }));
}

/** Run one search while counting global RegExp constructions. */
function countRegExp(fn) {
  const Original = globalThis.RegExp;
  let constructions = 0;
  globalThis.RegExp = function counted(...args) {
    constructions += 1;
    return new Original(...args);
  };
  try {
    return { result: fn(), constructions };
  } finally {
    globalThis.RegExp = Original;
  }
}

test("a multi-term search compiles each term once, not once per event", () => {
  const query = "alpha beta gamma";
  const small = countRegExp(() => searchSession(sessionOf(makeEvents(20)), query, { maxSearchHits: 3 }));
  const large = countRegExp(() => searchSession(sessionOf(makeEvents(400)), query, { maxSearchHits: 3 }));
  assert.equal(small.result.totalMatches, 20);
  assert.equal(large.result.totalMatches, 400);
  assert.equal(
    small.constructions,
    large.constructions,
    `RegExp constructions must not scale with the event count (20 events: ${small.constructions}, 400 events: ${large.constructions})`
  );
  assert.ok(large.constructions < 16, `expected a handful of constructions, saw ${large.constructions}`);
});

test("the ranked results are unchanged by the compile-once rule", () => {
  const events = [
    ...makeEvents(3),
    { seq: 9, type: "user/message", time: 9, data: { message: { role: "user", content: [{ type: "text", text: "alpha alpha alpha only" }] }, source: { kind: "user" } } },
    { seq: 10, type: "assistant/message", time: 10, data: { message: { role: "assistant", content: [{ type: "text", text: "gamma" }] } } }
  ];
  const scan = searchSession(sessionOf(events), "alpha gamma", { maxSearchHits: 10 });
  assert.equal(scan.mode, "terms");
  assert.equal(scan.totalMatches, 5);
  assert.deepEqual([...scan.hits.map((hit) => hit.seq)].sort((a, b) => a - b), [0, 1, 2, 9, 10]);
  // Re-running the same search is deterministic (the shared patterns are reset).
  const again = searchSession(sessionOf(events), "alpha gamma", { maxSearchHits: 10 });
  assert.deepEqual(again.hits.map((hit) => hit.seq), scan.hits.map((hit) => hit.seq));
});
