/**
 * A spilled tool result stays recoverable through the compiler.
 *
 * `dsh-spill-policy` (0.2) bounds an over-budget tool result at write time:
 * the persisted content is `head + "\n\n[...]\n\n" + tail` plus a trailing
 * notice naming the file that holds the full formatted result. The tail is the
 * recovery address, so `excerptToolResult` — which anchors its tail to the end
 * of the text — must never cut it away.
 * @module dsh-compaction-instant/test/spill-notice
 */
import assert from "node:assert/strict";
import test from "node:test";
import { compileNodes, countTokens, excerptToolResult, projectToolResultText } from "../src/compiler.js";

const CONFIG = {
  maxTokens: 8192,
  textTokens: 512,
  userTextTokens: 1024,
  toolCallTokens: 128,
  toolResultExcerptTokens: 256,
  includeReasoning: false,
  stripNoiseXml: true,
  noisePatterns: [],
  toolKeyFields: {},
  toolArgTools: ["read"],
  hideTools: []
};

/** One shaped-like-a-real spill: head, gap, tail, then the persisted notice. */
function spilled(headLines, tailLines, locator) {
  const head = Array.from({ length: headLines }, (_v, index) => `head line ${index + 1}`).join("\n");
  const tail = Array.from({ length: tailLines }, (_v, index) => `tail line ${index + 1}`).join("\n");
  const notice = `(120000 bytes omitted. Full formatted result stored at: ${locator}. Use read to view the file.)`;
  return `${head}\n\n[...]\n\n${tail}\n\n${notice}`;
}

const LOCATOR = "C:\\Users\\wangl\\AppData\\Local\\Temp\\spill\\sess\\a1b2c3-bash.txt";

test("excerptToolResult keeps the spill notice and its locator", () => {
  const text = spilled(400, 120, LOCATOR);
  assert.ok(countTokens(text) > 256, "fixture must be over the excerpt budget");
  const kept = excerptToolResult(text, 256, "seq 12 <- original 4");
  assert.match(kept, /Full formatted result stored at:/);
  assert.ok(kept.includes(LOCATOR), "the recoverable path survives the excerpt");
  assert.match(kept, /elided from seq 12 <- original 4/);
});

test("an already-bounded spill passes through untouched", () => {
  const text = "short head\n\n[...]\n\nshort tail\n\n(300 bytes omitted. Full formatted result stored at: C:\\tmp\\s.txt. Use read.)";
  assert.equal(excerptToolResult(text, 256, "seq 3"), text);
});

test("a compiled call row keeps the paired result recoverable", () => {
  const resultText = spilled(200, 60, LOCATOR);
  const nodes = [
    { seq: 11, message: { role: "assistant", content: [{ type: "tool-call", id: "c9", name: "bash", arguments: '{"command":"pnpm test"}' }] } },
    { seq: 12, message: { role: "user", content: [{ type: "tool-result", toolCallId: "c9", content: [{ type: "text", text: resultText }] }] } }
  ];
  const { entries } = compileNodes(nodes, CONFIG);
  const text = entries.map((entry) => entry.text).join("\n");
  // The result never occupies an entry, but its locator is what the agent needs:
  // the pointer plus the notice inside the result the compiler saw.
  assert.match(text, /\(seq 11 -> result 12\)/);
  const projected = projectToolResultText(nodes[1].message.content[0].content);
  assert.ok(projected.includes("Full formatted result stored at:"), "the notice rides inside the result text the recall path returns");
});
