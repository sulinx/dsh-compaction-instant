/**
 * P2 tests: per-turn injection sources are dropped from the compiled
 * checkpoint view only — the upstream `skipCustomTypes` semantics ported to
 * the DSH source vocabulary (`injectKeyOf` / `skipInjectTypes` /
 * `skipPerTurnInjections`).
 *
 * Contract under test:
 *   1. the default skip list covers the runtime-context snapshot and the skill
 *      catalog, and never a landed checkpoint;
 *   2. a skipped node produces no entry, but exactly one consolidated marker
 *      names the count, the estimated saved tokens, and the per-key breakdown;
 *   3. the marker is a `note` row, so cap pressure drops it first;
 *   4. real user turns, tool calls/results, and checkpoints are untouched;
 *   5. switching the feature off restores the old byte-for-byte behavior;
 *   6. `resolveConfig` resolves the switch and the list, and rejects junk.
 * @module dsh-compaction-instant/test/skip-inject
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  compileRegion,
  DEFAULT_SKIP_INJECT_TYPES,
  estimateEntryTokens,
  injectKeyLabel,
  injectKeyOf,
  isCheckpointSource
} from "../src/compiler.js";
import { resolveConfig } from "../src/index.js";

const SKILL_BODY = "<system-reminder>\nA skill is a reusable set of task-specific instructions.\n" + "skill line. ".repeat(60);

const text = (value) => ({ type: "text", text: value });
const user = (content, source) => ({ role: "user", content, source });
const assistant = (content) => ({ role: "assistant", content: [text(content)] });

const RUNTIME_CONTEXT = "plugin:@deepseek-ai/dsh-system-prompt";
const RUNTIME_CONTEXT_017 = "runtime-context:snapshot";
const SKILL_CATALOG = "skill-catalog:catalog";
const CHECKPOINT = "plugin:compact";
const CHECKPOINT_017 = "compact-checkpoint:-";

/** A runtime-context-shaped injection node. */
const injectNode = (seq, key, body = "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n" + "long-term memory line. ".repeat(40)) => {
  const [kind, name] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  const source = kind === "plugin" ? { kind, plugin: name } : kind === "compact-checkpoint" ? { kind: "compact-checkpoint", compactionId: "c-1" } : { kind, form: name };
  return { seq, message: user([text(body)], source) };
};
const realUserNode = (seq, body) => ({ seq, message: user([text(body)], { kind: "user", rpcId: "rpc-1" }) });
const checkpointNode = (seq, body) => ({ seq, message: user([text(body)], { kind: "plugin", plugin: "compact", compactionId: "c-1" }) });
const assistantNode = (seq, body) => ({ seq, message: assistant(body) });

const config = (overrides = {}) => ({
  textTokens: 512,
  userTextTokens: 1024,
  toolCallTokens: 128,
  toolResultExcerptTokens: 256,
  includeReasoning: false,
  stripNoiseXml: true,
  noisePatterns: [],
  toolArgTools: [],
  hideTools: [],
  skipInjectTypes: [...DEFAULT_SKIP_INJECT_TYPES],
  maxTokens: 65536,
  ...overrides
});

const joined = (result) => result.entries.map((entry) => entry.text).join("\n");

// ── the identity key ───────────────────────────────────────────────────────

test("injectKeyOf builds the canonical kind:name key for every source shape", () => {
  assert.equal(injectKeyOf({ kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" }), RUNTIME_CONTEXT);
  assert.equal(injectKeyOf({ kind: "skill-catalog", form: "catalog" }), SKILL_CATALOG);
  assert.equal(injectKeyOf({ kind: "plugin", plugin: "compact" }), CHECKPOINT);
  assert.equal(injectKeyOf({ kind: "user", rpcId: "rpc-1" }), "user:-");
  assert.equal(injectKeyOf(undefined), "unknown:-");
  assert.equal(injectKeyOf({ kind: "plugin" }), "plugin:-");
  // Name wins in declaration order: plugin, then form, then name.
  assert.equal(injectKeyOf({ kind: "x", name: "n", form: "f", plugin: "p" }), "x:p");
});

test("injectKeyLabel shortens plugin keys but never loses the identity", () => {
  assert.equal(injectKeyLabel(RUNTIME_CONTEXT), "dsh-system-prompt");
  assert.equal(injectKeyLabel(SKILL_CATALOG), "skill-catalog:catalog");
  assert.equal(injectKeyLabel("plugin:compact"), "compact");
  assert.equal(injectKeyLabel("plugin:@scope/name"), "name");
  assert.equal(injectKeyLabel("user:-"), "user:-");
});

test("the default skip list covers both host generations and not checkpoints", () => {
  assert.deepEqual([...DEFAULT_SKIP_INJECT_TYPES], [RUNTIME_CONTEXT_017, RUNTIME_CONTEXT, SKILL_CATALOG]);
  assert.equal(DEFAULT_SKIP_INJECT_TYPES.includes(CHECKPOINT), false);
  assert.equal(DEFAULT_SKIP_INJECT_TYPES.includes(CHECKPOINT_017), false);
  assert.equal(isCheckpointSource({ kind: "plugin", plugin: "compact" }), true);
});

test("isCheckpointSource recognises both the 0.1.6 and the 0.1.7 checkpoint vocabulary", () => {
  // dsh <= 0.1.6 lands a checkpoint as plugin:"compact"; 0.1.7 uses a dedicated
  // `compact-checkpoint` kind. A checkpoint misread as a user turn would be
  // truncated to the user-text budget AND demoted in the cap-elision order.
  assert.equal(isCheckpointSource({ kind: "plugin", plugin: "compact" }), true);
  assert.equal(isCheckpointSource({ kind: "compact-checkpoint", compactionId: "c-1" }), true);
  assert.equal(isCheckpointSource({ kind: "runtime-context", form: "snapshot" }), false);
  assert.equal(isCheckpointSource({ kind: "user", rpcId: "r" }), false);
  assert.equal(isCheckpointSource(undefined), false);
  assert.equal(isCheckpointSource("compact-checkpoint"), false);
});

test("a 0.1.7-shaped runtime-context snapshot is skipped by default", () => {
  const nodes = [
    injectNode(0, RUNTIME_CONTEXT_017),
    realUserNode(1, "carry on"),
    assistantNode(2, "ok")
  ];
  const result = compileRegion(nodes, config());
  assert.equal(result.stats.injectedSkipped, 1);
  assert.deepEqual(result.stats.injectedByKey, { [RUNTIME_CONTEXT_017]: 1 });
  assert.equal(joined(result).includes("Current runtime context"), false);
  assert.equal(joined(result).includes("carry on"), true);
});

test("a 0.1.7 checkpoint node compiles as a checkpoint, not as user text", () => {
  const nodes = [
    assistantNode(0, "before"),
    injectNode(1, CHECKPOINT_017, "## Compiled checkpoint: 12 nodes (seqs 1-40) — 9 entries"),
    realUserNode(2, "after")
  ];
  const result = compileRegion(nodes, config());
  assert.equal(result.stats.checkpoints, 1, "recognised as a checkpoint");
  assert.equal(result.stats.injectedSkipped, 0, "checkpoints are never skipped");
  const entry = result.entries.find((e) => e.text.includes("## Compiled checkpoint: 12 nodes"));
  assert.equal(entry.kind, "checkpoint");
  assert.match(entry.text, /^\[system\]\n/, "rendered under the system role header");
});

// ── the compiled view ──────────────────────────────────────────────────────

test("an injected node leaves no entry but one consolidated marker", () => {
  const nodes = [
    injectNode(0, RUNTIME_CONTEXT),
    realUserNode(1, "please fix the parser"),
    injectNode(2, SKILL_CATALOG, SKILL_BODY),
    assistantNode(3, "done")
  ];
  const result = compileRegion(nodes, config());
  assert.equal(result.stats.injectedSkipped, 2);
  assert.deepEqual(result.stats.injectedByKey, { [RUNTIME_CONTEXT]: 1, [SKILL_CATALOG]: 1 });
  assert.ok(result.stats.injectedSkippedTokens > 0, "saved tokens are reported");

  const body = joined(result);
  assert.equal(body.includes("Current runtime context"), false, "the injection body is gone");
  assert.equal(body.includes("A skill is a reusable set"), false);
  assert.equal(body.includes("please fix the parser"), true, "the real user turn survives");

  const markers = result.entries.filter((entry) => entry.text.startsWith("[2 per-turn injection"));
  assert.equal(markers.length, 1, "exactly one consolidated marker");
  assert.equal(markers[0].kind, "note");
  assert.equal(markers[0].seq, 0, "the marker carries the first skipped seq");
  assert.match(markers[0].text, /: dsh-system-prompt=1, skill-catalog:catalog=1 \(~\d+ tokens\)\]$/);
});

test("saved tokens equal what the row would have cost under the user-text budget", () => {
  const nodes = [injectNode(0, RUNTIME_CONTEXT), assistantNode(1, "ok")];
  const skipped = compileRegion(nodes, config());
  const kept = compileRegion(nodes, config({ skipInjectTypes: [] }));
  // The unfiltered compile renders the injection as a normal user entry.
  assert.equal(kept.stats.injectedSkipped, 0);
  assert.equal(joined(kept).includes("Current runtime context"), true);
  const injectionEntry = kept.entries.find((entry) => entry.text.includes("Current runtime context"));
  const marker = skipped.entries.find((entry) => entry.text.startsWith("[1 per-turn injection"));
  assert.ok(marker, "marker exists");
  // The reported saving is exactly the size of the row the compiler no longer
  // emits: the same truncated text without the `[user]` header the entry list
  // would have prefixed.
  const headerless = injectionEntry.text.replace(/^\[user\]\n/, "");
  assert.equal(skipped.stats.injectedSkippedTokens, estimateEntryTokens(headerless));
  assert.ok(marker.text.includes(`(~${skipped.stats.injectedSkippedTokens} tokens)]`));
});

test("checkpoints, tool results and real turns are never filtered", () => {
  const nodes = [
    realUserNode(0, "hi"),
    checkpointNode(1, "## Compiled checkpoint: 12 nodes"),
    injectNode(2, RUNTIME_CONTEXT),
    assistantNode(3, "ok")
  ];
  const result = compileRegion(nodes, config());
  const body = joined(result);
  assert.equal(result.stats.injectedSkipped, 1);
  assert.equal(result.stats.checkpoints, 1, "the checkpoint still compiles");
  assert.equal(body.includes("## Compiled checkpoint: 12 nodes"), true);
  assert.equal(body.includes("hi"), true);
});

test("a checkpoint whose source key was added explicitly is still not skipped", () => {
  // Guards the ordering of the two checks inside the user branch: the
  // checkpoint branch must win even if a user lists `plugin:compact`.
  const nodes = [checkpointNode(0, "## Compiled checkpoint: 3 nodes"), assistantNode(1, "ok")];
  const result = compileRegion(nodes, config({ skipInjectTypes: [CHECKPOINT] }));
  assert.equal(result.stats.injectedSkipped, 0);
  assert.equal(joined(result).includes("## Compiled checkpoint: 3 nodes"), true);
});

test("switching the list off restores the previous output exactly", () => {
  const nodes = [
    injectNode(0, RUNTIME_CONTEXT),
    realUserNode(1, "hello"),
    injectNode(2, SKILL_CATALOG, SKILL_BODY),
    assistantNode(3, "world")
  ];
  const off = compileRegion(nodes, config({ skipInjectTypes: [] }));
  assert.equal(off.stats.injectedSkipped, 0);
  assert.equal(off.entries.some((entry) => entry.text.startsWith("[1 per-turn injection")), false);
  assert.equal(off.entries.some((entry) => entry.text.startsWith("[2 per-turn injection")), false);
  assert.equal(joined(off).includes("Current runtime context"), true);
  assert.equal(joined(off).includes("A skill is a reusable set"), true);
});

test("an unknown key in the list skips nothing", () => {
  const nodes = [injectNode(0, RUNTIME_CONTEXT), assistantNode(1, "ok")];
  const result = compileRegion(nodes, config({ skipInjectTypes: ["plugin:not-installed"] }));
  assert.equal(result.stats.injectedSkipped, 0);
  assert.equal(joined(result).includes("Current runtime context"), true);
});

test("the omission marker is a note row, so cap pressure drops it first", () => {
  const nodes = [];
  for (let index = 0; index < 40; index += 1) {
    nodes.push(injectNode(index * 2, RUNTIME_CONTEXT));
    nodes.push(assistantNode(index * 2 + 1, `turn ${index} ` + "content ".repeat(120)));
  }
  const result = compileRegion(nodes, config({ maxTokens: 900 }));
  assert.equal(result.capped, true, "the cap was enforced");
  const body = joined(result);
  assert.equal(body.includes("Current runtime context"), false);
  // The marker may survive or be elided depending on how far the pass had to
  // go, but the conversation text must outlive it.
  assert.equal(body.includes("turn 39"), true, "the newest turn survives");
});

// ── configuration ──────────────────────────────────────────────────────────

test("resolveConfig defaults skipPerTurnInjections on, with the default list", () => {
  const resolved = resolveConfig({});
  assert.equal(resolved.skipPerTurnInjections, true);
  assert.deepEqual(resolved.skipInjectTypes, [...DEFAULT_SKIP_INJECT_TYPES]);
});

test("skipPerTurnInjections:false empties the list even when keys were given", () => {
  const resolved = resolveConfig({ skipPerTurnInjections: false, skipInjectTypes: [RUNTIME_CONTEXT] });
  assert.deepEqual(resolved.skipInjectTypes, []);
});

test("an explicit list replaces the defaults and is de-duplicated", () => {
  const resolved = resolveConfig({ skipInjectTypes: ["plugin:tool-jobs", "plugin:tool-jobs", SKILL_CATALOG] });
  assert.deepEqual(resolved.skipInjectTypes, ["plugin:tool-jobs", SKILL_CATALOG]);
  assert.equal(resolved.skipInjectTypes.includes(RUNTIME_CONTEXT), false);
});

test("an empty list means unset, not 'skip nothing'", () => {
  // The cordis config pipeline injects `[]` for absent array keys, so an empty
  // list must fall back to the defaults (same rule as hideTools/toolArgTools).
  assert.deepEqual(resolveConfig({ skipInjectTypes: [] }).skipInjectTypes, [...DEFAULT_SKIP_INJECT_TYPES]);
});

test("invalid skip configuration is rejected loudly", () => {
  assert.throws(() => resolveConfig({ skipPerTurnInjections: "yes" }), /skipPerTurnInjections must be a boolean/);
  assert.throws(() => resolveConfig({ skipInjectTypes: [1] }), /skipInjectTypes must be an array of non-empty strings/);
  assert.throws(() => resolveConfig({ skipInjectTypes: [""] }), /skipInjectTypes must be an array of non-empty strings/);
  assert.throws(() => resolveConfig({ skipInjectTypes: "plugin:x" }), /skipInjectTypes must be an array of non-empty strings/);
});
