/**
 * Automatic-pressure trigger face (P4a): the trigger reads the shrinkable
 * surface measurement instead of the provider-usage-inclusive total, an
 * optional absolute trigger is honored with the ratio as headroom guard, and a
 * landed compaction is returned even when pressure stays above the threshold.
 * @module dsh-compaction-instant/test/pressure-trigger
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { Session } from "@deepseek-ai/dsh-session";
import { createAssistantMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { InstantCompactionEngine, resolveCompactSpec, resolveConfig, resolveTargetPolicy } from "../src/index.js";

const user = (text) => createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
const assistant = (text) => createAssistantMessage({ content: [{ type: "text", text }], source: { provider: "p", model: "m" } });
const checkpoint = (text) => createUserMessage({ content: [{ type: "text", text }], source: { kind: "compact-checkpoint" } });

/**
 * Two closed turns, so the first one is compactable.
 *
 * `assistant/message` seeds must carry settlement fields (`turn`, `step`,
 * `stream`) — the host rejects fixtures without them, which is why the older
 * fixtures in this repository no longer seed.
 */
function makeSession() {
  const session = Session.create("pressure-session", [
    { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
    { type: "user/message", seq: 1, time: 2, data: user("please fix the bug"), surfaceOp: "append" },
    { type: "assistant/message", seq: 2, time: 3, data: { message: assistant("on it"), turn: 1, step: 1, stream: [] }, surfaceOp: "append" },
    { type: "turn/end", seq: 3, time: 4, data: { turn: 1 } },
    { type: "turn/start", seq: 4, time: 5, data: { turn: 2 } },
    { type: "user/message", seq: 5, time: 6, data: user("more context"), surfaceOp: "append" },
    { type: "assistant/message", seq: 6, time: 7, data: { message: assistant("done"), turn: 2, step: 1, stream: [] }, surfaceOp: "append" },
    { type: "turn/end", seq: 7, time: 8, data: { turn: 2 } }
  ]);
  // The route the engine prices against; the seed protocol has no header event
  // in this fixture, so the accessor is stubbed on the instance.
  Object.defineProperty(session, "requestHeader", { value: () => ({ config: { provider: "p", model: "m" } }), configurable: true });
  return session;
}

/** Engine whose compaction is stubbed, so only trigger decisions are observed. */
function makeEngine(session, measurement, calls, config = {}) {
  const ctx = new Context();
  ctx.provide("tokenMeter", { measure: () => measurement.value, estimateMessage: () => 10 });
  ctx.provide("llm", { resolveModelInfo: async () => ({ context: { contextWindow: 1000 } }) });
  class StubEngine extends InstantCompactionEngine {
    async compactRegion(start, end, agent, signal, tail) {
      calls.push({ start, end, tail });
      return { checkpoint: true, start, end };
    }
  }
  return new StubEngine(ctx, { thresholdRatio: 0.5, retainTokens: 0, compactionRetries: 1, ...config });
}

const prices = (session, tokens) => session.surface.nodes.map((seq) => ({ seq, tokens }));

test("the pressure trigger reads surface tokens, not the provider-usage total", async () => {
  const session = makeSession();
  const calls = [];
  // 90k of provider usage (a big cache read) with a 100-token surface: nothing
  // here is shrinkable, so the old reading fired at every step boundary.
  const measurement = { value: { nodes: prices(session, 25), surfaceTokens: 100, totalTokens: 90000 } };
  const engine = makeEngine(session, measurement, calls);
  assert.equal(await engine.compactIfNeeded({ session }, "pressure", undefined), null);
  assert.equal(calls.length, 0);
});

test("pressure still fires when the shrinkable surface itself is over the threshold", async () => {
  const session = makeSession();
  const calls = [];
  const measurement = { value: { nodes: prices(session, 3000), surfaceTokens: 6000, totalTokens: 90000 } };
  const engine = makeEngine(session, measurement, calls, { compactionRetries: 0 });
  const result = await engine.compactIfNeeded({ session }, "pressure", undefined);
  assert.equal(calls.length, 1);
  assert.deepEqual(result, { checkpoint: true, start: calls[0].start, end: calls[0].end });
});

test("a landed compaction is returned when pressure stays above the threshold", async () => {
  const session = makeSession();
  const calls = [];
  // The stub never reprices the surface, so every retry stays over the
  // threshold: the loop must return the checkpoint it wrote, not throw
  // (the old throw surfaced as "step compaction failed" for a durable write).
  const measurement = { value: { nodes: prices(session, 3000), surfaceTokens: 6000, totalTokens: 90000 } };
  const engine = makeEngine(session, measurement, calls);
  const result = await engine.compactIfNeeded({ session }, "pressure", undefined);
  assert.equal(calls.length, 2); // 1 initial attempt + compactionRetries (1)
  assert.equal(result?.checkpoint, true);
});

test("hosts without surface pricing keep the previous reading", async () => {
  const session = makeSession();
  const calls = [];
  const measurement = { value: { nodes: prices(session, 3000), totalTokens: 90000 } };
  const engine = makeEngine(session, measurement, calls, { compactionRetries: 0 });
  const result = await engine.compactIfNeeded({ session }, "pressure", undefined);
  assert.equal(calls.length, 1);
  assert.equal(result?.checkpoint, true);
});

test("pressure refuses a span that would only re-encode a landed checkpoint", async () => {
  // Two closed turns where the only compactable span is turn 1 = [an early
  // user message, a landed checkpoint]. The checkpoint is priced as the bulk of
  // the span, so the span carries almost no NEW tokens: compacting it would
  // re-encode what the checkpoint already holds, shrink the surface by nearly
  // nothing, and fire again at the next step boundary.
  const session = Session.create("pressure-checkpoint-session", [
    { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
    { type: "user/message", seq: 1, time: 2, data: user("early question"), surfaceOp: "append" },
    { type: "user/message", seq: 2, time: 3, data: checkpoint("## Compiled checkpoint: 40 nodes"), surfaceOp: "append" },
    { type: "turn/end", seq: 3, time: 4, data: { turn: 1 } },
    { type: "turn/start", seq: 4, time: 5, data: { turn: 2 } },
    { type: "user/message", seq: 5, time: 6, data: user("later question"), surfaceOp: "append" },
    { type: "assistant/message", seq: 6, time: 7, data: { message: assistant("later answer"), turn: 2, step: 1, stream: [] }, surfaceOp: "append" },
    { type: "turn/end", seq: 7, time: 8, data: { turn: 2 } }
  ]);
  Object.defineProperty(session, "requestHeader", { value: () => ({ config: { provider: "p", model: "m" } }), configurable: true });
  const prices = session.surface.nodes.map((seq) => ({ seq, tokens: seq === 2 ? 8000 : 10 }));
  const surfaceTokens = prices.reduce((total, node) => total + node.tokens, 0);
  const calls = [];
  const measurement = { value: { nodes: prices, surfaceTokens, totalTokens: surfaceTokens } };
  const engine = makeEngine(session, measurement, calls, { compactionRetries: 0 });
  assert.equal(await engine.compactIfNeeded({ session }, "pressure", undefined), null);
  assert.equal(calls.length, 0);
});

test("pressure still fires when the span carries enough new tokens beside the checkpoint", async () => {
  const session = Session.create("pressure-checkpoint-session-2", [
    { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
    { type: "user/message", seq: 1, time: 2, data: user("early question"), surfaceOp: "append" },
    { type: "user/message", seq: 2, time: 3, data: checkpoint("## Compiled checkpoint: 2 nodes"), surfaceOp: "append" },
    { type: "turn/end", seq: 3, time: 4, data: { turn: 1 } },
    { type: "turn/start", seq: 4, time: 5, data: { turn: 2 } },
    { type: "user/message", seq: 5, time: 6, data: user("later question"), surfaceOp: "append" },
    { type: "assistant/message", seq: 6, time: 7, data: { message: assistant("later answer"), turn: 2, step: 1, stream: [] }, surfaceOp: "append" },
    { type: "turn/end", seq: 7, time: 8, data: { turn: 2 } }
  ]);
  Object.defineProperty(session, "requestHeader", { value: () => ({ config: { provider: "p", model: "m" } }), configurable: true });
  const prices = session.surface.nodes.map((seq) => ({ seq, tokens: seq === 2 ? 100 : 5000 }));
  const surfaceTokens = prices.reduce((total, node) => total + node.tokens, 0);
  const calls = [];
  const measurement = { value: { nodes: prices, surfaceTokens, totalTokens: surfaceTokens } };
  const engine = makeEngine(session, measurement, calls, { compactionRetries: 0 });
  const result = await engine.compactIfNeeded({ session }, "pressure", undefined);
  assert.equal(calls.length, 1);
  assert.equal(result?.checkpoint, true);
});

test("compactAtTokens is an absolute trigger with the ratio as headroom guard", () => {
  const policy = (config) => resolveTargetPolicy(resolveConfig(config), { provider: "p", model: "m" });
  assert.equal(resolveCompactSpec(policy({}), 1000).thresholdTokens, 500);
  assert.equal(resolveCompactSpec(policy({ compactAtTokens: 300 }), 1000).thresholdTokens, 300);
  assert.equal(resolveCompactSpec(policy({ compactAtTokens: 900 }), 1000).thresholdTokens, 500);
  assert.equal(resolveCompactSpec(policy({ compactAtTokens: 300 }), 1000).ratioThresholdTokens, 500);
  // Per-target override wins over the top-level value.
  const overridden = resolveTargetPolicy(
    resolveConfig({ compactAtTokens: 900, modelPolicies: [{ provider: "p", model: "m", compactAtTokens: 200 }] }),
    { provider: "p", model: "m" }
  );
  assert.equal(resolveCompactSpec(overridden, 1000).thresholdTokens, 200);
});

test("compactAtTokens defaults to unset and rejects non-positive-integer values", () => {
  assert.equal(resolveConfig({}).compactAtTokens, undefined);
  assert.throws(() => resolveConfig({ compactAtTokens: 0 }), /compactAtTokens/);
  assert.throws(() => resolveConfig({ compactAtTokens: 1.5 }), /compactAtTokens/);
  assert.throws(() => resolveConfig({ compactAtTokens: "900" }), /compactAtTokens/);
  assert.throws(() => resolveConfig({ modelPolicies: [{ provider: "p", model: "m", compactAtTokens: -1 }] }), /compactAtTokens/);
});
