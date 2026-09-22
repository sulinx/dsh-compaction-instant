/**
 * Keyword/regex/ranked search over the durable session log types.
 * @module dsh-compaction-instant/search
 */

/** Default cap on the number of matching events shown in one result. */
export declare const DEFAULT_MAX_SEARCH_HITS: number;
/** Default cap on shown matching lines per hit event. */
export declare const MAX_LINES_PER_HIT: number;
/** Wall-clock budget for one search, in milliseconds (default 3000). */
export declare const SEARCH_BUDGET_MS: number;
/** Context lines kept above and below the first match of a ranked hit. */
export declare const SNIPPET_CONTEXT_LINES: number;
/** Relative BM25 noise floor applied to multi-term queries (default 0.2). */
export declare const BM25_RELATIVE_FLOOR: number;
/** Tools whose path argument always marks a file operation (read/write/edit). */
export declare const DEFAULT_FILE_TOOLS: readonly string[];

/** A search pattern that cannot be compiled into a regular expression. */
export declare class InvalidSearchPatternError extends Error {
    readonly source: string;
    constructor(source: unknown, reason: string);
}

/** A search that outran its wall-clock budget before finishing the corpus. */
export declare class SearchBudgetExceededError extends Error {
    readonly source: string;
    readonly budgetMs: number;
    constructor(source: unknown, budgetMs: number);
}

/** How one pattern was interpreted: compiled as a regex, or matched literally. */
export interface ResolvedSearchPattern {
    /** The compiled pattern (escaped when `literal`). */
    pattern: RegExp;
    /** The trimmed source text the caller supplied. */
    source: string;
    /** True when nested unbounded quantifiers forced a literal match. */
    literal: boolean;
}

/** How one query is scanned: as a single pattern, or as ranked terms. */
export type SearchQueryMode = 'regex' | 'terms';

/** One search hit: the durable seq, its kind, and the rendered block. */
export interface SearchHit {
    seq: number;
    kind: string;
    text: string;
}

/** Result of one search over a session log. */
export interface SearchResult {
    /** Compiled pattern source (after trimming). */
    pattern: string;
    /** True when the pattern was matched literally, not as a regex. */
    literal: boolean;
    /** Which path answered: one pattern, or BM25-ranked terms. */
    mode: SearchQueryMode;
    /** Events containing at least one match (after excluding the search surface itself). */
    totalMatches: number;
    /** Ranked matches dropped by the relative floor (0 on the regex path). */
    floorDropped: number;
    /** Rendered hits (bounded by `maxSearchHits` and the token budget). */
    hits: SearchHit[];
    /** Matches withheld by the cap or the floor. */
    omitted: number;
    /** Whether hits were dropped or cut by the budget. */
    truncated: boolean;
    /** Effective query terms (ranked path only). */
    terms?: readonly string[];
    /** Density-aware token total of the rendered hits. */
    tokens: number;
    /** The joined model-facing text. */
    text: string;
}

/** Search configuration (`maxRecallTokens`/`maxSearchHits` plus optional overrides). */
export interface SearchConfig {
    maxRecallTokens: number;
    maxSearchHits: number;
    /** Wall-clock budget for one search, in milliseconds. Default `SEARCH_BUDGET_MS`. */
    searchBudgetMs?: number;
    /**
     * Relative BM25 noise floor for multi-term queries. Default
     * `BM25_RELATIVE_FLOOR`; production call sites never pass it (upstream's
     * `SearchTuning` is for benches and targeted tests).
     */
    relativeFloor?: number;
}

/** Files-touched scan configuration. */
export interface TouchedConfig {
    searchBudgetMs?: number;
    page?: number;
    pageSize?: number;
    /** Directory to relativize displayed paths against. */
    cwd?: string;
}

/** One aggregated file, with the seqs of every operation on it. */
export interface TouchedFile {
    path: string;
    entries: readonly { seq: number; toolName: string }[];
}

/** Result of the files-touched scan. */
export interface TouchedResult {
    touched: readonly TouchedFile[];
    total: number;
    text: string;
    page: number;
    totalPages: number;
    pageSize: number;
    /** Durable seqs behind the rendered page. */
    shownSeqs: number[];
    tokens: number;
}

/** Session-shaped value search reads from. */
export interface SearchableSession {
    events: readonly { seq: number; type: string; data: unknown }[];
    deriveEventMessage?(event: unknown): { role: string; content: readonly unknown[] } | null;
}

/** Visit every line of `text` without materializing a line array (returns false to stop). */
export declare function forEachLine(text: string, visit: (line: string, lineNumber: number) => boolean | void): number;
/** Whether the query looks like a single regex pattern (contains metacharacters). */
export declare function looksLikeRegex(query: string): boolean;
/** Which path a query takes: one compiled pattern, or BM25-ranked terms. */
export declare function queryMode(source: string): SearchQueryMode;
/** Remove stopwords and one-character noise from a natural-language query. */
export declare function filterStopwords(terms: readonly string[]): string[];
/** Numbered context window around the first match of `regex`. */
export declare function lineSnippet(
    text: string,
    regex: RegExp,
    contextLines?: number
): { lines: { line: number; text: string }[]; omittedAbove: number; omittedBelow: number } | null;
/** Length and boundedness of the quantifier starting at `index`, if any. */
export declare function quantifierAt(pattern: string, index: number): { length: number; unbounded: boolean };
/** Detect an unbounded quantifier applied to a group that already contains one. */
export declare function hasNestedQuantifier(pattern: string): boolean;
/** Compile one pattern, reporting whether nested quantifiers forced a literal match. */
export declare function resolveSearchPattern(source: unknown): ResolvedSearchPattern;
/** Compile one search pattern (case-insensitive, Unicode-aware, ReDoS-guarded). */
export declare function compileSearchPattern(source: unknown): RegExp;
/** Search the durable log; returns matching events with their seq pointers. */
export declare function searchSession(session: SearchableSession, patternSource: string, config: SearchConfig): SearchResult;
/** Aggregate every file operation in the session by path, in first-touch order. */
export declare function collectTouchedFiles(session: SearchableSession, config?: TouchedConfig): TouchedResult;
