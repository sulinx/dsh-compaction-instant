/**
 * Regression tests for the search guards ported from upstream `pi-vcc` v0.8.0
 * `src/core/search-entries.ts`: the nested-quantifier literal fallback that
 * removes textbook ReDoS shapes, and the wall-clock budget that backstops the
 * shapes it cannot see (e.g. alternation overlap such as `(a|a)+`).
 * @module dsh-compaction-instant/test/search-guard
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  compileSearchPattern,
  hasNestedQuantifier,
  InvalidSearchPatternError,
  quantifierAt,
  resolveSearchPattern,
  SEARCH_BUDGET_MS,
  SearchBudgetExceededError,
  searchSession
} from "../src/search.js";
import { resolveConfig as resolveCommandConfig } from "../src/command.js";
import { defineSearchTool, resolveConfig as resolveToolConfig } from "../src/tool.js";

/** Minimal session-shaped value: one text line per event (recall.js shape). */
function fakeSession(texts) {
  return {
    events: texts.map((text, seq) => ({ seq, type: "assistant/message", data: { text } })),
    deriveEventMessage: (event) => ({ role: "assistant", content: [{ type: "text", text: event.data.text }] })
  };
}

const SEARCH_CONFIG = { maxRecallTokens: 16000, maxSearchHits: 50 };

// ── quantifierAt ────────────────────────────────────────────────────────────

test("quantifierAt reads unbounded and bounded quantifiers", () => {
  assert.deepEqual(quantifierAt("a+", 1), { length: 1, unbounded: true });
  assert.deepEqual(quantifierAt("a*", 1), { length: 1, unbounded: true });
  assert.deepEqual(quantifierAt("a?", 1), { length: 0, unbounded: false });
  assert.deepEqual(quantifierAt("a{2}", 1), { length: 3, unbounded: false });
  assert.deepEqual(quantifierAt("a{2,}", 1), { length: 4, unbounded: true });
  assert.deepEqual(quantifierAt("a{2,5}", 1), { length: 5, unbounded: false });
  // Not a quantifier: no `}`, or a non-numeric body.
  assert.deepEqual(quantifierAt("a{", 1), { length: 0, unbounded: false });
  assert.deepEqual(quantifierAt("a{x,}", 1), { length: 0, unbounded: false });
  assert.deepEqual(quantifierAt("abc", 1), { length: 0, unbounded: false });
});

// ── hasNestedQuantifier ─────────────────────────────────────────────────────

test("hasNestedQuantifier flags unbounded quantifiers over quantified groups", () => {
  for (const pattern of ["(a+)+", "(a+)+$", "(\\w*)*", "x(a*b+)+y", "((a+))*", "(a{2,})+", "(a+){2,}"]) {
    assert.equal(hasNestedQuantifier(pattern), true, pattern);
  }
});

test("hasNestedQuantifier stays off for bounded or non-nested patterns", () => {
  for (const pattern of [
    "",
    "a+",
    "(a|b)+",            // mixed alternation is the budget's job, not this guard's
    "foo(bar)?baz",
    "(a{2})+",           // bounded inner quantifier
    "(a{2,5})+",         // bounded inner quantifier
    "(a+)?",             // bounded outer quantifier
    "(a+)b+",            // the unbounded quantifier sits outside the group
    "\\(a+\\)\\+",       // escaped parens: a literal, not a group
    "[(a+)]+",           // a character class, not a group
    "[(]a+[)]+",
    "(?=a+)b",           // lookahead: never quantified
    "a\\+",
    "(a+)\\+"            // the trailing + is escaped, so the group stays unflagged
  ]) {
    assert.equal(hasNestedQuantifier(pattern), false, pattern);
  }
});

// ── compile / resolve ───────────────────────────────────────────────────────

test("resolveSearchPattern compiles normally and downgrades only nested quantifiers", () => {
  const normal = resolveSearchPattern("VCC");
  assert.equal(normal.literal, false);
  assert.equal(normal.source, "VCC");
  assert.equal(normal.pattern.test("vcc compiler"), true);

  // A real regex still compiles as a regex — the guard must not over-trigger.
  const regex = resolveSearchPattern("a{2,5}");
  assert.equal(regex.literal, false);
  assert.equal(regex.pattern.test("aaa"), true);

  const downgraded = resolveSearchPattern("(a+)+$");
  assert.equal(downgraded.literal, true);
  assert.equal(downgraded.source, "(a+)+$");
  // Matched literally: the pattern text itself, not the backreference shape.
  assert.equal(downgraded.pattern.test("please run (a+)+$ now"), true);
  assert.equal(downgraded.pattern.test("aaaa"), false);
});

test("compileSearchPattern keeps throwing for empty and uncompilable patterns", () => {
  assert.equal(compileSearchPattern("VCC").test("vcc"), true);
  assert.throws(() => compileSearchPattern(""), InvalidSearchPatternError);
  assert.throws(() => compileSearchPattern("   "), InvalidSearchPatternError);
  assert.throws(() => compileSearchPattern("(unclosed"), InvalidSearchPatternError);
  assert.throws(() => resolveSearchPattern("(unclosed"), InvalidSearchPatternError);
});

// ── searchSession under a hostile pattern ───────────────────────────────────

test("a catastrophic pattern is matched literally instead of hanging the search", () => {
  // 50k 'a' with no trailing 'b': `(a+)+b` unguarded explores exponentially.
  const hostile = `${"a".repeat(50_000)}`;
  const session = fakeSession([hostile]);
  const started = Date.now();
  const result = searchSession(session, "(a+)+b", SEARCH_CONFIG);
  const elapsed = Date.now() - started;
  assert.equal(result.literal, true);
  assert.equal(result.totalMatches, 0);
  assert.ok(elapsed < 1000, `search took ${elapsed}ms`);
  // The same pattern still answers when the text really contains it.
  const literalHit = searchSession(fakeSession(["keep (a+)+b as-is"]), "(a+)+b", SEARCH_CONFIG);
  assert.equal(literalHit.totalMatches, 1);
  assert.match(literalHit.text, /\(literal match: nested quantifier\)/);
});

test("an ordinary regex over a large body is unaffected by the guard", () => {
  const session = fakeSession([Array.from({ length: 2000 }, (_, i) => `line ${i} aaaab`).join("\n")]);
  const result = searchSession(session, "a+b", SEARCH_CONFIG);
  assert.equal(result.literal, false);
  assert.equal(result.totalMatches, 1);
  assert.match(result.text, /\[search "a\+b": 1 matching event\(s\)\]/);
});

test("a search that outruns its wall-clock budget aborts loudly", () => {
  assert.equal(SEARCH_BUDGET_MS, 3000);
  const session = fakeSession(["one", "two", "three"]);
  assert.throws(
    () => searchSession(session, "e", { ...SEARCH_CONFIG, searchBudgetMs: -1 }),
    (error) => error instanceof SearchBudgetExceededError && error.source === "e" && /search budget/.test(error.message)
  );
});

test("the search tool maps a budget abort to a typed harness error", async () => {
  // Large enough that the scan cannot finish inside the 1ms budget.
  const texts = Array.from({ length: 300 }, (_, event) =>
    Array.from({ length: 300 }, (_, line) => `event ${event} line ${line} payload`).join("\n"));
  const tool = defineSearchTool(resolveToolConfig({ searchBudgetMs: 1 }));
  await assert.rejects(
    () => tool.execute({ pattern: "payload" }, { agent: { session: fakeSession(texts) } }),
    (error) => error.code === "SEARCH_BUDGET_EXCEEDED" && /search budget/.test(error.message)
  );
});

// ── config surface ──────────────────────────────────────────────────────────

test("the tool and command configs default and validate searchBudgetMs", () => {
  assert.equal(resolveToolConfig({}).searchBudgetMs, SEARCH_BUDGET_MS);
  assert.equal(resolveCommandConfig({}).searchBudgetMs, SEARCH_BUDGET_MS);
  assert.equal(resolveToolConfig({ searchBudgetMs: 250 }).searchBudgetMs, 250);
  assert.equal(resolveCommandConfig({ searchBudgetMs: 250 }).searchBudgetMs, 250);
  assert.throws(() => resolveToolConfig({ searchBudgetMs: 0 }), /searchBudgetMs/);
  assert.throws(() => resolveToolConfig({ searchBudgetMs: -5 }), /searchBudgetMs/);
  assert.throws(() => resolveToolConfig({ searchBudgetMs: Number.NaN }), /searchBudgetMs/);
  assert.throws(() => resolveCommandConfig({ searchBudgetMs: "3000" }), /searchBudgetMs/);
});
