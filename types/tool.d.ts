/**
 * Model-facing same-session recall tool types: `recall` (typed restore),
 * `search` (keyword/regex/ranked search) and `touched_files` (files touched)
 * over the durable log.
 * @module dsh-compaction-instant/tool
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

/** Cordis companion plugin name. */
export declare const name: 'tool-recall';
/** Service required before the companion can register. */
export declare const inject: string[];
/** Tool plugin configuration. */
export interface ToolRecallConfig {
    /** Total budget for one recall/search operation, in density-aware tokens. Default 16000. */
    maxRecallTokens?: number;
    /** Cap on shown matching events per search. Default 50. */
    maxSearchHits?: number;
    /** Wall-clock budget for one search, in milliseconds. Default 3000. */
    searchBudgetMs?: number;
}
/** Validate and default the tool plugin configuration. */
export declare function resolveConfig(config?: ToolRecallConfig): Required<ToolRecallConfig>;
/** Register the recall tools; returns the combined disposer. */
export declare function apply(ctx: Context, config?: ToolRecallConfig): void;
/** The typed `recall` tool definition (type: seq | result | checkpoint). */
export declare function defineRecallTool(config: Required<ToolRecallConfig>): ToolDefinition;
/** The `search` tool definition (regex, keyword or ranked multi-term). */
export declare function defineSearchTool(config: Required<ToolRecallConfig>): ToolDefinition;
/** The `touched_files` tool definition (paginated files touched). */
export declare function defineTouchedTool(config: Required<ToolRecallConfig>): ToolDefinition;
/** Tool descriptions, exported for documentation and tests. */
export declare const RECALL_DESCRIPTION: string;
export declare const SEARCH_DESCRIPTION: string;
export declare const TOUCHED_DESCRIPTION: string;
