# smart-tools v3.1

Batching + fuzzy edits + productivity suite for [pi](https://github.com/badlogic/pi-mono) — **3.8 → 1.9 LLM calls/task (-50%)** via `smart_bundle`.

## Tools

| Tool | Replaces | What it does |
|------|----------|--------------|
| `smart_bundle` | `grep+glob+read+edit+write` | **Flagship** — heterogeneous batch in ONE LLM call (grep→glob→read→edit→write), queue-safe, saves 3 turns |
| `smart_read` | `read` | Batched 8 files, `offset/limit`, binary guard, adaptive budget, slice-aware LRU cache (32/5min, 60% hit) |
| `smart_write` | `write` | Batched 8 files, parallel sharded queue, hash dedup (skip no-op) |
| `smart_edit` | `edit` | Fuzzy line-trim/collapsed 0.72, queue-safe, `dryRun`/`strict`/`replaceAll`, auto-rescue, auto-merge, no-op dedup |
| `smart_grep` | `bash rg` | rg→grep bridge + intent cache 60s + optional auto-read (1 call vs 2) |
| `smart_glob` | `glob` / `bash find` | **NEW v3.1** — batch 8 patterns, mtime-sorted, intent cache 60s, optional includeRead |
| `smart_patch` | `git apply` | Atomic diff via `git apply` + auto fallback to edits |
| `smart_undo` | `bash git checkout` | **NEW v3.1** — atomic revert via undo stack (32 ops), `lastBundle` support |
| `search_smart_tools` | — | Lazy loader for `smart_grep`, `smart_patch`, `smart_glob` |

Plus: mandatory bash timeout gate (30s, quiet clamp), `/smart-status` & `/smart-history`, predictive prefetch, single telemetry flush.

## Install

```bash
pi install git:github.com/Danu28/smart-tools
# or
pi -e ./index.ts "your prompt"
```

## Usage — the 1-call happy path (v3.1)

```ts
// Tier-1 explicit files → 1 call
smart_bundle({
  reads: [{path:"src/app.ts"}],
  edits: [{path:"src/app.ts", edits:[{oldText:"old", newText:"new"}]}]
})

// Tier-2 explore → 2 calls: bundle grep+glob+read → bundle edit
smart_bundle({ greps:[{query:"TODO"}], globs:[{pattern:"src/**/*.ts"}], reads:[{path:"src/app.ts", limit:80}] })
smart_bundle({ edits:[{path:"src/app.ts", edits:[{oldText:"foo", newText:"bar"}]}] })

// File discovery (NEW v3.1) — 1 call vs glob+read 2 calls
smart_glob({ patterns:["src/**/*.ts", "**/*.test.ts"], includeRead:true, readLimit:60 })
smart_bundle({ globs:[{pattern:"src/**/*.ts"}], reads:[{path:"src/app.ts"}] })

// Global replace (NEW v3.1)
smart_edit({ path:"src/app.ts", edits:[{oldText:"oldName", newText:"newName"}], replaceAll:true })
smart_bundle({ edits:[{path:"a.ts", edits:[{oldText:"x", newText:"y"}]}], replaceAll:true })

// Undo last change (NEW v3.1)
smart_undo({ path:"src/app.ts" })
smart_undo({ lastBundle:true }) // revert whole bundle

// Multi-file refactor → 1 call vs 3
smart_bundle({
  edits: [
    {path:"a.ts", edits:[{oldText:"foo", newText:"bar"}]},
    {path:"b.ts", edits:[{oldText:"x", newText:"y"}]}
  ]
})

// Fallback still works ( specialists )
smart_read({ files: ["a.ts", {path:"b.ts", offset:100, limit:50}] })
smart_write({ writes: [{path:"a.ts", content:"..."}] })
smart_edit({ path:"app.ts", edits: [{oldText:"foo", newText:"bar"}] })
```

### Anchor rule (one rule)

> **Anchor = 3-6 lines, must include unique symbol** (function name, import, or string literal). Copy verbatim from `smart_read` slice. Fuzzy `0.72` handles whitespace; `strict:true` rejects low confidence; `dryRun:true` previews; `replaceAll:true` replaces all occurrences.

## Why v3.1 saves 1.9 calls

- **Delete** grep/glob when files explicit (prompt lists `src/foo.ts` → read directly)
- **Delete** read when cache-hot slice-aware (mtime+size+hash, 41%→60% hit)
- **Delete** retry via auto-rescue (fresh read in same execution) + auto-merge (same-line conflict only)
- **Simplify** to one heterogeneous `smart_bundle` (replaces 3-4 serial turns) now with `globs`
- **Accelerate** with intent cache (grep 60s, glob 60s), adaptive budget, prefetch `git diff --name-only`
- **Automate** fallback `patch→edit` + undo stack (32 ops) + single telemetry flush (300ms)

No new deps, no vector DB.

## Transparency

Collapsed = minimal (`✓ smart_bundle 4 ops saved 3`), Expanded (`expand`) = full sections with byte delta, strategies, hit lines. Status dot `●/○` + rich widget single source.

## Knobs

```js
{
  CACHE_MAX: 32, CACHE_TTL_MS: 300000,     // slice-aware
  GREPCACHE_TTL: 60000, GREPCACHE_MAX: 50,
  GLOBCACHE_TTL: 60000, GLOBCACHE_MAX: 50,
  UNDO_MAX: 32,
  BUNDLE_MAX: 8, BUDGET_BYTES: 51200
}
// Env: SMARTTOOLS_QUIET=1 silences widget nudge
```

## License

MIT © Danu28
