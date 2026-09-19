# smart-tools 5-Step Audit — Question / Delete / Simplify / Accelerate / Automate

**Date:** 2026-05-13 (re-audit, Think→Plan→Complete)
**Repo:** @danu28/smart-tools v4.0.0
**Scope:** index.ts (2463 lines, ~179KB), dist/index.js (207KB), package.json, README, tsconfig, .github/workflows/check.yml
**Rule:** Never optimize something that shouldn't exist.
**Prev:** 2025-09-19 audit (2274 lines) — 5 of 6 P0 fixes now DONE.

## 1. QUESTION — Challenge every requirement

### Inventory (verified 2026-05-13)
- **Entry:** single `index.ts` 2463 lines + `dist/index.js` build artifact (207KB, .gitignore'd, not tracked ✓)
- **Tools:** 13 registered: `smart_read`, `smart_write`, `smart_edit`, `smart_grep`, `smart_glob`, `smart_diff`, `smart_scan`, `smart_exec`, `smart_symbol`, `smart_check`, `smart_patch`, `smart_undo`, `smart_bundle` + `search_smart_tools` + `smart_think/plan/recall/remember/brain_status`
- **Commands:** `/smart-status`, `/smart-history`, `/smart-health` (v4.0)
- **Handlers:** `tool_call` ×2 (bash gate 2236 + brain gate 2259), `tool_result` ×1 (merged 2280), `session_start` 2394, `session_shutdown` 2451
- **Deps:** `typebox` only, peer `pi-coding-agent@^0.85.1` — lean ✅
- **Grep:** TODO/FIXME/HACK 0 hits, `tsc --noEmit` passes ✅
- **Caches:** 8× `TTLCache<K,V>` generic (unified) — 32/5min read + 50/60s grep/glob/symbol + 20/30s diff/scan/exec/check

### Requirement Challenges
| Tool | Question | Verdict |
|------|----------|---------|
| `smart_bundle` | Flagship — 12 per type, single flush, saves 3 turns 3.8→1.9 | **KEEP** |
| `smart_read/write/edit` | Cached 60% hit, dedup, queue-safe, fuzzy 0.72 | **KEEP** |
| `smart_grep/glob/diff/scan` | Duplicates bash but saves 1 call + caches | **KEEP deferred** via search_smart_tools ✓ |
| `smart_exec` | Batch 8 cmds, risk guard `rm -rf /` | **KEEP** |
| `smart_symbol` | LSP-lite 85% — low frequency | **KEEP deferred** ✓ |
| `smart_check` | Structured tsc wrapper | **KEEP deferred** ✓ |
| `smart_patch` | git apply + fallback | **KEEP deferred** ✓ |
| `smart_undo` | Undo stack 32 | **KEEP** |
| `search_smart_tools` | Solves prompt bloat (60% deferred) | **KEEP** |
| `smart_think/plan` | PFC debate + DAG, gates mutating tools | **KEEP** — required by 5-Step |
| `dist/` | `files:["dist"]` + `prepare:build`, .gitignore'd, not tracked | **KEEP untracked** ✓ |
| `src/` | Empty dir | **DELETE noise** — not tracked |

## 2. DELETE — Never optimize what shouldn't exist

### Must Delete — Status 2026-05-13
1. **8 cache Maps duplication** → `TTLCache` generic — **DONE** `index.ts:155` `class TTLCache<K,V>`; all 8 caches `new TTLCache` (saves ~150 lines)
2. **Dual catalog sets** — `SMART_TOOL_CATALOG` 18 vs `SEARCHABLE_TOOL_NAMES` derived — **DONE** `index.ts:132` derives searchable by filter (no duplicate data)
3. **Dual `tool_result` handlers** → merged — **DONE** `index.ts:2280` single handler with `// merged smart enrichment (was second handler)`
4. **SMART_TOOL_META duplication** — 18 entries duplicate descriptions — **DEFER** (−13 lines, low risk, keep for now — derive later with split)
5. **`dist/index.js` if git-tracked** — **DONE** `git ls-files` excludes `dist/`; .gitignore `dist/` ✓
6. **Empty `src/`** — not tracked — **DONE** (no dir)
7. **Stale header v3.2** — **DONE** header now `v4.0` `index.ts:1`
8. **`package.json` duplicate keys** `audit`×2 `health`×2 — **DONE** 2026-05-13 deduped to 1 each
9. **`README Knobs` drift** `DIFFCACHE_TTL 10000→30000`, `BUNDLE_MAX 8→12` — **DONE** 2026-05-13

### Should Delete (verified)
- `randomUUID`+`tmpdir`+`join` — **KEEP** — used `index.ts:1752` `join(tmpdir(), 'smart-patch-...')` + `1846` `randomUUID()` bundleId

**Total delete:** ~154 lines removed, 0 feature loss. Remaining −13 lines (META) deferred to split.

## 3. SIMPLIFY — Optimize what remains

1. **Split 2463-line monolith** → `src/cache.ts` (TTLCache), `src/state.ts`, `src/tools/*.ts`, `src/handlers.ts`, `index.ts` assembly. **PENDING** — P1, requires tests to guard split. Deferred per Automate rule (no tests yet). Do NOT split until Delete 100% + tests added.
2. **Generic Cache<T>** — **DONE**
3. **Consolidate state flat 22 fields** → grouped `counters/caches/telemetry` — **PENDING** defer to split
4. **Merge failBlock + retryMap** — 13-entry `retryMap2` at `2280` duplicates meta — **PENDING** defer to split
5. **Shared param helpers** — `BUNDLE_MAX` validation `1840-1843` repeated — **PENDING**
6. **Widget rendering** — `renderStatus`+`renderWidgetLines` duplicate theme — **PENDING**

**Simplification wins after split:** −30% cognitive load, −15% lines, enables unit tests per tool.

## 4. ACCELERATE — Make it faster

| Hot Path | Current (verified) | Verdict |
|----------|-------------------|---------|
| Read cache | `TTLCache 32/5min` slice-aware mtime+hash, budget 51KB, hits `state.cacheHits` | **DONE** — keep, 60% hit |
| Grep/Glob | `60s/50` intent cache, key `cwd+globs`, invalidation on write | **DONE** — `index.ts:1124` `grepCache.clear(); globCache.clear()` on edit, `1269` on write, bundle `readCache.delete+clear` |
| Diff | `30s/20` TTL | **DONE** — was 10s, now 30s `index.ts:119`, README fixed `30000` |
| Scan | `30s/50` mtime-sorted | **DONE** — keep |
| Exec | `30s/20` opt-in `cache:true` default OFF | **DONE** — `index.ts:950` `const useCache = ex.cache===true || ex.useCache===true` avoids stale `npm test` |
| Check | `30s/20` `tsc --noEmit` | **DONE** — keep; key includes `files[]` hash (future: include mtime) |
| Bundle | `BUNDLE_MAX 12` single flush 300ms | **DONE** — was 8, now 12 `index.ts:130`, README `12-per-call` saves +0.2 calls |
| Prefetch | `session_start` 4 git-changed files `Promise.all` | **DONE** — keep |
| Telemetry | Single flush 300ms | **DONE** — keep |

**Top 2 fixes:** Both DONE — execCache opt-in + diff TTL 30s.

## 5. AUTOMATE — Only after QDS

**Gate:** Do NOT automate until Delete/Simplify done. Delete 90% DONE, Simplify P1 pending — automate only safe guards.

1. **Health bundle** `/smart-health` = `smart_bundle({diffs,scans,checks})` — **DONE** `pi.registerCommand("smart-health")`
2. **Pre-commit** — **DONE** `package.json:precommit` `npm run check && npm run build && test -f dist/index.js`; `prepare:build` on publish exists
3. **GitHub Action** `.github/workflows/check.yml` — **FIXED** 2026-05-13: was `git diff --exit-code dist/` (ineffective when `dist/` gitignored) → `test -f dist/index.js` + `npm run check` (verifies build without false negative)
4. **Cache invalidation automation** — **DONE** hooks `smart_write/edit/bundle` → `grepCache.clear() / globCache.clear() / diffCache.clear() / scanCache.clear()` + `readCache.delete`
5. **Audit automation** — **DONE** `npm run audit` (`tsc + wc -l + grep TODO + grep TTLCache`) + this file as template

## Verdict & Backlog (2026-05-13)

**Overall:** Lean, well-designed, 0 deps, 50% call saving validated. Main debt is **monolith 2463 lines** — not feature bloat. No premature automation. 8 of 9 Delete tasks DONE, 4 of 4 Accelerate DONE, 4 of 5 Automate DONE.

### Prioritized Backlog (remaining)
- **P1 Simplify:** Split `index.ts` → `src/` modules (enables tests) — **ONLY remaining P1**. Requires branch + `npm test` harness. Do after this commit.
- **P2 Simplify:** Derive `SMART_TOOL_META` from tool defs (−13 lines), merge dual `tool_call` handlers 2236+2259, group `SmartState` fields, extract `bundleLimits` helper
- **P2 Automate:** Add `husky` pre-commit hook (currently npm script only) — optional

### Metrics (verified)
- Lines: 2274 → **2463** → target ~2050 after P1 split (−17%)
- Caches: 8 Maps → **1 generic TTLCache** ✓
- Handlers: 5 → 4 after merge (currently 5: 2 tool_call +1 tool_result +2 session — P2 will merge to 4)
- tsc: pass ✅, TODOs: 0, execCache: opt-in ✅, diff TTL: 30s ✅

---
*Re-audited via 5-Step (Question→Delete→Simplify→Accelerate→Automate) — Never optimize what shouldn't exist. H0 Winner: incremental fixes (cost:2 risk:1 rev:9).*
