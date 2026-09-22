# reference/ — upstream source snapshots (read-only)

Source snapshots of the **upstream project**, kept in-tree so porting work can be done offline.
**Do not edit anything here**, and do not let the build or package manifest reference these files.

## pi-vcc-v0.8.0/

| item | value |
|---|---|
| upstream repo | `https://github.com/sting8k/pi-vcc` |
| version / tag | `v0.8.0` |
| commit | `303e89dba` |
| published | 2026-09-19 |
| license | **MIT** (see the bundled `LICENSE`) |
| contents | full `src/` (35 `.ts` files) + `CHANGELOG.md` + `README.md` (stored as `upstream-README.md`) + `package.json` (stored as `upstream-package.json`) |

### Why v0.8.0

This fork descends from `TsFreddie/pi-vcc`, which froze at **v0.5.0** (2026-07-26) plus two Pi-specific commits.
Upstream `sting8k/pi-vcc` has since shipped **v0.6.0 / v0.6.1 / v0.7.0 / v0.7.1 / v0.7.2 / v0.7.3 / v0.8.0**
(70 commits in total), and **none of those improvements are in this fork** — that gap is the porting target.

### Files most relevant to porting

| file | lines | purpose |
|---|---|---|
| `src/core/search-entries.ts` | 576 | search/recall core, including the **regex catastrophic-backtracking guard** and the search budget |
| `src/core/jsonl.ts` | 58 | **streaming** reader for large session JSONL |
| `src/core/format-recall.ts` | 101 | recall result formatting / noise filtering |
| `src/core/global-indices.ts` | 82 | **session-global `#N` reference numbering** |
| `src/core/drill-down.ts` | 298 | `#N:path` drill-down and file-activity index |
| `src/core/rank.ts` | 284 | block relevance ranking |
| `src/core/brief.ts` | 408 | brief generation and block selection |
| `src/core/skill-collapse.ts` | 36 | skill-catalog collapsing |
| `src/core/token-estimate.ts` | 101 | token estimation plus **calibration against real usage** |
| `src/hooks/before-compact.ts` | 865 | Pi-side compaction hook (budget tail-cut, skip-custom-types, …); **the most host-coupled file of all** |

### Refreshing this snapshot

```sh
git clone --depth 1 --branch <new-tag> https://github.com/sting8k/pi-vcc /tmp/pi-vcc-upstream
# then copy src/ + CHANGELOG.md + LICENSE (+ README.md, package.json) into reference/pi-vcc-<new-tag>/
# and update the coordinates table above
```

A `pivcc` remote pointing at `https://github.com/sting8k/pi-vcc` is configured in this repository,
so `git fetch pivcc` followed by `git diff pivcc/vX.Y.Z -- <path>` also works for direct comparison.
