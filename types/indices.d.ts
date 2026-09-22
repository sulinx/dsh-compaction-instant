/**
 * The shared reference space: seq lookup, checkpoint ordinals, and the one
 * parser for every pointer the engine prints (port of upstream pi-vcc
 * `core/global-indices.ts`).
 * @module dsh-compaction-instant/indices
 */

/** Session-shaped value the reference space reads from. */
export interface IndexedSession {
    events?: readonly unknown[];
    snapshotEvents?(): readonly unknown[];
}

/** One durable log event as the reference space sees it. */
export interface LoggedEvent {
    seq: number;
    type: string;
    data?: { source?: unknown; [key: string]: unknown };
}

/** Result of {@link createEventIndex}. */
export interface EventIndex {
    /** The ordered event list as the host supplied it. */
    events: readonly unknown[];
    /** Whether `events[i].seq === i` held for the whole list. */
    dense: boolean;
    /** The event carrying this seq, or undefined. */
    at(seq: number): LoggedEvent | undefined;
}

/** The durable event list of one session, across host generations. */
export declare function sessionEvents(session: IndexedSession | undefined): readonly any[];
/** A seq index that also resolves non-dense host arrays. */
export declare function createEventIndex(session: IndexedSession): EventIndex;
/** Resolve one seq to its event without materializing an index. */
export declare function eventAtSeq(session: IndexedSession, seq: number): LoggedEvent | undefined;
/** Whether a message source identifies a landed compaction checkpoint node. */
export declare function isCheckpointSource(source: unknown): boolean;
/** Whether the event is a persisted message entry. */
export declare function isCountedMessageEntry(event: unknown): boolean;
/** This session's checkpoints: seqs oldest first, plus the seq→ordinal map. */
export declare function scanCheckpoints(session: IndexedSession): { seqs: number[]; ordinals: Map<number, number> };
/** Checkpoint seqs in log order (1 = oldest). */
export declare function checkpointSeqs(session: IndexedSession): number[];
/** seq → 1-based checkpoint ordinal, session-wide. */
export declare function checkpointOrdinals(session: IndexedSession): Map<number, number>;
/** Split one printed or typed reference into its optional kind word and body. */
export declare function parseRefToken(raw: unknown): { body: string; kind: 'seq' | 'result' | 'checkpoint' | undefined; hashed: boolean };
/** Split one inclusive seq span into chunks no wider than `maxSpan`. */
export declare function splitSeqSpan(start: number, end: number, maxSpan: number): { start: number; end: number }[];
