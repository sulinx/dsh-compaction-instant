/**
 * Shrink-gate retry (P4/T2c): a checkpoint that would not reduce the span is
 * retried with the compiler budget pinned to a fraction of the span itself,
 * and only declined when no tighter cap can pay for the framing.
 * @module dsh-compaction-instant/test/shrink-retry
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "@deepseek-ai/dsh-session";
import { createAssistantMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { CheckpointNotSmallerError, compactSurfaceRegion } from "../src/region.js";

const user = (text) => createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
const assistant = (text) => createAssistantMessage({ content: [{ type: "text", text }], source: { provider: "p", model: "m" } });

/** Two closed turns; the first one (seqs 1-2) is the replacement target. */
function makeSession(name) {
  return Session.create(name, [
    { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
    { type: "user/message", seq: 1, time: 2, data: user("please fix the bug"), surfaceOp: "append" },
    { type: "assistant/message", seq: 2, time: 3, data: { message: assistant("on it"), turn: 1, step: 1, stream: [] }, surfaceOp: "append" },
    { type: "turn/end", seq: 3, time: 4, data: { turn: 1 } },
    { type: "turn/start", seq: 4, time: 5, data: { turn: 2 } },
    { type: "user/message", seq: 5, time: 6, data: user("more context"), surfaceOp: "append" },
    { type: "assistant/message", seq: 6, time: 7, data: { message: assistant("done"), turn: 2, step: 1, stream: [] }, surfaceOp: "append" },
    { type: "turn/end", seq: 7, time: 8, data: { turn: 2 } }
  ]);
}

/** Meter whose message pricing is the serialized length (so content size decides). */
function makeMeter(session) {
  const perNode = 4000; // 2-node span = 8000 priced tokens, comfortably above the framing
  const measurement = {
    nodes: session.surface.nodes.map((seq) => ({ seq, tokens: perNode })),
    surfaceTokens: session.surface.nodes.length * perNode,
    totalTokens: session.surface.nodes.length * perNode
  };
  return { measure: () => measurement, estimateMessage: (message) => JSON.stringify(message).length };
}

test("the shrink gate retries at a tighter span-pinned cap and lands", async () => {
  const session = makeSession("shrink-retry-pass");
  const calls = [];
  const dependencies = {
    meter: makeMeter(session),
    compile: async (prepared, agent, signal, options) => {
      calls.push(options?.capFraction);
      // The first attempt overshoots the 1000-token span; the span-pinned
      // retries come back small enough to satisfy the shrink guarantee.
      const filler = options?.capFraction === undefined ? "x".repeat(8000) : "y".repeat(50);
      return { entries: [{ seq: prepared.shadowedSeqs[0], text: `[user] (seq ${prepared.shadowedSeqs[0]})\n${filler}` }], stats: { tokens: filler.length, toolResults: 3, toolResultTokens: 12345, erroredToolCalls: 1 }, provider: "p", model: "m" };
    }
  };
  const result = await compactSurfaceRegion(dependencies, session, 1, 2, undefined, { owner: null, stability: "selected-span" }, undefined);
  assert.deepEqual(calls, [undefined, 0.5], "first attempt, then the half-span cap");
  assert.ok(result !== undefined);
  // The intro line names what the checkpoint chose not to carry: tool results
  // cost the surface in full and the checkpoint nothing.
  const summary = result.summary[0].text;
  assert.match(summary, /未编入 3 条工具结果 \(~12345 tokens\)/);
  assert.match(summary, /1 条失败调用已整条丢弃/);
  assert.match(summary, /可用 recall 取回/);
});

test("a span that cannot pay for the framing is declined, not retried forever", async () => {
  const session = makeSession("shrink-retry-decline");
  const calls = [];
  const dependencies = {
    meter: makeMeter(session),
    // Every cap produces the same oversized body: a hook that ignores
    // `capFraction` must not be retried three times for nothing.
    compile: async (prepared, agent, signal, options) => {
      calls.push(options?.capFraction);
      return { entries: [{ seq: prepared.shadowedSeqs[0], text: "z".repeat(8000) }], stats: { tokens: 8000 }, provider: "p", model: "m" };
    }
  };
  await assert.rejects(
    () => compactSurfaceRegion(dependencies, session, 1, 2, undefined, { owner: null, stability: "selected-span" }, undefined),
    (error) => error.code === "summary" && error.cause instanceof CheckpointNotSmallerError
  );
  assert.deepEqual(calls, [undefined, 0.5], "stops as soon as a tighter cap changes nothing");
});
