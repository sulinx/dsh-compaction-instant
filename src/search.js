/**
 * Keyword/regex search over the durable session log for `dsh-compaction-instant`.
 *
 * The retrieval counterpart of the VCC-style compiler's `--grep` view: the
 * append-only session log is the full transcript, so this module scans every
 * event's projected content and returns the matching events with their
 * `(seq N)` pointers. An agent (or the `/recall` command) can then call
 * `recall` with any pointer to restore the exact original tokens.
 *
 * Nothing is modified, nothing is elided — only the rendered hit lines are
 * bounded, by the shared `maxRecallTokens` budget and a per-hit line cap.
 *
 * The pattern is caller-supplied (a model or a human writes it), and a regular
 * expression can be made to backtrack exponentially — on a single-threaded host
 * one `(a+)+$` would otherwise freeze every session sharing the process. Two
 * independent guards bound that, ported from upstream `pi-vcc` v0.8.0
 * `src/core/search-entries.ts`:
 *
 *   1. **structural** (`hasNestedQuantifier`) — a pattern that applies an
 *      unbounded quantifier to a group that already contains one is matched as
 *      a literal string instead of being compiled, which removes the textbook
 *      ReDoS shapes without rejecting the query; and
 *   2. **wall-clock** (`SEARCH_BUDGET_MS`) — checked between events and every
 *      `BUDGET_CHECK_LINES` scanned lines, so a pattern that survives step 1
 *      (alternation overlap such as `(a|a)+`) aborts loudly instead of running
 *      to completion over the whole corpus. JavaScript cannot interrupt a
 *      running `RegExp.test`, so this is a checkpoint between matches, not a
 *      hard per-call ceiling — the damage is bounded to one checkpoint window.
 *
 * @module dsh-compaction-instant/search
 */
import { estimateEntryTokens, sanitize, truncateTokens } from "./compiler.js";
import { projectMessageText } from "./recall.js";
const sessionEvents = (s) => (Array.isArray(s.events) ? s.events : s.snapshotEvents ? s.snapshotEvents() : []);

/** Default cap on the number of matching events shown in one result. */
export const DEFAULT_MAX_SEARCH_HITS = 50;
/** Default cap on shown matching lines per hit event. */
export const MAX_LINES_PER_HIT = 10;

/**
 * Wall-clock budget for one search, in milliseconds. A normal query over a few
 * hundred events takes ~10ms, so this only trips on a pathological pattern that
 * survived the structural guard. Aborting loudly beats freezing the host — or
 * returning a silently truncated match count.
 */
export const SEARCH_BUDGET_MS = 3000;
/** Scanned lines between two budget checkpoints inside one event body. */
const BUDGET_CHECK_LINES = 512;

/** A search pattern that cannot be compiled into a regular expression. */
export class InvalidSearchPatternError extends Error {
  /**
   * @param source - the raw pattern the user supplied.
   * @param reason - the regex compiler's message.
   */
  constructor(source, reason) {
    super(`invalid search pattern ${JSON.stringify(String(source))}: ${reason}`);
    this.source = String(source);
  }
}

/** A search that outran its wall-clock budget before finishing the corpus. */
export class SearchBudgetExceededError extends Error {
  /**
   * @param source - the raw pattern the user supplied.
   * @param budgetMs - the budget that was exceeded.
   */
  constructor(source, budgetMs) {
    super(
      `search aborted: pattern ${JSON.stringify(String(source))} exceeded the ${budgetMs}ms search budget — ` +
      "simplify the pattern; nested quantifiers such as (a+)+ can make matching blow up"
    );
    this.source = String(source);
    this.budgetMs = budgetMs;
  }
}

/** Escape every regular-expression metacharacter so the text matches literally. */
function escapeRegex(source) {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Length and boundedness of the quantifier starting at `index`, if any. Only
 * unbounded forms (`+`, `*`, `{n,}`) can drive catastrophic backtracking;
 * bounded ones (`{2}`, `{2,5}`) always terminate.
 * @param pattern - the pattern text.
 * @param index - index of the candidate quantifier character.
 * @returns the quantifier's length (`0` when there is none) and whether it is unbounded.
 */
export function quantifierAt(pattern, index) {
  const char = pattern[index];
  if (char === "+" || char === "*") return { length: 1, unbounded: true };
  if (char === "{") {
    const end = pattern.indexOf("}", index);
    const body = end === -1 ? "" : pattern.slice(index + 1, end);
    if (/^\d+(,\d*)?$/.test(body)) return { length: end - index + 1, unbounded: body.endsWith(",") };
  }
  return { length: 0, unbounded: false };
}

/**
 * Detect an unbounded quantifier applied to a group that already contains one,
 * e.g. `(a+)+` or `(\w*)*`. That shape makes the engine explore exponentially
 * many splits on a non-matching input. Alternation overlap such as `(a|a)+` is
 * not covered here; the wall-clock budget in `searchSession` is the backstop.
 * @param pattern - the pattern text.
 * @returns true when the pattern nests unbounded quantifiers.
 */
export function hasNestedQuantifier(pattern) {
  const groups = []; // per open group: does it contain an unbounded quantifier?
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") {
      inClass = true;
      continue;
    }
    if (char === "(") {
      groups.push(false);
      continue;
    }
    if (char === ")") {
      const inner = groups.pop() ?? false;
      const quantifier = quantifierAt(pattern, index + 1);
      if (inner && quantifier.unbounded) return true;
      if (groups.length > 0) groups[groups.length - 1] = groups[groups.length - 1] || inner || quantifier.unbounded;
      index += quantifier.length;
      continue;
    }
    const quantifier = quantifierAt(pattern, index);
    if (quantifier.unbounded && groups.length > 0) {
      groups[groups.length - 1] = true;
      index += quantifier.length - 1;
    }
  }
  return false;
}

/**
 * Compile one search pattern: case-insensitive, Unicode-aware, treated as a
 * regular expression (VCC `--grep` semantics) so keywords work as-is and
 * regexes work when escaped. A pattern whose structure nests unbounded
 * quantifiers is compiled as its escaped literal instead — the query still
 * answers, it just cannot explode (see `hasNestedQuantifier`).
 * @param source - raw pattern text.
 * @returns the compiled pattern, the trimmed source, and whether it was matched literally.
 * @throws InvalidSearchPatternError when empty or not compilable.
 */
export function resolveSearchPattern(source) {
  const trimmed = String(source ?? "").trim();
  if (trimmed.length === 0) throw new InvalidSearchPatternError(source, "pattern is empty");
  const literal = hasNestedQuantifier(trimmed);
  try {
    return {
      pattern: new RegExp(literal ? escapeRegex(trimmed) : trimmed, "iu"),
      source: trimmed,
      literal
    };
  } catch (error) {
    throw new InvalidSearchPatternError(source, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Compile one search pattern (case-insensitive, Unicode-aware regex, with the
 * nested-quantifier guard applied).
 * @param source - raw pattern text.
 * @returns the compiled pattern.
 * @throws InvalidSearchPatternError when empty or not compilable.
 */
export function compileSearchPattern(source) {
  return resolveSearchPattern(source).pattern;
}

/**
 * Search one session's durable log for a keyword or regex.
 * @param session - the session whose append-only event log is scanned.
 * @param patternSource - raw pattern text (see `resolveSearchPattern`).
 * @param config - `{ maxRecallTokens, maxSearchHits, searchBudgetMs? }`.
 * @returns matching events with their seq pointers and the rendered text.
 * @throws InvalidSearchPatternError | SearchBudgetExceededError
 */
export function searchSession(session, patternSource, config) {
  const { pattern, source, literal } = resolveSearchPattern(patternSource);
  const budgetMs = config.searchBudgetMs ?? SEARCH_BUDGET_MS;
  // One deadline per call: the budget is per search, not per event, because
  // N events multiplied by one pathological per-event cost is the runaway case.
  const deadline = Date.now() + budgetMs;
  const checkBudget = () => {
    if (Date.now() > deadline) throw new SearchBudgetExceededError(source, budgetMs);
  };
  const maxHits = config.maxSearchHits;
  const maxTokens = config.maxRecallTokens;
  const events = sessionEvents(session);
  const hits = [];
  let totalMatches = 0;
  let budget = maxTokens;
  let truncated = false;
  for (let seq = 0; seq < events.length; seq += 1) {
    checkBudget();
    const event = events[seq];
    if (event === undefined || event.seq !== seq) continue;
    const message = typeof session.deriveEventMessage === "function" ? session.deriveEventMessage(event) : null;
    const body = message !== null
      ? projectMessageText(message)
      : `[${event.type}]\n${JSON.stringify(event.data ?? null)}`;
    const lines = body.split("\n");
    const matched = [];
    for (let index = 0; index < lines.length; index += 1) {
      // A single line's `test` cannot be interrupted, so this bounds the
      // overshoot to one checkpoint window instead of one whole event body.
      if (index > 0 && index % BUDGET_CHECK_LINES === 0) checkBudget();
      if (pattern.test(lines[index])) matched.push({ line: index + 1, text: sanitize(lines[index]) });
    }
    if (matched.length === 0) continue;
    totalMatches += 1;
    if (hits.length >= maxHits || budget <= 0) {
      truncated = true;
      continue;
    }
    const header = `[seq ${seq}: ${message !== null ? message.role : event.type}]`;
    const shown = matched.slice(0, MAX_LINES_PER_HIT);
    const more = matched.length - shown.length;
    const block = [
      header,
      ...shown.map((match) => `  ${match.line}: ${match.text}`),
      ...(more > 0 ? [`  ...(${more} more matching lines in this event)`] : [])
    ].join("\n");
    const kept = truncateTokens(block, budget, "search budget");
    budget -= estimateEntryTokens(kept.text);
    if (kept.truncated) truncated = true;
    hits.push({ seq, kind: message !== null ? message.role : event.type, text: kept.text });
  }
  const omitted = totalMatches - hits.length;
  const lines = [
    `[search "${source}"${literal ? " (literal match: nested quantifier)" : ""}: ${totalMatches} matching event(s)]`,
    ...hits.map((hit) => hit.text),
    ...(omitted > 0 ? [`[${omitted} more matching event(s) omitted — narrow the pattern or use recall]`] : []),
    ...(truncated ? ["[search budget exhausted; some hits were cut]"] : [])
  ];
  if (hits.length > 0) lines.push("[use recall with a (seq N) pointer to restore any hit's full original content]");
  const text = lines.join("\n\n");
  return {
    pattern: source,
    literal,
    totalMatches,
    hits,
    omitted,
    truncated,
    tokens: hits.reduce((total, hit) => total + estimateEntryTokens(hit.text), 0),
    text
  };
}
