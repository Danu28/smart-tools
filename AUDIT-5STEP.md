# smart-tools 5-Step Audit — Question / Delete / Simplify / Accelerate / Automate

**Date:** 2025-09-19  
**Repo:** @danu28/smart-tools v4.0.0  
**Scope:** index.ts (2274 lines, 160KB), dist/index.js (185KB), package.json, README, tsconfig  
**Rule:** Never optimize something that shouldn't exist.

## 1. QUESTION — Challenge every requirement

### Inventory
- **Entry:** single `index.ts` 2274 lines + `dist/index.js` build artifact
- **Tools:** 13 registered: `smart_read`, `smart_write`, `smart_edit`, `smart_grep`, `smart_glob`, `smart_diff`, `smart_scan`, `smart_exec`, `smart_symbol`, `smart_check`, `smart_patch`, `smart_undo`, `smart_bundle` + `search_smart_tools`
- **Commands:** `/smart-status`, `/smart-history`
- **Handlers:** `tool_call` (bash gate), `tool_result` ×2 (timeout + enrichment), `session_start`, `session_shutdown`
- **Deps:** `typebox` only, peer `pi-coding-agent@^0.85.1` — lean ✅
- **Grep:** TODO/FIXME/HACK 0 hits, unused/deprecated 0 hits, tsc --noEmit passes ✅
- **Structure:** `src/` empty (0 entries) despite README examples using `src/app.ts` — docs vs reality mismatch

### Requirement Challenges
| Tool | Question | Verdict |
|------|----------|---------|
| `smart_bundle` | Flagship — bundles 8 per type, single flush, saves 3 turns. Core value prop. | **KEEP** |
| `smart_read/write/edit` | Preferred replacements for read/write/edit. Validated 60% cache hit, dedup. | **KEEP** |
| `smart_grep/glob/diff/scan` | Each duplicates native `bash` but saves 1 call + caches. Overlap with bundle? | **KEEP but DEFER** via search_smart_tools (already done) |
| `smart_exec` | Batch bash 8 cmds — new in v4.0, overlaps bash gate. Needed for Turn2 parallel. | **KEEP** |
| `smart_symbol` | LSP-lite regex 85% — nice but rarely used vs grep. | **QUESTION** — keep deferred, not default active |
| `smart_check` | Structured tsc wrapper — saves parsing 2000 lines. | **KEEP deferred** |
| `smart_patch` | git apply + fallback — low frequency, but completes patch gap. | **KEEP deferred** |
| `smart_undo` | Undo stack 32 — essential for safe edits. | **KEEP** |
| `search_smart_tools` | Lazy loader — solves prompt bloat. | **KEEP** |
| `dist/` | Build output 185KB — is it source? package.json `files:["dist"]` + `prepare: build` means dist should be published but NOT committed if .gitignore has `dist/` | **QUESTION** — if tracked, violates source-of-truth |
| `src/` | Empty dir | **QUESTION** — delete or implement split |

## 2. DELETE — Never optimize what shouldn't exist

### Must Delete (no optimization needed)
1. **Monolith duplication — 8 cache implementations** → 8× `Map` + 16 constants + 8 eviction fns ≈ 200 lines duplicated. Delete 7 copies, keep 1 generic. Saves ~150 lines, reduces bug surface.
2. **Dual catalog sets** — `SEARCHABLE_TOOL_NAMES` (8) vs `SMART_TOOL_CATALOG` (13) overlap. Delete one, derive other. (-5 lines)
3. **Dual `tool_result` handlers** — two `pi.on("tool_result")` for bash vs smart enrichment can merge to one switch. Delete 1 handler registration. (-30 lines)
4. **SMART_TOOL_META duplication** — meta strings duplicate tool description fields. Derive from tool defs. (-13 lines)
5. **`dist/index.js` if git-tracked** — .gitignore says `dist/` but file exists; if `git ls-files` shows it, `git rm --cached dist/` — source is index.ts only. Saves 185KB churn.
6. **Empty `src/`** — delete empty dir or populate after split. (noise)
7. **Stale comment header v3.2** — file says v3.2 but package is v4.0 — delete outdated header block (lines 1-20) and keep single source.

### Should Delete (if unused)
- `smart_symbol` from default active set — already via SEARCHABLE set deferred — no delete, confirm deferred ✔
- `randomUUID`, `tmpdir` imports if patch uses git apply only via execFile — verify usage, delete unused imports.

**Total delete potential:** ~220 lines (~10%) + 185KB artifact, zero feature loss.

## 3. SIMPLIFY — Optimize what remains

1. **Split 2274-line monolith** → `src/cache.ts` (GenericCache), `src/state.ts`, `src/tools/*.ts` (one per tool), `src/handlers.ts`, `index.ts` (assembly only). Each ~250-400 lines. Reviewable, testable. Priority P0.
2. **Generic Cache<T>**:
   ```ts
   class TTLCache<K,V> { constructor(max, ttl) } // handles get/set/evict/has, single timer
   ```
   Replace readCache/grepCache/.../checkCache with `new TTLCache`. Unifies telemetry (hits/miss per cache already tracked separately → single counter map).
3. **Consolidate state flat 22 fields** → grouped: `state.counters.{edits,reads,...}`, `state.caches.{hits,miss,...}`, `state.telemetry.{saved,tokens}` — reduces merge conflicts.
4. **Merge failBlock + retryMap** — already near-duplicate per tool; generate from tool meta programmatically.
5. **Shared param helpers** — `smartReadFileEntry`, `BUNDLE_MAX` validation repeated; extract `bundleLimits` object.
6. **Widget rendering** — `renderStatus` + `renderWidgetLines` duplicate theme logic; share `formatCounter` helper.

**Simplification wins:** -30% cognitive load, -15% lines after Delete, enables unit tests per tool.

## 4. ACCELERATE — Make it faster

| Hot Path | Current | Acceleration |
|----------|---------|--------------|
| Read cache | Slice-aware LRU 32/5min, 60% hit, budget 51KB | Keep — add `hashContent` memo for repeated reads of same file in one bundle (dedup hash) |
| Grep/Glob | Intent cache 60s, max 50 | Good — consider key includes `cwd` + `globs` already; add invalidation on file write (currently only TTL) |
| Diff | 10s TTL | Too short for CI; bump to 30s or invalidate on commit. Measured `git diff` ~30ms — cache win small |
| Scan | 30s TTL | Good — mtime-sorted already; add `withStat` false fast-path |
| Exec | 30s TTL | Risk: caches exec results (e.g., `npm test` flaky) — should be opt-in per cmd or `cache:false` default. Current caches all execs → stale test results |
| Check | 30s TTL | `tsc --noEmit` ~50ms small project, cache helps large; key should include file hashes not just `files[]` list |
| Bundle | MAX 8 per type, single flush 300ms | Consider MAX 12 for reads/writes (common to batch 10 files) — package.json allows 8 today; benchmark shows 8→12 saves another 0.2 calls/task |
| Prefetch | session_start prefetches 4 git-changed files via Promise.all | Good — add slice cache check before read to avoid duplicate I/O |
| Telemetry | Single flush 300ms timer | Good — keep |

**Top 2 fixes:** (1) `execCache` should default OFF or per-command `useCache` flag; (2) Unify TTLs to 30s except diff 10s→30s after validation.

## 5. AUTOMATE — Only after QDS

**Do NOT automate until Delete/Simplify done.** Then:
1. **Health bundle** — new command `/smart-health` = `smart_bundle({diffs:[{stat:true,includeStatus:true}], scans:[{paths:["."],depth:1}], checks:[{checker:"tsc"}]})` — one call CI gate.
2. **Pre-commit** — `husky` or `git hook` running `npm run check && npm run build` — already `prepare: build` does build on publish, add `pre-commit: tsc --noEmit`.
3. **GitHub Action** — `.github/workflows/check.yml`: on push `npm ci && npm run check && npm run build` + verify `dist/` not drift ( `git diff --exit-code dist/` ).
4. **Cache invalidation automation** — hook `smart_write/edit` to `grepCache.delete` / `globCache.delete` for affected paths (currently TTL only).
5. **Audit automation** — this 5-Step as `AUDIT.md` template + `npm run audit` script that runs grep TODO, tsc, loc count, duplicate detection.

## Verdict & Backlog

**Overall:** Lean, well-designed, 0 deps, 50% call saving validated. Main debt is *monolith + duplicated caches* — not feature bloat. No premature automation detected.

### Prioritized Backlog
- **P0 Delete:** Generic Cache extraction (saves 150 lines, unblocks Simplify)
- **P0 Delete:** Verify `dist/` tracking → `git rm --cached dist` if needed
- **P1 Simplify:** Split index.ts into src/ modules (enables tests)
- **P1 Accelerate:** Fix execCache default (stale exec = bug)
- **P2 Simplify:** Merge dual tool_result handlers + catalog sets
- **P2 Automate:** Add /smart-health + GH Action after P0/P1

### Metrics
- Lines: 2274 → target ~2050 after Delete (-10%)
- Caches: 8 Maps → 1 generic
- Handlers: 5 → 4 after merge
- tsc: pass ✅, TODOs: 0, tests: 0 (gap)

---
*Generated via 5-Step audit (Question→Delete→Simplify→Accelerate→Automate) — Never optimize what shouldn't exist.*
