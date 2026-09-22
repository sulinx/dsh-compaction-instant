/**
 * Regression test for the region-selection boundary crash found while
 * verifying P1: when the newest surface node alone exceeds `retainTokens`, the
 * ceiling loop keeps the whole tail (`keepFromIdx = turns.length`) and the
 * tool-pairing guard then dereferenced `surfaceNodes[keepFromIdx]` — one past
 * the end — handing `toolPairingBalancedBefore` an `undefined` seq and failing
 * `/compact` with `tool-pairing balance: surface seq undefined not found`
 * (a gateway/internal error). Reproduced with the pre-P1 sources as well, so
 * the guard is a latent bug, not a regression from the ranked search port.
 * @module dsh-compaction-instant/test/region-boundary
 */
import assert from "node:assert/strict";
import test from "node:test";
import { selectCompactableRange } from "../src/region.js";

/**
 * Minimal session surface: `eventAt` and `surface.nodes` are all the host's
 * tool-pairing guard reads, and `snapshotEvents` is what `surfaceTurns` walks.
 */
function makeSession(events) {
  return {
    events,
    snapshotEvents: () => events,
    eventAt: (seq) => events.find((event) => event.seq === seq),
    surface: { nodes: events.map((event) => event.seq), replaceGeneration: 0 }
  };
}

/** One closed turn: turn/start, a user message, an assistant message, turn/end. */
function closedTurn(startSeq) {
  return [
    { seq: startSeq, type: "turn/start", data: { turn: 1 } },
    { seq: startSeq + 1, type: "user/message", data: { content: [{ type: "text", text: "hi" }], source: { kind: "user" } } },
    { seq: startSeq + 2, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "ok" }] } } },
    { seq: startSeq + 3, type: "turn/end", data: { turn: 1 } }
  ];
}

/** Measurement over the same nodes, with one node inflated past the ceiling. */
function measurementFor(events, oversizedSeq, tokens = 10) {
  return { nodes: events.map((event) => ({ seq: event.seq, tokens: event.seq === oversizedSeq ? 999_999 : tokens })) };
}

test("an oversized newest node no longer crashes region selection", () => {
  const events = closedTurn(0);
  // A large appended message (a `/recall` output) that alone exceeds retainTokens.
  events.push({ seq: 4, type: "user/message", data: { content: [{ type: "text", text: "x".repeat(200) }], source: { kind: "plugin", plugin: "recall", form: "recall" } } });
  const session = makeSession(events);
  const range = selectCompactableRange(session, measurementFor(events, 4), 1, 5120);
  assert.notEqual(range, undefined);
  // The oversized newest node is retained: the range stops one node short of it.
  assert.equal(range.start, 0);
  assert.equal(range.end, 3);
});

test("an oversized newest node in a longer surface retains just that node", () => {
  const events = [...closedTurn(0), ...closedTurn(4)];
  const last = events[events.length - 1].seq;
  const session = makeSession(events);
  const range = selectCompactableRange(session, measurementFor(events, last), 1, 5120);
  assert.notEqual(range, undefined);
  assert.equal(range.start, 0);
  assert.equal(range.end, last - 1);
});

test("a normal selection is unchanged by the boundary guard", () => {
  const events = [...closedTurn(0), ...closedTurn(4)];
  const session = makeSession(events);
  const range = selectCompactableRange(session, measurementFor(events, -1), 1, 20);
  assert.notEqual(range, undefined);
  assert.equal(range.start, 0);
  assert.ok(range.end < events.length - 1);
});
