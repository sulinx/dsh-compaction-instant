/**
 * Durable compaction transaction types (surface retention + log protocol).
 * @module dsh-compaction-instant/region
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CompactionResult } from '@deepseek-ai/dsh-compaction';
import type { Session } from '@deepseek-ai/dsh-session';
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter';

/** Rejects a compiled checkpoint whose replacement boundaries changed. */
export declare class SurfaceChangedError extends Error {}

/** Conversation meter and compile hook bound by the engine. */
export interface RegionDependencies {
    meter: {
        measure(session: Session): TokenMeasurement;
        estimateMessage(message: unknown): number;
    };
    compile(prepared: PreparedRegion, agent: Agent | undefined, signal: AbortSignal | undefined): Promise<{
        entries: readonly (string | { seq: number; text: string })[];
        provider: string;
        model: string;
        [key: string]: unknown;
    }>;
}

/** Priced, validated selection snapshot handed to the compile hook. */
export interface PreparedRegion {
    start: number;
    end: number;
    startIdx: number;
    endIdx: number;
    shadowedSeqs: readonly number[];
    session: Session;
    measurement: TokenMeasurement;
    selectedNodes: readonly { seq: number; tokens: number }[];
    shadowedTokenCount: number;
    /** Which retention rule kept the tail (see {@link RetainedTail}). */
    tail?: RetainedTail;
}

/**
 * Provenance of the verbatim tail the selection retained: the rule that
 * decided it, how much survived, and whether the tool-pair guard had to
 * recede. The DSH counterpart of upstream pi-vcc's `budgetCut`.
 */
export interface RetainedTail {
    /** `retain-turns` | `whole-turns` | `node-suffix`. */
    policy: 'retain-turns' | 'whole-turns' | 'node-suffix';
    /** Number of surface nodes left uncompiled in the retained region. */
    keptNodes: number;
    /** Priced tokens of those nodes. */
    keptTokens: number;
    /** The configured ceiling (0 when the preferred-turn rule applies). */
    ceiling: number;
    /** Whether the tool-pairing guard moved the keep boundary. */
    receded: boolean;
}

export interface CompactionOptions {
    owner: 'current-turn' | null;
    stability: 'whole-surface' | 'selected-span';
    sourceCommandId?: string;
    /** Retained-tail provenance carried into the checkpoint footer. */
    tail?: RetainedTail;
    flush?: () => Promise<void>;
}

/** Resolve the next head-anchored, tool-pairing-balanced range. */
export declare function selectCompactableRange(session: Session, measurement: TokenMeasurement, retainTurns: number, retainTokens: number): { start: number; end: number; tail: RetainedTail } | null;
/** Human-readable account of the retained tail, for the checkpoint footer. */
export declare function describeTail(tail: RetainedTail | undefined | null): string;
/** Run the single durable compaction transaction over one positional span. */
export declare function compactSurfaceRegion(dependencies: RegionDependencies, session: Session, start: number, end: number, agent: Agent | undefined, options: CompactionOptions, signal: AbortSignal | undefined): Promise<CompactionResult>;
/** Wrap text in an adaptive Markdown code fence (longer than any inner ``` run). */
export declare function fenceCode(text: string): string;
/** Recheck the durable compaction lock after an asynchronous policy decision. */
export declare function assertNoActiveCompaction(session: Session, stage: string): void;
/** Validate one requested surface-position span before any work begins. */
export declare function validateSurfaceRegion(session: Session, start: number, end: number): {
    start: number;
    end: number;
    startIdx: number;
    endIdx: number;
    shadowedSeqs: number[];
};
/** Snapshot pricing for a validated surface range. */
export declare function prepareCompaction(dependencies: RegionDependencies, session: Session, selection: unknown): PreparedRegion;
/** Require the whole surface to be unchanged since preparation. */
export declare function assertWholeSurfaceUnchanged(dependencies: RegionDependencies, session: Session, prepared: PreparedRegion): void;
/** Require only the selected span to remain a stable replacement target. */
export declare function assertSelectedSpanStable(dependencies: RegionDependencies, session: Session, prepared: PreparedRegion): void;
/** Inspect open-turn, unmatched-compaction, and latest seed-boundary state. */
export declare function inspectCompactionEntryState(events: readonly unknown[]): {
    openTurn: number | null;
    unmatchedCompactionStart?: { seq: number };
    latestEndSeedSeq?: number;
};
