/**
 * P1 tests: the ranked (multi-term) search path, the noise floor and hard cap
 * with honest accounting, the self-match exclusions, the streaming line scan,
 * and the files-touched view — all ported from upstream `pi-vcc` v0.8.0
 * (`core/search-entries.ts`, `core/format-recall.ts`, `core/jsonl.ts`).
 * @module dsh-compaction-instant/test/search-noise
 */
import assert from "node:assert/strict";
import test from "node:test";
import { defineRecallCommand, resolveConfig as resolveCommandConfig } from "../src/command.js";
import { formatTouchedOutput, shortPath, TOUCHED_PAGE_SIZE } from "../src/format.js";
import {
  BM25_RELATIVE_FLOOR,
  collectTouchedFiles,
  DEFAULT_FILE_TOOLS,
  DEFAULT_MAX_SEARCH_HITS,
  filterStopwords,
  forEachLine,
  lineSnippet,
  looksLikeRegex,
  queryMode,
  searchSession
} from "../src/search.js";
import { defineTouchedTool, resolveConfig as resolveToolConfig } from "../src/tool.js";

const SEARCH_CONFIG = { maxRecallTokens: 16000, maxSearchHits: 50 };

const text = (value) => ({ type: "text", text: value });
const toolCall = (name, args, id = "call-1") => ({ type: "tool-call", id, name, arguments: args });
const message = (role, content) => ({ role, content });

/**
 * Minimal session-shaped value: each spec carries the event envelope (for the
 * self-match exclusions, which read `data`) and the derived message search
 * projects.
 */
function makeSession(specs) {
  return {
    events: specs.map((spec, seq) => ({ seq, type: spec.type, data: spec.data ?? {} })),
    deriveEventMessage: (event) => specs[event.seq]?.message ?? null
  };
}

/** Session whose `append` records what a command wrote back. */
function appendableSession(specs) {
  const session = makeSession(specs);
  Object.assign(session, {
    appended: [],
    append(type, appendedMessage, options) {
      const seq = session.events.length + session.appended.length;
      session.appended.push({ seq, type, message: appendedMessage, options });
      return { seq };
    }
  });
  return session;
}

// ── streaming line scan (the `core/jsonl.ts` property) ─────────────────────

test("forEachLine reproduces split('\\n') exactly while streaming", () => {
  const collect = (value) => {
    const lines = [];
    const visited = forEachLine(value, (line, number) => {
      lines.push([number, line]);
    });
    return { lines, visited };
  };
  for (const value of ["", "a", "a\nb", "a\nb\n", "\n\n", "tail\n", "line\r\nnext"]) {
    const { lines, visited } = collect(value);
    const expected = value.split("\n");
    assert.deepEqual(lines.map(([, line]) => line), expected, JSON.stringify(value));
    assert.deepEqual(lines.map(([number]) => number), expected.map((_, index) => index + 1));
    assert.equal(visited, expected.length);
  }
});

test("forEachLine stops when the visitor returns false", () => {
  const seen = [];
  forEachLine("1\n2\n3\n4", (line) => {
    seen.push(line);
    return seen.length < 2;
  });
  assert.deepEqual(seen, ["1", "2"]);
});

// ── query mode ─────────────────────────────────────────────────────────────

test("single words and metacharacter queries scan as one pattern", () => {
  assert.equal(looksLikeRegex("counter"), false);
  assert.equal(queryMode("counter"), "regex");
  assert.equal(queryMode("  counter  "), "regex");
  assert.equal(queryMode("a+b"), "regex");
  assert.equal(queryMode("what happened?"), "regex", "whitespace only reaches the ranked path after a zero-hit regex scan");
  assert.equal(queryMode("counter overflow"), "terms");
  assert.equal(queryMode("赛里木湖 自驾"), "terms");
});

test("filterStopwords keeps the query when every term is a stopword", () => {
  assert.deepEqual(filterStopwords(["what", "is", "the"]), ["what", "is", "the"]);
  assert.deepEqual(filterStopwords(["what", "is", "the", "counter"]), ["counter"]);
  assert.deepEqual(filterStopwords(["a", "bb"]), ["bb"]);
});

// ── ranked multi-term search ───────────────────────────────────────────────

test("a multi-word query ranks by BM25 and renders a context snippet", () => {
  const session = makeSession([
    { type: "user/message", data: {}, message: message("user", [text("alpha only, mentioned once")]) },
    {
      type: "assistant/message",
      data: {},
      message: message("assistant", [text([
        "filler line 1",
        "filler line 2",
        "filler line 3",
        "the alpha and beta subsystem",
        "beta again and alpha again",
        "filler line 4",
        "filler line 5"
      ].join("\n"))])
    },
    { type: "user/message", data: {}, message: message("user", [text("beta only, mentioned once")]) }
  ]);
  const result = searchSession(session, "alpha beta", SEARCH_CONFIG);
  assert.equal(result.mode, "terms");
  assert.equal(result.totalMatches, 3);
  assert.equal(result.hits[0].seq, 1, "the event with both terms ranks first");
  assert.match(result.text, /\(ranked multi-term search\)/);
  assert.match(result.text, /score=/);
  assert.match(result.text, /  4: the alpha and beta subsystem/);
  assert.match(result.text, /1 lines above/);
  assert.match(result.text, /1 lines below/);
});

test("the relative floor drops the OR-tail for multi-term queries and reports it", () => {
  const session = makeSession([
    { type: "assistant/message", data: {}, message: message("assistant", [text("alpha beta alpha beta alpha beta alpha beta")]) },
    { type: "assistant/message", data: {}, message: message("assistant", [text("alpha gamma delta epsilon zeta eta theta iota kappa lambda")]) }
  ]);
  const result = searchSession(session, "alpha beta", SEARCH_CONFIG);
  assert.equal(result.totalMatches, 2);
  assert.equal(result.floorDropped, 1);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].seq, 0);
  assert.match(result.text, /1 low-relevance match\(es\) hidden/);
  // The floor is tunable for benches (upstream's `SearchTuning`); 0 keeps everything.
  const unfiltered = searchSession(session, "alpha beta", { ...SEARCH_CONFIG, relativeFloor: 0 });
  assert.equal(unfiltered.floorDropped, 0);
  assert.equal(unfiltered.hits.length, 2);
});

test("the floor is gated on distinct terms, so one repeated word still returns everything", () => {
  const session = makeSession([
    { type: "assistant/message", data: {}, message: message("assistant", [text("alpha alpha alpha alpha alpha")]) },
    { type: "assistant/message", data: {}, message: message("assistant", [text("alpha")]) }
  ]);
  const result = searchSession(session, "alpha alpha", SEARCH_CONFIG);
  assert.equal(result.mode, "terms");
  assert.equal(result.floorDropped, 0);
  assert.equal(result.hits.length, 2);
});

test("a prose query that matches nothing verbatim falls through to the ranked path", () => {
  const session = makeSession([
    { type: "assistant/message", data: {}, message: message("assistant", [text("the counter overflows when the turn index resets")]) }
  ]);
  const verbatim = searchSession(session, "why does the counter overflow?", SEARCH_CONFIG);
  assert.equal(verbatim.mode, "terms");
  assert.equal(verbatim.totalMatches, 1);
  // The same query with no whitespace stays on the regex path and answers honestly.
  const single = searchSession(session, "counter-overflow?", SEARCH_CONFIG);
  assert.equal(single.mode, "regex");
  assert.equal(single.totalMatches, 0);
});

test("the ranked path still honors the wall-clock budget", () => {
  const specs = Array.from({ length: 200 }, (_, index) => ({
    type: "assistant/message",
    data: {},
    message: message("assistant", [text(Array.from({ length: 200 }, () => "alpha beta gamma").join(" "))])
  }));
  assert.throws(
    () => searchSession(makeSession(specs), "alpha beta", { ...SEARCH_CONFIG, searchBudgetMs: -1 }),
    /search budget/
  );
});

// ── honest cap accounting ──────────────────────────────────────────────────

test("the hard cap reports the true match count instead of understating it", () => {
  const specs = Array.from({ length: 12 }, (_, index) => ({
    type: "assistant/message",
    data: {},
    message: message("assistant", [text(`needle payload ${index}`)])
  }));
  const result = searchSession(makeSession(specs), "needle", { maxRecallTokens: 16000, maxSearchHits: 3 });
  assert.equal(result.totalMatches, 12);
  assert.equal(result.hits.length, 3);
  assert.equal(result.omitted, 9);
  assert.equal(result.truncated, true);
  assert.match(result.text, /3 of 12 matching event\(s\) shown/);
  assert.match(result.text, /\[9 more matching event\(s\) omitted/);
  assert.equal(DEFAULT_MAX_SEARCH_HITS, 50);
});

test("only the lines that will be rendered are kept for a very broad pattern", () => {
  const body = Array.from({ length: 5000 }, (_, index) => `line ${index} needle`).join("\n");
  const result = searchSession(makeSession([{ type: "assistant/message", data: {}, message: message("assistant", [text(body)]) }]), "needle", SEARCH_CONFIG);
  assert.equal(result.totalMatches, 1);
  // 10 shown lines + an honest "more" count, without a 5000-entry line array.
  assert.match(result.text, /\.\.\.\(4990 more matching lines in this event\)/);
  assert.equal((result.text.match(/needle/g) ?? []).length, 11, "10 rendered lines + the header/footer mention");
});

// ── self-match exclusions ──────────────────────────────────────────────────

test("a search never matches its own invocation or its own earlier output", () => {
  const specs = [
    { type: "user/message", data: { source: { kind: "user" } }, message: message("user", [text("please investigate the timeout")]) },
    {
      type: "user/message",
      data: { source: { kind: "plugin", plugin: "recall", form: "recall" } },
      message: message("user", [text('[search "timeout": 1 matching event(s)]')])
    },
    { type: "command/run", data: { name: "recall", args: " timeout" } },
    { type: "assistant/message", data: {}, message: message("assistant", [toolCall("search", '{"pattern":"timeout"}')]) },
    { type: "tool/call", data: { name: "search", callId: "call-1", arguments: '{"pattern":"timeout"}' } },
    {
      type: "tool/result",
      data: { message: { source: { kind: "tool", callId: "call-1" }, content: [{ type: "tool-result", toolCallId: "call-1" }] } },
      message: message("user", [{ type: "tool-result", toolCallId: "call-1", content: [text('Found 1 matching event(s) for "timeout"')] }])
    }
  ];
  const result = searchSession(makeSession(specs), "timeout", SEARCH_CONFIG);
  assert.equal(result.totalMatches, 1, "only the genuine user message counts");
  assert.equal(result.hits[0].seq, 0);
});

test("an unrelated tool result is still indexed", () => {
  const specs = [
    { type: "tool/call", data: { name: "read", callId: "call-9", arguments: '{"file_path":"a.js"}' } },
    {
      type: "tool/result",
      data: { message: { source: { kind: "tool", callId: "call-9" }, content: [{ type: "tool-result", toolCallId: "call-9" }] } },
      message: message("user", [{ type: "tool-result", toolCallId: "call-9", content: [text("the timeout constant lives here")] }])
    }
  ];
  const result = searchSession(makeSession(specs), "timeout", SEARCH_CONFIG);
  assert.equal(result.totalMatches, 1);
  assert.equal(result.hits[0].kind, "user");
});

// ── line snippets ──────────────────────────────────────────────────────────

test("lineSnippet windows the first match and counts the omitted lines", () => {
  const body = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
  const snippet = lineSnippet(body, /line 5\b/u, 2);
  assert.deepEqual(snippet.lines.map((entry) => entry.line), [3, 4, 5, 6, 7]);
  assert.equal(snippet.omittedAbove, 2);
  assert.equal(snippet.omittedBelow, 3);
  assert.equal(lineSnippet(body, /nope/u), null);
  // A match on the first line has nothing above it.
  const first = lineSnippet(body, /line 1\b/u, 2);
  assert.equal(first.omittedAbove, 0);
  assert.deepEqual(first.lines.map((entry) => entry.line), [1, 2, 3]);
});

// ── files-touched view (upstream `format-recall.ts`) ────────────────────────

function fileSpecs() {
  return [
    {
      type: "assistant/message",
      data: {},
      message: message("assistant", [
        toolCall("read", '{"file_path":"K:/proj/src/a.js"}', "c1"),
        toolCall("edit", '{"file_path":"K:/proj/src/b.js","old_string":"x","new_string":"y"}', "c2"),
        toolCall("write", '{"file_path":"K:/proj/src/a.js","content":"z"}', "c3"),
        toolCall("bash", '{"command":"ls -la"}', "c4"),
        toolCall("glob", '{"pattern":"**/*.js"}', "c5"),
        // Unknown tool with a content-bearing argument: shape-based acceptance.
        toolCall("apply_patch", '{"path":"K:/proj/src/c.js","content":"p"}', "c6")
      ])
    },
    { type: "assistant/message", data: {}, message: message("assistant", [toolCall("read", '{"file_path":"K:/proj/src/b.js"}', "c7")]) }
  ];
}

test("collectTouchedFiles aggregates by path and ignores non-file tools", () => {
  const result = collectTouchedFiles(makeSession(fileSpecs()), {});
  assert.equal(result.total, 3);
  assert.deepEqual(result.touched.map((file) => file.path), ["K:/proj/src/a.js", "K:/proj/src/b.js", "K:/proj/src/c.js"]);
  assert.deepEqual(result.touched[0].entries, [{ seq: 0, toolName: "read" }, { seq: 0, toolName: "write" }]);
  assert.deepEqual(result.touched[1].entries, [{ seq: 0, toolName: "edit" }, { seq: 1, toolName: "read" }]);
  assert.deepEqual(result.shownSeqs, [0, 0, 0, 1, 0]);
  assert.deepEqual([...DEFAULT_FILE_TOOLS], ["read", "write", "edit"]);
});

test("the files view paginates and shortens paths", () => {
  const touched = Array.from({ length: 7 }, (_, index) => ({
    path: `K:/proj/src/f${index}.js`,
    entries: [{ seq: index, toolName: "edit" }]
  }));
  const page1 = formatTouchedOutput(touched, 1, TOUCHED_PAGE_SIZE, "K:/proj");
  assert.match(page1, /Page 1\/2 \(7 total files\)/);
  assert.match(page1, /\.\/src\/f0\.js {4}#0 \(edit\)/);
  assert.match(page1, /--- Use page:2 for more results ---/);
  const page2 = formatTouchedOutput(touched, 2, TOUCHED_PAGE_SIZE, "K:/proj");
  assert.match(page2, /\.\/src\/f6\.js/);
  assert.doesNotMatch(page2, /Use page/);
  assert.equal(formatTouchedOutput([], 1, TOUCHED_PAGE_SIZE, "K:/proj"), "No file operations found in session history.");
});

test("shortPath relativizes inside cwd and trims long outside paths", () => {
  assert.equal(shortPath("K:\\proj\\src\\a.js", "K:/proj"), "./src/a.js");
  assert.equal(shortPath("/home/me/deep/nested/path/file.js"), ".../nested/path/file.js");
  assert.equal(shortPath("a/b.js"), "a/b.js");
  assert.equal(shortPath(""), "");
});

test("the touched_files tool returns a page and validates it", async () => {
  const tool = defineTouchedTool(resolveToolConfig({}));
  assert.equal(tool.name, "touched_files");
  const value = await tool.execute({}, { agent: { session: makeSession(fileSpecs()) } });
  assert.equal(value.total, 3);
  assert.equal(value.page, 1);
  assert.equal(value.totalPages, 1);
  assert.match(value.text, /3 files touched/);
  await assert.rejects(() => tool.execute({ page: 0 }, { agent: { session: makeSession(fileSpecs()) } }), /page/);
  await assert.rejects(() => tool.execute({}, {}), /calling agent/);
});

// ── /recall files, and the growth loop it closes ───────────────────────────

test("/recall files appends the page and records the seqs behind it", async () => {
  const session = appendableSession(fileSpecs());
  const command = defineRecallCommand(resolveCommandConfig({}));
  const result = await command.handler({
    agent: { session, runMaintenance: (task) => task(new AbortController().signal) },
    rawInput: "files",
    signal: new AbortController().signal,
    commandId: "cmd-files"
  });
  assert.equal(result.kind, "success");
  assert.match(result.text, /Found 3 file\(s\) touched/);
  assert.equal(session.appended.length, 1);
  assert.equal(session.appended[0].type, "user/message");
  assert.match(session.appended[0].message.content[0].text, /\.\/src\/a\.js|a\.js/);
  assert.deepEqual(session.appended[0].options.sourceEventSeqs, [0, 0, 0, 1, 0]);
  // 0.1.7 (v4 producers) attributes a plugin message as `plugin:<name>`; the
  // released v3 shape was `{ kind: "plugin", plugin: <name> }`. Either way the
  // appended page must be attributed to this plugin, which is exactly what the
  // self-source filter keys on.
  const source = session.appended[0].message.source;
  assert.equal(source.kind === "plugin" ? source.plugin : source.kind.slice("plugin:".length), "recall");
});

test("/recall files reports an empty session instead of appending", async () => {
  const session = appendableSession([{ type: "user/message", data: {}, message: message("user", [text("hi")]) }]);
  const command = defineRecallCommand(resolveCommandConfig({}));
  const result = await command.handler({
    agent: { session, runMaintenance: (task) => task(new AbortController().signal) },
    rawInput: "--files 2",
    signal: new AbortController().signal,
    commandId: "cmd-files-2"
  });
  assert.equal(result.kind, "error");
  assert.match(result.text, /No file operations/);
  assert.equal(session.appended.length, 0);
});

test("repeating a search does not grow its own hit list", async () => {
  const specs = [{ type: "user/message", data: { source: { kind: "user" } }, message: message("user", [text("the counter overflows")]) }];
  const session = appendableSession(specs);
  const command = defineRecallCommand(resolveCommandConfig({}));
  const agent = { session, runMaintenance: (task) => task(new AbortController().signal) };
  const invocation = (id) => ({
    agent,
    rawInput: "counter",
    signal: new AbortController().signal,
    commandId: id
  });
  const first = await command.handler(invocation("cmd-1"));
  assert.equal(first.kind, "success");
  assert.match(first.text, /Found 1 matching event\(s\)/);
  // The host persists the appended output; a second run must not match it.
  const appended = session.appended[0];
  session.events.push({ seq: appended.seq, type: appended.type, data: appended.message });
  specs.push({
    type: appended.type,
    data: appended.message,
    message: { role: "user", content: appended.message.content }
  });
  const second = await command.handler(invocation("cmd-2"));
  assert.equal(second.kind, "success");
  assert.match(second.text, /Found 1 matching event\(s\)/, "the previous recall output is not a hit");
  assert.equal(BM25_RELATIVE_FLOOR, 0.2);
});
