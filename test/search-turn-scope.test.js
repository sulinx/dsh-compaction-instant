/**
 * Search scope: the turn in progress is left out (P5b).
 *
 * A search runs inside a turn, so the agent's own question is the newest content
 * in the log. Matching it is how a search made to answer a question returns the
 * question itself as the top hit.
 * @module dsh-compaction-instant/test/search-turn-scope
 */
import assert from "node:assert/strict";
import test from "node:test";
import { searchSession } from "../src/search.js";

const user = (seq, text) => ({ seq, type: "user/message", time: seq, data: { message: { role: "user", content: [{ type: "text", text }] }, source: { kind: "user" } } });
const assistant = (seq, text) => ({ seq, type: "assistant/message", time: seq, data: { message: { role: "assistant", content: [{ type: "text", text }] } } });
const turnStart = (seq, turn) => ({ seq, type: "turn/start", time: seq, data: { turn } });
const turnEnd = (seq, turn) => ({ seq, type: "turn/end", time: seq, data: { turn } });

/** Minimal session shape search reads. */
const sessionOf = (events) => ({ snapshotEvents: () => events });

/** One closed turn and one open turn that repeats the same keyword. */
function openTurnSession() {
  return sessionOf([
    turnStart(0, 1),
    user(1, "how does the retry budget work?"),
    assistant(2, "the retry budget is compactionRetries"),
    turnEnd(3, 1),
    turnStart(4, 2),
    user(5, "retry budget"),
    assistant(6, "thinking about the retry budget")
  ]);
}

test("a regex search does not return the turn in progress", () => {
  const scan = searchSession(openTurnSession(), "retry", { maxSearchHits: 10 });
  assert.equal(scan.mode, "regex");
  assert.deepEqual(scan.hits.map((hit) => hit.seq), [1, 2]);
  assert.equal(scan.skippedTurnEvents, 3);
  assert.equal(scan.openTurn, 2);
  assert.match(scan.text, /the turn in progress \(turn 2\) is not searched \(3 event\(s\) so far\)/);
});

test("a ranked multi-term search is scoped the same way", () => {
  const scan = searchSession(openTurnSession(), "how retry budget work", { maxSearchHits: 10 });
  assert.equal(scan.mode, "terms");
  assert.deepEqual([...scan.hits.map((hit) => hit.seq)].sort((a, b) => a - b), [1, 2]);
  assert.equal(scan.skippedTurnEvents, 3);
});

test("an idle session skips nothing and says nothing", () => {
  const session = sessionOf([
    turnStart(0, 1),
    user(1, "retry budget"),
    assistant(2, "the retry budget is compactionRetries"),
    turnEnd(3, 1)
  ]);
  const scan = searchSession(session, "retry", { maxSearchHits: 10 });
  assert.equal(scan.skippedTurnEvents, 0);
  assert.equal(scan.openTurn, undefined);
  assert.ok(!scan.text.includes("turn in progress"));
  assert.deepEqual(scan.hits.map((hit) => hit.seq), [1, 2]);
});

test("explicit recall is unaffected: only search scopes by turn", () => {
  const session = openTurnSession();
  // The current turn's events are still in the log and still addressable.
  assert.equal(session.snapshotEvents().length, 7);
});
