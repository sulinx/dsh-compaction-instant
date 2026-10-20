/**
 * `[tracked commands]` ledger types (port of upstream pi-vcc v0.10.2
 * `src/extract/tracked-commands.ts`).
 * @module dsh-compaction-instant/tracked
 */

/** Characters kept per recorded entry before truncation. */
export declare const MAX_ENTRY_CHARS: number;
/** Separator between entries of one command inside its line. */
export declare const COMMAND_SEPARATOR: string;
/** How many invocations of one command the ledger keeps (newest last). */
export declare const COMMANDS_PER_NAME: number;
/** Tool names whose `command` argument is scanned. */
export declare const COMMAND_TOOL_NAMES: readonly string[];

/** One tool call as the ledger sees it. */
export interface TrackedCall {
    name: string;
    command: string;
}

/** Indices of UNQUOTED shell separators (`;`, `&`, `|`, newline). */
export declare function unquotedSeparators(cmd: string): number[];
/** Segment start indices where an invocation of `name` begins. */
export declare function findTopLevelInvocations(cmd: string, name: string): number[];
/** The remote command of an `ssh …` invocation, when one is present. */
export declare function sshRemoteCommand(afterSsh: string): string | undefined;
/** Command name → entries (oldest first, re-runs moved to the tail). */
export declare function extractTrackedCommands(
    calls: readonly TrackedCall[],
    trackCommands: readonly string[]
): Map<string, Set<string>>;
/** Render the ledger as one `[tracked commands]` row body, or `""` when empty. */
export declare function formatTrackedCommands(byCommand: Map<string, Set<string>>): string;
/** Drop a rendered line's "(+N earlier)" overflow marker. */
export declare function stripOverflowMarker(text: string): string;
