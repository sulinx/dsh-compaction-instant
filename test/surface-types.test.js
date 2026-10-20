// Regression guard for the off-surface label: only a type the surface can
// CARRY may be reported as "no longer in the current context". Log-only events
// (tool/call, session/title, agent/inbox/spliced) never had a node.
import assert from "node:assert/strict";
import test from "node:test";
import { SURFACE_EVENT_TYPES } from "../src/indices.js";

test("only message-producing types can occupy a surface node", () => {
  for (const type of ["system/message", "developer/message", "user/message", "assistant/message", "tool/result"]) {
    assert.ok(SURFACE_EVENT_TYPES.has(type), `${type} carries a surface node`);
  }
  for (const type of ["tool/call", "session/title", "session/title-llm-request", "agent/inbox/spliced", "request/header", "step/start", "assistant/attempt"]) {
    assert.ok(!SURFACE_EVENT_TYPES.has(type), `${type} never carries a surface node`);
  }
});

test("the set mirrors the host's surface-eligible list exactly", () => {
  // Pinned deliberately: if the host ever adds a surface-carrying type, the
  // off-surface label must learn about it, so this test fails first.
  assert.deepEqual(
    [...SURFACE_EVENT_TYPES].sort(),
    ["assistant/message", "developer/message", "system/message", "tool/result", "user/message"]
  );
});
