/**
 * Output formatting types for the recall/search surface: path shortening, the
 * aggregated files-touched view, and the hit/header rendering both search modes
 * share (ported from upstream `pi-vcc` v0.8.0 `src/core/format-recall.ts`).
 * @module dsh-compaction-instant/format
 */

/** Rows per page of the aggregated "files touched" view. */
export declare const TOUCHED_PAGE_SIZE: number;

/** One numbered line of a rendered hit. */
export interface RenderedLine {
    line: number;
    text: string;
}

/** One hit block: a header line plus numbered matching lines or a snippet. */
export interface RenderableHit {
    seq: number;
    kind: string;
    lines?: readonly RenderedLine[];
    /** Matching lines beyond the per-hit cap. */
    more?: number;
    /** Extra parenthetical notes (snippet context counts). */
    notes?: readonly string[];
    /** Paths the entry touched, when known. */
    files?: readonly string[];
    /** BM25 score (ranked hits only). */
    score?: number;
    /** Distinct query terms matched (ranked hits only). */
    matchCount?: number;
    /** Effective term count of the query (ranked hits only). */
    termCount?: number;
}

/** Search/recall header summary. */
export interface SearchHeaderSummary {
    source: string;
    literal?: boolean;
    mode?: string;
    totalMatches: number;
    shown: number;
    floorDropped?: number;
    truncated?: boolean;
}

/** One file touched in the session, with the seqs of every operation on it. */
export interface TouchedFile {
    path: string;
    entries: readonly { seq: number; toolName: string }[];
}

/** Shorten an absolute file path for display. */
export declare function shortPath(fullPath: string, cwd?: string): string;
/** Render one search or recall hit. */
export declare function formatHitBlock(hit: RenderableHit): string;
/** Render one search/recall result header, stating honestly what was withheld. */
export declare function formatSearchHeader(summary: SearchHeaderSummary): string;
/** Render one page of the aggregated files-touched view. */
export declare function formatTouchedOutput(
    touched: readonly TouchedFile[],
    page?: number,
    pageSize?: number,
    cwd?: string
): string;
