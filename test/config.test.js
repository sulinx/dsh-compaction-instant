/**
 * Configuration resolution tests for the instant compaction engine.
 * @module dsh-compaction-instant/test/config
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { compileNoisePatterns, DEFAULT_ARG_TOOLS, DEFAULT_NOISE_PATTERNS } from "../src/compiler.js";
import { resolveCompactSpec, resolveConfig, resolveTargetPolicy, TargetPressureConfigError } from "../src/index.js";

test("resolveConfig applies the documented defaults", () => {
  const config = resolveConfig({});
  assert.equal(config.thresholdRatio, 0.5);
  assert.equal(config.retainTurns, 1);
  assert.equal(config.retainTokens, 5120);
  assert.equal(config.maxTokens, 8192);
  assert.equal(config.checkpointScale, 0.1);
  assert.equal(config.checkpointCap, 65536);
  assert.equal(config.textTokens, 512);
  assert.equal(config.userTextTokens, 1024);
  assert.equal(config.toolCallTokens, 128);
  assert.equal(config.toolResultExcerptTokens, 256);
  assert.equal(config.includeReasoning, false);
  assert.equal(config.stripNoiseXml, true);
  assert.equal(config.auto, true);
  assert.equal(config.noisePatterns.length, 5);
  assert.deepEqual(config.modelPolicies, []);
});

test("resolveConfig rejects unknown keys", () => {
  assert.throws(() => resolveConfig({ textToken: 1 }), /unknown key "textToken"/);
  assert.throws(() => resolveConfig({ retainRatio: 0.05 }), /unknown key "retainRatio"/);
  assert.throws(() => resolveConfig({ manualRetainRatio: 0.05 }), /unknown key "manualRetainRatio"/);
  assert.throws(() => resolveConfig({ manualRetainTokens: 100 }), /unknown key "manualRetainTokens"/);
});

test("resolveConfig validates ratios, term retention, and threshold", () => {
  assert.throws(() => resolveConfig({ thresholdRatio: 0 }), /thresholdRatio/);
  assert.throws(() => resolveConfig({ thresholdRatio: 1.5 }), /thresholdRatio/);
  assert.throws(() => resolveConfig({ retainTurns: 0 }), /retainTurns/);
  assert.throws(() => resolveConfig({ retainTurns: 1.5 }), /retainTurns/);
  assert.throws(() => resolveConfig({ retainTokens: -1 }), /retainTokens/);
  assert.throws(() => resolveConfig({ retainTokens: 1.5 }), /retainTokens/);
});

test("resolveConfig validates compiler budgets and flags", () => {
  assert.throws(() => resolveConfig({ textTokens: 0 }), /textTokens/);
  assert.throws(() => resolveConfig({ toolResultExcerptTokens: -1 }), /toolResultExcerptTokens/);
  assert.throws(() => resolveConfig({ includeReasoning: "yes" }), /includeReasoning/);
  assert.throws(() => resolveConfig({ stripNoiseXml: 1 }), /stripNoiseXml/);
  assert.throws(() => resolveConfig({ noisePatterns: ["("] }), /noisePatterns\[0\]/);
  assert.throws(() => resolveConfig({ noisePatterns: "x" }), /noisePatterns/);
  assert.throws(() => resolveConfig({ toolKeyFields: { read: 5 } }), /toolKeyFields/);
});

test("resolveConfig validates tool whitelists and hides, and deduplicates", () => {
  assert.ok(resolveConfig({}).toolArgTools.includes("read"));
  assert.ok(resolveConfig({}).toolArgTools.includes("bash"));
  assert.deepEqual(resolveConfig({}).hideTools, []);
  assert.throws(() => resolveConfig({ toolArgTools: "read" }), /toolArgTools/);
  assert.throws(() => resolveConfig({ toolArgTools: [""] }), /toolArgTools/);
  assert.throws(() => resolveConfig({ hideTools: ["job_kill", 5] }), /hideTools/);
  const config = resolveConfig({ toolArgTools: ["read", "read", "bash"], hideTools: ["job_kill", "job_kill"] });
  assert.deepEqual(config.toolArgTools, ["read", "bash"]);
  assert.deepEqual(config.hideTools, ["job_kill"]);
});

test("resolveConfig treats schemastery-injected empty arrays as unset", () => {
  // The cordis config pipeline validates rows through the plugin's schemastery
  // schema, whose `~standard` adapter injects `[]` for every absent array key.
  // Regression: that shape must fall back to the defaults, not disable them.
  const injected = { toolArgTools: [], hideTools: [], noisePatterns: [], toolKeyFields: {}, debug: true };
  const config = resolveConfig(injected);
  assert.deepEqual(config.toolArgTools, [...DEFAULT_ARG_TOOLS]);
  assert.deepEqual(config.hideTools, []);
  assert.deepEqual(config.noisePatterns, compileNoisePatterns(DEFAULT_NOISE_PATTERNS));
});

test("rankElision defaults on, is configurable, and is validated", () => {
  assert.equal(resolveConfig({}).rankElision, true);
  assert.equal(resolveConfig({ rankElision: false }).rankElision, false);
  assert.equal(resolveConfig({ rankElision: true }).rankElision, true);
  assert.throws(() => resolveConfig({ rankElision: "off" }), /rankElision/);
});

test("resolveConfig debug defaults off and installs a file sink when on", () => {
  assert.equal(resolveConfig({}).debug, false);
  assert.equal(resolveConfig({}).debugSink, undefined);
  assert.throws(() => resolveConfig({ debug: "yes" }), /debug/);
  assert.throws(() => resolveConfig({ debugLogPath: 5 }), /debugLogPath/);
  const debug = resolveConfig({ debug: true, debugLogPath: "/tmp/dsh-compaction-debug-test.log" });
  assert.equal(debug.debug, true);
  assert.equal(typeof debug.debugSink, "function");
  debug.debugSink(`test line ${Date.now()}`);
  const lines = readFileSync("/tmp/dsh-compaction-debug-test.log", "utf8").trim().split("\n");
  assert.match(lines[lines.length - 1], /test line/);
  rmSync("/tmp/dsh-compaction-debug-test.log", { force: true });
});

test("resolveConfig validates retained-term budgets", () => {
  assert.throws(() => resolveConfig({ retainTurns: 0 }), /retainTurns/);
  assert.equal(resolveConfig({ retainTurns: 3 }).retainTurns, 3);
  assert.equal(resolveConfig({ retainTokens: 50000 }).retainTokens, 50000);
  assert.throws(() => resolveConfig({ checkpointScale: 0 }), /checkpointScale/);
  assert.throws(() => resolveConfig({ checkpointCap: 0 }), /checkpointCap/);
  const config = resolveConfig({ retainTurns: 2, retainTokens: 3000, checkpointScale: 0.25, checkpointCap: 32768 });
  assert.equal(config.retainTurns, 2);
  assert.equal(config.retainTokens, 3000);
  assert.equal(config.checkpointScale, 0.25);
  assert.equal(config.checkpointCap, 32768);
});

test("resolveConfig validates the inert summarization pair for drop-in parity", () => {
  assert.throws(() => resolveConfig({ summarizationProvider: "p" }), /set together/);
  const config = resolveConfig({ summarizationProvider: "", summarizationModel: "" });
  assert.equal(config.maxTokens, 8192);
});

test("resolveConfig validates modelPolicies and rejects duplicates", () => {
  assert.throws(() => resolveConfig({ modelPolicies: [{ provider: "p" }] }), /modelPolicies\[0\]/);
  assert.throws(() => resolveConfig({ modelPolicies: [{ provider: "p", model: "m", retainRatio: 0.9 }] }), /modelPolicies\[0\].*unknown key "retainRatio"/);
  assert.throws(() => resolveConfig({
    modelPolicies: [
      { provider: "p", model: "m" },
      { provider: "p", model: "m" }
    ]
  }), /duplicate model policy/);
});

test("resolveTargetPolicy overlays exact-target fields over defaults", () => {
  const config = resolveConfig({ retainTurns: 2, retainTokens: 3000 });
  const policy = resolveTargetPolicy(config, { provider: "p", model: "m" });
  assert.equal(policy.thresholdRatio, 0.5);
  assert.equal(policy.retainTurns, 2);
  assert.equal(policy.retainTokens, 3000);
  const overridden = resolveConfig({
    modelPolicies: [{ provider: "p", model: "m", thresholdRatio: 0.9, retainTurns: 5, retainTokens: 9000 }]
  });
  const targeted = resolveTargetPolicy(overridden, { provider: "p", model: "m" });
  assert.equal(targeted.thresholdRatio, 0.9);
  assert.equal(targeted.retainTurns, 5);
  assert.equal(targeted.retainTokens, 9000);
});

test("resolveCompactSpec scales budgets and rejects invalid windows", () => {
  const policy = resolveTargetPolicy(resolveConfig({}), { provider: "p", model: "m" });
  const spec = resolveCompactSpec(policy, 1000);
  assert.equal(spec.thresholdTokens, 500);
  assert.equal(spec.retainTurns, 1);
  assert.equal(spec.retainTokens, 5120);
  assert.throws(() => resolveCompactSpec(policy, 0), TargetPressureConfigError);
  const configured = resolveTargetPolicy(resolveConfig({ retainTurns: 2, retainTokens: 4000 }), { provider: "p", model: "m" });
  const scaled = resolveCompactSpec(configured, 1000);
  assert.equal(scaled.retainTurns, 2);
  assert.equal(scaled.retainTokens, 4000);
});
