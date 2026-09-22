/**
 * Relevance ranking and repeat collapsing for compiled checkpoint rows.
 *
 * Port of upstream pi-vcc `core/rank.ts` (`scoreBlock`, `dedupKey`,
 * `selectRankedBriefBlocks`) onto this engine's compiled-entry model. Upstream
 * ranks `NormalizedBlock[]` and takes the best blocks under a size budget; here
 * the compiler already renders every row (nothing is dropped silently), so the
 * ranking decides *which* row leaves first when the checkpoint cap forces
 * elision, and which repeated rows collapse into one marker.
 *
 * The value model is upstream's, mapped to the DSH tool catalog:
 *
 *   - recency                       (the newest rows are what continuity needs);
 *   - kind                           user text > assistant text > tool > media/note;
 *   - tool shape                     edits 34 > test commands 26 > workflow commands
 *                                   14 > other 12 > reads 6 > scaffolding −16;
 *   - repetition                    an identical row seen again is worth less.
 *
 * Measured on this machine (10 real sessions, 228,671 checkpoint rows): 56% of
 * tool rows used to render name-only because the shell tool (`pwsh`, 36% of all
 * tool rows) was not in the argument whitelist; the ranking is what keeps the
 * rows that *do* carry a durable fact when the cap bites.
 *
 * @module dsh-compaction-instant/rank
 */

/** Scoring weights; upstream's numbers, with the DSH vocabulary substituted. */
export const DEFAULT_RANK_WEIGHTS = Object.freeze({
  /** Points contributed by position alone (newest row gets the full amount). */
  recencyMax: 12,
  /** Base score by compiled kind. */
  userText: 18,
  assistantText: 10,
  checkpointRow: 6,
  mediaRow: 2,
  noteRow: 0,
  /** Tool-call classes (upstream `EDIT_TOOL_RE` / `TEST_COMMAND_RE` / …). */
  editTool: 34,
  testCommand: 26,
  workflowCommand: 14,
  otherTool: 12,
  readTool: 6,
  /** Scaffolding-only shell commands (`cd`, `ls`, `echo`, `sleep`, …). */
  trivialCommand: -16,
  /** Charged once per additional identical row in the same region. */
  repeatPenalty: -12,
  /** A very long rendered row is less likely to be a durable fact. */
  longRowPenalty: -8,
  longRowChars: 1000
});

/** DSH tools whose payload is a file change. */
const EDIT_TOOL_RE = /^(?:write|edit|multiedit|apply_patch|notebook_edit|str_replace_editor)$/iu;
/** DSH tools whose payload is a lookup rather than a change. */
const READ_TOOL_RE = /^(?:read|glob|grep|ls|find|touched_files|sftp_list|browser_read|sftp_read)$/iu;

/** A command that runs the test/lint/build loop — durable evidence of state. */
const TEST_COMMAND_RE = /\b(?:bun|npm|pnpm|yarn|node|npx|deno|pytest|py|python|python3|uv|cargo|go|mvn|gradle|dotnet|vitest|jest|tsc)\b[^\n]*(?:test|spec|check|lint|build|tsc|typecheck|noEmit)/iu;
/** A command that changes repository or review state. */
const WORKFLOW_COMMAND_RE = /(?:^|\s)(?:gh\s+(?:pr|issue|run|release)\b|git\s+(?:commit|push|merge|rebase|revert|cherry-pick|tag|reset|checkout|switch|branch|worktree)\b|git-cli\b)/iu;
/**
 * Scaffolding-only commands: they change the shell, not the world. Covers both
 * the POSIX and the PowerShell spellings, because this host's shell tool is
 * `pwsh` (measured: 25,826 of 70,424 tool rows across ten sessions).
 */
const TRIVIAL_COMMAND_RE = /^(?:set\s+[-+]|cd(?:\s+\S+)?$|export\s+\w+=|(?:source|\.)\s+\S+|pwd$|true$|:$|#|ls(?:\s|$)|echo\b|clear$|sleep\b|Set-Location\b|Get-ChildItem\b|Write-Host\b|Start-Sleep\b|Set-Variable\b|Get-Location\b|\$ErrorActionPreference)/iu;

/** Classify one shell-ish command text. Pure; used by the ranking and tests. */
export function classifyCommand(command) {
  if (typeof command !== "string" || command.length === 0) return "other";
  if (TEST_COMMAND_RE.test(command)) return "test";
  if (WORKFLOW_COMMAND_RE.test(command)) return "workflow";
  if (TRIVIAL_COMMAND_RE.test(command)) return "trivial";
  return "other";
}

/** The trailing newline-and-whitespace-insensitive identity of a command. */
function normalizeCommand(command) {
  return command.replace(/\s+/gu, " ").trim();
}

/**
 * The dedup/repeat identity of one rendered row — upstream's `dedupKey`.
 *
 * Two rows with the same key carry the same durable fact, so repeats are worth
 * less and can be collapsed. Untagged rows (conversation text) have no key.
 * @param row - `{ kind, toolName, argText }`.
 * @returns the key, or undefined when the row is not repeatable.
 */
export function rankKeyOf(row) {
  if (row?.kind !== "tool" || typeof row.toolName !== "string") return undefined;
  const name = row.toolName.toLowerCase();
  const argument = typeof row.argText === "string" ? normalizeCommand(row.argText) : "";
  return argument.length === 0 ? `tool:${name}` : `tool:${name}:${argument}`;
}

/**
 * Score one compiled row.
 *
 * `index`/`total` are the row's position among the region's compiled rows, so
 * recency is relative to the region rather than to the session.
 *
 * @param input - `{ kind, text, toolName?, argText?, index, total, repeats }`.
 * @param weights - weight overrides.
 * @returns `{ score, reasons }` — reasons are short stable tags for tests/logs.
 */
export function rankScore(input, weights = DEFAULT_RANK_WEIGHTS) {
  const reasons = [];
  let score = 0;
  const total = Math.max(1, input.total ?? 1);
  const index = Math.max(0, input.index ?? 0);
  const recency = total <= 1 ? 0 : Math.round((index / (total - 1)) * weights.recencyMax);
  if (recency !== 0) {
    score += recency;
    reasons.push("recency");
  }
  switch (input.kind) {
    case "text": score += input.role === "user" ? weights.userText : weights.assistantText; reasons.push(`text:${input.role ?? "assistant"}`); break;
    case "reasoning": score += weights.assistantText; reasons.push("reasoning"); break;
    case "checkpoint": score += weights.checkpointRow; reasons.push("checkpoint"); break;
    case "media": score += weights.mediaRow; reasons.push("media"); break;
    case "note": score += weights.noteRow; reasons.push("note"); break;
    case "tool": {
      const command = typeof input.argText === "string" ? input.argText : "";
      const name = typeof input.toolName === "string" ? input.toolName : "";
      if (EDIT_TOOL_RE.test(name)) { score += weights.editTool; reasons.push("edit-tool"); }
      else if (command.length > 0 && TEST_COMMAND_RE.test(command)) { score += weights.testCommand; reasons.push("test-command"); }
      else if (READ_TOOL_RE.test(name)) { score += weights.readTool; reasons.push("read-tool"); }
      else { score += weights.otherTool; reasons.push("tool-call"); }
      if (command.length > 0 && WORKFLOW_COMMAND_RE.test(command)) { score += weights.workflowCommand; reasons.push("workflow-command"); }
      if (command.length > 0 && TRIVIAL_COMMAND_RE.test(command)) { score += weights.trivialCommand; reasons.push("trivial-command"); }
      break;
    }
    default: break;
  }
  if (typeof input.text === "string" && input.text.length > weights.longRowChars) {
    score += weights.longRowPenalty;
    reasons.push("long-row");
  }
  const repeats = input.repeats ?? 1;
  if (repeats > 1) {
    score += weights.repeatPenalty * (repeats - 1);
    reasons.push(`repeat:${repeats}`);
  }
  return { score, reasons };
}

/**
 * Index of the entry the cap should drop next.
 *
 * Phase A of `compileRegion` used to drop the **oldest** low-value row. Ranking
 * keeps its promise — conversation text still outlives logs — but within the
 * low-value set the least valuable row goes first: a repeated poll or a
 * scaffolding command now leaves before an older file edit. The newest entry is
 * never a candidate (it is the row the next turn continues from).
 *
 * @param entries - compiled entries carrying `{ score }`.
 * @param isLowValue - predicate selecting the droppable kinds.
 * @returns the index to drop, or -1 when nothing may be dropped.
 */
export function lowestValueIndex(entries, isLowValue) {
  let best = -1;
  let bestScore = Infinity;
  for (let index = 0; index < entries.length - 1; index += 1) {
    if (!isLowValue(entries[index])) continue;
    const score = typeof entries[index].score === "number" ? entries[index].score : 0;
    if (score < bestScore) {
      bestScore = score;
      best = index;
    }
  }
  return best;
}

/** Minimum run length that justifies replacing rows with one marker. */
export const MIN_REPEAT_RUN = 3;

/**
 * Collapse runs of the same repeated tool row into one marker.
 *
 * Upstream's selection simply skips duplicate keys; here every row already
 * exists, so the compiler keeps the **first and last** occurrence (the latter
 * for recency continuity) and replaces the middle with a single `note` marker
 * naming the seq range — which `recall` can restore in full, exactly like every
 * other elision marker.
 *
 * @param entries - compiled entries with `{ seq, text, kind, rankKey }`.
 * @returns `{ entries, collapsed, collapsedRows }`.
 */
export function collapseRepeatedRows(entries) {
  const positions = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const key = entries[index]?.rankKey;
    if (typeof key !== "string" || key.length === 0) continue;
    const list = positions.get(key);
    if (list === undefined) positions.set(key, [index]);
    else list.push(index);
  }
  const drop = new Set();
  const markers = [];
  let collapsedRows = 0;
  for (const [key, list] of positions) {
    if (list.length < MIN_REPEAT_RUN) continue;
    const middle = list.slice(1, -1);
    if (middle.length === 0) continue;
    for (const index of middle) drop.add(index);
    collapsedRows += middle.length;
    const seqs = middle.map((index) => entries[index].seq);
    const first = seqs[0];
    const last = seqs[seqs.length - 1];
    const label = key.split(":").slice(1, 2).join("") || "tool";
    markers.push({
      after: list[0],
      entry: {
        seq: first,
        text: `[${middle.length} repeated ${label} row(s) elided: ${first === last ? `seq ${first}` : `seqs ${first}-${last}`}]`,
        kind: "note",
        score: DEFAULT_RANK_WEIGHTS.noteRow,
        reasons: ["repeat-collapse"],
        rankKey: undefined
      }
    });
  }
  if (drop.size === 0) return { entries, collapsed: false, collapsedRows: 0 };
  const out = [];
  const markerByAfter = new Map(markers.map((m) => [m.after, m.entry]));
  for (let index = 0; index < entries.length; index += 1) {
    if (drop.has(index)) continue;
    out.push(entries[index]);
    const marker = markerByAfter.get(index);
    if (marker !== undefined) out.push(marker);
  }
  return { entries: out, collapsed: true, collapsedRows };
}
