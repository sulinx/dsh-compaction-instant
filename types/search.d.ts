/**
 * Keyword/regex search over the durable session log types.
 * @module dsh-compaction-instant/search
 */

/** Default cap on the number of matching events shown in one result. */
export declare const DEFAULT_MAX_SEARCH_HITS: number;
/** Default cap on shown matching lines per hit event. */
export declare const MAX_LINES_PER_HIT: number;
/** Wall-clock budget for one search, in milliseconds (default 3000). */
export declare const SEARCH_BUDGET_MS: number;

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

/** One search hit: the durable seq, its kind, and the rendered matched lines. */
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
    /** Events containing at least one matching line. */
    totalMatches: number;
    /** Rendered hits (bounded by `maxSearchHits` and the token budget). */
    hits: SearchHit[];
    /** Matching events beyond the shown cap. */
    omitted: number;
    /** Whether hits were dropped or cut by the budget. */
    truncated: boolean;
    /** Density-aware token total of the rendered hits. */
    tokens: number;
    /** The joined model-facing text. */
    text: string;
}

/** Search configuration (`maxRecallTokens`/`maxSearchHits` plus an optional budget override). */
export interface SearchConfig {
    maxRecallTokens: number;
    maxSearchHits: number;
    /** Wall-clock budget for one search, in milliseconds. Default `SEARCH_BUDGET_MS`. */
    searchBudgetMs?: number;
}

/** Session-shaped value search reads from. */
export interface SearchableSession {
    events: readonly { seq: number; type: string; data: unknown }[];
    deriveEventMessage?(event: unknown): { role: string; content: readonly unknown[] } | null;
}

/** Length and boundedness of the quantifier starting at `index`, if any. */
export declare function quantifierAt(pattern: string, index: number): { length: number; unbounded: boolean };
/** Detect an unbounded quantifier applied to a group that already contains one. */
export declare function hasNestedQuantifier(pattern: string): boolean;
/** Compile one pattern, reporting whether nested quantifiers forced a literal match. */
export declare function resolveSearchPattern(source: unknown): ResolvedSearchPattern;
/** Compile one search pattern (case-insensitive, Unicode-aware regex, ReDoS-guarded). */
export declare function compileSearchPattern(source: unknown): RegExp;
/** Search the durable log; returns matching events with their seq pointers. */
export declare function searchSession(session: SearchableSession, patternSource: string, config: SearchConfig): SearchResult;
