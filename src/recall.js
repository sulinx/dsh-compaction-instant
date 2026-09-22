/**
 * Same-session recall core for `dsh-compaction-instant`.
 *
 * The lossless counterpart of the VCC-style compiler: compaction checkpoints
 * mark every elision with a `(seq N)` / `(seqs A-B)` pointer into the durable
 * session log; this module expands those pointers back into the exact
 * original content. Because the log is append-only, every token the compiler
 * ever truncated or elided is still present and recoverable — recall closes
 * the loop that makes the compaction engine near-lossless.
 *
 * Shared by the model-facing `recall` tool (`./tool`). Reads any session-shaped
 * value with `events` and `deriveEventMessage`, so it is unit-testable without
 * a running harness.
 *
 * @module dsh-compaction-instant/recall
 */
import { estimateEntryTokens, projectToolResultText, sanitize, truncateTokens } from "./compiler.js";
import { createEventIndex, eventAtSeq, isCheckpointSource, parseRefToken, scanCheckpoints, sessionEvents, splitSeqSpan } from "./indices.js";

/** Default total budget for one recall operation, in density-aware tokens. */
export const DEFAULT_MAX_RECALL_TOKENS = 16000;
/**
 * Widest single range expanded at once. A wider requested range is not
 * rejected: it is expanded in chunks of this width (see `expandSelections`),
 * because the marker the compiler prints — `[N entries elided: seqs A-B]` —
 * must always be pasteable back. Output stays bounded by the recall token
 * budget, not by the requested span.
 */
export const MAX_RECALL_SPAN = 1000;
/**
 * Ceiling on the TOTAL number of seqs one reference may expand to. Ranges are
 * no longer rejected for being wider than {@link MAX_RECALL_SPAN} (a printed
 * `seqs A-B` marker must paste back), so the work bound lives here instead —
 * far above any span a real compaction marker produces.
 */
export const MAX_RECALL_SEQS = 100000;

/**
 * Parse one seq selection string into ordered inclusive ranges.
 *
 * Accepted forms per comma-separated part: `12`, `3-7`, `seq 12`,
 * `seqs 3-7`, with optional surrounding parentheses — so a model or human
 * can paste a checkpoint marker verbatim.
 * @param input - raw selection text.
 * @returns `{ selections, errors }`; errors are stable human-readable strings.
 */
export function parseSeqSpec(input) {
  const selections = [];
  const errors = [];
  const raw = String(input ?? "").trim();
  if (raw.length === 0) return { selections, errors: ["missing seq selection"] };
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    // Every printed pointer parses here: `(seq 12)`, `seqs 3-7`, `#12`, `12`.
    const { body, kind } = parseRefToken(trimmed);
    if (kind !== undefined && kind !== "seq") {
      errors.push(`invalid seq selection "${trimmed}"`);
      continue;
    }
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/u.exec(body);
    if (match === null) {
      errors.push(`invalid seq selection "${trimmed}"`);
      continue;
    }
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (end < start) {
      errors.push(`invalid seq range "${trimmed}" (end before start)`);
      continue;
    }
    selections.push({ start, end });
  }
  const total = selections.reduce((sum, selection) => sum + (selection.end - selection.start + 1), 0);
  if (total > MAX_RECALL_SEQS) errors.push(`selection expands to ${total} seqs, more than the ${MAX_RECALL_SEQS}-seq limit`);
  return { selections, errors };
}

/**
 * Project one derived message into plain text, keeping everything: text,
 * reasoning, raw tool-call arguments, and nested tool-result content.
 * Recall is the lossless layer, so nothing is elided here except media,
 * which renders as labels (their bytes live in the attachment service).
 * @param message - derived message (`Session.deriveEventMessage` output).
 * @param options - `{ skipToolCalls }`: tool names whose call arguments are left
 *   out of the projection. Recall never skips anything; the search index uses
 *   it to exclude this plugin's own read-back surface, whose invocation
 *   arguments would otherwise make a repeated query match itself.
 * @returns full plain-text projection.
 */
export function projectMessageText(message, options = {}) {
  const skipToolCalls = options.skipToolCalls;
  const parts = [];
  for (const block of message.content) {
    switch (block.type) {
      case "text":
        if (block.text !== undefined && block.text.length > 0) parts.push(sanitize(block.text));
        break;
      case "reasoning":
        if (block.text !== undefined && block.text.length > 0) parts.push(`[reasoning]\n${sanitize(block.text)}`);
        break;
      case "tool-call": {
        const toolName = block.name ?? "unknown";
        if (skipToolCalls !== undefined && skipToolCalls.includes(toolName)) break;
        parts.push(`[tool-call ${toolName}]\n${sanitize(block.arguments ?? "")}`);
        break;
      }
      case "tool-result":
        parts.push(`[tool-result]\n${projectToolResultText(block.content ?? [])}`);
        break;
      case "image":
        parts.push("[image]");
        break;
      case "document":
        parts.push("[document]");
        break;
      default:
        parts.push(`[${String(block.type)}]`);
    }
  }
  return parts.join("\n");
}

/**
 * Expand ordered selections into a deduplicated ordered seq list.
 *
 * Ranges wider than {@link MAX_RECALL_SPAN} are expanded in chunks, so the
 * memory bound holds without rejecting a wide printed marker.
 * @param selections - parsed inclusive ranges.
 * @param maxSpan - chunk width (defaults to {@link MAX_RECALL_SPAN}).
 * @returns unique seqs in first-appearance order.
 */
export function expandSelections(selections, maxSpan = MAX_RECALL_SPAN) {
  const seqs = [];
  const seen = new Set();
  for (const { start, end } of selections) {
    for (const chunk of splitSeqSpan(start, end, maxSpan)) {
      for (let seq = chunk.start; seq <= chunk.end; seq += 1) {
        if (seen.has(seq)) continue;
        seen.add(seq);
        seqs.push(seq);
      }
    }
  }
  return seqs;
}

/**
 * Collect the durable seqs of every landed compaction checkpoint node in one
 * session, oldest first. Each compaction replaces its span with exactly one
 * checkpoint node, so the ordinal (`1` = oldest) counts compactions.
 * @param session - session-shaped value with `events`.
 * @returns checkpoint node seqs in chronological order.
 */
export function findCheckpointSeqs(session) {
  return scanCheckpoints(session).seqs;
}

/**
 * Resolve one typed recall reference into inclusive seq ranges.
 *
 *   - `type: "seq"` — `id` is a seq selection: numbers/ranges with the
 *     checkpoint marker forms (`12`, `3-7,15`, `seq 12`, `seqs 3-7`).
 *   - `type: "result"` — `id` names a tool result: the `result N` pointer
 *     from a tool-call one-liner (`result 3`, `seq 3`, or bare `3`); the
 *     resolved seq must be a `tool/result` event.
 *   - `type: "checkpoint"` — `id` is a checkpoint ordinal (`1` = oldest,
 *     as in the `[checkpoint N]` elision marker) or a `seq N` pointer to a
 *     checkpoint node.
 *
 * @param session - session-shaped value with `events` and `deriveEventMessage`.
 * @param type - reference type: `seq`, `result`, or `checkpoint`.
 * @param id - type-dependent reference text.
 * @returns `{ selections, errors }`; errors are stable human-readable strings.
 */
export function resolveRecallReference(session, type, id) {
  const raw = String(id ?? "").trim();
  if (type === "seq") return parseSeqSpec(raw);
  if (type !== "result" && type !== "checkpoint") return { selections: [], errors: [`invalid recall type "${String(type)}" (expected "seq", "result", or "checkpoint")`] };
  // One parser for every printed form, so `(seq 3 -> result 4)`'s tail, `#4`
  // and a bare `4` all resolve the same way.
  const { body, kind } = parseRefToken(raw);
  const digits = /^(\d+)$/u.exec(body);
  if (type === "result") {
    if (kind !== undefined && kind !== "result" && kind !== "seq" || digits === null) return { selections: [], errors: [`invalid result reference "${id}" (expected a seq like "3" or "result 3")`] };
    const seq = Number(digits[1]);
    const event = eventAtSeq(session, seq);
    if (event === undefined) return { selections: [], errors: [`result seq ${seq} not found in this session`] };
    if (event.type !== "tool/result") return { selections: [], errors: [`seq ${seq} is not a tool result (it is ${event.type})`] };
    return { selections: [{ start: seq, end: seq }], errors: [] };
  }
  // Checkpoint references are either an ordinal into the session-wide
  // checkpoint list (`[checkpoint N]`, the marker the compiler prints) or an
  // explicit `seq N` pointer at one checkpoint node.
  if (kind === "seq") {
    if (digits === null) return { selections: [], errors: [`invalid checkpoint reference "${id}" (expected an ordinal like "1" or "checkpoint 1", or a "seq N" pointer)`] };
    const seq = Number(digits[1]);
    const event = eventAtSeq(session, seq);
    if (event === undefined) return { selections: [], errors: [`checkpoint seq ${seq} not found in this session`] };
    if (!isCheckpointSource(event.data?.source)) return { selections: [], errors: [`seq ${seq} is not a checkpoint node`] };
    return { selections: [{ start: seq, end: seq }], errors: [] };
  }
  if (kind !== undefined && kind !== "checkpoint" || digits === null) return { selections: [], errors: [`invalid checkpoint reference "${id}" (expected an ordinal like "1" or "checkpoint 1", or a "seq N" pointer)`] };
  const index = Number(digits[1]);
  if (!Number.isSafeInteger(index) || index < 1) return { selections: [], errors: [`invalid checkpoint ordinal "${id}"`] };
  const checkpointSeqsInLog = findCheckpointSeqs(session);
  const seq = checkpointSeqsInLog[index - 1];
  if (seq === undefined) return { selections: [], errors: [`checkpoint ${index} not found (this session has ${checkpointSeqsInLog.length} checkpoint(s))`] };
  return { selections: [{ start: seq, end: seq }], errors: [] };
}

/**
 * Recall the full original content of the requested seqs from one session's
 * durable log. Message events project through `deriveEventMessage`; log-only
 * events render as a labeled data dump. The total output is bounded by
 * `config.maxRecallTokens`; a cut appends a provenance marker and remaining
 * requested seqs are accounted in `skipped`.
 * @param session - session-shaped value with `events` and `deriveEventMessage`.
 * @param selections - parsed inclusive ranges.
 * @param config - `{ maxRecallTokens }`.
 * @returns `{ text, entries, seqs, recalled, missing, skipped, truncated, tokens }`.
 */
export function recallSession(session, selections, config) {
  const maxRecallTokens = config.maxRecallTokens;
  // One materialization for the whole call: a per-seq `sessionEvents(session)`
  // inside the loop below is cheap only while the host caches its snapshot, and
  // a wide selection over a large log must not depend on that. The index also
  // resolves seqs in a non-dense host array, where `events[seq]` would miss.
  const index = createEventIndex(session);
  const requested = expandSelections(selections);
  const entries = [];
  const seqs = [];
  let budget = maxRecallTokens;
  let truncated = false;
  let missing = 0;
  let skipped = 0;
  for (let position = 0; position < requested.length; position += 1) {
    const seq = requested[position];
    if (budget <= 0) {
      skipped = requested.length - position;
      truncated = true;
      break;
    }
    const event = index.at(seq);
    if (event === undefined) {
      missing += 1;
      entries.push({ seq, text: `[seq ${seq}: not found in this session]` });
      continue;
    }
    const message = typeof session.deriveEventMessage === "function" ? session.deriveEventMessage(event) : null;
    const body = message !== null
      ? `[seq ${seq}: ${message.role}]\n${projectMessageText(message)}`
      : `[seq ${seq}: ${event.type}]\n${JSON.stringify(event.data).slice(0, maxRecallTokens * 4)}`;
    const kept = truncateTokens(body, budget, "recall budget");
    budget -= estimateEntryTokens(kept.text);
    if (kept.truncated) truncated = true;
    entries.push({ seq, text: kept.text, truncated: kept.truncated });
    seqs.push(seq);
  }
  if (skipped > 0) {
    entries.push({ seq: requested[requested.length - skipped], text: `[recall budget exhausted: ${skipped} further requested seq(s) not included]` });
  }
  return {
    text: entries.map((entry) => entry.text).join("\n\n"),
    entries,
    seqs,
    recalled: seqs.length,
    missing,
    skipped,
    truncated,
    tokens: entries.reduce((total, entry) => total + estimateEntryTokens(entry.text), 0)
  };
}
