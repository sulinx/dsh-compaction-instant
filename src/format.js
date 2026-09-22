/**
 * Output formatting for the recall/search surface of `dsh-compaction-instant`.
 *
 * Ported from upstream `pi-vcc` v0.8.0 `src/core/format-recall.ts` (MIT): path
 * shortening, the aggregated "files touched" view with pagination, and the
 * hit/header rendering that both search modes share. Kept in its own module so
 * the search and touched views render identically and the plugin's public
 * `dsh-compaction-instant/format` entry stays importable on its own.
 *
 * Host divergence from upstream: Pi's `shortPath` closes over its own
 * `process.cwd()`. A DSH harness process serves many sessions with different
 * working directories, so the cwd is a parameter here and defaults to the
 * harness process cwd — a path outside it renders as `.../last/three/parts`.
 *
 * @module dsh-compaction-instant/format
 */

/** Page size of the aggregated "files touched" view. */
export const TOUCHED_PAGE_SIZE = 5;

/**
 * Shorten an absolute file path for display:
 *   - inside `cwd`, return `./relative/path`;
 *   - otherwise keep the last three path components, prefixed with `.../`;
 *   - short paths (≤3 components) are returned unchanged.
 * Both separators are accepted; the result always uses `/`.
 * @param fullPath - the path as recorded in the tool call.
 * @param cwd - directory to relativize against (defaults to the process cwd).
 * @returns the display path.
 */
export function shortPath(fullPath, cwd = process.cwd()) {
  const normalized = String(fullPath ?? "").replace(/\\/gu, "/");
  if (normalized.length === 0) return "";
  const cwdNormalized = String(cwd ?? "").replace(/\\/gu, "/").replace(/\/+$/u, "");
  if (cwdNormalized.length > 0 && normalized.startsWith(`${cwdNormalized}/`)) {
    return `.${normalized.slice(cwdNormalized.length)}`;
  }
  const parts = normalized.split("/");
  if (parts.length > 3) return `.../${parts.slice(-3).join("/")}`;
  return normalized;
}

/**
 * Render one search or recall hit.
 *
 * A hit carries either numbered matching lines (regex mode: every matching
 * line, capped by `MAX_LINES_PER_HIT`) or a numbered context window around the
 * first match (term mode, see `lineSnippet`). Both render the same way so a
 * reader does not have to care which mode produced the hit.
 * @param hit - `{ seq, kind, files?, lines?, snippet?, score?, matchCount?, termCount?, more?, note? }`.
 * @returns the rendered block (`[seq N: role]` header + indented lines).
 */
export function formatHitBlock(hit) {
  const modifiers = [];
  if (hit.files !== undefined && hit.files.length > 0) modifiers.push(`files:[${hit.files.join(", ")}]`);
  if (typeof hit.score === "number") {
    const terms = typeof hit.termCount === "number" ? `/${hit.termCount}` : "";
    modifiers.push(`score=${hit.score.toFixed(2)} terms=${hit.matchCount ?? 0}${terms}`);
  }
  const header = `[seq ${hit.seq}: ${hit.kind}]${modifiers.length > 0 ? ` ${modifiers.join(" ")}` : ""}`;
  const body = [];
  for (const line of hit.lines ?? []) body.push(`  ${line.line}: ${line.text}`);
  if (hit.more !== undefined && hit.more > 0) body.push(`  ...(${hit.more} more matching lines in this event)`);
  for (const note of hit.notes ?? []) body.push(`  ...(${note})`);
  return [header, ...body].join("\n");
}

/**
 * Render one search/recall result header, stating honestly what was withheld:
 * the shown count against the genuine match count, the relative-floor drop,
 * and the literal-match downgrade.
 * @param summary - `{ source, literal?, mode?, totalMatches, shown, floorDropped?, truncated? }`.
 * @returns the header line.
 */
export function formatSearchHeader(summary) {
  const { source, totalMatches, shown } = summary;
  const parts = [`[search ${JSON.stringify(source)}`];
  if (summary.literal === true) parts.push(" (literal match: nested quantifier)");
  if (summary.mode === "terms") parts.push(" (ranked multi-term search)");
  const count = shown < totalMatches
    ? `${shown} of ${totalMatches} matching event(s) shown`
    : `${totalMatches} matching event(s)`;
  parts.push(`: ${count}`);
  if (summary.floorDropped !== undefined && summary.floorDropped > 0) {
    parts.push(`; ${summary.floorDropped} low-relevance match(es) hidden`);
  }
  parts.push("]");
  return parts.join("");
}

/**
 * Format the aggregated "files touched" view.
 *
 * Ported from pi-blackhole (via upstream `pi-vcc` `format-recall.ts`), MIT.
 * @param touched - `{ path, entries: [{ seq, toolName }] }[]`.
 * @param page - 1-based page number (defaults to 1).
 * @param pageSize - rows per page (defaults to `TOUCHED_PAGE_SIZE`).
 * @param cwd - directory to relativize paths against.
 * @returns the rendered page, with a `page:N+1` hint when more rows remain.
 */
export function formatTouchedOutput(touched, page, pageSize, cwd) {
  if (touched.length === 0) return "No file operations found in session history.";
  const size = pageSize ?? TOUCHED_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(touched.length / size));
  const current = Math.min(Math.max(1, page ?? 1), totalPages);
  const start = (current - 1) * size;
  const rows = touched.slice(start, start + size);
  const header = totalPages > 1
    ? `Page ${current}/${totalPages} (${touched.length} total files)`
    : `${touched.length} files touched`;
  const lines = rows.map((file) => {
    const pointers = file.entries.map((entry) => `#${entry.seq} (${entry.toolName})`).join(", ");
    return `  ${shortPath(file.path, cwd)}    ${pointers}`;
  });
  let text = `${header}:\n\n${lines.join("\n")}`;
  if (current < totalPages) text += `\n\n--- Use page:${current + 1} for more results ---`;
  return text;
}
