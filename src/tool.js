/**
 * Model-facing same-session recall tools for `dsh-compaction-instant`.
 *
 * Three complementary entry points over the durable session log:
 *
 *   - `recall` — restore the exact original content of earlier events by a
 *     typed reference: `type: "seq"` for `(seq N)` / `(seqs A-B)` markers,
 *     `type: "result"` for the `result N` pointer on a tool-call one-liner,
 *     `type: "checkpoint"` for a `[checkpoint N]` elision line.
 *   - `search` — keyword, regex, or natural-language search over the log.
 *     Returns the matching events with their `(seq N)` pointers, so the agent
 *     can then call `recall` to restore any hit in full.
 *   - `touched_files` — every file the session read/wrote/edited, aggregated by
 *     path with the seq pointers of each operation, paginated.
 *
 * None of these does a model round-trip and none paraphrases: the log is
 * append-only, so the output is always the original content.
 *
 * Registered as the `recall`, `search` and `touched_files` tools on any context
 * providing `tools`.
 * @module dsh-compaction-instant/tool
 */
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { DEFAULT_MAX_RECALL_TOKENS, recallSession, resolveRecallReference } from "./recall.js";
import { collectTouchedFiles, DEFAULT_MAX_SEARCH_HITS, InvalidSearchPatternError, SEARCH_BUDGET_MS, SearchBudgetExceededError, searchSession } from "./search.js";

export const name = "tool-recall";
export const inject = ["tools"];

/** Validate and default the tool plugin configuration. */
export function resolveConfig(config = {}) {
  const maxRecallTokens = config.maxRecallTokens ?? DEFAULT_MAX_RECALL_TOKENS;
  const maxSearchHits = config.maxSearchHits ?? DEFAULT_MAX_SEARCH_HITS;
  const searchBudgetMs = config.searchBudgetMs ?? SEARCH_BUDGET_MS;
  if (typeof maxRecallTokens !== "number" || !Number.isInteger(maxRecallTokens) || maxRecallTokens <= 0) throw new Error("ToolRecallConfig: maxRecallTokens must be a positive integer");
  if (typeof maxSearchHits !== "number" || !Number.isInteger(maxSearchHits) || maxSearchHits <= 0) throw new Error("ToolRecallConfig: maxSearchHits must be a positive integer");
  if (typeof searchBudgetMs !== "number" || !Number.isFinite(searchBudgetMs) || searchBudgetMs <= 0) throw new Error("ToolRecallConfig: searchBudgetMs must be a positive number");
  return { maxRecallTokens, maxSearchHits, searchBudgetMs };
}

const RECALL_DESCRIPTION = "Restore the exact original content of earlier events in THIS conversation by a typed reference. type=\"seq\" with a seq selection id (\"3-7,15\", \"seq 12\", \"seqs 3-7\" — the checkpoint marker forms) restores those events; type=\"result\" with the \"result N\" pointer from a tool-call one-liner (\"result 3\" or \"3\") restores that tool result; type=\"checkpoint\" with an ordinal (\"1\" = oldest, as in a \"[checkpoint N]\" elision line) or a \"seq N\" pointer restores that full checkpoint. The durable log is append-only, so recalled content is always the original tokens. To find events by keyword or regex instead, use the search tool.";

const SEARCH_DESCRIPTION = "Search THIS conversation's durable event log by keyword, regular expression, or natural-language query (case-insensitive, Unicode-aware). Every event ever recorded is searchable, including content elided or truncated by compaction checkpoints — the log is append-only and untouched. A single word or a pattern with regex metacharacters is matched as one pattern and returns every matching event with its matching lines. A multi-word query is scored (BM25) over the whole log and returns the best-matching events, ranked, each with a short context window around its first match — so a prose question is answered by the events that actually discuss it rather than by every event containing one of its words; the tail below 20% of the top score is dropped and the drop is reported honestly. Results are capped (maxSearchHits) and the cap is always stated. A search never matches its own invocation or its own earlier output. Escape regex special characters (e.g. use \\\\( for a literal parenthesis). A pattern that nests unbounded quantifiers (such as (a+)+) is matched literally rather than as a regex, and a search that outruns its time budget is aborted with an error. Then call recall with a (seq N) pointer to restore any hit's full exact original content.";

const TOUCHED_DESCRIPTION = "List every file THIS conversation has read, written or edited, aggregated by path with the (seq N) pointers of each operation, in first-touch order and paginated. Use it to recover which files the session worked on — including operations hidden inside compaction checkpoints — and then call recall with a (seq N) pointer to restore the full original tool call. Nothing is paraphrased: the pointers address the append-only durable log.";

const RECALL_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string", required: true },
      recalled: { type: "integer", required: true },
      missing: { type: "integer", required: true },
      skipped: { type: "integer", required: true },
      truncated: { type: "boolean", required: true },
      tokens: { type: "integer", required: true }
    }
  },
  render: (_args, value) => [{ type: "text", text: value.text }]
};

const SEARCH_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string", required: true },
      pattern: { type: "string", required: true },
      mode: { type: "string", required: true },
      totalMatches: { type: "integer", required: true },
      omitted: { type: "integer", required: true },
      truncated: { type: "boolean", required: true },
      tokens: { type: "integer", required: true }
    }
  },
  render: (_args, value) => [{ type: "text", text: value.text }]
};

const TOUCHED_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string", required: true },
      total: { type: "integer", required: true },
      page: { type: "integer", required: true },
      totalPages: { type: "integer", required: true },
      tokens: { type: "integer", required: true }
    }
  },
  render: (_args, value) => [{ type: "text", text: value.text }]
};

/** Shared execution of one typed recall request against the calling agent. */
function executeRecall(exec, type, id, resolved) {
  const agent = exec.agent;
  if (agent === undefined) throw new HarnessError("recall requires a calling agent with a session", "RECALL_AGENT_REQUIRED");
  const { selections, errors } = resolveRecallReference(agent.session, type, id);
  if (errors.length > 0) throw new HarnessError(`invalid ${type} recall: ${errors.join("; ")}`, "RECALL_INVALID_SELECTION");
  const recalled = recallSession(agent.session, selections, resolved);
  return {
    text: recalled.text,
    recalled: recalled.recalled,
    missing: recalled.missing,
    skipped: recalled.skipped,
    truncated: recalled.truncated,
    tokens: recalled.tokens
  };
}

/**
 * Build the typed `recall` tool definition against one resolved config.
 * @param resolved - validated `{ maxRecallTokens, maxSearchHits }`.
 * @returns a registry-ready ToolDefinition.
 */
export function defineRecallTool(resolved) {
  return defineTool({
    name: "recall",
    description: RECALL_DESCRIPTION,
    parameters: {
      type: {
        type: "string",
        required: true,
        enum: ["seq", "result", "checkpoint"],
        description: 'Reference type: "seq" for events by sequence number, "result" for a tool result by its `result N` pointer, "checkpoint" for a whole checkpoint by ordinal or seq.'
      },
      id: {
        type: "string",
        required: true,
        description: 'Type-dependent reference: "3-7,15" / "seq 12" for seq; "result 3" or "3" for result; "1" / "checkpoint 1" or "seq 12345" for checkpoint.'
      }
    },
    output: RECALL_OUTPUT,
    execute: (args, exec) => executeRecall(exec, args.type, args.id, resolved),
    presentCall: (args) => ({
      card: "generic",
      title: "Recall events",
      kind: "read",
      rawInput: `${args.type} ${args.id}`
    })
  });
}

/**
 * Build the `search` (grep) tool definition against one resolved config.
 * @param resolved - validated `{ maxRecallTokens, maxSearchHits, searchBudgetMs }`.
 * @returns a registry-ready ToolDefinition.
 */
export function defineSearchTool(resolved) {
  return defineTool({
    name: "search",
    description: SEARCH_DESCRIPTION,
    parameters: {
      pattern: {
        type: "string",
        required: true,
        description: "Keyword or regular expression to search for (case-insensitive). Escape regex special characters."
      }
    },
    output: SEARCH_OUTPUT,
    execute(args, exec) {
      const agent = exec.agent;
      if (agent === undefined) throw new HarnessError("search requires a calling agent with a session", "RECALL_AGENT_REQUIRED");
      let result;
      try {
        result = searchSession(agent.session, args.pattern, resolved);
      } catch (error) {
        if (error instanceof InvalidSearchPatternError) throw new HarnessError(error.message, "SEARCH_INVALID_PATTERN", { cause: error });
        if (error instanceof SearchBudgetExceededError) throw new HarnessError(error.message, "SEARCH_BUDGET_EXCEEDED", { cause: error });
        throw error;
      }
      return {
        text: result.text,
        pattern: result.pattern,
        mode: result.mode,
        totalMatches: result.totalMatches,
        omitted: result.omitted,
        truncated: result.truncated,
        tokens: result.tokens
      };
    },
    presentCall: (args) => ({
      card: "generic",
      title: "Search history",
      kind: "read",
      rawInput: args.pattern
    })
  });
}

/**
 * Build the `touched_files` tool definition against one resolved config.
 * @param resolved - validated `{ maxRecallTokens, maxSearchHits, searchBudgetMs }`.
 * @returns a registry-ready ToolDefinition.
 */
export function defineTouchedTool(resolved) {
  return defineTool({
    name: "touched_files",
    description: TOUCHED_DESCRIPTION,
    parameters: {
      page: {
        type: "integer",
        description: "1-based page of the file list (5 files per page). The first page is returned when omitted; the footer names the next page."
      }
    },
    output: TOUCHED_OUTPUT,
    execute(args, exec) {
      const agent = exec.agent;
      if (agent === undefined) throw new HarnessError("touched_files requires a calling agent with a session", "RECALL_AGENT_REQUIRED");
      const page = args.page ?? 1;
      if (!Number.isInteger(page) || page < 1) throw new HarnessError("touched_files: page must be a positive integer", "RECALL_INVALID_SELECTION");
      let result;
      try {
        result = collectTouchedFiles(agent.session, { searchBudgetMs: resolved.searchBudgetMs, page });
      } catch (error) {
        if (error instanceof SearchBudgetExceededError) {
          throw new HarnessError(`touched-files scan exceeded the ${resolved.searchBudgetMs}ms budget`, "SEARCH_BUDGET_EXCEEDED", { cause: error });
        }
        throw error;
      }
      return { text: result.text, total: result.total, page: result.page, totalPages: result.totalPages, tokens: result.tokens };
    },
    presentCall: (args) => ({
      card: "generic",
      title: "Files touched",
      kind: "read",
      rawInput: `page ${args.page ?? 1}`
    })
  });
}

/**
 * Register the recall tools (`recall` restore + `search` grep + `touched_files`).
 * @param ctx - context carrying the tools service.
 * @param config - `{ maxRecallTokens?, maxSearchHits?, searchBudgetMs? }`.
 * @returns the installed registrations' combined disposer.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(defineRecallTool(resolved)),
      ctx.tools.register(defineSearchTool(resolved)),
      ctx.tools.register(defineTouchedTool(resolved))
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  });
}

export { DEFAULT_MAX_RECALL_TOKENS, RECALL_DESCRIPTION, SEARCH_DESCRIPTION, TOUCHED_DESCRIPTION };
