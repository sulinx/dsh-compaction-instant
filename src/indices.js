/**
 * One definition of the session's reference space.
 *
 * Ported from upstream pi-vcc `core/global-indices.ts` (k0valik/pi-blackhole
 * `f82e07a`, issue #28). Upstream's problem: recall numbered every persisted
 * message entry session-globally while `normalize` numbered the selected
 * compaction window from zero, so a summary's `#12` and recall's `#12` were
 * different rows. The fix was to make one module own the counting rule so both
 * sides agree *by construction*, rather than by two implementations happening
 * to match.
 *
 * DSH's durable log already carries a session-global `seq` on every event, so
 * the shared index space is the seq itself — the port is not the numbering,
 * it is the *single definition*. Three rules have to agree between the side
 * that PRINTS a reference and the side that RESOLVES it:
 *
 *   1. how a seq resolves to an event (`at`),
 *   2. how checkpoints are counted (the `[checkpoint N]` marker),
 *   3. how a printed reference string is parsed back (`parseRefToken`).
 *
 * Before this module (2) lived twice — once in the compiler path
 * (`index.js:compile`) and once in recall (`findCheckpointSeqs`) — and (3) was
 * re-implemented per reference type, which is exactly the drift upstream fixed.
 *
 * @module dsh-compaction-instant/indices
 */

/**
 * The durable event list of one session, across host generations.
 * `session.events` was removed in dsh 0.1.3; `snapshotEvents()` is the
 * supported replacement and is preferred whenever it exists.
 * @param session - session-shaped value.
 * @returns the ordered event list (empty when neither accessor exists).
 */
export function sessionEvents(session) {
  if (Array.isArray(session?.events)) return session.events;
  return typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];
}

/**
 * Dense array fast path with a map fallback.
 *
 * Every consumer indexes the log by seq (`events[seq]`) and then verifies
 * `event.seq === seq`, which is correct only while the host hands back a dense
 * array. The host does today (checked against 67 real `session.v3` logs: index
 * equals seq in all of them), but the array is host-owned and a retracted or
 * imported session could hand back a sparse one, where `events[seq]` silently
 * misses and every pointer resolves as "not found".
 *
 * `at` keeps the array path for the common case and falls back to a seq→event
 * map when the array is not dense, so a pointer printed by the compiler still
 * resolves.
 *
 * @param session - session-shaped value.
 * @returns `{ events, dense, at(seq) }` — `at` returns undefined for a
 *   missing seq.
 */
export function createEventIndex(session) {
  const events = sessionEvents(session);
  let dense = true;
  for (let index = 0; index < events.length; index += 1) {
    const seq = events[index]?.seq;
    if (typeof seq !== "number" || seq !== index) {
      dense = false;
      break;
    }
  }
  if (dense) {
    return {
      events,
      dense,
      at: (seq) => {
        const event = events[seq];
        return event !== undefined && event.seq === seq ? event : undefined;
      }
    };
  }
  const bySeq = new Map();
  for (const event of events) {
    if (typeof event?.seq === "number" && !bySeq.has(event.seq)) bySeq.set(event.seq, event);
  }
  return { events, dense, at: (seq) => bySeq.get(seq) };
}

/**
 * Resolve one seq to its event without materializing an index.
 * @param session - session-shaped value.
 * @param seq - durable event seq.
 * @returns the event, or undefined when the seq is not in the log.
 */
export function eventAtSeq(session, seq) {
  const events = sessionEvents(session);
  const event = events[seq];
  if (event !== undefined && event.seq === seq) return event;
  return events.find((candidate) => candidate?.seq === seq);
}

/**
 * A message source that belongs to this compaction engine's own checkpoints.
 * A checkpoint is the condensed history itself, so misreading one as an
 * ordinary user turn both truncates it to the user-text budget and demotes it
 * in the cap-elision order. dsh 0.1.7 re-tagged the source
 * (`plugin:compact` → `compact-checkpoint`), so both spellings are recognized.
 * @param source - `message.source` from `Session.deriveEventMessage`.
 * @returns true when the node is a landed checkpoint.
 */
export function isCheckpointSource(source) {
  if (source === undefined || source === null || typeof source !== "object") return false;
  if (source.kind === "compact-checkpoint") return true;
  return source.kind === "plugin" && source.plugin === "compact";
}

/**
 * A persisted message entry — the class of log rows the reference space
 * counts. Mirrors upstream's `isCountedMessageEntry`.
 * @param event - one durable log event.
 * @returns true when the event is a persisted message.
 */
export function isCountedMessageEntry(event) {
  return event?.type === "user/message" || event?.type === "assistant/message" || event?.type === "system/message";
}

/**
 * Count this session's landed checkpoints in one pass.
 *
 * Each compaction replaces its span with exactly one checkpoint node, so the
 * ordinal (`1` = oldest, the `[checkpoint N]` marker) counts compactions in
 * log order. The count is **session-wide, not region-local**: a checkpoint
 * restored later must keep the ordinal it was minted with, and the compiler
 * that elides an old checkpoint under cap pressure must print the same number
 * recall will resolve.
 *
 * @param session - session-shaped value.
 * @returns `{ seqs, ordinals }` — checkpoint seqs oldest first and the
 *   seq→ordinal map (both derived from the same pass, so they cannot drift).
 */
export function scanCheckpoints(session) {
  const seqs = [];
  const ordinals = new Map();
  for (const event of sessionEvents(session)) {
    if (event.type !== "user/message") continue;
    if (!isCheckpointSource(event.data?.source)) continue;
    seqs.push(event.seq);
    ordinals.set(event.seq, seqs.length);
  }
  return { seqs, ordinals };
}

/** Checkpoint seqs in log order (`1` = oldest). */
export function checkpointSeqs(session) {
  return scanCheckpoints(session).seqs;
}

/** seq → 1-based checkpoint ordinal, session-wide. */
export function checkpointOrdinals(session) {
  return scanCheckpoints(session).ordinals;
}

/**
 * Split one reference string into its optional kind word and its body.
 *
 * Accepts every form this engine prints or documents, so a marker copied out
 * of a checkpoint, a search hit, or the touched-files list always parses:
 *
 *   `12` `3-7` `seq 12` `seqs 3-7` `(seq 12)` `#12` `#3-7`
 *   `result 12` `checkpoint 3`
 *
 * @param raw - reference text as printed or as typed by the model.
 * @returns `{ body, kind, hashed }` — `kind` is `"seq"`, `"result"`,
 *   `"checkpoint"`, or undefined when the reference carried no kind word.
 */
export function parseRefToken(raw) {
  let token = String(raw ?? "").trim();
  let hashed = false;
  if (token.length === 0) return { body: "", kind: undefined, hashed };
  const parenthesized = /^\((.*)\)$/u.exec(token);
  if (parenthesized !== null) token = parenthesized[1].trim();
  if (token.startsWith("#")) {
    hashed = true;
    token = token.slice(1).trim();
  }
  const prefixed = /^(seqs?|result|checkpoint)\s+(.*)$/iu.exec(token);
  if (prefixed === null) return { body: token, kind: undefined, hashed };
  const word = prefixed[1].toLowerCase();
  return {
    body: prefixed[2].trim(),
    kind: word === "seqs" ? "seq" : word,
    hashed
  };
}

/**
 * Split one inclusive seq span into chunks no wider than `maxSpan`.
 *
 * Recall bounds its work by *output tokens*, not by the requested span, so a
 * range that is wider than the expansion cap must still resolve: the case that
 * matters is a `[N entries elided: seqs A-B]` marker whose span is wider than
 * the cap, which the agent can only fix by re-reading the log by hand. Splitting
 * keeps the memory bound while making every printed marker pasteable.
 *
 * @param start - inclusive first seq.
 * @param end - inclusive last seq.
 * @param maxSpan - maximum seqs per chunk (>= 1).
 * @returns ordered chunks, each `{ start, end }` inclusive.
 */
export function splitSeqSpan(start, end, maxSpan) {
  const width = Math.max(1, Math.floor(maxSpan));
  const chunks = [];
  for (let from = start; from <= end; from += width) chunks.push({
    start: from,
    end: Math.min(end, from + width - 1)
  });
  return chunks;
}
