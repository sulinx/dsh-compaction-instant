/**
 * Human-facing `/recall` command for `dsh-compaction-instant`.
 *
 * Grep-based, like VCC's `--grep`: `/recall <keyword|regex>` searches the
 * session's durable event log (including content elided or truncated by
 * compaction) and appends a `form: "recall"` user message with the matching
 * events and their `(seq N)` pointers, so the next model turn sees them.
 * `/recall files [page]` is the same loop over the files this session touched,
 * aggregated by path. The log is append-only, so hits are always the original
 * content.
 *
 * @module dsh-compaction-instant/command
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { DEFAULT_MAX_RECALL_TOKENS } from "./recall.js";
import { collectTouchedFiles, DEFAULT_MAX_SEARCH_HITS, InvalidSearchPatternError, SEARCH_BUDGET_MS, SearchBudgetExceededError, searchSession } from "./search.js";

export const name = "command-recall";
export const inject = ["commands"];
export const USAGE = "Usage: /recall <keyword|regex> | /recall files [page]";
/** The files-touched form: `files`, `--files` or `-f`, with an optional page. */
const FILES_FORM = /^(?:files|--files|-f)(?:\s+(\d+))?$/iu;

/** Validate and default the command plugin configuration. */
export function resolveConfig(config = {}) {
  const maxRecallTokens = config.maxRecallTokens ?? DEFAULT_MAX_RECALL_TOKENS;
  const maxSearchHits = config.maxSearchHits ?? DEFAULT_MAX_SEARCH_HITS;
  const searchBudgetMs = config.searchBudgetMs ?? SEARCH_BUDGET_MS;
  if (typeof maxRecallTokens !== "number" || !Number.isInteger(maxRecallTokens) || maxRecallTokens <= 0) throw new Error("CommandRecallConfig: maxRecallTokens must be a positive integer");
  if (typeof maxSearchHits !== "number" || !Number.isInteger(maxSearchHits) || maxSearchHits <= 0) throw new Error("CommandRecallConfig: maxSearchHits must be a positive integer");
  if (typeof searchBudgetMs !== "number" || !Number.isFinite(searchBudgetMs) || searchBudgetMs <= 0) throw new Error("CommandRecallConfig: searchBudgetMs must be a positive number");
  return { maxRecallTokens, maxSearchHits, searchBudgetMs };
}

/** Append one recall output message and report the command result. */
async function appendResult(invocation, text, summary, sourceEventSeqs) {
  let appended;
  try {
    appended = await invocation.agent.runMaintenance(() => {
      return invocation.agent.session.append("user/message", createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "plugin", plugin: "recall", form: "recall" }
      }), {
        surfaceOp: "append",
        sourceEventSeqs
      });
    });
  } catch (error) {
    return {
      kind: "error",
      text: error instanceof Error ? error.message : String(error)
    };
  }
  return { kind: "success", text: summary, sourceEventSeq: appended.seq };
}

/** Execute the `/recall files [page]` form against the calling agent's session. */
async function executeFiles(invocation, resolved, pageText) {
  const page = pageText === undefined ? 1 : Number(pageText);
  let result;
  try {
    result = collectTouchedFiles(invocation.agent.session, { searchBudgetMs: resolved.searchBudgetMs, page });
  } catch (error) {
    if (error instanceof SearchBudgetExceededError) return {
      kind: "error",
      text: `Files-touched scan aborted: it exceeded the ${resolved.searchBudgetMs}ms budget.`
    };
    throw error;
  }
  if (result.total === 0) return {
    kind: "error",
    text: "No file operations found in this session."
  };
  const summary = result.totalPages > 1
    ? `Page ${result.page}/${result.totalPages} — ${result.total} file(s) touched (~${result.tokens} tokens).`
    : `Found ${result.total} file(s) touched (~${result.tokens} tokens).`;
  return appendResult(invocation, result.text, summary, result.shownSeqs);
}

/** Execute one grep-based recall request against the calling agent's session. */
async function executeRecall(invocation, resolved) {
  const pattern = invocation.rawInput.trim();
  if (pattern.length === 0) return {
    kind: "error",
    text: USAGE
  };
  const filesForm = FILES_FORM.exec(pattern);
  if (filesForm !== null) return executeFiles(invocation, resolved, filesForm[1]);
  let result;
  try {
    result = searchSession(invocation.agent.session, pattern, resolved);
  } catch (error) {
    if (error instanceof InvalidSearchPatternError || error instanceof SearchBudgetExceededError) return {
      kind: "error",
      text: error.message
    };
    throw error;
  }
  if (result.totalMatches === 0) return {
    kind: "error",
    text: `No matching events for "${result.pattern}".`
  };
  return appendResult(
    invocation,
    result.text,
    `Found ${result.totalMatches} matching event(s) (~${result.tokens} tokens).`,
    result.hits.map((hit) => hit.seq)
  );
}

/**
 * Build the `recall` command definition (for tests and introspection).
 * @param resolved - validated `{ maxRecallTokens, maxSearchHits, searchBudgetMs }`.
 * @returns a registry-ready CommandDefinition.
 */
export function defineRecallCommand(resolved) {
  return {
    name: "recall",
    description: "Search earlier conversation history by keyword or regex, or list the files this session touched",
    handler: (invocation) => executeRecall(invocation, resolved)
  };
}

/**
 * Register `/recall` for every composed human-command adapter.
 * @param ctx - context carrying the command registry.
 * @param config - `{ maxRecallTokens?, maxSearchHits? }`.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  ctx.effect(() => ctx.commands.register(defineRecallCommand(resolved)));
}
