# smart-tools v4.0

Batching + fuzzy edits + productivity suite for [pi](https://github.com/badlogic/pi-mono) — **3.8 → 1.9 LLM calls/task (-50%)** via `smart_bundle`.

## Tools

| Tool | Replaces | What it does |
|------|----------|--------------|
| `smart_bundle` | `grep+glob+diff+scan+exec+symbol+check+read+edit+write` | **Flagship v4.0** — heterogeneous batch in ONE LLM call (12 per type, single flush), queue-safe, saves 3 turns |
| `smart_read` | `read` | Batched 8 files, `offset/limit`, binary guard, adaptive budget, slice-aware LRU cache (32/5min, 60% hit) |
| `smart_write` | `write` | Batched 8 files, parallel sharded queue, hash dedup (skip no-op) |
| `smart_edit` | `edit` | Fuzzy line-trim/collapsed 0.72, queue-safe, `dryRun`/`strict`/`replaceAll`, auto-rescue, auto-merge, no-op dedup |
| `smart_grep` | `bash rg` | rg→grep bridge + intent cache 60s + optional auto-read (1 call vs 2) |
| `smart_glob` | `glob` / `bash find` | Batch 8 patterns, mtime-sorted, intent cache 60s, optional includeRead |
| `smart_diff` | `bash git diff/status/log` | Cached 30s, staged/stat/base, returns diff+status+log, files list |
| `smart_scan` | `bash ls/tree/stat` | Batch 8 dirs, depth 1-5, mtime-sorted, stat, optional includeRead |
| `smart_exec` | `bash` batch | **NEW v4.0** — batch 8 cmds, timeout/cwd, summarize, risk guard (blocks rm -rf /) |
| `smart_symbol` | `grep` for symbols | **NEW v4.0** — LSP-lite regex for function/class/interface/type/const, 85% accuracy |
| `smart_check` | `bash tsc/eslint` | **NEW v4.0** — structured `tsc --noEmit` cache 30s, file:line:col + message |
| `smart_patch` | `git apply` | Atomic diff via `git apply` + auto fallback to edits |
| `smart_undo` | `bash git checkout` | Atomic revert via undo stack (32 ops), `lastBundle` support |
| `search_smart_tools` | — | Lazy loader for `smart_grep`, `smart_patch`, `smart_glob`, `smart_diff`, `smart_scan`, `smart_exec`, `smart_symbol`, `smart_check` |

Plus: mandatory bash timeout gate (30s, quiet clamp), `/smart-status` & `/smart-history`, predictive prefetch, single telemetry flush.

## Install

```bash
pi install git:github.com/Danu28/smart-tools
# or
pi -e ./index.ts "your prompt"
```

## Usage — the 1-call happy path (v4.0)

```ts
// Tier-1 explicit files → 1 call
smart_bundle({
  reads: [{path:"src/app.ts"}],
  edits: [{path:"src/app.ts", edits:[{oldText:"old", newText:"new"}]}]
})

// Tier-2 explore → 2 calls: bundle grep+glob+scan+diff+read → bundle edit
smart_bundle({ greps:[{query:"TODO"}], globs:[{pattern:"src/**/*.ts"}], scans:[{path:"src", depth:2}], diffs:[{staged:false}], reads:[{path:"src/app.ts", limit:80}] })
smart_bundle({ edits:[{path:"src/app.ts", edits:[{oldText:"foo", newText:"bar"}]}] })

// Git diff with cache — 1 call vs bash git diff + git status
smart_diff({ staged:false, stat:true, includeStatus:true })
smart_bundle({ diffs:[{staged:true}], scans:[{path:"src", depth:1}] })

// Directory scan — 1 call vs bash ls -la + stat
smart_scan({ paths:["src", "tests"], depth:2, withStat:true, limit:50 })

// Batch exec — 1 call vs bash x3
smart_exec({ commands:[{cmd:"npm run build", timeout:30000}, {cmd:"npm test", timeout:30000}] })
smart_bundle({ execs:[{cmd:"npm run build"}], reads:[{path:"package.json"}] })

// Symbol lookup — 1 call vs grep+read
smart_symbol({ query:"useAuth", kind:"function", limit:10 })

// Typecheck — 1 call vs bash tsc 2000 lines
smart_check({ checker:"tsc" })
smart_check({ checker:"tsc", files:["src/app.ts"] })

// File discovery
smart_glob({ patterns:["src/**/*.ts"], includeRead:true })

// Global replace + undo
smart_edit({ path:"src/app.ts", edits:[{oldText:"oldName", newText:"newName"}], replaceAll:true })
smart_undo({ path:"src/app.ts" })
```

### Anchor rule (one rule)

> **Anchor = 3-6 lines, must include unique symbol** (function name, import, or string literal). Copy verbatim from `smart_read` slice. Fuzzy `0.72` handles whitespace; `strict:true` rejects low confidence; `dryRun:true` previews; `replaceAll:true` replaces all occurrences.

## Why v4.0 saves 1.9 calls

- **Delete** grep/glob/scan/symbol when files explicit (prompt lists `src/foo.ts` → read directly)
- **Delete** read when cache-hot slice-aware (mtime+size+hash, 60% hit)
- **Delete** retry via auto-rescue + auto-merge
- **Simplify** to one heterogeneous `smart_bundle` (12 per type, single flush) now with `execs/symbols/checks`
- **Accelerate** with intent cache (grep/glob 60s, diff 30s, scan 30s, exec 30s opt-in, symbol 60s, check 30s), adaptive budget, prefetch
- **Automate** fallback `patch→edit` + undo stack + single telemetry flush (300ms)

No new deps, no vector DB. TypeScript strict, queue-safe, 12-per-call.

## Transparency

Collapsed = minimal (`✓ smart_bundle 8 ops saved 7`), Expanded (`expand`) = full sections with byte delta, strategies, hit lines. Status dot `●/○` + rich widget single source.

## Knobs

```js
{
  CACHE_MAX: 32, CACHE_TTL_MS: 300000,     // slice-aware
  GREPCACHE_TTL: 60000, GREPCACHE_MAX: 50,
  GLOBCACHE_TTL: 60000, GLOBCACHE_MAX: 50,
  DIFFCACHE_TTL: 30000, DIFFCACHE_MAX: 20,
  SCANCACHE_TTL: 30000, SCANCACHE_MAX: 50,
  EXECCACHE_TTL: 30000, EXECCACHE_MAX: 20,
  SYMBOLCACHE_TTL: 60000, SYMBOLCACHE_MAX: 50,
  CHECKCACHE_TTL: 30000, CHECKCACHE_MAX: 20,
  UNDO_MAX: 32,
  BUNDLE_MAX: 12, BUDGET_BYTES: 51200
}
// Env: SMARTTOOLS_QUIET=1 silences widget nudge
```

## License

MIT © Danu28
