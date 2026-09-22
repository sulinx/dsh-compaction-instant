# PATCHES.md — host-generation patches carried by this fork

This fork = upstream [`TsFreddie/dsh-compaction-instant@f688029`](https://github.com/TsFreddie/dsh-compaction-instant)
**plus 6 host-compatibility patches** (**no algorithm changes**).
Upstream was archived on 2026-09-02, so these fixes are maintained here.

| # | file | dsh generation | change | why it is required |
|---|---|---|---|---|
| 1 | `src/index.js` | 0.1.3 | add `const sessionEvents = (s) => (Array.isArray(s.events) ? s.events : s.snapshotEvents ? s.snapshotEvents() : []);` and route every former `session.events` read through it | `dsh-session` removed `Session.events` in 0.1.3 and kept only `snapshotEvents()`; without this the engine cannot read the event stream at all |
| 2 | `src/recall.js` | 0.1.3 | same as #1 | same |
| 3 | `src/search.js` | 0.1.3 | same as #1 | same |
| 4 | `src/region.js` | 0.1.3 + 0.1.5 | ① `sessionEvents` fallback; ② **surface-head protection**: a compaction replace may not shadow surface node 0 — when that node is a `system/message` it is skipped (`headSkip = 1`); ③ replace surface-op keys **`start`/`end` → `startSeq`/`endSeq`** | ① same as #1; ② the host's `assertSystemHeadRewrite` rejects rewrites that shadow the system head, so skipping it is mandatory; ③ 0.1.5 renamed the replace-op fields, and the old keys make the write-back fail validation |
| 5 | `src/client.js` | 0.1.2 | `require("@deepseek-ai/dsh-client-runtime/client")` → `require("@deepseek-ai/dsh-client-store")` | since 0.1.2 `createSnapshotStore` ships in `dsh-client-store`; the old specifier no longer exports it |
| 6 | `package.json` | 0.1.2 | `dsh.client.inject`: `@deepseek-ai/dsh-client-runtime` → `@deepseek-ai/dsh-client-store` | companion to #5 |

## Audit fingerprints (sha256, first 16 hex chars, uppercase)

| file | sha16 (with patches applied) |
|---|---|
| `src/region.js` | `6F843C543DA9166A` (was `338120A611CDA547` before the boundary guard below) |
| `src/index.js` | `8CFD5BC32D2E256C` (was `1BF8DD6EEA9EA1F8` before the P2 injection filter below) |
| `src/recall.js` | `41696141C6052B9E` (was `149567516934D9F4` before the P1 port below) |
| `src/search.js` | `83CAC25D83CA7A34` (was `47433C94C4A10DEC` after P0, `8223DABA1FCE557F` before it) |
| `src/format.js` | `8F3B416165CC24EE` (new in P1) |
| `src/compiler.js` | `C5E9669636AEB400` (was `BA162C0052F61CA7` mid-P2, `D93AF625DFAAADAB` after P1, `C3055E3BE84A80E8` before it) |
| `src/tool.js` | `D660C4338F1A9C9C` (was `172F89B496041B4C` after P0) |
| `src/command.js` | `7177D4ABE27DF971` (was `F07169D9940A776B` after P0) |
| `src/client.js` | `4AD3ACBAA3202950` (was `4A662939016E1B0A` before the P2 settings toggle) |

These fingerprints are the reference for any deployment that tracks this fork: a deployed copy must match them,
and any intentional change here must update the tracking manifest in the same commit.

## Ported upstream improvements (algorithm/robustness, not host compatibility)

| batch | upstream source (`reference/pi-vcc-v0.8.0/src/...`) | what was ported | files touched |
|---|---|---|---|
| **P0 · ReDoS guard** | `core/search-entries.ts` (`quantifierAt`, `hasNestedQuantifier`, `startBudget`, `SEARCH_BUDGET_MS`) | A search pattern that applies an unbounded quantifier to a group that already contains one (`(a+)+`, `(\w*)*`, `(a{2,})+`) is now matched **literally** instead of compiled — same query, no exponential backtracking. A wall-clock budget (default 3000 ms, `searchBudgetMs`) is checked between events and every 512 scanned lines and aborts the search with `SearchBudgetExceededError` for shapes the structural guard cannot see (`(a|a)+`). Both guards only touch the `search` / `/recall` read path; the compiler never matches caller-supplied regexes. | `src/search.js`, `src/tool.js`, `src/command.js`, `types/search.d.ts`, `types/tool.d.ts`, `types/command.d.ts` |
| **P1 · big sessions + honest result sets** | `core/search-entries.ts` (mode detection, stopwords, BM25-lite, `BM25_RELATIVE_FLOOR`, `SEARCH_RESULT_CAP`, `capHits`, `lineSnippet`, `getTouchedFiles`, self-match exclusion), `core/format-recall.ts` (`shortPath`, `TOUCHED_PAGE_SIZE`, `formatTouchedOutput`), `core/jsonl.ts` (chunked line scanning — the *property*, see below) | ① **Ranked multi-term search**: a multi-word query is scored with BM25-lite over the whole corpus and rendered as ranked hits with a numbered context window; a metacharacter query that finds nothing but contains whitespace falls through to the ranked path. ② **Noise floor + cap with honest accounting**: hits below 20% of the top score are dropped for queries with ≥2 *distinct* effective terms, and `totalMatches` / `floorDropped` / `omitted` / `truncated` report everything withheld. ③ **Self-match exclusion**: `/recall` output, the `recall`/`search`/`touched_files` tool arguments and their results are never indexed, so a repeated query cannot grow its own hit list. ④ **Streaming body scan**: `forEachLine` (indexOf) replaces `body.split("\n")` and the ranked pass keeps per-event term counts instead of document text, so a 15 MB session searches in ~100–220 ms with <1 MB of transient allocation. ⑤ **`touched_files`** tool + `/recall files [page]`: every file the session read/wrote/edited, aggregated by path with seq pointers, 5 per page, paths shortened by `shortPath`. | `src/search.js`, `src/format.js` (new), `src/tool.js`, `src/command.js`, `src/recall.js`, `src/compiler.js` (RECALL guide), `package.json` (`./format` export), `types/*.d.ts` |

| **P2a · skip per-turn injections** | `core/settings.ts` + `hooks/before-compact.ts` (`skipCustomTypes`, refs #23) | Upstream drops user-declared `customType` entries from the **summarizer input** only, because some extensions inject per-turn boilerplate that is regenerated every request. Here the same rule is keyed on the DSH message source: `injectKeyOf(source)` builds `<kind>:<name>` (`runtime-context:snapshot`, `plugin:@deepseek-ai/dsh-system-prompt`, `skill-catalog:catalog`, `plugin:compact`, `compact-checkpoint:-`, `user:-`), and `skipInjectTypes` (default: the runtime-context/memory snapshot + the skill catalog, in both host spellings) is filtered out of the compiled view. Upstream's invariant is preserved: **only the compiled view is filtered** — region selection, token pricing, `firstKeptEntryId`-equivalent boundaries and kept-turn counts are untouched. Dropped nodes leave one consolidated `note` marker (`[N per-turn injection event(s) omitted: … (~T tokens)]`) so nothing is silently missing; being a `note`, the cap-elision pass drops it first. `skipPerTurnInjections: false` disables the filter; an empty `skipInjectTypes` means *unset* and falls back to the defaults (the same cordis `[]` rule as `hideTools`). Checkpoints are never skipped. | `src/compiler.js`, `src/index.js`, `src/client.js`, `types/compiler.d.ts`, `types/index.d.ts`, `test/skip-inject.test.js` (new) |

**Why the two source families are defaults (measured on real sessions)**: compiling the same
compaction span with the filter off and on — 27 nodes: 8240 → 1042 tokens (87.4% saved), 23 nodes:
6926 → 761 (89.0%), 13 nodes: 6455 → 290 (95.5%), 12 nodes: 3285 → 219 (93.3%). Across three sessions
the worst span was **98.0%** boilerplate. Whole-session sizing: a 15.5 MB session carried **77
runtime-context snapshots (~71 KB each) and 78 skill-catalog snapshots (~16.6 KB each) = 6.8 MB**, and
all 74 of its checkpoints contained some. Both are re-sent verbatim with every request and every copy
remains in the append-only log, so `recall` / `search` still restore them exactly.

**Host-generation vocabulary (both spellings are accepted)**: the isolated 0.1.7 end-to-end run showed
the host renamed the injected sources, so the defaults list both generations and
`isCheckpointSource` matches both:

| meaning | dsh ≤ 0.1.6 | dsh 0.1.7 |
|---|---|---|
| runtime-context / memory snapshot | `plugin:@deepseek-ai/dsh-system-prompt` | `runtime-context:snapshot` (`{kind:"runtime-context", form:"snapshot", sections:[…]}`) |
| skill catalog | `skill-catalog:catalog` | `skill-catalog:catalog` (unchanged) |
| landed checkpoint | `plugin:compact` | `compact-checkpoint` (`{kind:"compact-checkpoint", compactionId}`) |

The checkpoint rename was a **latent 0.1.7 defect this verification surfaced**: with only the old
spelling recognized, a prior checkpoint compiled as an ordinary user turn — truncated to
`userTextTokens` instead of kept whole, rendered under `[user]` instead of `[system]`, demoted to a
low-value row for cap elision, and invisible to `checkpointOrdinals`, so the `[checkpoint N]`
recovery markers were never emitted. `isCheckpointSource` now accepts both shapes.

**Deliberately not ported from P1**: upstream's `TOOL_ARGS_BUDGET` head cap on indexed tool-call
arguments. Truncating the indexed text silently loses matches and this engine's contract is that
nothing is lost; the streaming scanner bounds memory without dropping a match. Upstream's
`core/jsonl.ts` file reader also has no call site here — the host hands the engine a live event log,
never a file — so what is ported is the property it exists for (bounded materialization), not the
file-level API.

## Local correctness fix: region-selection boundary (found during P1 verification)

`selectCompactableRange` (`src/region.js`) sets the keep-boundary to `turns.length` when the **newest
surface node alone exceeds `retainTokens`** — which is what a large `/recall` output looks like once it
has been appended as one durable user message. The tool-pairing guard below then read
`surfaceNodes[keepFromIdx]`, one index past the end, and passed `undefined` to the host's
`toolPairingBalancedBefore`: `/compact` failed with `gateway/internal: tool-pairing balance: surface
seq undefined not found`. Reproduced with the pre-P1 sources on the same session, so this is latent,
not a regression from the P1 port.

The guard now treats an out-of-range boundary as "not balanced yet" and recedes, which retains the
oversized newest node instead of failing the whole compaction. The branch can only be reached where
the old code threw, so no currently-working selection changes; `test/region-boundary.test.js` pins all
three cases (oversized newest node, longer surface, normal selection).

## Host-compatibility adaptation for dsh 0.1.7 (patch #7)

dsh 0.1.7 **rewrote `@deepseek-ai/dsh-settings`**: the namespace seam this engine used
(`ctx.settings.register(namespace, schema, { base, validate })`) is gone, replaced by Config-derived
forms (`SettingsForms`: `describe`/`update`/`replace`/`mutate`, addressed by **profile entry id**, with
fields exposed by marking them `.volatile()` in the plugin's own Config schema — schemastery gained
`volatile()` in 3.18.3). `src/index.js` now:

1. guards the legacy seam (`typeof settings.register === "function"`) so a 0.1.7 host cannot throw inside
   the inject callback, and keeps reading the composition entry as its config source there; and
2. marks exactly the legacy `SETTINGS_SCHEMA` surface (`checkpointCap`, `auto`, `thresholdRatio`,
   `retainTurns`, `retainTokens`) volatile through a feature-detected helper, so on 0.1.7 those fields
   project into a settings form if the row is mounted at the profile top level.

Verified against a real 0.1.7-alpha.1 harness (`iso017` profile, isolated `DSH_HOME`): boot clean,
`/compact` and `/recall "(a+)+$"` both work, and `Config.toJSON()` marks exactly those five fields.
No other imported host API changed (see `_updates/20260922-p0-search-redos/api-diff-016-vs-017.mjs`).



## Rules when porting upstream changes

1. **Do not drop the 6 patches above** — they are what keeps this engine runnable on current dsh hosts, not optional extras.
2. **Upstream is TypeScript, this repo is plain JavaScript** — strip type annotations and replace
   `@earendil-works/pi-ai` types with the host's event/surface structures.
3. **Verify against an isolated profile first**, then roll out to a production profile.
