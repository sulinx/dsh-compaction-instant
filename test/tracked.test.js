/**
 * `[tracked commands]` ledger — ported from pi-vcc v0.10.2
 * `tests/extract-tracked-commands.test.ts`.
 *
 * The cases below are the upstream ones re-expressed for this engine's shape:
 * pi-vcc scans `{kind:"tool_call", name:"bash"}` blocks, this compiler scans
 * `{name, command}` pairs pulled out of `{role, content}` messages, and the
 * section header is `[tracked commands]` (one synthetic note row) rather than a
 * `[Tracked Commands]` summary section.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMANDS_PER_NAME,
  COMMAND_SEPARATOR,
  COMMAND_TOOL_NAMES,
  extractTrackedCommands,
  findTopLevelInvocations,
  formatTrackedCommands,
  sshRemoteCommand,
  stripOverflowMarker,
  unquotedSeparators
} from "../src/tracked.js";
import { compileNodes } from "../src/compiler.js";

/** Record one command run through one tool. */
const call = (command, name = "pwsh") => ({ name, command });

/** Entries of one command, oldest first. */
const entriesOf = (calls, trackCommands, name) => [...extractTrackedCommands(calls, trackCommands).get(name)];

test("unquotedSeparators ignores separators inside quotes", () => {
  assert.deepEqual(unquotedSeparators("a; b"), [1]);
  assert.deepEqual(unquotedSeparators(`echo "a; b"`), []);
  assert.deepEqual(unquotedSeparators(`echo 'a|b'`), []);
  // A redirection is not a separator.
  assert.deepEqual(unquotedSeparators("cmd 2>&1"), []);
  // A comment's apostrophe does not open a quote.
  assert.deepEqual(unquotedSeparators("ls # don't panic; x"), []);
});

test("findTopLevelInvocations matches only a real invocation", () => {
  assert.deepEqual(findTopLevelInvocations("docker ps", "docker"), [0]);
  assert.deepEqual(findTopLevelInvocations(`echo "a; docker ps"`, "docker"), []);
  // A longer command sharing the prefix is not an invocation.
  assert.deepEqual(findTopLevelInvocations("docker-compose up", "docker"), []);
  assert.deepEqual(findTopLevelInvocations("ssh-keygen -t ed25519", "ssh"), []);
  // After an unquoted separator the segment start is what gets recorded.
  assert.deepEqual(findTopLevelInvocations("cd /tmp && docker ps", "docker"), [10]);
});

test("sudo / env / VAR= prefixes are seen through but kept in the entry", () => {
  assert.deepEqual(entriesOf([call("sudo -u root kubectl get pods")], ["kubectl"], "kubectl"), ["sudo -u root kubectl get pods"]);
  assert.deepEqual(entriesOf([call("FOO=1 docker ps")], ["docker"], "docker"), ["FOO=1 docker ps"]);
  assert.deepEqual(entriesOf([call("env -u X docker ps")], ["docker"], "docker"), ["env -u X docker ps"]);
});

test("an entry stops at the next unquoted separator", () => {
  assert.deepEqual(entriesOf([call("docker ps; docker rm -f x")], ["docker"], "docker"), ["docker ps", "docker rm -f x"]);
  assert.deepEqual(entriesOf([call("docker ps | grep web")], ["docker"], "docker"), ["docker ps"]);
});

test("an ssh remote command is scanned for the other tracked names", () => {
  assert.deepEqual(entriesOf([call("ssh -p 2222 host 'docker ps'")], ["ssh", "docker"], "docker"), ["docker ps"]);
  assert.deepEqual(entriesOf([call(`ssh host "systemctl status nginx"`)], ["ssh", "systemctl"], "systemctl"), ["systemctl status nginx"]);
  // `ssh -T host` (boolean flag) must not consume `host` as -T's value.
  assert.deepEqual(entriesOf([call("ssh -T host 'docker ps'")], ["ssh", "docker"], "docker"), ["docker ps"]);
  // A value-taking flag consumes exactly one token: `-i key-prod` eats the key,
  // so `prod` is the target and only `uptime` is the remote command.
  assert.equal(sshRemoteCommand("-i key-prod prod uptime"), "uptime");
});

test("re-running an invocation moves it to the tail instead of duplicating", () => {
  const calls = [call("docker ps"), call("kubectl get pods"), call("docker ps")];
  assert.deepEqual(entriesOf(calls, ["docker"], "docker"), ["docker ps"]);
  const order = entriesOf(calls, ["docker", "kubectl"], "kubectl");
  assert.deepEqual(order, ["kubectl get pods"]);
});

test("the ledger keeps the newest N invocations and says how many are hidden", () => {
  const calls = Array.from({ length: COMMANDS_PER_NAME + 2 }, (_, index) => call(`docker run image-${index}`));
  const rows = formatTrackedCommands(extractTrackedCommands(calls, ["docker"]));
  assert.match(rows, /^\[tracked commands\]\n- docker: \(\+2 earlier\) docker run image-2/u);
  assert.ok(!rows.includes("image-0"), "the two oldest are dropped");
  assert.ok(rows.includes(`image-${COMMANDS_PER_NAME + 1}`), "the newest survives");
  // The overflow marker must never come back in as an entry.
  assert.equal(stripOverflowMarker("(+2 earlier) a | b"), "a | b");
});

test("a configured command with no invocation contributes no line", () => {
  assert.equal(formatTrackedCommands(extractTrackedCommands([call("ls")], ["docker"])), "");
  assert.equal(formatTrackedCommands(extractTrackedCommands([], [])), "");
});

test("an entry containing the separator is escaped so a re-parse keeps it whole", () => {
  // An unquoted `|` already ends the entry, so the only way one carries the
  // separator is inside quotes (`sqlite3 db "a | b"`) — exactly the case the
  // escape exists for, since a re-parse splits on it.
  const rows = formatTrackedCommands(extractTrackedCommands([call(`docker run sh -c "a | b"`)], ["docker"]));
  assert.match(rows, /docker run sh -c "a \\\| b"/u);
});

test("only shell-ish tools are scanned", () => {
  for (const name of COMMAND_TOOL_NAMES) {
    assert.equal(entriesOf([call("docker ps", name)], ["docker"], "docker").length, 1, `${name} is scanned`);
  }
  assert.equal(entriesOf([call("docker ps", "read")], ["docker"], "docker").length, 0, "a non-shell tool is not scanned");
});

test("long entries are truncated, multi-line ones flattened", () => {
  const rows = formatTrackedCommands(extractTrackedCommands([call(`python3 -c '${"x".repeat(400)}'`)], ["python3"]));
  assert.ok(!rows.includes("\n\n"), "one line per command");
  assert.match(rows, /…/u, "truncated");
});

test("compileNodes emits the ledger only when trackCommands is configured", () => {
  const nodes = [
    { seq: 1, message: { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "pwsh", arguments: JSON.stringify({ command: "docker ps" }) }] } },
    { seq: 2, message: { role: "user", content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "ok" }] }] } }
  ];
  const base = {
    textTokens: 512,
    userTextTokens: 1024,
    toolCallTokens: 128,
    toolResultExcerptTokens: 256,
    maxTokens: 100000,
    skipInjectTypes: []
  };
  const off = compileNodes(nodes, base);
  assert.ok(!off.entries.some((entry) => entry.text.includes("[tracked commands]")), "off by default");
  assert.deepEqual(off.stats.trackedCommandLines, []);

  const on = compileNodes(nodes, { ...base, trackCommands: ["docker"] });
  const row = on.entries.find((entry) => entry.text.includes("[tracked commands]"));
  assert.ok(row !== undefined, "the ledger row is emitted");
  assert.match(row.text, /- docker: docker ps/u);
  assert.equal(row.kind, "note", "a note row, so the first elision pass may drop it");
  assert.deepEqual(on.stats.trackedCommandLines, ["docker=1"]);
  // The tool row itself is unaffected: the ledger is additive.
  assert.ok(on.entries.some((entry) => entry.text.includes(`* pwsh "docker ps"`)), "the call one-liner still renders");
});

test("compileNodes puts the ledger behind the injection-omission marker", () => {
  const nodes = [
    { seq: 1, message: { role: "user", content: [{ type: "text", text: "ctx" }], source: { kind: "runtime-context", name: "snapshot" } } },
    { seq: 2, message: { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "pwsh", arguments: JSON.stringify({ command: "docker ps" }) }] } },
    { seq: 3, message: { role: "user", content: [{ type: "text", text: "real ask" }], source: { kind: "user" } } }
  ];
  const { entries } = compileNodes(nodes, {
    textTokens: 512,
    userTextTokens: 1024,
    toolCallTokens: 128,
    toolResultExcerptTokens: 256,
    maxTokens: 100000,
    skipInjectTypes: ["runtime-context:snapshot"],
    trackCommands: ["docker"]
  });
  assert.match(entries[0].text, /per-turn injection event\(s\) omitted/u, "the span-wide marker leads");
  assert.match(entries[1].text, /\[tracked commands\]/u, "the ledger follows it");
});

test("the separator constant is the one the renderer escapes", () => {
  assert.equal(COMMAND_SEPARATOR, " | ");
});
