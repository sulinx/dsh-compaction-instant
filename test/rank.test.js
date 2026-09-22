/**
 * Ranking and repeat collapsing (`src/rank.js`) — the DSH port of upstream
 * pi-vcc `core/rank.ts`. The value model has to survive contact with this
 * host's tool catalog, where the shell tool is `pwsh` and scaffolding commands
 * (`cd`, `Set-Location`, `Get-ChildItem`) are as common as real edits.
 * @module dsh-compaction-instant/test/rank
 */
import assert from "node:assert/strict";
import test from "node:test";
import { classifyCommand, collapseRepeatedRows, DEFAULT_RANK_WEIGHTS, lowestValueIndex, MIN_REPEAT_RUN, rankKeyOf, rankScore } from "../src/rank.js";

test("classifyCommand recognizes tests, workflow commands, and scaffolding", () => {
  for (const command of ["npm test", "pnpm run lint", "node --test test/api.test.js", "cargo test --all", "py -3 -m pytest -q", "python -m pytest -q"]) {
    assert.equal(classifyCommand(command), "test", command);
  }
  for (const command of ["git push origin main", "git commit -m x", "gh pr view 17", "git worktree add /tmp/wt", "gh release create v1"]) {
    assert.equal(classifyCommand(command), "workflow", command);
  }
  for (const command of ["cd /tmp", "ls", "ls -la", "echo hi", "sleep 2", "pwd", "export A=1", "Set-Location K:\\x", "Get-ChildItem -Recurse", "Write-Host ok", "Start-Sleep 3"]) {
    assert.equal(classifyCommand(command), "trivial", command);
  }
  for (const command of ["node scripts/build.mjs", "npm run build", "tsc --noEmit"]) {
    assert.equal(classifyCommand(command), "test", command);
  }
  // ...except a command that neither runs the verification loop nor changes state.
  for (const command of ["curl -s https://example.com", "python analysis.py", "node scripts/report.mjs"]) {
    assert.equal(classifyCommand(command), "other", command);
  }
  assert.equal(classifyCommand(""), "other");
  assert.equal(classifyCommand(undefined), "other");
});

test("rankScore orders the value model: edits > tests > other tools > reads > scaffolding", () => {
  const at = (name, argText, kind = "tool") => rankScore({ kind, text: `* ${name} "${argText}"`, toolName: name, argText, index: 5, total: 10 }).score;
  const edit = at("edit", "src/a.js");
  const write = at("write", "src/b.js");
  const test1 = at("pwsh", "npm test");
  const other = at("pwsh", "curl -s https://example.com");
  const readTool = at("read", "src/c.js");
  const trivial = at("pwsh", "cd /tmp");
  const workflow = at("pwsh", "git push origin main");
  assert.ok(edit > test1, "an edit outranks a test run");
  assert.ok(write > other, "a write outranks an ordinary command");
  assert.ok(test1 > other, "a test run outranks an ordinary command");
  assert.ok(other > readTool, "an ordinary command outranks a read");
  assert.ok(readTool > trivial, "a read outranks scaffolding");
  assert.ok(workflow > other, "a workflow command gets its boost");
  // Recency is part of the score.
  const early = rankScore({ kind: "tool", toolName: "pwsh", argText: "node x.mjs", index: 0, total: 10 });
  const late = rankScore({ kind: "tool", toolName: "pwsh", argText: "node x.mjs", index: 9, total: 10 });
  assert.ok(late.score > early.score, "newer rows score higher");
  // Repeats are charged; user text outranks assistant text of the same length.
  const repeated = rankScore({ kind: "tool", toolName: "read", argText: "a.js", repeats: 4 });
  const once = rankScore({ kind: "tool", toolName: "read", argText: "a.js", repeats: 1 });
  assert.ok(once.score > repeated.score, "a repeat is worth less");
  assert.equal(rankScore({ kind: "text", role: "user" }).score > rankScore({ kind: "text", role: "assistant" }).score, true);
});

test("rankKeyOf groups only rows that carry the same durable fact", () => {
  assert.equal(rankKeyOf({ kind: "tool", toolName: "read", argText: "a.js" }), "tool:read:a.js");
  assert.equal(rankKeyOf({ kind: "tool", toolName: "read", argText: "a.js\n" }), "tool:read:a.js");
  assert.equal(rankKeyOf({ kind: "tool", toolName: "pwsh", argText: "git   status" }), "tool:pwsh:git status");
  assert.equal(rankKeyOf({ kind: "tool", toolName: "pwsh" }), "tool:pwsh");
  assert.equal(rankKeyOf({ kind: "text", text: "hello" }), undefined);
  assert.equal(rankKeyOf({ kind: "note" }), undefined);
});

test("lowestValueIndex drops the least valuable row and never the newest", () => {
  const entries = [
    { seq: 1, kind: "tool", text: "edit", score: 40 },
    { seq: 2, kind: "tool", text: "cd", score: -4 },
    { seq: 3, kind: "tool", text: "poll", score: 2, rankKey: "tool:job_output:j1" },
    { seq: 4, kind: "text", text: "conversation", score: 30 }
  ];
  const lowValue = (entry) => entry.kind === "tool";
  assert.equal(lowestValueIndex(entries, lowValue), 1, "the scaffolding command leaves first");
  // The last entry is never a candidate even when it is low-value and lowest.
  const tail = [
    { seq: 1, kind: "tool", text: "edit", score: 40 },
    { seq: 2, kind: "tool", text: "cd", score: -99 }
  ];
  assert.equal(lowestValueIndex(tail, lowValue), 0);
  assert.equal(lowestValueIndex([{ seq: 1, kind: "text", score: 1 }], lowValue), -1);
});

test("collapseRepeatedRows keeps the first and last occurrence and marks the span", () => {
  const rows = (count, seqOf) => Array.from({ length: count }, (_, i) => ({ seq: seqOf(i), kind: "tool", text: `* read "a.js" (seq ${seqOf(i)})`, rankKey: "tool:read:a.js" }));
  const kept = collapseRepeatedRows(rows(5, (i) => i * 2 + 10));
  assert.equal(kept.collapsed, true);
  assert.equal(kept.collapsedRows, 3, "the middle three collapse");
  assert.equal(kept.entries.length, 3, "first, marker, last");
  assert.equal(kept.entries[0].seq, 10);
  assert.equal(kept.entries[2].seq, 18);
  assert.match(kept.entries[1].text, /\[3 repeated read row\(s\) elided: seqs 12-16\]/);
  assert.equal(kept.entries[1].kind, "note", "the marker is droppable first");
  // Below the run threshold nothing collapses.
  const short = collapseRepeatedRows(rows(MIN_REPEAT_RUN - 1, (i) => i));
  assert.equal(short.collapsed, false);
  assert.equal(short.entries.length, MIN_REPEAT_RUN - 1);
  // Rows without an identity are never collapsed.
  const untagged = collapseRepeatedRows(Array.from({ length: 5 }, (_, i) => ({ seq: i, kind: "text", text: "same text" })));
  assert.equal(untagged.collapsed, false);
});

test("note rows are the cheapest kind and long rows are penalized", () => {
  const note = rankScore({ kind: "note", text: "marker", index: 9, total: 10 });
  assert.equal(note.score, DEFAULT_RANK_WEIGHTS.recencyMax + DEFAULT_RANK_WEIGHTS.noteRow);
  const long = rankScore({ kind: "text", role: "assistant", text: "x".repeat(DEFAULT_RANK_WEIGHTS.longRowChars + 1), index: 0, total: 1 });
  assert.ok(long.reasons.includes("long-row"));
  assert.ok(long.score < rankScore({ kind: "text", role: "assistant", text: "short", index: 0, total: 1 }).score);
});
