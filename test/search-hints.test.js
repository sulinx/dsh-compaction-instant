/**
 * Tests for the two low-cost UX ports from pi-vcc v0.10.2 that live in the
 * search surface: the ready-made "around the first hit" call, and the label on
 * hits that are no longer on the model-visible surface.
 *
 * Both are pure rendering/annotation, so they are exercised through
 * `formatSearchHeader` / the recorded result shape rather than a full session.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { formatSearchHeader } from "../src/format.js";
import { aroundFirstHitHint } from "../src/search.js";

test("the next-step hint is a call this engine's recall accepts", () => {
  // A seq near zero must not produce a negative start.
  assert.equal(
    aroundFirstHitHint(1),
    `--- Around the first hit: recall with type:"seq", id:"0-4" (or id:"1" for that entry alone) ---`
  );
  assert.equal(
    aroundFirstHitHint(120),
    `--- Around the first hit: recall with type:"seq", id:"117-123" (or id:"120" for that entry alone) ---`
  );
});

test("search header states how many hits left the current context", () => {
  const text = formatSearchHeader({ source: "cache", mode: "terms", totalMatches: 3, shown: 3, offSurface: 1 });
  assert.match(text, /3 matching event\(s\)/u);
  assert.match(text, /1 hit\(s\) not in the current context \(edited or rewound\), still recallable/u);
});

test("search header stays silent when every hit is live", () => {
  for (const offSurface of [0, undefined]) {
    const text = formatSearchHeader({ source: "cache", mode: "terms", totalMatches: 2, shown: 2, offSurface });
    assert.ok(!text.includes("current context"), `offSurface=${String(offSurface)} says nothing`);
  }
});

test("search header keeps the existing clauses alongside the off-surface note", () => {
  const text = formatSearchHeader({
    source: "why",
    literal: true,
    totalMatches: 5,
    shown: 2,
    floorDropped: 1,
    skippedTurnEvents: 4,
    openTurn: 7,
    offSurface: 2
  });
  assert.match(text, /literal match: nested quantifier/u);
  assert.match(text, /low-relevance match\(es\) hidden/u);
  assert.match(text, /turn in progress \(turn 7\) is not searched/u);
  assert.match(text, /2 hit\(s\) not in the current context/u);
});
