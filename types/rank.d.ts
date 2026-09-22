/**
 * Relevance ranking and repeat collapsing for compiled checkpoint rows
 * (port of upstream pi-vcc `core/rank.ts`).
 * @module dsh-compaction-instant/rank
 */

/** Scoring weights; upstream's numbers with the DSH tool vocabulary. */
export declare const DEFAULT_RANK_WEIGHTS: {
    recencyMax: number;
    userText: number;
    assistantText: number;
    checkpointRow: number;
    mediaRow: number;
    noteRow: number;
    editTool: number;
    testCommand: number;
    workflowCommand: number;
    otherTool: number;
    readTool: number;
    trivialCommand: number;
    repeatPenalty: number;
    longRowPenalty: number;
    longRowChars: number;
};

/** Minimum run length that justifies replacing repeated rows with one marker. */
export declare const MIN_REPEAT_RUN: number;

/** One compiled row as the ranking sees it. */
export interface RankableRow {
    /** Compiled entry kind (`text` | `reasoning` | `tool` | `media` | `note` | `checkpoint`). */
    kind: string;
    /** Rendered row text. */
    text?: string;
    /** Tool name for `kind: "tool"`. */
    toolName?: string;
    /** The key argument the one-liner rendered. */
    argText?: string;
    /** `user` | `assistant` for text rows. */
    role?: string;
    /** Position among the region's compiled rows. */
    index?: number;
    /** Number of rows in the region. */
    total?: number;
    /** How many times this row's rank key has been seen so far. */
    repeats?: number;
}

/** `test` | `workflow` | `trivial` | `other`. */
export declare function classifyCommand(command: unknown): 'test' | 'workflow' | 'trivial' | 'other';
/** The dedup/repeat identity of one rendered row, or undefined. */
export declare function rankKeyOf(row: { kind?: string; toolName?: string; argText?: string }): string | undefined;
/** Score one compiled row. */
export declare function rankScore(input: RankableRow, weights?: typeof DEFAULT_RANK_WEIGHTS): { score: number; reasons: string[] };
/** Index of the row the cap should drop next, or -1. */
export declare function lowestValueIndex(entries: readonly { kind: string; score?: number }[], isLowValue: (entry: any) => boolean): number;
/** Collapse runs of the same repeated tool row into one marker. */
export declare function collapseRepeatedRows(entries: readonly any[]): { entries: any[]; collapsed: boolean; collapsedRows: number };
