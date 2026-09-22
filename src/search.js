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
 * ── P0: the search cannot be made to hang ──────────────────────────────────
 *
 * The pattern is caller-supplied (a model or a human writes it), and a regular
 * expression can be made to backtrack exponentially — on a single-threaded host
 * one `(a+)+$` would otherwise freeze every session sharing the process. Two
 * independent guards bound that:
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
 * ── P1: large sessions and honest result sets ───────────────────────────────
 *
 * Ported from upstream `pi-vcc` v0.8.0 (`src/core/jsonl.ts`,
 * `src/core/search-entries.ts`, `src/core/format-recall.ts`, all MIT):
 *
 *   - **two query modes.** A single word or anything containing regex
 *     metacharacters is scanned as one pattern, exactly as before. A
 *     multi-word query is scored with BM25-lite over the whole corpus and
 *     rendered as ranked hits with a context snippet, so a prose question
 *     returns the events that actually answer it instead of every event that
 *     mentions one of its words. A metacharacter query that finds nothing but
 *     contains whitespace falls through to the ranked path — upstream measured
 *     that gate on real sessions at 47.5% → 1.1% zero-hit queries.
 *   - **noise floor + hard cap with honest accounting.** Ranked hits below
 *     `BM25_RELATIVE_FLOOR` of the top score are dropped, but only for queries
 *     with **two or more distinct** effective terms: repeating or re-casing one
 *     word is still a single-term query, whose score differences are term
 *     frequency rather than OR-tail noise. Every withheld match is reported
 *     (`totalMatches`, `floorDropped`, `omitted`) instead of silently
 *     understating the result count.
 *   - **the search never indexes itself.** A `/recall` run appends its own
 *     output as a durable user message, and the `recall`/`search` tools leave
 *     their invocation and result in the log; without excluding all three, a
 *     repeated query matches its own earlier output and the hit count grows on
 *     every search. This is a targeted invariant about this plugin's own
 *     surface, not a general tool allowlist.
 *   - **streaming line scan.** Bodies are walked with `forEachLine` (an
 *     indexOf scanner) instead of `body.split("\n")`, so one enormous tool
 *     result cannot transiently materialize hundreds of thousands of line
 *     strings; `lineSnippet` and `wordCount` likewise scan without allocating.
 *     Upstream's chunked JSONL reader has no call site here — this host hands
 *     the engine a live event log, never a file — so what is ported is the
 *     property it exists for: bounded per-operation materialization.
 *
 * Deliberately **not** ported: upstream's `TOOL_ARGS_BUDGET` head cap on
 * indexed tool-call arguments. Truncating the indexed text silently loses
 * matches, and "nothing is lost" is this engine's whole contract; the
 * streaming scanner bounds memory without dropping a match.
 *
 * @module dsh-compaction-instant/search
 */
import { estimateEntryTokens, parseToolArguments, sanitize, truncateTokens } from "./compiler.js";
import { projectMessageText } from "./recall.js";
import { formatHitBlock, formatSearchHeader, formatTouchedOutput, TOUCHED_PAGE_SIZE } from "./format.js";
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

/** Context lines kept above and below the first match of a ranked hit. */
export const SNIPPET_CONTEXT_LINES = 2;

/**
 * Relative BM25 noise floor for **multi-term** queries: after ranking, hits
 * scoring below this fraction of the top score are dropped. Relative rather
 * than absolute because BM25 magnitudes vary with corpus size and document
 * length, so a fixed score threshold behaves inconsistently across short and
 * long sessions. Upstream's evidence (real corpora, 161 + 222 queries):
 * 0.20 halved the median result count with 0 zero-hit regressions and 0 top-1
 * changes; 0.10 was too weak, 0.25 roughly doubled top-5 disruption. The
 * top-scoring hit always survives by construction.
 */
export const BM25_RELATIVE_FLOOR = 0.2;
/** BM25 term-frequency saturation and length-normalization constants. */
const BM25_K = 1.2;
const BM25_B = 0.75;

/**
 * Tool names of this plugin's own read-back surface. A search must not match
 * its own invocation (`{ pattern }` arguments) or its own result text: without
 * both exclusions a repeated query keeps matching itself and the hit count
 * grows on every search.
 */
const SELF_TOOL_NAMES = Object.freeze(["recall", "search", "touched_files"]);
/** `source.plugin` values of durable messages this plugin appends (the `/recall` output). */
const SELF_PLUGIN_NAMES = Object.freeze(["recall"]);
/** Command names whose invocation record must not match itself (the `/recall` command). */
const SELF_COMMAND_NAMES = Object.freeze(["recall"]);

/** Stopwords dropped from a natural-language query before scoring. */
const STOPWORDS = new Set([
  // English
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "of", "in", "to", "for",
  "with", "on", "at", "from", "by", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "out", "off", "over",
  "under", "again", "further", "then", "once", "here", "there", "when",
  "where", "why", "how", "all", "both", "each", "few", "more", "most",
  "other", "some", "such", "no", "nor", "not", "only", "own", "same",
  "so", "than", "too", "very", "just", "about", "it", "its", "that",
  "this", "what", "which", "who", "whom", "these", "those"
]);

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

// ── streaming scan helpers (upstream `core/jsonl.ts` property port) ─────────

/**
 * Visit every line of `text` in order without materializing a line array.
 * The emitted sequence is byte-identical to `text.split("\n")` — including the
 * trailing empty segment of a body that ends in a newline — so matching
 * behavior is unchanged; only the allocation is. Returning `false` from
 * `visit` stops the scan.
 * @param text - the body to walk.
 * @param visit - `(line, oneBasedLineNumber) => boolean | void`.
 * @returns the number of lines visited.
 */
export function forEachLine(text, visit) {
  let start = 0;
  let line = 1;
  for (;;) {
    const end = text.indexOf("\n", start);
    if (end === -1) {
      visit(text.slice(start), line);
      return line;
    }
    if (visit(text.slice(start, end), line) === false) return line;
    start = end + 1;
    line += 1;
  }
}

/** Number of lines `text` splits into, without allocating them. */
function countLines(text) {
  let count = 1;
  let index = 0;
  while ((index = text.indexOf("\n", index)) !== -1) {
    count += 1;
    index += 1;
  }
  return count;
}

/** Whitespace-separated word count, scanning without allocating a token array. */
function wordCount(text) {
  let words = 0;
  let inWord = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const space = code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11;
    if (space) inWord = false;
    else if (!inWord) {
      inWord = true;
      words += 1;
    }
  }
  return Math.max(1, words);
}

/** Case-insensitive occurrence count for one compiled term, without an array of matches. */
function termFrequency(text, source) {
  const pattern = new RegExp(source, "gi");
  let count = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    count += 1;
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return count;
}

// ── pattern guards (P0, unchanged) ─────────────────────────────────────────

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

// ── query mode + natural-language scoring (P1) ─────────────────────────────

/** Whether the query looks like a single regex pattern (contains metacharacters). */
export function looksLikeRegex(query) {
  return /[|*+?{}()[\]\\^$.]/.test(query);
}

/**
 * Remove stopwords and one-character noise, keeping meaningful terms. When
 * every term is a stopword the original list is returned — losing the whole
 * query is worse than scoring a weak one.
 * @param terms - whitespace-split query terms.
 * @returns the effective terms.
 */
export function filterStopwords(terms) {
  const meaningful = terms.filter((term) => !STOPWORDS.has(term.toLowerCase()) && term.length > 1);
  return meaningful.length > 0 ? meaningful : terms;
}

/** Compile one term the way the regex path would, so guards apply to both. */
function safeRegexSource(term) {
  return hasNestedQuantifier(term) ? escapeRegex(term) : term;
}

/** Whether a raw query is scanned as one pattern or scored as ranked terms. */
export function queryMode(source) {
  const trimmed = String(source ?? "").trim();
  return looksLikeRegex(trimmed) || !/\s/.test(trimmed) ? "regex" : "terms";
}

/**
 * Numbered context window around the first match of `regex` (±`contextLines`
 * lines), with the count of lines outside the window. One forward scan with a
 * rolling window; the scan stops once the trailing window is full.
 * @param text - the unnumbered body.
 * @param regex - the pattern to locate.
 * @param contextLines - lines kept above and below.
 * @returns `{ lines, omittedAbove, omittedBelow }`, or null when nothing matches.
 */
export function lineSnippet(text, regex, contextLines = SNIPPET_CONTEXT_LINES) {
  const before = [];
  const lines = [];
  let found = false;
  let omittedAbove = 0;
  let matchedLine = 0;
  forEachLine(text, (line, number) => {
    if (!found) {
      if (regex.test(line)) {
        found = true;
        matchedLine = number;
        omittedAbove = number - 1 - before.length;
        lines.push({ line: number, text: sanitize(line) });
        return true;
      }
      before.push({ line: number, text: sanitize(line) });
      if (before.length > contextLines) before.shift();
      return true;
    }
    lines.push({ line: number, text: sanitize(line) });
    return lines.length - 1 < contextLines;
  });
  if (!found) return null;
  const total = countLines(text);
  const omittedBelow = Math.max(0, total - matchedLine - (lines.length - 1));
  return { lines: [...before, ...lines], omittedAbove, omittedBelow };
}

// ── event projection ───────────────────────────────────────────────────────

/**
 * Whether this event belongs to the search's own read-back surface and must not
 * be indexed (see `SELF_TOOL_NAMES`). Tool results are matched to their call by
 * `callId`, because a `tool/result` event carries no tool name of its own.
 * @param event - one session event.
 * @param selfCalls - accumulating set of call ids owned by this plugin's tools.
 * @returns true when the event is the search machinery itself.
 */
function isSelfSearchEvent(event, selfCalls) {
  const data = event.data;
  if (event.type === "command/run") {
    return typeof data?.name === "string" && SELF_COMMAND_NAMES.includes(data.name);
  }
  if (event.type === "tool/call") {
    if (typeof data?.name !== "string" || !SELF_TOOL_NAMES.includes(data.name)) return false;
    if (data.callId !== undefined) selfCalls.add(data.callId);
    return true;
  }
  if (event.type === "tool/result") {
    const callId = data?.message?.source?.callId ?? data?.message?.content?.[0]?.toolCallId;
    return callId !== undefined && selfCalls.has(callId);
  }
  const source = data?.source;
  return source !== undefined && source.kind === "plugin" && SELF_PLUGIN_NAMES.includes(source.plugin);
}

/**
 * Full searchable text for one event: the derived message projected to text
 * (minus this plugin's own tool-call arguments, see `projectMessageText`), or
 * a labeled data dump for a log-only event.
 * @param event - one session event.
 * @param message - its derived message, or null.
 * @returns the text to scan.
 */
function searchableText(event, message) {
  if (message !== null) return projectMessageText(message, { skipToolCalls: SELF_TOOL_NAMES });
  return `[${event.type}]\n${JSON.stringify(event.data ?? null)}`;
}

// ── result rendering ───────────────────────────────────────────────────────

/** Join the rendered header, hits and footers into the model-facing text. */
function renderResult(result) {
  const lines = [
    formatSearchHeader({
      source: result.pattern,
      literal: result.literal,
      mode: result.mode,
      totalMatches: result.totalMatches,
      shown: result.hits.length,
      floorDropped: result.floorDropped,
      truncated: result.truncated
    }),
    ...result.hits.map((hit) => hit.text),
    ...(result.omitted > 0
      ? [`[${result.omitted} more matching event(s) omitted — narrow the pattern or use recall]`]
      : []),
    ...(result.truncated ? ["[search budget exhausted; some hits were cut]"] : [])
  ];
  if (result.hits.length > 0) lines.push("[use recall with a (seq N) pointer to restore any hit's full original content]");
  return lines.join("\n\n");
}

/**
 * Scan every event as one regex, collecting matching lines per event. Hits are
 * capped **during** the scan (the count is not), so a broad pattern over a huge
 * log cannot accumulate unbounded rendered text.
 */
function scanRegex(context, resolved, config) {
  const { events, checkBudget } = context;
  const pattern = resolved.pattern;
  const maxHits = config.maxSearchHits;
  const hits = [];
  let totalMatches = 0;
  let budget = config.maxRecallTokens;
  let truncated = false;
  for (let seq = 0; seq < events.length; seq += 1) {
    checkBudget();
    const event = events[seq];
    if (event === undefined || event.seq !== seq) continue;
    if (isSelfSearchEvent(event, context.selfCalls)) continue;
    const message = typeof context.session.deriveEventMessage === "function" ? context.session.deriveEventMessage(event) : null;
    const text = searchableText(event, message);
    // Only the lines that will be rendered are kept: a pattern that matches
    // every line of a huge body must not accumulate a line object per match
    // just to report a count. `matchedCount` stays the honest total.
    const shown = [];
    let matchedCount = 0;
    forEachLine(text, (line, number) => {
      if (number > 1 && number % BUDGET_CHECK_LINES === 0) checkBudget();
      if (!pattern.test(line)) return true;
      matchedCount += 1;
      if (shown.length < MAX_LINES_PER_HIT) shown.push({ line: number, text: sanitize(line) });
      return true;
    });
    if (matchedCount === 0) continue;
    totalMatches += 1;
    if (hits.length >= maxHits || budget <= 0) {
      truncated = true;
      continue;
    }
    const block = formatHitBlock({
      seq,
      kind: message !== null ? message.role : event.type,
      lines: shown,
      more: matchedCount - shown.length
    });
    const kept = truncateTokens(block, budget, "search budget");
    budget -= estimateEntryTokens(kept.text);
    if (kept.truncated) truncated = true;
    hits.push({ seq, kind: message !== null ? message.role : event.type, text: kept.text });
  }
  return { hits, totalMatches, truncated };
}

/** Stable ranking: BM25 score desc, chronological order for ties. */
function bm25Score(termFrequencies, docLength, terms, context) {
  let score = 0;
  for (let index = 0; index < terms.length; index += 1) {
    const frequency = termFrequencies[index];
    if (frequency === 0) continue;
    const documentFrequency = context.documentFrequency[index];
    const idf = Math.log((context.documents - documentFrequency + 0.5) / (documentFrequency + 0.5) + 1);
    const normalization = BM25_K * (1 - BM25_B + BM25_B * (docLength / context.averageLength));
    score += idf * ((frequency * (BM25_K + 1)) / (frequency + normalization));
  }
  return score;
}

/**
 * Ranked multi-term scan. One pass collects per-event term frequencies and
 * document lengths (small integers — never the document text), a second pass
 * scores and orders them, and only the surviving hits are re-projected to build
 * their snippets.
 */
function scanTerms(context, source, config) {
  const { events, checkBudget } = context;
  const terms = filterStopwords(source.split(/\s+/));
  const termSources = terms.map((term) => safeRegexSource(term));
  const candidates = [];
  const documentFrequency = terms.map(() => 0);
  let documents = 0;
  let totalLength = 0;
  let totalMatches = 0;
  for (let seq = 0; seq < events.length; seq += 1) {
    checkBudget();
    const event = events[seq];
    if (event === undefined || event.seq !== seq) continue;
    if (isSelfSearchEvent(event, context.selfCalls)) continue;
    const message = typeof context.session.deriveEventMessage === "function" ? context.session.deriveEventMessage(event) : null;
    const text = searchableText(event, message);
    documents += 1;
    const docLength = wordCount(text);
    totalLength += docLength;
    const frequencies = [];
    let matchedTerms = 0;
    for (let index = 0; index < termSources.length; index += 1) {
      const frequency = termFrequency(text, termSources[index]);
      frequencies.push(frequency);
      if (frequency > 0) {
        matchedTerms += 1;
        documentFrequency[index] += 1;
      }
    }
    if (matchedTerms === 0) continue;
    totalMatches += 1;
    candidates.push({
      seq,
      kind: message !== null ? message.role : event.type,
      frequencies,
      docLength,
      matchCount: matchedTerms
    });
  }
  if (candidates.length === 0) {
    return { hits: [], totalMatches, floorDropped: 0, truncated: false, terms };
  }
  const scoreContext = {
    documents: Math.max(1, documents),
    averageLength: totalLength / Math.max(1, documents),
    documentFrequency
  };
  const scored = candidates.map((candidate) => ({
    candidate,
    score: bm25Score(candidate.frequencies, candidate.docLength, terms, scoreContext)
  }));
  scored.sort((left, right) => right.score - left.score);

  const distinctTerms = new Set(terms.map((term) => term.toLowerCase())).size;
  const topScore = scored[0].score;
  const kept = distinctTerms >= 2 && topScore > 0
    ? scored.filter((entry) => entry.score >= topScore * (config.relativeFloor ?? BM25_RELATIVE_FLOOR))
    : scored;
  const floorDropped = scored.length - kept.length;

  const snippetPattern = new RegExp(termSources.join("|"), "i");
  const maxHits = config.maxSearchHits;
  const hits = [];
  let budget = config.maxRecallTokens;
  let truncated = false;
  for (const entry of kept) {
    if (hits.length >= maxHits || budget <= 0) {
      truncated = true;
      break;
    }
    const event = events[entry.candidate.seq];
    const message = typeof context.session.deriveEventMessage === "function" ? context.session.deriveEventMessage(event) : null;
    const snippet = lineSnippet(searchableText(event, message), snippetPattern);
    const block = formatHitBlock({
      seq: entry.candidate.seq,
      kind: entry.candidate.kind,
      lines: snippet !== null ? snippet.lines : [],
      notes: snippet !== null
        ? [
            ...(snippet.omittedAbove > 0 ? [`${snippet.omittedAbove} lines above`] : []),
            ...(snippet.omittedBelow > 0 ? [`${snippet.omittedBelow} lines below`] : [])
          ]
        : [],
      score: entry.score,
      matchCount: entry.candidate.matchCount,
      termCount: terms.length
    });
    const keptBlock = truncateTokens(block, budget, "search budget");
    budget -= estimateEntryTokens(keptBlock.text);
    if (keptBlock.truncated) truncated = true;
    hits.push({ seq: entry.candidate.seq, kind: entry.candidate.kind, text: keptBlock.text });
  }
  return { hits, totalMatches, floorDropped, truncated, terms };
}

// ── public search ──────────────────────────────────────────────────────────

/**
 * Search one session's durable log for a keyword, a regular expression, or a
 * natural-language query (see the module doc for the mode rules).
 * @param session - the session whose append-only event log is scanned.
 * @param patternSource - raw query text.
 * @param config - `{ maxRecallTokens, maxSearchHits, searchBudgetMs?, relativeFloor? }`.
 * @returns matching events with their seq pointers and the rendered text.
 * @throws InvalidSearchPatternError | SearchBudgetExceededError
 */
export function searchSession(session, patternSource, config) {
  const source = String(patternSource ?? "").trim();
  if (source.length === 0) throw new InvalidSearchPatternError(patternSource, "pattern is empty");
  const budgetMs = config.searchBudgetMs ?? SEARCH_BUDGET_MS;
  // One deadline per call: the budget is per search, not per event, because
  // N events multiplied by one pathological per-event cost is the runaway case.
  const deadline = Date.now() + budgetMs;
  const checkBudget = () => {
    if (Date.now() > deadline) throw new SearchBudgetExceededError(source, budgetMs);
  };
  const context = { session, events: sessionEvents(session), checkBudget, selfCalls: new Set() };

  let mode = queryMode(source);
  let literal = false;
  let scan;
  if (mode === "regex") {
    const resolved = resolveSearchPattern(source);
    literal = resolved.literal;
    scan = scanRegex(context, resolved, config);
    // A prose question trips the metacharacter detector (a trailing "?" or ".")
    // and then matches nothing verbatim. Retry it as ranked terms rather than
    // answering "no matches" — upstream measured that gate at 47.5% → 1.1%
    // zero-hit queries on real sessions.
    if (scan.totalMatches === 0 && /\s/.test(source)) {
      mode = "terms";
      scan = scanTerms(context, source, config);
    }
  } else {
    scan = scanTerms(context, source, config);
  }

  const result = {
    pattern: source,
    literal,
    mode,
    totalMatches: scan.totalMatches,
    floorDropped: scan.floorDropped ?? 0,
    hits: scan.hits,
    omitted: scan.totalMatches - (scan.floorDropped ?? 0) - scan.hits.length,
    truncated: scan.truncated,
    terms: scan.terms,
    tokens: 0,
    text: ""
  };
  result.tokens = scan.hits.reduce((total, hit) => total + estimateEntryTokens(hit.text), 0);
  result.text = renderResult(result);
  return result;
}

// ── files-touched view (upstream `format-recall.ts` + `getTouchedFiles`) ────

/** Tools whose path argument is always a real file operation. */
export const DEFAULT_FILE_TOOLS = Object.freeze(["read", "write", "edit"]);
/** Argument fields that carry a path, in preference order (upstream's list). */
const PATH_FIELDS = Object.freeze(["file_path", "path", "filePath", "file"]);
/** Argument fields whose presence marks an unknown tool as content-bearing. */
const CONTENT_FIELDS = Object.freeze(["content", "old_string", "new_string", "new_text"]);

/** Path of a file operation, or undefined when the tool call is not one. */
function filePathOf(toolName, input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  let path;
  for (const field of PATH_FIELDS) {
    if (typeof input[field] === "string" && input[field].length > 0) {
      path = input[field];
      break;
    }
  }
  if (path === undefined) return undefined;
  if (DEFAULT_FILE_TOOLS.includes(toolName)) return path;
  // Unknown tool: accept it only when the arguments look like a file write.
  return CONTENT_FIELDS.some((field) => typeof input[field] === "string") ? path : undefined;
}

/**
 * Aggregate every file operation in the session by path, in first-touch order,
 * so the model can jump straight to a `(seq N)` pointer instead of searching.
 * @param session - the session whose event log is scanned.
 * @param config - `{ searchBudgetMs?, page?, pageSize?, cwd? }`.
 * @returns `{ touched, total, text, page, totalPages }`.
 * @throws SearchBudgetExceededError when the scan outruns its budget.
 */
export function collectTouchedFiles(session, config = {}) {
  const budgetMs = config.searchBudgetMs ?? SEARCH_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const checkBudget = () => {
    if (Date.now() > deadline) throw new SearchBudgetExceededError("touched files", budgetMs);
  };
  const events = sessionEvents(session);
  const selfCalls = new Set();
  const byPath = new Map();
  for (let seq = 0; seq < events.length; seq += 1) {
    checkBudget();
    const event = events[seq];
    if (event === undefined || event.seq !== seq) continue;
    if (isSelfSearchEvent(event, selfCalls)) continue;
    const message = typeof session.deriveEventMessage === "function" ? session.deriveEventMessage(event) : null;
    if (message === null || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block === null || typeof block !== "object" || block.type !== "tool-call") continue;
      const path = filePathOf(block.name ?? "", parseToolArguments(block.arguments ?? ""));
      if (path === undefined) continue;
      const existing = byPath.get(path);
      if (existing === undefined) byPath.set(path, { path, entries: [{ seq, toolName: block.name ?? "" }] });
      else existing.entries.push({ seq, toolName: block.name ?? "" });
    }
  }
  const touched = [...byPath.values()];
  const size = config.pageSize ?? TOUCHED_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(touched.length / size));
  const page = Math.min(Math.max(1, config.page ?? 1), totalPages);
  const shown = touched.slice((page - 1) * size, (page - 1) * size + size);
  const text = formatTouchedOutput(touched, page, size, config.cwd);
  return {
    touched,
    total: touched.length,
    text,
    page,
    totalPages,
    pageSize: size,
    // Durable seqs behind the rendered page, for a caller that wants to record
    // where its own output came from (the `/recall files` command does).
    shownSeqs: shown.flatMap((file) => file.entries.map((entry) => entry.seq)),
    tokens: estimateEntryTokens(text)
  };
}
