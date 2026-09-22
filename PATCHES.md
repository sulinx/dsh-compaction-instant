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
| `src/region.js` | `338120A611CDA547` |
| `src/index.js` | `A1978BD0D4297557` |
| `src/recall.js` | `149567516934D9F4` |
| `src/search.js` | `47433C94C4A10DEC` (was `8223DABA1FCE557F` before the P0 port below) |
| `src/client.js` | `4A662939016E1B0A` |

These fingerprints are the reference for any deployment that tracks this fork: a deployed copy must match them,
and any intentional change here must update the tracking manifest in the same commit.

## Ported upstream improvements (algorithm/robustness, not host compatibility)

| batch | upstream source (`reference/pi-vcc-v0.8.0/src/...`) | what was ported | files touched |
|---|---|---|---|
| **P0 · ReDoS guard** | `core/search-entries.ts` (`quantifierAt`, `hasNestedQuantifier`, `startBudget`, `SEARCH_BUDGET_MS`) | A search pattern that applies an unbounded quantifier to a group that already contains one (`(a+)+`, `(\w*)*`, `(a{2,})+`) is now matched **literally** instead of compiled — same query, no exponential backtracking. A wall-clock budget (default 3000 ms, `searchBudgetMs`) is checked between events and every 512 scanned lines and aborts the search with `SearchBudgetExceededError` for shapes the structural guard cannot see (`(a|a)+`). Both guards only touch the `search` / `/recall` read path; the compiler never matches caller-supplied regexes. | `src/search.js`, `src/tool.js`, `src/command.js`, `types/search.d.ts`, `types/tool.d.ts`, `types/command.d.ts` |


## Rules when porting upstream changes

1. **Do not drop the 6 patches above** — they are what keeps this engine runnable on current dsh hosts, not optional extras.
2. **Upstream is TypeScript, this repo is plain JavaScript** — strip type annotations and replace
   `@earendil-works/pi-ai` types with the host's event/surface structures.
3. **Verify against an isolated profile first**, then roll out to a production profile.
