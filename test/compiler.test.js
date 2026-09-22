/**
 * Unit tests for the deterministic VCC-style region compiler.
 * @module dsh-compaction-instant/test/compiler
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseSeqSpec } from "../src/recall.js";
import {
  DEFAULT_NOISE_PATTERNS,
  compileNoisePatterns,
  compileNodes,
  compileRegion,
  countTokens,
  estimateDeepSeekTokens,
  estimateEntryTokens,
  excerptToolResult,
  frameCheckpoint,
  isCheckpointSource,
  isCjkChar,
  joinCompiledEntries,
  oneLineArg,
  parseToolArguments,
  pickToolKeyArg,
  projectToolResultText,
  sanitize,
  stripNoiseXml,
  tokenize,
  truncateTokens
} from "../src/compiler.js";

const CONFIG = {
  maxTokens: 8192,
  textTokens: 512,
  userTextTokens: 1024,
  toolCallTokens: 128,
  toolResultExcerptTokens: 256,
  includeReasoning: false,
  stripNoiseXml: true,
  noisePatterns: compileNoisePatterns(DEFAULT_NOISE_PATTERNS),
  toolKeyFields: {},
  toolArgTools: ["read", "write", "edit", "glob", "grep", "bash", "shell", "web_search", "skill", "subagent", "subagent_fork", "ralph", "workflow"],
  hideTools: []
};

test("tokenize splits character classes like VCC", () => {
  assert.deepEqual(tokenize("let x = 42;"), ["let", " ", "x", " ", "=", " ", "42", ";"]);
  assert.equal(countTokens("let x = 42;"), 5);
  assert.equal(countTokens(""), 0);
});

test("sanitize strips ANSI and control bytes", () => {
  assert.equal(sanitize("a\x1b[31mred\x1b[0m\u0007b"), "aredb");
  assert.equal(sanitize("a\r\nb"), "a\nb");
  assert.equal(sanitize(undefined), "");
});

test("truncateTokens keeps original tokens and adds provenance", () => {
  const short = truncateTokens("one two three four five", 3, "seq 7");
  assert.equal(short.text, "one two three...(truncated from seq 7)");
  assert.equal(short.truncated, true);
  const intact = truncateTokens("one two", 3, "seq 7");
  assert.equal(intact.text, "one two");
  assert.equal(intact.truncated, false);
});

test("truncateTokens enforces the character-density ceiling on token runs", () => {
  const blob = "B".repeat(4000);
  const out = truncateTokens(blob, 100, "seq 9");
  assert.ok(out.truncated);
  assert.ok(out.text.length <= 400 + 32); // 100 * 4 chars + note
  assert.match(out.text, /\.\.\.\(truncated from seq 9\)$/);
});

test("stripNoiseXml removes configured wrappers and unwraps command tags", () => {
  const text = "keep me <system-reminder>drop this</system-reminder> tail <command-name>x</command-name><command-args>y</command-args>";
  const stripped = stripNoiseXml(text, CONFIG.noisePatterns);
  assert.equal(stripped, "keep me  tail xy");
});

test("compileNoisePatterns rejects invalid regexes with the index", () => {
  assert.throws(() => compileNoisePatterns(["("]), /noisePatterns\[0\].*not a valid regular expression/);
});

test("pickToolKeyArg prefers the tool-specific field then any string", () => {
  assert.equal(pickToolKeyArg("read", { file_path: "a.js", offset: 1 }, {}), "a.js");
  assert.equal(pickToolKeyArg("unknown", { pattern: "*.ts" }, {}), "*.ts");
  assert.equal(pickToolKeyArg("bash", { command: "ls" }, {}), "ls");
  assert.equal(pickToolKeyArg("empty", { n: 5 }, {}), undefined);
  assert.equal(pickToolKeyArg("empty", null, {}), undefined);
  assert.equal(pickToolKeyArg("read", { file_path: "x" }, { read: "other" }), "x");
});

test("estimateDeepSeekTokens applies the docs weights: 0.3 non-CJK, 0.6 CJK", () => {
  assert.equal(estimateDeepSeekTokens("abc"), 0.9);
  assert.equal(estimateDeepSeekTokens("你好"), 1.2);
  assert.equal(estimateDeepSeekTokens("hi 你好!"), 2.4);
  assert.equal(estimateDeepSeekTokens(""), 0);
  assert.equal(isCjkChar("中"), true);
  assert.equal(isCjkChar("a"), false);
  assert.equal(isCjkChar("、"), true); // CJK punctuation
  assert.equal(isCjkChar("Ａ"), true); // fullwidth form
});

test("oneLineArg collapses multiline arguments to the first line plus a cap marker", () => {
  assert.equal(oneLineArg("ls -la"), "ls -la");
  assert.equal(oneLineArg("grep -n foo bar/baz\n\ncat x\necho y"), "grep -n foo bar/baz [+ 3 lines]");
  assert.equal(oneLineArg("a\r\nb"), "a [+ 1 lines]");
  assert.equal(oneLineArg("\ncommand"), "command [+ 1 lines]");
});

test("parseToolArguments tolerates invalid JSON", () => {
  assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
  assert.equal(parseToolArguments("{oops"), null);
});

test("projectToolResultText joins text and labels media", () => {
  assert.equal(projectToolResultText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]), "a\n[image]\nb");
});

test("excerptToolResult passes small results through and anchors the tail", () => {
  const small = "short result";
  assert.equal(excerptToolResult(small, 100, "seq 2"), small);
  const long = "HEAD_".repeat(500) + "TAIL_MARKER";
  const out = excerptToolResult(long, 100, "seq 2");
  assert.match(out, /^HEAD_/);
  assert.match(out, /TAIL_MARKER$/);
  assert.match(out, /\.\.\.\(elided from seq 2\)/);
});

test("isCheckpointSource recognizes the seam marker", () => {
  assert.equal(isCheckpointSource({ kind: "plugin", plugin: "compact" }), true);
  assert.equal(isCheckpointSource({ kind: "user" }), false);
  assert.equal(isCheckpointSource(undefined), false);
});

test("compileNodes collapses a tool step and elides reasoning", () => {
  const nodes = [
    { seq: 1, message: { role: "user", content: [{ type: "text", text: "fix the bug" }], source: { kind: "user" } } },
    { seq: 2, message: { role: "assistant", content: [
      { type: "reasoning", text: "think think" },
      { type: "text", text: "on it" },
      { type: "tool-call", id: "c1", name: "read", arguments: '{"file_path":"a.js"}' }
    ] } },
    { seq: 3, message: { role: "user", content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "file contents" }] }] } }
  ];
  const { entries, stats } = compileNodes(nodes, CONFIG);
  assert.equal(stats.toolCalls, 1);
  assert.equal(stats.toolResults, 1);
  assert.equal(stats.reasoningElided, 1);
  const text = entries.map((entry) => entry.text).join("\n");
  assert.match(text, /\[user\]\nfix the bug/);
  assert.match(text, /\[assistant\]\non it/);
  // One line per tool call, with the result pointer; the result itself is gone.
  assert.match(text, /\* read "a\.js" \(seq 2 -> result 3\)/);
  assert.doesNotMatch(text, /-> read: ok/);
  assert.doesNotMatch(text, /file contents/);
});

test("compileNodes renders multiline bash arguments as first line plus line count", () => {
  const nodes = [
    { seq: 1, message: { role: "assistant", content: [
      { type: "tool-call", id: "c1", name: "bash", arguments: '{"command":"grep -n foo src/index.js\\n\\ncat README.md\\necho done"}' }
    ], source: { provider: "p", model: "m" } } },
    { seq: 2, message: { role: "user", content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "ok" }] }] } }
  ];
  const { entries } = compileNodes(nodes, CONFIG);
  const text = entries.map((entry) => entry.text).join("\n");
  assert.match(text, /\* bash "grep -n foo src\/index\.js \[\+\s*3 lines\]" \(seq 1 -> result 2\)/);
  assert.doesNotMatch(text, /cat README\.md/);
  assert.doesNotMatch(text, /echo done/);
});

test("compileNodes renders name-only rows for non-whitelisted tools", () => {
  const nodes = [
    { seq: 1, message: { role: "user", content: [{ type: "text", text: "cleanup" }], source: { kind: "user" } } },
    { seq: 2, message: { role: "assistant", content: [
      { type: "tool-call", id: "j1", name: "job_kill", arguments: '{"job_id":"job-9","reason":"done"}' }
    ], source: { provider: "p", model: "m" } } },
    { seq: 3, message: { role: "user", content: [{ type: "tool-result", toolCallId: "j1", content: [{ type: "text", text: "killed" }] }] } }
  ];
  const { entries, stats } = compileNodes(nodes, CONFIG);
  assert.equal(stats.toolCalls, 1);
  const text = entries.map((entry) => entry.text).join("\n");
  assert.match(text, /\* job_kill \(seq 2 -> result 3\)/);
  assert.doesNotMatch(text, /job-9/);
  assert.doesNotMatch(text, /killed/);
});

test("compileNodes drops hideTools rows entirely", () => {
  const nodes = [
    { seq: 1, message: { role: "user", content: [{ type: "text", text: "cleanup" }], source: { kind: "user" } } },
    { seq: 2, message: { role: "assistant", content: [
      { type: "tool-call", id: "j1", name: "job_kill", arguments: '{"job_id":"job-9"}' }
    ], source: { provider: "p", model: "m" } } }
  ];
  const { entries, stats } = compileNodes(nodes, { ...CONFIG, hideTools: ["job_kill"] });
  assert.equal(stats.toolCalls, 1);
  assert.equal(entries.length, 1);
  assert.doesNotMatch(entries[0].text, /job_kill/);
});

test("compileNodes treats an empty whitelist as unset and renders args", () => {
  // The cordis config pipeline injects `[]` for absent array keys; an empty
  // whitelist must fall back to the defaults, not render every tool name-only.
  const nodes = [
    { seq: 1, message: { role: "assistant", content: [
      { type: "tool-call", id: "c1", name: "read", arguments: '{"file_path":"a.js"}' }
    ], source: { provider: "p", model: "m" } } }
  ];
  const { entries } = compileNodes(nodes, { ...CONFIG, toolArgTools: [] });
  assert.match(entries[0].text, /\* read "a\.js"/);
});

test("compileNodes emits per-tool diagnostics when debug is on", () => {
  const nodes = [
    { seq: 1, message: { role: "user", content: [{ type: "text", text: "go" }], source: { kind: "user" } } },
    { seq: 2, message: { role: "assistant", content: [
      { type: "tool-call", id: "c1", name: "read", arguments: '{"file_path":"a.js"}' }
    ], source: { provider: "p", model: "m" } } }
  ];
  const lines = [];
  const { entries } = compileNodes(nodes, { ...CONFIG, debug: true, debugSink: (line) => lines.push(line) });
  assert.ok(lines.some((line) => line.includes("rev=") && line.includes("nodes=2")), "compile banner logged");
  assert.ok(lines.some((line) => line.includes("name=read") && line.includes("whitelist=yes") && line.includes("argsType=string") && line.includes("arg=")), "tool diagnostics logged");
  assert.match(entries.map((entry) => entry.text).join("\n"), /\* read "a\.js"/);
  const off = [];
  compileNodes(nodes, { ...CONFIG, debug: false, debugSink: (line) => off.push(line) });
  assert.equal(off.length, 0, "no diagnostics when debug is off");
});

test("compileNodes strips noise and marks noise-only user messages", () => {
  const nodes = [
    { seq: 1, message: { role: "user", content: [{ type: "text", text: "<system-reminder>only noise</system-reminder>" }], source: { kind: "user" } } },
    { seq: 2, message: { role: "user", content: [{ type: "text", text: "real question" }], source: { kind: "user" } } }
  ];
  const { entries, stats } = compileNodes(nodes, CONFIG);
  assert.equal(stats.noiseElided, 1);
  assert.match(entries[0].text, /user message elided: noise-only/);
  assert.match(entries[1].text, /real question/);
});

test("compileNodes copies prior checkpoints verbatim", () => {
  const nodes = [
    { seq: 1, message: { role: "user", content: [{ type: "text", text: "prior checkpoint body" }], source: { kind: "plugin", plugin: "compact", compactionId: "x" } } },
    { seq: 2, message: { role: "user", content: [{ type: "text", text: "new work" }], source: { kind: "user" } } }
  ];
  const { entries, stats } = compileNodes(nodes, CONFIG);
  assert.equal(stats.checkpoints, 1);
  // The durable node is a user/message, but the checkpoint is harness-generated
  // framing — it displays as [system], not [user].
  assert.match(entries[0].text, /^\[system\]\nprior checkpoint body/);
  assert.match(entries[1].text, /^\[user\]\nnew work/);
});

test("compileNodes labels images and documents", () => {
  const nodes = [
    { seq: 1, message: { role: "user", content: [{ type: "image", attachment: { id: "i1" } }], source: { kind: "user" } } },
    { seq: 2, message: { role: "assistant", content: [{ type: "document", attachment: { id: "d1" } }] } }
  ];
  const { stats } = compileNodes(nodes, CONFIG);
  assert.equal(stats.images, 1);
  assert.equal(stats.documents, 1);
});

test("compileNodes keeps reasoning when configured", () => {
  const nodes = [{ seq: 1, message: { role: "assistant", content: [{ type: "reasoning", text: "chain of thought" }] } }];
  const { stats } = compileNodes(nodes, { ...CONFIG, includeReasoning: true });
  assert.equal(stats.reasoningElided, 0);
});

test("compileRegion rescales budgets and front-elides under the cap", () => {
  const nodes = [];
  for (let seq = 1; seq <= 20; seq += 1) {
    nodes.push({ seq, message: { role: "user", content: [{ type: "text", text: `payload ${seq} ${"word ".repeat(80)}` }], source: { kind: "user" } } });
  }
  const { entries, stats, capped } = compileRegion(nodes, { ...CONFIG, maxTokens: 2000 });
  assert.ok(stats.tokens <= 2000 + 64, `tokens ${stats.tokens} within cap`);
  assert.ok(capped, "cap enforcement ran");
  assert.match(entries[0].text, /earlier entries elided/);
  // The newest node always survives.
  const last = entries[entries.length - 1];
  assert.match(last.text, /payload 20/);
});

test("compileRegion elides tool rows before conversation text", () => {
  const nodes = [];
  for (let seq = 1; seq <= 8; seq += 1) {
    nodes.push({ seq: seq * 2 - 1, message: { role: "user", content: [{ type: "text", text: `question ${seq}` }], source: { kind: "user" } } });
    nodes.push({
      seq: seq * 2,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: `answer ${seq} ${"word ".repeat(200)}` },
          // Distinct paths: identical rows are collapsed by the ranking pass
          // before the cap is ever consulted (see the repeat-collapse test).
          { type: "tool-call", id: `c${seq}`, name: "read", arguments: `{"file_path":"a${seq}.js"}` }
        ],
        source: { provider: "p", model: "m" }
      }
    });
    nodes.push({
      seq: seq * 2 + 1,
      message: { role: "user", content: [{ type: "tool-result", toolCallId: `c${seq}`, content: [{ type: "text", text: `${"data ".repeat(200)} end ${seq}` }] }] }
    });
  }
  // The cap is derived from the uncapped total so that removing HALF of the
  // tool rows' tokens satisfies it: only low-value rows may be elided, and the
  // conversation text is rescaled but never removed.
  const uncapped = compileRegion(nodes, { ...CONFIG, maxTokens: 1_000_000 });
  const toolTokens = uncapped.entries
    .filter((entry) => entry.kind === "tool")
    .reduce((total, entry) => total + estimateEntryTokens(entry.text), 0);
  const { entries, stats, capped } = compileRegion(nodes, { ...CONFIG, maxTokens: uncapped.stats.tokens - Math.ceil(toolTokens * 0.6) });
  assert.ok(capped, "cap enforcement ran");
  assert.ok(stats.elidedToolRows > 0, "low-value rows were elided first");
  assert.equal(stats.elidedRows, 0, "no conversation text was elided");
  const text = entries.map((entry) => entry.text).join("\n");
  assert.match(text, /tool\/result entries elided/);
  // Every conversation text survives elision.
  for (let seq = 1; seq <= 8; seq += 1) {
    assert.match(text, new RegExp(`question ${seq}`), `user text ${seq} survives`);
    assert.match(text, new RegExp(`answer ${seq}`), `assistant text ${seq} survives`);
  }
});

test("compileRegion collapses repeated identical tool rows", () => {
  // Eight identical `read a.js` calls: one durable fact, eight rows. The
  // ranking pass keeps the first and last occurrence and replaces the middle
  // with one marker whose seq range `recall` can restore in full.
  const nodes = [];
  for (let seq = 1; seq <= 8; seq += 1) {
    nodes.push({ seq: seq * 2 - 1, message: { role: "user", content: [{ type: "text", text: `question ${seq}` }], source: { kind: "user" } } });
    nodes.push({
      seq: seq * 2,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: `answer ${seq}` },
          { type: "tool-call", id: `c${seq}`, name: "read", arguments: '{"file_path":"a.js"}' }
        ],
        source: { provider: "p", model: "m" }
      }
    });
    nodes.push({ seq: seq * 2 + 1, message: { role: "user", content: [{ type: "tool-result", toolCallId: `c${seq}`, content: [{ type: "text", text: "body" }] }] } });
  }
  const { entries, stats } = compileRegion(nodes, { ...CONFIG });
  assert.equal(stats.collapsedRows, 6, "the middle six repeats collapsed");
  const toolRows = entries.filter((entry) => entry.kind === "tool");
  assert.equal(toolRows.length, 2, "first and last occurrence survive");
  const marker = entries.find((entry) => /repeated read row\(s\) elided/.test(entry.text));
  assert.notEqual(marker, undefined, "one marker names the collapsed span");
  assert.equal(marker.kind, "note", "the marker is a droppable note row");
});

test("compileRegion drops the lowest-value low-value row, not the oldest", () => {
  // One old high-value row (an edit) and six newer scaffolding commands. The
  // cap forces several elisions; ranking must spend them on the scaffolding and
  // keep the edit, which oldest-first elision would have sacrificed first.
  const filler = "word ".repeat(200);
  const nodes = [
    { seq: 1, message: { role: "user", content: [{ type: "text", text: `q1 ${filler}` }], source: { kind: "user" } } },
    { seq: 2, message: { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "edit", arguments: '{"file_path":"src/a.js"}' }], source: { provider: "p", model: "m" } } },
    { seq: 3, message: { role: "user", content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "ok" }] }] } },
    { seq: 4, message: { role: "user", content: [{ type: "text", text: `q2 ${filler}` }], source: { kind: "user" } } }
  ];
  for (let i = 1; i <= 6; i += 1) {
    const seq = 10 + i * 2;
    nodes.push({ seq, message: { role: "assistant", content: [{ type: "tool-call", id: `p${i}`, name: "pwsh", arguments: `{"command":"cd K:\\\\dshwork\\\\_tmp\\\\branch${i}"}` }], source: { provider: "p", model: "m" } } });
    nodes.push({ seq: seq + 1, message: { role: "user", content: [{ type: "tool-result", toolCallId: `p${i}`, content: [{ type: "text", text: "ok" }] }] } });
  }
  nodes.push({ seq: 99, message: { role: "assistant", content: [{ type: "text", text: `a2 ${filler}` }], source: { provider: "p", model: "m" } } });
  const uncapped = compileRegion(nodes, { ...CONFIG, maxTokens: 1_000_000 });
  // Price the scaffolding rows from the uncapped run and demand about half of
  // them back: enough to force elision, not enough to exhaust them.
  const scaffoldingTokens = uncapped.entries
    .filter((entry) => entry.kind === "tool" && entry.seq >= 12)
    .reduce((total, entry) => total + estimateEntryTokens(entry.text), 0);
  const cap = uncapped.stats.tokens - Math.floor(scaffoldingTokens * 0.5);
  const { entries, stats, capped } = compileRegion(nodes, { ...CONFIG, maxTokens: cap });
  assert.ok(capped, "cap enforcement ran");
  assert.ok(stats.elidedToolRows >= 1, "low-value rows paid for the cap");
  assert.equal(entries.some((entry) => entry.seq === 2), true, "the older high-value edit survived");
  const scaffoldingLeft = entries.filter((entry) => entry.kind === "tool" && entry.seq >= 12).length;
  assert.ok(scaffoldingLeft < 6, "some scaffolding rows were elided");
  // The marker's own range is a paste-able pointer: elision happens in value
  // order, so it must be reported min-max rather than in drop order.
  const marker = /\[(\d+) tool\/result entries elided: (seqs? [\d-]+)\]/.exec(entries.map((entry) => entry.text).join("\n"));
  assert.notEqual(marker, null, "the elision marker is present");
  assert.equal(parseSeqSpec(marker[2]).errors.length, 0, `marker range "${marker[2]}" parses back`);
});

test("compileRegion keeps a text floor when budgets collapse", () => {
  const nodes = [];
  for (let seq = 1; seq <= 6; seq += 1) {
    nodes.push({ seq, message: { role: "user", content: [{ type: "text", text: `payload ${seq} ${"word ".repeat(200)}` }], source: { kind: "user" } } });
  }
  // A tiny cap forces heavy rescaling; text entries must keep their 32-token
  // floor (~128 chars) instead of collapsing to 8-token slivers.
  const { entries, capped } = compileRegion(nodes, { ...CONFIG, maxTokens: 150 });
  assert.ok(capped, "cap enforcement ran");
  const textEntries = entries.filter((entry) => /payload/.test(entry.text));
  assert.ok(textEntries.length > 0, "text entries survive");
  for (const entry of textEntries) {
    assert.ok(entry.text.length >= 96, `text entry keeps the floor (${entry.text.length} chars)`);
  }
});

test("frameCheckpoint wraps entries with the durable tags and the recall guide", () => {
  const blocks = frameCheckpoint(["a", "b"], "## header");
  assert.equal(blocks.length, 3);
  assert.match(blocks[0].text, /<compacted-checkpoint>$/);
  assert.equal(blocks[2].text, "</compacted-checkpoint>");
  // The recall guide heads the block, before the header line and entries.
  assert.match(blocks[1].text, /^RECALL: /);
  assert.match(blocks[1].text, /recall/);
  assert.match(blocks[1].text, /search/);
  assert.match(blocks[1].text, /## header\n\na\n\nb$/);
});

test("compileRegion leaves a [checkpoint N] line when a prior checkpoint is elided", () => {
  const nodes = [
    { seq: 1, message: { role: "user", content: [{ type: "text", text: `prior checkpoint ${"word ".repeat(2000)}` }], source: { kind: "plugin", plugin: "compact", compactionId: "x" } } },
    { seq: 2, message: { role: "user", content: [{ type: "text", text: "new question" }], source: { kind: "user" } } },
    { seq: 3, message: { role: "assistant", content: [{ type: "text", text: `new answer ${"word ".repeat(60)}` }], source: { provider: "p", model: "m" } } }
  ];
  const withOrdinals = compileRegion(nodes, { ...CONFIG, maxTokens: 60, checkpointOrdinals: new Map([[1, 1]]) });
  assert.ok(withOrdinals.capped, "cap enforcement ran");
  assert.ok(withOrdinals.stats.elidedRows >= 1, "oldest entries were elided");
  assert.match(withOrdinals.entries[0].text, /\[checkpoint 1\]/);
  assert.match(withOrdinals.entries[0].text, /earlier entries elided/);
  // Without the session-wide ordinal map the seq pointer is used instead.
  const without = compileRegion(nodes, { ...CONFIG, maxTokens: 60 });
  assert.match(without.entries[0].text, /\[checkpoint @ seq 1\]/);
  // The dropped checkpoint is never silently gone: the marker names it.
  assert.doesNotMatch(withOrdinals.entries[0].text, /prior checkpoint word/);
});

test("joinCompiledEntries keeps tool runs compact and separates groups", () => {
  const entries = [
    { seq: 1, text: "[user]\nquestion", kind: "text" },
    { seq: 2, text: "* read \"a.js\" (seq 2 -> result 3)", kind: "tool" },
    { seq: 2, text: "* write \"b.js\" (seq 2 -> result 4)", kind: "tool" },
    { seq: 5, text: "* bash (seq 5 -> result 6)", kind: "tool" },
    { seq: 7, text: "[assistant]\ndone", kind: "text" }
  ];
  assert.equal(
    joinCompiledEntries(entries),
    "[user]\nquestion\n\n* read \"a.js\" (seq 2 -> result 3)\n* write \"b.js\" (seq 2 -> result 4)\n* bash (seq 5 -> result 6)\n\n[assistant]\ndone"
  );
  // Strings behave like text entries.
  assert.equal(joinCompiledEntries(["guide", "header", "a", "b"]), "guide\n\nheader\n\na\n\nb");
  assert.equal(joinCompiledEntries([]), "");
});
