# smart-tools

Batching + fuzzy edits + productivity suite for [pi](https://github.com/badlogic/pi-mono) — **8:1 LLM call savings**.

## Tools

| Tool | Replaces | What it does |
|------|----------|--------------|
| `smart_read` | `read` | Batched 8 files per call, `offset/limit`, binary guard, adaptive budget, LRU cache (32/5min) |
| `smart_write` | `write` | Batched 8 files, parallel sharded queue, hash dedup (skip no-op) |
| `smart_edit` | `edit` | Fuzzy line-trim/collapsed, queue-safe, `dryRun`/`strict`, overlap detection |
| `smart_grep` | `bash rg` | rg→grep bridge + optional auto-read of top hits (1 call vs 2) |
| `smart_patch` | `git apply` | Atomic unified diff via `git apply` (deferred) |
| `search_smart_tools` | — | Deferred loader for lazy tools (`smart_grep`, `smart_patch`) |

Plus: mandatory bash timeout gate (30s), `/smart-status`, `/smart-history`, polished widget.

## Install

```bash
# via pi (recommended)
pi install git:github.com/Danu28/smart-tools

# or manual
pi -e ./index.ts "your prompt"
# or clone
 git clone https://github.com/Danu28/smart-tools
 pi -e ./smart-tools/index.ts
```

## Usage

```ts
// ALWAYS use smart_* instead of raw tools — saves 7 calls per batch
smart_read({ files: ["a.ts", {path:"b.ts", offset:100, limit:50}] })
smart_write({ writes: [{path:"a.ts", content:"..."}, {path:"b.ts", content:"..."}] })
smart_edit({ path:"app.ts", edits: [{oldText:"foo", newText:"bar"}] })
```

## Transparency

Collapsed = minimal (`✓ 3 file(s): a.ts, b.ts +1 more`), Expanded (`expand` key) = full `what happened` (byte delta, strategies, stdout preview, hit lines).

## License

MIT © Danu28
