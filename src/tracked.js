/**
 * `[tracked commands]` — a recency ledger of configured CLI invocations.
 *
 * Ported from upstream `pi-vcc` v0.10.2 `src/extract/tracked-commands.ts` (MIT),
 * reshaped for this engine: pi-vcc renders a whole `[Tracked Commands]` summary
 * section, while this compiler emits one synthetic `note` row, because the
 * checkpoint body is compiled entries rather than sections.
 *
 * Why it exists: in an ops session the commands ARE the record — a session that
 * never edits a file and never commits anything leaves nothing durable once its
 * tool one-liners are elided under cap pressure. Listing the invocations the
 * user asked to remember keeps them across compactions.
 *
 * Deliberately shallow: one line per invocation, cut at the next unquoted shell
 * separator, no per-CLI argument parsing. That is the whole point — a structured
 * extractor per command would need updating every time a CLI grows a flag.
 *
 * @module dsh-compaction-instant/tracked
 */

/** Characters kept per recorded entry (a one-liner, not a full command). */
const MAX_ENTRY_CHARS = 80;

/** Entry separator inside one command's line. `" | "` and not `","` because an
 * entry (`kubectl get pods,svc`) legitimately contains a comma. */
export const COMMAND_SEPARATOR = " | ";

/** How many invocations of one command the ledger keeps (newest last). */
export const COMMANDS_PER_NAME = 10;

/**
 * Single-pass quote-aware scan: the index of every UNQUOTED shell separator
 * (`;`, `&`, `|`, newline). Quote state tracks `'` and `"` plus backslash
 * escapes; separators inside quotes are not boundaries. Deliberately stops
 * there — `$( )` and backticks are not handled, keeping this a small tokenizer
 * rather than a shell parser.
 * @param {string} cmd - the command text.
 * @returns {number[]} separator indices, ascending.
 */
export function unquotedSeparators(cmd) {
  const seps = [];
  let quote = null;
  for (let i = 0; i < cmd.length; i += 1) {
    const c = cmd[i];
    if (quote) {
      // Backslash escapes inside "..." only; inside '...' it is literal.
      if (c === "\\" && quote === '"') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") i += 1; // `it\'s` is not an opening quote
    else if (c === "'" || c === '"') quote = c;
    // A comment runs to the newline; its apostrophes (`# don't`) are not quotes.
    else if (c === "#" && (i === 0 || /[\s;&|(]/u.test(cmd[i - 1]))) {
      while (i + 1 < cmd.length && cmd[i + 1] !== "\n") i += 1;
    }
    // `2>&1`, `<&3`, `&>file` are redirections, not separators.
    else if (c === "&" && (cmd[i - 1] === ">" || cmd[i - 1] === "<" || cmd[i + 1] === ">")) continue;
    else if (c === ";" || c === "&" || c === "|" || c === "\n") seps.push(i);
  }
  return seps;
}

/**
 * Cut `text` at the next UNQUOTED separator. Quotes are kept as written: the cut
 * never lands inside a quote, so they stay balanced. No truncation here — dedup
 * must see the full string, since two invocations sharing an 80-char prefix are
 * still two facts; the truncation lives in {@link renderEntry}.
 * @param {string} text - one segment of a command.
 * @returns {string} the entry text, trimmed.
 */
function captureEntry(text) {
  const seps = unquotedSeparators(text);
  const cut = seps.length > 0 ? text.slice(0, seps[0]) : text;
  return cut.trim();
}

/** Prefixes that hide the real command name: `VAR=val` assignments and a tiny,
 * decades-stable wrapper list — NOT a growing per-CLI taxonomy. They are skipped
 * only to FIND the name; the recorded entry keeps them, so `sudo -u root kubectl
 * get pods` is recorded whole. */
const WRAPPERS = new Set(["sudo", "env", "nohup", "time", "command"]);

/** Wrapper flags that consume the following token as their value. */
const WRAPPER_VALUE_FLAGS = {
  sudo: /^-[ugpCDRT]$/u, // -u user -g group -p prompt -C fd -D dir
  env: /^-[uS]$/u // -u name, -S split-string
};

/**
 * Next token from `pos` on the same line: a newline is a separator, so a lone
 * `VAR=x` line must not borrow the command on the next one.
 * @param {string} cmd - command text.
 * @param {number} pos - scan position.
 * @returns {[string, number]} the token and its start index.
 */
function tokenAt(cmd, pos) {
  let at = pos;
  while (at < cmd.length && (cmd[at] === " " || cmd[at] === "\t")) at += 1;
  const token = cmd.slice(at).match(/^\S+/u)?.[0] ?? "";
  return [token, at];
}

/**
 * Skip `VAR=val` prefixes and wrapper invocations from `pos`, returning where
 * the real command begins.
 * @param {string} cmd - command text.
 * @param {number} pos - scan position.
 * @returns {number} the index of the real command name.
 */
function skipToCommand(cmd, pos) {
  let at = pos;
  for (;;) {
    const [tok, index] = tokenAt(cmd, at);
    if (tok.length === 0) return index;
    if (/^[A-Za-z_]\w*=/u.test(tok)) {
      at = index + tok.length;
      continue;
    }
    if (!WRAPPERS.has(tok)) return index;
    at = index + tok.length;
    for (;;) {
      const [flag, flagAt] = tokenAt(cmd, at);
      if (!flag.startsWith("-")) break;
      at = flagAt + flag.length;
      if (WRAPPER_VALUE_FLAGS[tok]?.test(flag)) {
        const [value, valueAt] = tokenAt(cmd, at); // consume the flag's value
        at = valueAt + value.length;
      }
    }
  }
}

/**
 * Positions where an invocation of `name` begins: position 0 or right after an
 * UNQUOTED separator, so `echo "a; docker restart"` is not an invocation.
 * Requires whitespace (or end of string) right after `name`, so `ssh-keygen` /
 * `docker-compose` do not match `ssh` / `docker`. Returns the START of the
 * segment (before any `VAR=` / wrapper prefixes) so the recorded entry stays
 * faithful to what actually ran.
 * @param {string} cmd - command text.
 * @param {string} name - tracked command name (may be a prefix such as "gh pr").
 * @returns {number[]} segment start indices.
 */
export function findTopLevelInvocations(cmd, name) {
  const bounds = [0, ...unquotedSeparators(cmd).map((i) => i + 1)];
  const starts = [];
  for (const bound of bounds) {
    const pos = skipToCommand(cmd, bound);
    if (!cmd.startsWith(name, pos)) continue;
    const after = cmd[pos + name.length];
    if (after === undefined || /\s/u.test(after)) starts.push(bound);
  }
  return starts;
}

/** ssh flags that take NO argument; every other leading `-flag` consumes the
 * next token. Without this, `ssh -T host 'cmd'` misreads `host` as -T's value
 * and the remote command is never found. Clusters (`-tt`, `-NT`) count as
 * boolean when every letter is one. */
const SSH_BOOL_FLAG = /^-[46ACfGgKkMNTtVvXxYynaq]+$/u;

/**
 * Locate the SSH target by TOKEN POSITION (via `matchAll`'s own `.index`, never
 * a substring re-search, which would misfire on `ssh -i key-prod prod …` finding
 * "prod" inside "key-prod") and return everything after it, trimmed.
 * @param {string} afterSsh - the command text after the `ssh` token.
 * @returns {string | undefined} the remote command, or undefined.
 */
export function sshRemoteCommand(afterSsh) {
  const tokens = [...afterSsh.matchAll(/\S+/gu)];
  let i = 0;
  while (i < tokens.length && tokens[i][0].startsWith("-")) {
    i += SSH_BOOL_FLAG.test(tokens[i][0]) ? 1 : 2;
  }
  const target = tokens[i];
  if (target === undefined) return undefined;
  const rest = afterSsh.slice(target.index + target[0].length).trim();
  return rest.length === 0 ? undefined : rest;
}

/** Tool names whose `command` argument is scanned. The DSH shell surface, not
 * just `bash`: `pwsh` is this host's shell tool, and `ssh_exec` / `ssh_batch`
 * carry remote commands that are exactly the ones an ops session wants back. */
export const COMMAND_TOOL_NAMES = Object.freeze(["pwsh", "bash", "shell", "ssh_exec", "ssh_batch"]);

/**
 * Record one entry, keeping the SET as "most-recently-USED last": re-running an
 * invocation moves it to the tail instead of duplicating it.
 * @param {Map<string, Set<string>>} byCommand - the ledger.
 * @param {string} name - tracked command name.
 * @param {string} entry - captured entry (may be empty).
 * @returns {void}
 */
function record(byCommand, name, entry) {
  if (entry.length === 0) return;
  const set = byCommand.get(name);
  if (set === undefined) return;
  if (set.has(entry)) set.delete(entry);
  set.add(entry);
}

/**
 * Collect every invocation of the configured command names from one region's
 * tool calls.
 *
 * When `ssh` itself is tracked, its own remote-command argument is scanned for
 * the other tracked names: running a command over SSH is as common as running
 * it locally, and a top-level-only scan would miss it. Only the literal command
 * text is matched, never tool output.
 *
 * @param {Array<{ name: string, command: string }>} calls - extracted tool calls.
 * @param {readonly string[]} trackCommands - configured command names.
 * @returns {Map<string, Set<string>>} command name → entries, oldest first.
 */
export function extractTrackedCommands(calls, trackCommands) {
  const byCommand = new Map();
  for (const name of trackCommands) byCommand.set(name, new Set());
  if (trackCommands.length === 0) return byCommand;

  const trackSsh = trackCommands.includes("ssh");

  for (const call of calls) {
    if (!COMMAND_TOOL_NAMES.includes(call.name)) continue;
    const cmd = typeof call.command === "string" ? call.command : "";
    if (cmd.length === 0) continue;

    for (const name of trackCommands) {
      for (const startAt of findTopLevelInvocations(cmd, name)) {
        record(byCommand, name, captureEntry(cmd.slice(startAt).trim()));
      }
    }

    if (trackSsh) {
      for (const bound of findTopLevelInvocations(cmd, "ssh")) {
        // Bounds are segment starts (incl. wrappers); the ssh token itself sits
        // at skipToCommand — slice past it for the remote parser.
        const segment = cmd.slice(bound);
        const remote = sshRemoteCommand(segment.slice(skipToCommand(segment, 0) + "ssh".length));
        if (remote === undefined) continue;
        // The remote string's quotes were the LOCAL shell's syntax, not the
        // remote command's — a leftover stray quote would open a phantom quote
        // in the rescanner and swallow the rest of the line. Strip them all;
        // boundary detection stays shallow regardless.
        const unquoted = remote.replace(/['"]/gu, "");
        for (const name of trackCommands) {
          if (name === "ssh") continue;
          for (const startAt of findTopLevelInvocations(unquoted, name)) {
            record(byCommand, name, captureEntry(unquoted.slice(startAt).trim()));
          }
        }
      }
    }
  }
  return byCommand;
}

/**
 * Render one entry: one line (a quoted multi-line argument such as
 * `python3 -c '...'` would otherwise break the row format), with an inner
 * separator escaped as ` \| ` so a re-parse keeps the entry whole — then
 * truncated.
 * @param {string} entry - captured entry.
 * @returns {string} the display form.
 */
function renderEntry(entry) {
  const line = entry.replace(/\s+/gu, " ").replaceAll(COMMAND_SEPARATOR, " \\| ");
  return line.length > MAX_ENTRY_CHARS ? `${line.slice(0, MAX_ENTRY_CHARS)}…` : line;
}

/**
 * Format the ledger as one synthetic row body, or `""` when nothing matched.
 *
 * Keeps the NEWEST entries: a ledger of what was run recently must not freeze at
 * its first ten while everything later drowns in a permanent "(+N more)".
 *
 * @param {Map<string, Set<string>>} byCommand - extraction result.
 * @returns {string} `[tracked commands]\n- name: a | b` body, or "".
 */
export function formatTrackedCommands(byCommand) {
  const lines = [];
  for (const [name, entries] of byCommand) {
    if (entries.size === 0) continue;
    const items = [...entries].map(renderEntry);
    const over = items.length - COMMANDS_PER_NAME;
    const body = over > 0
      ? `(+${over} earlier) ${items.slice(-COMMANDS_PER_NAME).join(COMMAND_SEPARATOR)}`
      : items.join(COMMAND_SEPARATOR);
    lines.push(`- ${name}: ${body}`);
  }
  return lines.length === 0 ? "" : `[tracked commands]\n${lines.join("\n")}`;
}

/**
 * Drop the "(+N earlier)" overflow marker a rendered line carries, so a re-parse
 * of this engine's own output never records it as an entry.
 * @param {string} text - one command's rendered items.
 * @returns {string} the text without the leading marker.
 */
export function stripOverflowMarker(text) {
  return text.replace(/^\s*\(\+\d+ earlier\)\s*/u, "");
}
