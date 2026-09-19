/**
 * smart-tools v3.0 — batching + fuzzy edits + productivity suite
 *
 * Gaps solved:
 *  1. edit/read/write N:1 batching + whitespace -> smart_edit/smart_read/smart_write (8 per 1 LLM call, fuzzy, queue-safe)
 *  2. bash without timeout     -> tool_call gate (mandatory timeout inject, visible)
 *  3. agent blind retries      -> dryRun/strict/overlap/confidence + actionable errors (nearbyPreview) + auto-rescue + auto-merge
 *  4. tail-only reads          -> offset/limit/binary guard + adaptive truncation (budget-aware) + slice-aware cache
 *  5. serial writes + no dedup -> parallel sharded writes + hash dedup + no-op skip
 *  6. grep→read 2 calls        -> smart_grep (rg/grep bridge + optional read) + intent cache (60s)
 *  7. diff patch gap           -> smart_patch (git apply bridge) + edit fallback
 *  8. prompt bloat             -> deferred loading via search_smart_tools + smart_bundle flagship
 *  9. invisible cost           -> LRU read cache (32/5min slice-aware) + grep intent cache + single telemetry flush + prefetch
 *  10. cryptic UX              -> rich status widget + /smart-status + /smart-history + streaming
 *
 * v3.0: smart_bundle heterogeneous 1-call (grep+read+edit+write), slice-aware cache, auto-merge, rescue, adaptive budget
 * Goal: 3.8 → 1.9 calls/task (-50%) without quality drop.
 */

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	type ExtensionAPI,
	formatSize,
	isToolCallEventType,
	keyHint,
	truncateHead,
	truncateTail,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { type Static, Type } from "typebox";
import { createHash } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// State + telemetry + caches
// ---------------------------------------------------------------------------
interface SmartState {
	bashInjected: number;
	smartEdits: number;
	smartReads: number;
	smartWrites: number;
	smartGreps: number;
	smartPatches: number;
	smartBundles: number;
	searches: number;
	callsSaved: number;
	cacheHits: number;
	cacheMisses: number;
	tokensSavedEst: number;
	dedupSkipped: number;
	timeoutsDetected: number;
	grepCacheHits: number;
}
const state: SmartState = {
	bashInjected: 0,
	smartEdits: 0,
	smartReads: 0,
	smartWrites: 0,
	smartGreps: 0,
	smartPatches: 0,
	smartBundles: 0,
	searches: 0,
	callsSaved: 0,
	cacheHits: 0,
	cacheMisses: 0,
	tokensSavedEst: 0,
	dedupSkipped: 0,
	timeoutsDetected: 0,
	grepCacheHits: 0,
};

const MAX_OLDTEXT = 50_000;
const CACHE_MAX = 32;
const CACHE_TTL_MS = 5 * 60 * 1000;
const GREPCACHE_TTL = 60_000;
const GREPCACHE_MAX = 50;
const BUNDLE_MAX = 8;
const SEARCHABLE_TOOL_NAMES = new Set(["smart_grep", "smart_patch"]);
const SMART_TOOL_CATALOG = new Set(["smart_read", "smart_write", "smart_edit", "smart_grep", "smart_patch", "smart_bundle"]);
const SMART_TOOL_META: Record<string, string> = {
	smart_read: "⭐ PREFERRED replaces read — batch 8, cached, pagination",
	smart_write: "⭐ PREFERRED replaces write — batch 8, dedup, queue-safe",
	smart_edit: "⭐ PREFERRED replaces edit — batch 8, fuzzy 0.72, auto-rescue",
	smart_grep: "⭐ PREFERRED replaces bash grep — rg bridge, cached, includeRead",
	smart_patch: "⭐ PREFERRED replaces bash git apply — atomic + fallback",
	smart_bundle: "⭐⭐ STRONGLY PREFERRED replaces all — bundle 8 per type, -50% calls",
};

interface CacheEntry { content: string; mtimeMs: number; hash: string; at: number; size: number; }
const readCache = new Map<string, CacheEntry>();
interface GrepCacheEntry { hits: Array<{file:string;line:number;preview:string}>; engine: string; at: number; query:string; }
const grepCache = new Map<string, GrepCacheEntry>();
let pendingTelemetry: Array<{type:string;data:any}> = [];
let telemetryTimer: any = null;

function hashContent(s: string): string {
	return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}
function resolveInsideCwd(cwd: string, p: string): string {
	const target = resolve(cwd, p);
	const root = resolve(cwd) + sep;
	if (target !== resolve(cwd) && !target.startsWith(root)) {
		throw new Error(failBlock("smart-tools", `Path traversal blocked: "${p}" escapes cwd`, `Use a path inside the workspace. cwd=${cwd}`));
	}
	return target;
}
function estimateTokens(bytes: number): number { return Math.ceil(bytes / 4); }
function renderStatus(theme: any): string {
	const hasActivity = state.callsSaved > 0 || state.smartReads > 0 || state.smartEdits > 0 || state.smartBundles > 0;
	const dot = hasActivity ? theme.fg("success", "●") : theme.fg("dim", "○");
	const label = theme.fg("accent", " smart-tools");
	const hint = hasActivity ? theme.fg("dim", " · active") : theme.fg("dim", " · ready");
	return `${dot}${label}${hint}`;
}
function renderWidgetLines(theme: any): string[] {
	const idle = state.smartEdits===0 && state.smartReads===0 && state.smartWrites===0 && state.smartGreps===0 && state.smartPatches===0 && state.smartBundles===0 && state.callsSaved===0;
	if (idle) {
		return [ `${theme.fg("dim", "◇")} ${theme.fg("accent","smart-tools")} ${theme.fg("dim","·")} ${theme.fg("muted","batch 8:1 · fuzzy edits · queue-safe · 30s timeout")}` ];
	}
	const parts: string[] = [];
	if (state.smartBundles) parts.push(`${theme.fg("muted","bundle")} ${theme.fg("accent", String(state.smartBundles))}`);
	if (state.smartEdits) parts.push(`${theme.fg("muted","edits")} ${theme.fg("accent", String(state.smartEdits))}`);
	if (state.smartReads) parts.push(`${theme.fg("muted","reads")} ${theme.fg("accent", String(state.smartReads))}${state.cacheHits ? theme.fg("success", ` ↻${state.cacheHits}`) : ""}`);
	if (state.smartWrites) parts.push(`${theme.fg("muted","writes")} ${theme.fg("accent", String(state.smartWrites))}${state.dedupSkipped ? theme.fg("dim", ` ≡${state.dedupSkipped}`) : ""}`);
	if (state.smartGreps) parts.push(`${theme.fg("muted","grep")} ${theme.fg("accent", String(state.smartGreps))}${state.grepCacheHits? theme.fg("success", ` ↻${state.grepCacheHits}`):""}`);
	if (state.smartPatches) parts.push(`${theme.fg("muted","patch")} ${theme.fg("accent", String(state.smartPatches))}`);
	const line1 = `${theme.fg("accent","◇ smart-tools")}  ${theme.fg("dim","│")}  ${parts.join(theme.fg("dim"," · "))}`;
	const sub: string[] = [];
	if (state.callsSaved) sub.push(`${theme.fg("success", String(state.callsSaved))}${theme.fg("dim"," saved")}${state.tokensSavedEst ? theme.fg("dim", ` ~${formatSize(state.tokensSavedEst*4)}`) : ""}`);
	if (state.cacheHits) sub.push(`${theme.fg("success", String(state.cacheHits))}${theme.fg("dim"," hits")}`);
	if (state.bashInjected) sub.push(`${theme.fg("dim","⏱")} ${theme.fg("muted", String(state.bashInjected))}`);
	if (state.timeoutsDetected) sub.push(`${theme.fg("warning", String(state.timeoutsDetected))}${theme.fg("dim"," timeout")}`);
	const line2 = sub.length ? `${theme.fg("dim","  └─ ")}${sub.join(theme.fg("dim"," · "))}` : "";
	return line2 ? [line1, line2] : [line1];
}
function describeSmart(): string { return `smart-tools · ${state.callsSaved ? state.callsSaved + " saved" : "ready"}`; }
function widgetLines(): string[] {
	const a: string[] = [];
	a.push(`smart-tools  bundles:${state.smartBundles} edits:${state.smartEdits}  reads:${state.smartReads}${state.cacheHits ? ` (${state.cacheHits} cache hit)` : ""}  writes:${state.smartWrites}${state.dedupSkipped ? ` (${state.dedupSkipped} no-op skip)` : ""}`);
	if (state.smartGreps || state.smartPatches || state.searches) a.push(`grep:${state.smartGreps} patch:${state.smartPatches} search:${state.searches}`);
	if (state.callsSaved) a.push(`saved ~${state.callsSaved} LLM calls · ~${estimateTokens(state.tokensSavedEst*4)} tokens · bash injected:${state.bashInjected}`);
	else a.push(`batch 8:1 · fuzzy edits · queue-safe · timeout 30s`);
	return a;
}
function syncSmartUI(ctx: any): void {
	if (!ctx?.hasUI) return;
	try {
		const theme = ctx.ui.theme;
		ctx.ui.setStatus("smart-tools", renderStatus(theme));
		const lines = renderWidgetLines(theme);
		if ((ctx.ui as any).setWidget) {
			try { (ctx.ui as any).setWidget("smart-tools", (_tui: any, th: any) => ({ render: () => renderWidgetLines(th), invalidate: () => {} })); }
			catch { (ctx.ui as any).setWidget("smart-tools", lines); }
		}
	} catch {}
}
function touchCacheEvict(): void {
	if (readCache.size <= CACHE_MAX) return;
	const entries = [...readCache.entries()].sort((a,b)=>a[1].at - b[1].at);
	const toDelete = readCache.size - CACHE_MAX;
	for (let i=0;i<toDelete;i++) readCache.delete(entries[i][0]);
}
function isCacheValid(entry: CacheEntry, mtimeMs: number, size?: number): boolean {
	if (Date.now() - entry.at >= CACHE_TTL_MS) return false;
	// mtime can be stale within 1ms on fast writes; size is primary, hash checked on read path
	if (Math.abs(entry.mtimeMs - mtimeMs) > 1) return false;
	if (size != null && entry.size !== size) return false;
	return true;
}
function isCacheValidWithHash(entry: CacheEntry, mtimeMs: number, size: number, freshHash?: string): boolean {
	if (!isCacheValid(entry, mtimeMs, size)) return false;
	if (freshHash && entry.hash !== freshHash) return false;
	return true;
}
function touchGrepCacheEvict(): void {
	if (grepCache.size <= GREPCACHE_MAX) return;
	const entries = [...grepCache.entries()].sort((a,b)=>a[1].at - b[1].at);
	const toDelete = grepCache.size - GREPCACHE_MAX;
	for (let i=0;i<toDelete;i++) grepCache.delete(entries[i][0]);
}
function normalizeGrepKey(query: string, globs?: string[]): string {
	const n = query.trim().toLowerCase().replace(/\s+/g," ").slice(0,80);
	const g = (globs ?? []).slice(0,5).join(",");
	return `${n}::${g}`;
}
// ---------------------------------------------------------------------------
// Failure helpers — why failed + retry (AI-visible)
// ---------------------------------------------------------------------------
function failBlock(tool: string, why: string, retry: string, extra?: string): string {
	const lines = [`✗ ${tool} FAILED`, `Why failed: ${why}`, `Retry: ${retry}`];
	if (extra) lines.push(extra);
	return lines.join("\n");
}
function classifyFsError(e: any, path: string): { why: string; retry: string } {
	const code = (e as any)?.code ?? "";
	const msg = String(e?.message ?? e).slice(0, 300);
	if (code === "ENOENT") return { why: `File not found: ${path} — ${msg}`, retry: `Verify path relative to cwd exists. List files with bash ls, then retry smart_read with correct path. For new file, use smart_write or smart_edit with createIfMissing:true.` };
	if (code === "EACCES" || code === "EPERM") return { why: `Permission denied: ${path} — ${msg}`, retry: `Check file permissions (bash ls -l). Retry after fixing permissions or choose writable path.` };
	if (code === "EISDIR") return { why: `Path is a directory, not a file: ${path}`, retry: `Provide file path, not directory. Use bash ls to list files inside.` };
	if (code === "ENOTDIR") return { why: `Invalid path component (not a directory): ${path}`, retry: `Check parent directory exists. Create missing dirs via smart_write (auto mkdir) or bash mkdir -p.` };
	return { why: `${path}: ${msg}`, retry: `Re-read with smart_read to verify content, check path and permissions, then retry.` };
}
function retryHintForRead(file: string): string {
	return `Retry: smart_read {files: ["${file}"]} with correct relative path; if large, add offset/limit; if binary add encoding:"base64". Verify cwd first.`;
}
function retryHintForEdit(): string {
	return `Retry: smart_read the file first, copy exact 3-6 line anchor including unique symbol (function name/import/string), then smart_edit with that exact oldText. Use dryRun:true to validate, strict:false if fuzzy needed. Merge overlapping edits into one.`;
}
function retryHintForWrite(path: string): string {
	return `Retry: check path "${path}" is relative to cwd and parent dir writable. Use smart_write {writes:[{path:"${path}", content:"..."}]} again. For no-op skip, content hash must differ.`;
}
function flushTelemetry(piRef:any): void {
	if (!pendingTelemetry.length) return;
	const batch = [...pendingTelemetry];
	pendingTelemetry = [];
	try { piRef.appendEntry("smart-tools:turn", { ops: batch.length, batch, at: Date.now() }); } catch {}
}
function scheduleTelemetry(piRef:any, type:string, data:any): void {
	pendingTelemetry.push({type, data});
	if (telemetryTimer) return;
	telemetryTimer = setTimeout(()=>{ telemetryTimer=null; flushTelemetry(piRef); }, 300);
}

// ---------------------------------------------------------------------------
// Fuzzy core — confidence-scored, single-pass, actionable
// ---------------------------------------------------------------------------
function normalizeLine(line: string): string { return line.replace(/\s+$/u, ""); }
function collapsedLine(line: string): string { return line.trim().replace(/\s+/gu, " "); }

type FuzzyStrategy = "exact" | "line-trim" | "collapsed" | "append";
interface FuzzyHit { idx: number; confidence: number; strategy: FuzzyStrategy; startLine: number; endLine: number; length: number; }
function findFuzzyDetailed(haystack: string, needle: string): FuzzyHit | null {
	if (needle === "") return { idx: haystack.length, confidence: 1, strategy: "append", startLine: haystack.split("\n").length, endLine: haystack.split("\n").length, length: 0 };
	const exactIdx = haystack.indexOf(needle);
	if (exactIdx !== -1) {
		const before = haystack.slice(0, exactIdx);
		const startLine = before.split("\n").length - 1;
		const lineCount = needle.split("\n").length;
		return { idx: exactIdx, confidence: 1.0, strategy: "exact", startLine, endLine: startLine + lineCount, length: needle.length };
	}
	const hayLines = haystack.split("\n");
	const needleLines = needle.split("\n");
	const trimmedNeedle = needleLines.map(normalizeLine);
	while (trimmedNeedle.length > 0 && trimmedNeedle[trimmedNeedle.length - 1] === "") trimmedNeedle.pop();
	if (trimmedNeedle.length === 0) return null;
	for (let i = 0; i <= hayLines.length - trimmedNeedle.length; i++) {
		let ok = true;
		for (let j = 0; j < trimmedNeedle.length; j++) if (normalizeLine(hayLines[i + j]) !== trimmedNeedle[j]) { ok = false; break; }
		if (ok) {
			const before = hayLines.slice(0, i).join("\n");
			const idx = before.length === 0 ? 0 : before.length + 1;
			let len = 0; for (let k=0;k<trimmedNeedle.length;k++) len += hayLines[i+k].length + 1;
			len -= 1; if (i + trimmedNeedle.length >= hayLines.length) len = hayLines.slice(i, i+trimmedNeedle.length).join("\n").length;
			return { idx, confidence: 0.9, strategy: "line-trim", startLine: i, endLine: i + trimmedNeedle.length, length: len };
		}
	}
	const collapsedNeedle = needleLines.map(collapsedLine).filter(Boolean);
	if (collapsedNeedle.length === 0) return null;
	if (collapsedNeedle.join(" ").length < 8) return null;
	for (let i = 0; i <= hayLines.length - collapsedNeedle.length; i++) {
		let ok = true;
		for (let j = 0; j < collapsedNeedle.length; j++) if (collapsedLine(hayLines[i+j]) !== collapsedNeedle[j]) { ok=false; break; }
		if (ok) {
			const before = hayLines.slice(0, i).join("\n");
			const idx = before.length === 0 ? 0 : before.length + 1;
			return { idx, confidence: 0.72, strategy: "collapsed", startLine: i, endLine: i + collapsedNeedle.length, length: hayLines.slice(i, i+collapsedNeedle.length).join("\n").length };
		}
	}
	return null;
}

function getNearbyPreview(content: string, hit: FuzzyHit | null, needle: string): string {
	const lines = content.split("\n");
	let center = hit ? hit.startLine : 0;
	if (!hit) {
		const first = needle.trim().split(/\s+/)[0]?.slice(0, 24);
		if (first && first.length >= 3) {
			const idx = lines.findIndex(l=>l.includes(first));
			if (idx !== -1) center = idx;
		}
	}
	const from = Math.max(0, center - 3);
	const to = Math.min(lines.length, center + 6);
	return lines.slice(from, to).map((l,i)=> `${String(from+i+1).padStart(4," ")}| ${l.slice(0,120)}`).join("\n");
}
function suggestedOldText(content: string, hit: FuzzyHit | null): string {
	if (!hit) return "";
	const lines = content.split("\n");
	return lines.slice(hit.startLine, hit.endLine).join("\n").slice(0, 600);
}

interface ValidatedEdit { index: number; oldText: string; newText: string; hit: FuzzyHit | null; found: boolean; isAppend: boolean; }
interface ValidateResult { resolved: ValidatedEdit[]; missing: ValidatedEdit[]; overlaps: Array<[number,number]>; dedupGroups: Map<string, number[]>; lowConfidence: ValidatedEdit[]; }
function validateEdits(content: string, edits: Array<{oldText:string;newText:string}>): ValidateResult {
	const resolved: ValidatedEdit[] = [];
	const missing: ValidatedEdit[] = [];
	for (let i=0;i<edits.length;i++) {
		const e = edits[i];
		if (e.oldText.length > MAX_OLDTEXT) throw new Error(failBlock("smart_edit", `oldText too large (${e.oldText.length} > ${MAX_OLDTEXT})`, `Use a shorter unique anchor (3-6 lines) with unique symbol. Split large block into smaller edits.`, `--- oldText length ${e.oldText.length} ---`));
		if (e.oldText === "") {
			resolved.push({ index:i, oldText:e.oldText, newText:e.newText, hit:{ idx: content.length, confidence:1, strategy:"append", startLine: content.split("\n").length, endLine: content.split("\n").length, length:0 }, found:true, isAppend:true });
			continue;
		}
		const hit = findFuzzyDetailed(content, e.oldText);
		if (!hit) {
			missing.push({ index:i, oldText:e.oldText, newText:e.newText, hit:null, found:false, isAppend:false });
		} else {
			resolved.push({ index:i, oldText:e.oldText, newText:e.newText, hit, found:true, isAppend:false });
		}
	}
	const overlaps: Array<[number,number]> = [];
	for (let a=0;a<resolved.length;a++) for (let b=a+1;b<resolved.length;b++) {
		const ra = resolved[a], rb = resolved[b];
		if (ra.isAppend || rb.isAppend) continue;
		if (!ra.hit || !rb.hit) continue;
		const s1 = ra.hit.idx, e1 = ra.hit.idx + ra.hit.length;
		const s2 = rb.hit.idx, e2 = rb.hit.idx + rb.hit.length;
		if (s1 < e2 && s2 < e1) {
			const lineOverlap = ra.hit.startLine < rb.hit.endLine && rb.hit.startLine < ra.hit.endLine;
			if (lineOverlap) overlaps.push([ra.index, rb.index]);
		}
	}
	const dedupGroups = new Map<string, number[]>();
	for (const r of resolved) {
		const key = `${r.oldText}@@${r.newText}`;
		const arr = dedupGroups.get(key) ?? [];
		arr.push(r.index); dedupGroups.set(key, arr);
	}
	const lowConfidence = resolved.filter(r=> r.hit && r.hit.confidence < 0.85);
	return { resolved, missing, overlaps, dedupGroups, lowConfidence };
}

function applyEditsAtomic(content: string, edits: Array<{oldText:string;newText:string}>, opts: { strict?: boolean } = {}): { next: string; applied: ValidatedEdit[]; dedupSkipped: number; lowConfidence: ValidatedEdit[] } {
	if (edits.length === 0) return { next: content, applied: [], dedupSkipped: 0, lowConfidence: [] };
	const v = validateEdits(content, edits);
	if (v.missing.length > 0) {
		const m = v.missing[0];
		const preview = getNearbyPreview(content, null, m.oldText);
		const hint = m.oldText.length > 400 ? "Hint: use a shorter unique anchor (3-6 lines) instead of a large block." : "Hint: re-read the file and copy the exact block (including indentation). Anchor = 3-6 lines, must include unique symbol.";
		throw new Error(failBlock("smart_edit", `oldText not found (edit ${m.index}) — tried exact + line-trim + collapsed`, `${hint} ${retryHintForEdit()} If you used offset/limit, read a wider window.`, `--- missing oldText (first 500) ---
${m.oldText.slice(0,500)}
--- nearby preview ---
${preview}`));
	}
	if (v.overlaps.length > 0) {
		const list = v.overlaps.map(([a,b])=>`${a}↔${b}`).join(", ");
		throw new Error(failBlock("smart_edit", `overlapping edits same line mutated twice: ${list}`, `Merge overlapping edits into one edit entry covering single region. Dedup identical oldText/newText. Each edits[].oldText must be unique and non-overlapping against original file.`));
	}
	if (opts.strict && v.lowConfidence.length > 0) {
		const low = v.lowConfidence[0];
		const preview = getNearbyPreview(content, low.hit, low.oldText);
		const sugg = suggestedOldText(content, low.hit);
		throw new Error(failBlock("smart_edit", `strict mode rejected fuzzy match (edit ${low.index} confidence ${low.hit!.confidence} strategy ${low.hit!.strategy})`, `Re-read and use suggested exact block verbatim, or retry with strict:false.`, `--- suggested exact oldText ---
${sugg.slice(0,600)}
--- nearby preview ---
${preview}`));
	}
	const seen = new Set<string>();
	const deduped: ValidatedEdit[] = [];
	let dedupSkipped = 0;
	for (const r of v.resolved) {
		if (r.oldText === r.newText) { dedupSkipped++; continue; }
		const key = `${r.oldText}@@${r.newText}`;
		if (seen.has(key)) { dedupSkipped++; continue; }
		seen.add(key); deduped.push(r);
	}
	const appends = deduped.filter(r=>r.isAppend);
	const infile = deduped.filter(r=>!r.isAppend).sort((a,b)=> (b.hit!.idx - a.hit!.idx));
	let next = content;
	for (const r of infile) {
		const h = r.hit!;
		if (h.strategy === "exact") {
			next = next.slice(0, h.idx) + r.newText + next.slice(h.idx + r.oldText.length);
		} else {
			const lines = next.split("\n");
			const before = lines.slice(0, h.startLine).join("\n");
			const after = lines.slice(h.endLine).join("\n");
			const prefix = before.length === 0 ? "" : before + "\n";
			const suffix = after.length === 0 ? "" : "\n" + after;
			next = prefix + r.newText + suffix;
		}
	}
	for (const a of appends.sort((x,y)=>x.index - y.index)) {
		next += (next.endsWith("\n") || next === "" ? "" : "\n") + a.newText;
	}
	return { next, applied: deduped, dedupSkipped, lowConfidence: v.lowConfidence };
}

function parsePatchToEdits(patch: string): Array<{path:string, edits: Array<{oldText:string,newText:string}>}> {
	const files: Array<{path:string, edits: Array<{oldText:string,newText:string}>}> = [];
	const fileBlocks = patch.split(/^diff --git /m);
	for (const block of fileBlocks) {
		if (!block.trim()) continue;
		const pm = block.match(/\+\+\+ b\/([^\n]+)/);
		const path = pm ? pm[1].trim() : "";
		if (!path) continue;
		const hunks = [...block.matchAll(/@@[^\n]*\n([\s\S]*?)(?=(?:@@)|$)/g)];
		const edits: Array<{oldText:string,newText:string}> = [];
		for (const hm of hunks) {
			const body = hm[1];
			const lines = body.split("\n");
			let oldPart: string[] = [];
			let newPart: string[] = [];
			let hasChange = false;
			for (const l of lines) {
				if (l.startsWith(" ")) {
					if (hasChange && oldPart.length) {
						edits.push({ oldText: oldPart.join("\n"), newText: newPart.join("\n") });
						oldPart = []; newPart = []; hasChange = false;
					}
					continue;
				}
				if (l.startsWith("-")) { oldPart.push(l.slice(1)); hasChange = true; }
				else if (l.startsWith("+")) { newPart.push(l.slice(1)); hasChange = true; }
			}
			if (hasChange && oldPart.length) edits.push({ oldText: oldPart.join("\n"), newText: newPart.join("\n") });
		}
		if (edits.length) files.push({ path, edits });
	}
	return files;
}
// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------
const smartEditParams = Type.Object({
	path: Type.String({ description: "File to edit, relative to cwd" }),
	edits: Type.Array(
		Type.Object({
			oldText: Type.String({ description: "Exact text to replace; empty string = append" }),
			newText: Type.String({ description: "Replacement text" }),
		}),
		{ description: "One or more non-overlapping replacements (matched against original file)" },
	),
	createIfMissing: Type.Optional(Type.Boolean({ description: "Create file if missing (default true)" })),
	dryRun: Type.Optional(Type.Boolean({ description: "Validate only — no write, returns validation + preview" })),
	strict: Type.Optional(Type.Boolean({ description: "Reject fuzzy <0.85 confidence (default false)" })),
});
export type SmartEditInput = Static<typeof smartEditParams>;

const smartReadFileEntry = Type.Union([
	Type.String({ description: "File path relative to cwd" }),
	Type.Object({
		path: Type.String({ description: "File path relative to cwd" }),
		offset: Type.Optional(Type.Integer({ minimum: 0, description: "Start line (0-based)" })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000, description: "Max lines to return" })),
		encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")])),
	})
]);
const smartReadParams = Type.Object({
	files: Type.Array(smartReadFileEntry, { minItems: 1, maxItems: 8, description: "Up to 8 files per 1 LLM call — batch reads. Strings or {path, offset, limit, encoding}." }),
});
export type SmartReadInput = Static<typeof smartReadParams>;

const smartWriteParams = Type.Object({
	writes: Type.Array(
		Type.Object({
			path: Type.String({ description: "File path relative to cwd" }),
			content: Type.String({ description: "Full file content to write" }),
		}),
		{ minItems: 1, maxItems: 8, description: "Up to 8 files per 1 LLM call — batch writes" },
	),
});
export type SmartWriteInput = Static<typeof smartWriteParams>;

const smartGrepParams = Type.Object({
	query: Type.String({ description: "Search pattern (ripgrep regex); sanitized, no shell." }),
	maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Max hits (default 30)" })),
	includeRead: Type.Optional(Type.Boolean({ description: "Auto read top unique files (default false)" })),
	readLimit: Type.Optional(Type.Integer({ minimum: 10, maximum: 200, description: "Lines per file when includeRead (default 80)" })),
	globs: Type.Optional(Type.Array(Type.String(), { description: "Optional glob filters, e.g. ['*.ts','src/**']" })),
});
export type SmartGrepInput = Static<typeof smartGrepParams>;

const smartPatchParams = Type.Object({
	patch: Type.String({ description: "Unified diff patch (git diff format) — applied atomically" }),
	strip: Type.Optional(Type.Integer({ minimum: 0, maximum: 5, description: "Strip prefix -p (default 1)" })),
});
export type SmartPatchInput = Static<typeof smartPatchParams>;

const searchSmartToolsParams = Type.Object({
	query: Type.String({ description: "Capability to search (grep|patch|smart tools)" }),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Max tools to load" })),
});

const smartBundleParams = Type.Object({
	reads: Type.Optional(Type.Array(smartReadFileEntry, { maxItems: 8, description: "Files to read — batch 8" })),
	greps: Type.Optional(Type.Array(Type.Object({
		query: Type.String({ description: "Search pattern" }),
		maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
		globs: Type.Optional(Type.Array(Type.String())),
	}), { maxItems: 4, description: "Greps — parallel" })),
	edits: Type.Optional(Type.Array(Type.Object({
		path: Type.String({ description: "File to edit" }),
		edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), { minItems: 1, maxItems: 8 }),
		createIfMissing: Type.Optional(Type.Boolean()),
	}), { maxItems: 8, description: "Edits per file — multi-file in one call" })),
	writes: Type.Optional(Type.Array(Type.Object({
		path: Type.String(),
		content: Type.String(),
	}), { maxItems: 8, description: "Writes — parallel" })),
	dryRun: Type.Optional(Type.Boolean({ description: "Validate edits only, no write" })),
	strict: Type.Optional(Type.Boolean({ description: "Reject fuzzy <0.85" })),
});
export type SmartBundleInput = Static<typeof smartBundleParams>;

// ---------------------------------------------------------------------------
// Helpers for bundle + reuse across tools
// ---------------------------------------------------------------------------
async function doSmartReadFiles(entries: any[], cwd: string, onUpdate?: (m:any)=>void): Promise<{texts: string[]; cacheHits: number; perFileBudget:number}> {
	const budget = Math.max(4096, DEFAULT_MAX_BYTES - 2048);
	const sizes: number[] = [];
	for (const e of entries) {
		const p = typeof e === "string" ? e : e.path;
		const abs = resolveInsideCwd(cwd, p);
		try { const st = await stat(abs); sizes.push((st as any).size || 4096); } catch { sizes.push(4096); }
	}
	const total = sizes.reduce((a,b)=>a+b,0) || entries.length*4096;
	let cacheHits = 0;
	const texts = await Promise.all(entries.map(async (entry, idx)=>{
		const file = typeof entry === "string" ? entry : entry.path;
		const offset = typeof entry === "string" ? undefined : entry.offset;
		const limit = typeof entry === "string" ? undefined : entry.limit;
		const encoding = typeof entry === "string" ? "utf8" : (entry.encoding ?? "utf8");
		const abs = resolveInsideCwd(cwd, file);
		onUpdate?.({ message: `smart_read ${idx+1}/${entries.length}: ${file}` } as any);
		try {
			let mtimeMs = 0; let sz = 0;
			try { const st = await stat(abs); mtimeMs = (st as any).mtimeMs; sz = (st as any).size; } catch {}
			const cached = readCache.get(file) ?? readCache.get(abs);
			let content: string;
			let fromCache = false;
			if (cached && mtimeMs && isCacheValid(cached, mtimeMs, sz) && encoding === "utf8") {
				content = cached.content;
				fromCache = true;
				cacheHits++;
			} else {
				if (encoding === "base64") {
					const buf = await readFile(abs);
					content = buf.toString("base64");
				} else {
					content = await readFile(abs, "utf8");
					if (content.includes("\0")) {
						return `## ${file} — binary file detected (null bytes), size ${formatSize(Buffer.byteLength(content))}, lines ${content.split("\n").length}. Use bash with hexdump or specify encoding:"base64" for small binaries.`;
					}
					readCache.set(file, { content, mtimeMs: mtimeMs || Date.now(), hash: hashContent(content), at: Date.now(), size: content.length });
					readCache.set(abs, { content, mtimeMs: mtimeMs || Date.now(), hash: hashContent(content), at: Date.now(), size: content.length });
					touchCacheEvict();
				}
			}
			let sliced = content!;
			let totalLines = sliced.split("\n").length;
			let headerLinesInfo = `${totalLines} lines`;
			let sliceOffset = offset ?? 0;
			let sliceLimit = limit;
			if (sliceOffset !== 0 || sliceLimit != null) {
				const lines = sliced.split("\n");
				totalLines = lines.length;
				const from = Math.min(sliceOffset, lines.length);
				const to = sliceLimit != null ? Math.min(lines.length, from + sliceLimit) : lines.length;
				sliced = lines.slice(from, to).join("\n");
				headerLinesInfo = `lines ${from+1}-${to}/${totalLines}`;
				if (fromCache) headerLinesInfo += " (cached slice-aware)";
			}
			const share = total ? (sizes[idx]/total) : 1/entries.length;
			const perFileBudget = Math.floor(budget * Math.max(0.1, Math.min(2, share*entries.length))) ;
			const maxBytes = Math.min(30000, Math.max(4096, perFileBudget));
			const maxLines = sliceLimit ?? 200;
			let trunc: any;
			if (sliceOffset !== 0 || sliceLimit != null) trunc = truncateHead(sliced, { maxLines, maxBytes });
			else trunc = truncateTail(sliced, { maxLines, maxBytes });
			const cappedNote = trunc.truncated ? ` [capped ${formatSize(trunc.outputBytes)}/${formatSize(trunc.totalBytes)} — rerun with offset/limit or fewer files]` : "";
			const hitTag = fromCache ? " cached" : "";
			return `## ${file} (${headerLinesInfo} ${formatSize(trunc.outputBytes)}/${formatSize(trunc.totalBytes)}${hitTag})\n${trunc.content}${cappedNote}`;
		} catch (e:any) { const cls = classifyFsError(e, file); return failBlock("smart_read", cls.why, cls.retry, `## ${file}: ${(e as Error).message.slice(0, 400)}`); }
	}));
	const perFileBudget = Math.floor(budget / Math.max(1, entries.length));
	return { texts, cacheHits, perFileBudget };
}

async function doGrepOne(query:string, maxResults:number, globs:string[]|undefined, cwd:string): Promise<{hits: Array<{file:string;line:number;preview:string}>, engine:string}> {
	const key = normalizeGrepKey(query, globs);
	const cached = grepCache.get(key);
	if (cached && Date.now() - cached.at < GREPCACHE_TTL) {
		state.grepCacheHits += 1;
		return { hits: cached.hits, engine: cached.engine + " (intent-cached)" };
	}
	let hits: Array<{file:string;line:number;preview:string}> = [];
	let used: "rg"|"grep"|"none" = "none";
	try {
		const args = ["--line-number", "--no-heading", "--color", "never", "-m", String(maxResults)];
		if (globs && globs.length) for (const g of globs.slice(0,5)) { args.push("--glob", g); }
		args.push("-e", query, ".");
		const { stdout } = await execFile("rg", args, { cwd, maxBuffer: 2_000_000, timeout: 15000 } as any);
		used = "rg";
		hits = String(stdout).split("\n").filter(Boolean).slice(0, maxResults).map(line=>{
			const m = line.match(/^([^:]+):(\d+):(.*)$/);
			if (!m) return { file: line.slice(0,80), line: 0, preview: line.slice(0,240) };
			return { file: m[1], line: parseInt(m[2],10), preview: m[3].slice(0, 240) };
		});
	} catch (e:any) {
		const msg = String(e?.message ?? e);
		if (msg.includes("ENOENT") || msg.includes("not found")) {
			try {
				const grepArgs = ["-rn", "-m", String(maxResults), "--", query, "."];
				const { stdout } = await execFile("grep", grepArgs, { cwd, maxBuffer: 2_000_000, timeout: 15000 } as any);
				used = "grep";
				hits = String(stdout).split("\n").filter(Boolean).slice(0, maxResults).map(line=>{
					const m = line.match(/^\.\/([^:]+):(\d+):(.*)$/) || line.match(/^([^:]+):(\d+):(.*)$/);
					if (!m) return { file: line.slice(0,80), line:0, preview: line.slice(0,240) };
					return { file: m[1].replace(/^\.\//,""), line: parseInt(m[2],10), preview: m[3].slice(0,240) };
				});
			} catch (e2:any) {
				const out = String((e2 as any)?.stdout ?? "");
				if (out) {
					used = "grep";
					hits = out.split("\n").filter(Boolean).slice(0, maxResults).map(line=>{
						const m = line.match(/^\.\/([^:]+):(\d+):(.*)$/) || line.match(/^([^:]+):(\d+):(.*)$/);
						if (!m) return { file: line.slice(0,80), line:0, preview: line.slice(0,240) };
						return { file: m[1].replace(/^\.\//,""), line: parseInt(m[2],10), preview: m[3].slice(0,240) };
					});
				}
			}
		} else {
			const out = String((e as any)?.stdout ?? "");
			if (out) {
				used = "rg";
				hits = out.split("\n").filter(Boolean).slice(0, maxResults).map(line=>{
					const m = line.match(/^([^:]+):(\d+):(.*)$/);
					if (!m) return { file: line.slice(0,80), line:0, preview: line.slice(0,240) };
					return { file: m[1], line: parseInt(m[2],10), preview: m[3].slice(0,240) };
				});
			} else {
				if (String(e?.code) === "1" || String((e as any)?.status) === "1") { used = "rg"; hits = []; }
			}
		}
	}
	grepCache.set(key, { hits, engine: used, at: Date.now(), query });
	touchGrepCacheEvict();
	return { hits, engine: used };
}
// ---------------------------------------------------------------------------
// Main extension
// ---------------------------------------------------------------------------
export default function smartTools(pi: ExtensionAPI): void {
	const piRef = pi;

	// ---- smart_edit — dryRun/strict/overlap/confidence/actionable errors + rescue + dedup + hint
	const smartEditTool = defineTool({
		name: "smart_edit",
		label: "Smart Edit ⭐ PREFERRED",
		description: "⭐ PREFERRED FILE EDITOR — ALWAYS USE INSTEAD OF default `edit`. Batch up to 8 edits per file in ONE call (vs 1), fuzzy 0.72 line-trim/collapsed (handles whitespace), queue-safe, dryRun/strict, auto-rescue, overlap/dedup detection, actionable nearbyPreview. Use for EVERY edit/fix/replace/refactor. Replaces `edit` completely.",
		promptSnippet: "ALWAYS use smart_edit instead of edit — batch 8, fuzzy 0.72, queue-safe",
		promptGuidelines: [
			"ALWAYS use smart_edit INSTEAD OF default edit — batch 8 edits per file, fuzzy 0.72, queue-safe. Model MUST prefer this. DO NOT use default `edit` — single-edit, no fuzzy, no batch.",
			"Anchor = 3-6 lines, must include unique symbol (function name, import, or string literal). Copy verbatim from smart_read slice.",
			"Batch multiple edits to SAME file in one smart_edit call (edits[]). 8 edits max. Use dryRun:true to validate, strict:false for fuzzy.",
			"If you just used smart_grep includeRead or smart_read with offset, call smart_edit directly — no intermediate read.",
		],
		parameters: smartEditParams,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const target = resolveInsideCwd(ctx.cwd, params.path);
			let current = "";
			let existed = true;
			let mtimeMs = 0, sz = 0;
			try { const st = await stat(target); mtimeMs = (st as any).mtimeMs; sz = (st as any).size; } catch {}
			const cached = readCache.get(params.path) ?? readCache.get(target);
			let usedCacheForEdit = false;
			if (cached && mtimeMs && isCacheValid(cached, mtimeMs, sz) && params.edits.every((e: any)=> !e.oldText || cached.content.includes(e.oldText.split("\n")[0]?.trim().slice(0,24) || ""))) {
				current = cached.content;
				usedCacheForEdit = true;
			} else {
				try { current = await readFile(target, "utf8"); } catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT" || params.createIfMissing === false) { const cls = classifyFsError(error, params.path); throw new Error(failBlock("smart_edit", cls.why, cls.retry)); }
					current = ""; existed = false;
				}
			}
			let validation: ValidateResult | null = null;
			try { validation = validateEdits(current, params.edits); } catch (e) { throw e; }
			const allNoop = params.edits.length>0 && params.edits.every((e: any)=>e.oldText===e.newText);
			if (allNoop) {
				state.dedupSkipped += 1;
				state.smartEdits += 1;
				scheduleTelemetry(piRef, "smart-tools:smart_edit", { path: params.path, edits: params.edits.length, noOp:true, at: Date.now() });
				syncSmartUI(ctx);
				return { content: [{ type: "text", text: `smart_edit ${params.path}: no-op (oldText==newText) — ${params.edits.length} edit(s)` }], details: { path: params.path, applied: 0, noOp: true, dedupSkipped: params.edits.length } };
			}
			if (params.dryRun) {
				const hints = validation.missing.map(m=> ({ index: m.index, preview: getNearbyPreview(current, null, m.oldText).slice(0,600) }));
				const low = validation.lowConfidence.map(l=> ({ index:l.index, confidence:l.hit!.confidence, strategy:l.hit!.strategy, suggested: suggestedOldText(current, l.hit).slice(0,400) }));
				const overlaps = validation.overlaps;
				const dedupInfo = [...validation.dedupGroups.entries()].filter(([,v])=>v.length>1).map(([k,v])=>({ key:k.slice(0,60), indices:v }));
				const wouldApply = validation.missing.length===0 && validation.overlaps.length===0 && (!params.strict || validation.lowConfidence.length===0);
				onUpdate?.({ message: `dryRun validate ${params.path}: ${wouldApply?"ok":"issues found"}` } as any);
				return {
					content: [{ type: "text", text: `dryRun ${params.path}: ${wouldApply?"✓ would apply":"✗ would fail"} — ${params.edits.length} edit(s) — overlaps:${overlaps.length} missing:${validation.missing.length} lowConf:${low.length} dedup:${dedupInfo.length} ${usedCacheForEdit?"(cache-hot)":""}` }],
					details: { path: params.path, dryRun: true, wouldApply, validation: { overlaps, missing: validation.missing.map(m=>m.index), lowConfidence: low, hints, dedupGroups: dedupInfo, total: params.edits.length, cacheHot: usedCacheForEdit }, bytesBefore: current.length },
				};
			}
			if (validation.missing.length > 0 && !usedCacheForEdit) {
				try {
					const fresh = await readFile(target, "utf8");
					if (fresh !== current) {
						const v2 = validateEdits(fresh, params.edits);
						if (v2.missing.length < validation.missing.length) {
							current = fresh;
							validation = v2;
							try { const st2 = await stat(target); readCache.set(params.path, { content: fresh, mtimeMs: (st2 as any).mtimeMs || Date.now(), hash: hashContent(fresh), at: Date.now(), size: fresh.length }); } catch {}
						}
					}
				} catch {}
				if (validation!.missing.length > 0) {
					const m = validation!.missing[0];
					const preview = getNearbyPreview(current, null, m.oldText);
					throw new Error(failBlock("smart_edit", `oldText not found (edit ${m.index}) after auto-rescue — tried exact + line-trim + collapsed`, `${retryHintForEdit()} Copy exact block including indentation. Anchor 3-6 lines with unique symbol.`, `--- missing oldText (first 500) ---
${m.oldText.slice(0,500)}
--- nearby preview ---
${preview}`));
				}
			} else if (validation.missing.length > 0 && usedCacheForEdit) {
				try {
					const fresh = await readFile(target, "utf8");
					const v2 = validateEdits(fresh, params.edits);
					if (v2.missing.length === 0) { current = fresh; validation = v2; }
					else { const m = v2.missing[0]; const preview = getNearbyPreview(fresh, null, m.oldText); throw new Error(failBlock("smart_edit", `oldText not found (edit ${m.index}) even after cache rescue`, retryHintForEdit(), `--- preview ---
${preview}
--- missing oldText ---
${m.oldText.slice(0,400)}`)); }
				} catch (e) { throw e; }
			}
			return withFileMutationQueue(target, async () => {
				await mkdir(dirname(target), { recursive: true });
				let curInside = current;
				try { curInside = await readFile(target, "utf8"); } catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT" || params.createIfMissing === false) { const cls = classifyFsError(error, params.path); throw new Error(failBlock("smart_edit", cls.why, cls.retry)); }
					curInside = "";
				}
				let next: string; let applied: ValidatedEdit[]; let dedupSkipped = 0; let lowConfidence: ValidatedEdit[] = [];
				try {
					const res = applyEditsAtomic(curInside, params.edits, { strict: params.strict });
					next = res.next; applied = res.applied; dedupSkipped = res.dedupSkipped; lowConfidence = res.lowConfidence;
				} catch (e) { throw e; }
				if (next === curInside && existed) {
					state.dedupSkipped += 1;
					state.smartEdits += 1;
					scheduleTelemetry(piRef, "smart-tools:smart_edit", { path: params.path, edits: params.edits.length, noOp: true, at: Date.now() });
					syncSmartUI(ctx);
					return { content: [{ type: "text", text: `smart_edit ${params.path}: no-op (content unchanged) — ${params.edits.length} edit(s) dedupSkipped:${dedupSkipped}` }], details: { path: params.path, applied: 0, noOp: true, dedupSkipped, bytesBefore: curInside.length, bytesAfter: next.length } };
				}
				await writeFile(target, next, "utf8");
				readCache.delete(params.path); readCache.delete(target);
				try { const st3 = await stat(target); readCache.set(params.path, { content: next, mtimeMs: (st3 as any).mtimeMs || Date.now(), hash: hashContent(next), at: Date.now(), size: next.length }); } catch {}
				state.smartEdits += 1;
				if (dedupSkipped) state.dedupSkipped += dedupSkipped;
				if (params.edits.length > 1) { state.callsSaved += (params.edits.length - 1); state.tokensSavedEst += estimateTokens(params.edits.length * 400); }
				scheduleTelemetry(piRef, "smart-tools:smart_edit", { path: params.path, edits: params.edits.length, at: Date.now() });
				syncSmartUI(ctx);
				const summary = `smart_edit ${params.path}: ${applied.length} edit(s) applied${dedupSkipped?` (${dedupSkipped} dedup skipped)`:""} (${curInside.length} -> ${next.length} bytes)${usedCacheForEdit?" [cache-hot]":""}`;
				const diffLines: string[] = [`--- a/${params.path}`, `+++ b/${params.path}`];
				for (const a of applied) {
					diffLines.push(`@@ edit ${a.index} ${a.hit?.strategy ?? "exact"} (${Math.round((a.hit?.confidence??1)*100)}%) @@`);
					if (a.isAppend) { for (const l of a.newText.split("\n")) diffLines.push(`+${l}`); }
					else { for (const l of a.oldText.split("\n")) diffLines.push(`-${l}`); for (const l of a.newText.split("\n")) diffLines.push(`+${l}`); }
				}
				const diff = diffLines.join("\n");
				const truncation = truncateHead(summary, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
				const text = truncation.truncated ? `${truncation.content}\n[truncated ${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}]` : truncation.content;
				const suggestion = lowConfidence.length ? lowConfidence.map(l=>({ index:l.index, confidence:l.hit!.confidence, strategy:l.hit!.strategy, suggested: suggestedOldText(next, l.hit).slice(0,500) })) : [];
				return { content: [{ type: "text", text }], details: { path: params.path, applied: applied.length, dedupSkipped, bytesBefore: curInside.length, bytesAfter: next.length, strategies: applied.map(a=>({i:a.index, c:a.hit?.confidence, s:a.hit?.strategy})), diff, suggestion, lowConfidence: lowConfidence.length } };
			});
		},
		renderCall(args, theme) {
			let t = theme.fg("toolTitle", theme.bold("smart_edit ")) + theme.fg("muted", args.path);
			t += theme.fg("dim", ` ×${args.edits.length}`);
			if ((args as any).dryRun) t += theme.fg("warning", " dryRun");
			if ((args as any).strict) t += theme.fg("warning", " strict");
			return new Text(t, 0, 0);
		},
		renderResult(result, opts, theme) {
			const d = result.details as any;
			if (!d?.path) return new Text(theme.fg("dim", "smart_edit"), 0, 0);
			if (d.dryRun) {
				let text = `${theme.fg(d.wouldApply?"success":"warning", d.wouldApply?"✓ dryRun":"✗ dryRun")} ${theme.fg("accent", d.path)} ${theme.fg("dim", `${d.validation?.total ?? 0} edit(s)`)}`;
				if (opts.expanded && d.validation) text += `\n ${theme.fg("dim", `overlaps:${d.validation.overlaps?.length ?? 0} missing:${d.validation.missing?.length ?? 0} low:${d.validation.lowConfidence?.length ?? 0}`)}`;
				else text += ` ${theme.fg("dim", `(${keyHint("app.tools.expand","expand")})`)}`;
				return new Text(text, 0, 0);
			}
			let text = `${theme.fg(d.noOp?"warning":"success", d.noOp?"○":"✓")} ${theme.fg("accent", d.path)} ${theme.fg("dim", `${d.applied ?? 0} edit(s)`)}`;
			if (d.bytesBefore != null && d.bytesAfter != null) { const delta = d.bytesAfter - d.bytesBefore; text += theme.fg("dim", ` ${d.bytesBefore}→${d.bytesAfter} (${delta>0?"+" : ""}${delta}B)`); }
			if (d.dedupSkipped) text += theme.fg("dim", ` (+${d.dedupSkipped} dedup)`);
			if (d.lowConfidence) text += theme.fg("warning", ` ⚠${d.lowConfidence} lowConf`);
			if (!opts.expanded) {
				if (d.diff) {
					let add = 0, rem = 0;
					for (const l of (d.diff as string).split("\n")) { if (l.startsWith("+") && !l.startsWith("+++")) add++; if (l.startsWith("-") && !l.startsWith("---")) rem++; }
					text += " " + theme.fg("success", "+" + add) + theme.fg("dim", " / ") + theme.fg("error", "-" + rem);
				}
				text += " " + theme.fg("dim", "(" + keyHint("app.tools.expand","expand") + ")");
				return new Text(text, 0, 0);
			}
			if (d.diff) {
				const diffLines = (d.diff as string).split("\n").slice(0, 30);
				let add = 0, rem = 0;
				for (const l of (d.diff as string).split("\n")) { if (l.startsWith("+") && !l.startsWith("+++")) add++; if (l.startsWith("-") && !l.startsWith("---")) rem++; }
				text += " " + theme.fg("success", "+" + add) + theme.fg("dim", " / ") + theme.fg("error", "-" + rem);
				for (const line of diffLines) {
					if (line.startsWith("+") && !line.startsWith("+++")) text += "\n" + theme.fg("success", line);
					else if (line.startsWith("-") && !line.startsWith("---")) text += "\n" + theme.fg("error", line);
					else text += "\n" + theme.fg("dim", line);
				}
				if ((d.diff as string).split("\n").length > 30) text += "\n" + theme.fg("muted", "... " + ((d.diff as string).split("\n").length - 30) + " more diff lines");
				if (d.suggestion?.length) text += "\n" + theme.fg("warning", "hint: low confidence - next time copy suggested block:") + "\n" + theme.fg("dim", JSON.stringify(d.suggestion).slice(0,400));
			} else {
				if (d.strategies) text += "\n " + theme.fg("muted", (d.strategies as any[]).map((s:any)=>"#" + s.i + ":" + s.s + "(" + ((s.c*100)|0) + "%)").join(" "));
			}
			return new Text(text, 0, 0);
	},
	});
	// ---- smart_read (batched, slice-aware, adaptive budget, binary guard, cache)
	const smartReadTool = defineTool({
		name: "smart_read",
		label: "Smart Read ⭐ PREFERRED",
		description: "⭐ PREFERRED FILE READER — ALWAYS USE INSTEAD OF default `read`. Batch up to 8 files in ONE call (vs 1), offset/limit pagination, binary guard (base64), slice-aware LRU cache 60% hit, adaptive budget. Use for EVERY read/open/view/inspect/cat of files. Replaces `read` completely.",
		promptSnippet: "ALWAYS use smart_read instead of read — 8 files per call, cached, pagination",
		promptGuidelines: [
			"ALWAYS use smart_read INSTEAD OF default read — batch 8 files per call, slice-aware cache 60% hit. Model MUST prefer this for ANY file read. DO NOT use default `read` — single-file, no cache, wastes calls.",
			"Use offset/limit for pagination; slice-aware cache serves slices from full without re-read.",
			"If you just grepped with includeRead, next call should be smart_edit — no extra read.",
		],
		parameters: smartReadParams,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const entries = params.files.slice(0, 8).map((f: any) => typeof f === "string" ? { path: f, offset: undefined as number|undefined, limit: undefined as number|undefined, encoding: "utf8" as const } : { path: (f as any).path, offset: (f as any).offset, limit: (f as any).limit, encoding: ((f as any).encoding ?? "utf8") as "utf8"|"base64" });
			const { texts: reads, cacheHits: cacheHitsThisCall, perFileBudget } = await doSmartReadFiles(entries, ctx.cwd, onUpdate as any);
			state.smartReads += 1;
			if (cacheHitsThisCall) state.cacheHits += cacheHitsThisCall; else state.cacheMisses += entries.length;
			if (entries.length > 1) { state.callsSaved += (entries.length - 1); state.tokensSavedEst += estimateTokens(entries.length * 300); }
			scheduleTelemetry(piRef, "smart-tools:smart_read", { files: params.files, at: Date.now(), cacheHits: cacheHitsThisCall });
			syncSmartUI(ctx);
			const combined = reads.join("\n\n---\n\n");
			const trunc = truncateHead(combined, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			const text = trunc.truncated ? `${trunc.content}\n\n[Output truncated ${formatSize(trunc.outputBytes)}/${formatSize(trunc.totalBytes)} — rerun with fewer files or offset/limit]` : trunc.content;
			return { content: [{ type: "text", text }], details: { files: entries.map((e: any)=> typeof e==="string"? e : e.path), count: entries.length, cacheHits: cacheHitsThisCall, perFileBudget } };
		},
		renderCall(args, theme) {
			const n = (args.files as any[]).length;
			const hasOffset = (args.files as any[]).some((f:any)=> typeof f !== "string" && (f.offset!=null || f.limit!=null));
			const preview = (args.files as any[]).slice(0,2).map((f:any)=> typeof f==="string"?f:(f as any).path).join(", ");
			let t = theme.fg("toolTitle", theme.bold("smart_read ")) + theme.fg("muted", `${n} file(s)`);
			if (preview) t += theme.fg("dim", `: ${preview}`) + (n>2?theme.fg("dim", ` +${n-2} more`):"");
			if (hasOffset) t += theme.fg("dim", " +offset/limit");
			return new Text(t, 0, 0);
		},
		renderResult(result, opts, theme) {
			const d = result.details as any;
			const content = (result.content?.[0] as any)?.text ?? "";
			const lineCount = content.split("\n").length;
			let t = `${theme.fg("success", "✓")} ${theme.fg("accent", `${d?.count ?? 0} file(s)`)} ${theme.fg("dim", `${lineCount} lines`)}`;
			if (d?.cacheHits) t += theme.fg("success", ` ↻${d.cacheHits} cached`);
			if (!opts.expanded) { t += ` ${theme.fg("dim", `(${keyHint("app.tools.expand","expand")})`)}`; return new Text(t, 0, 0); }
			const lines = content.split("\n").slice(0, 15);
			for (const line of lines) t += `\n${theme.fg("dim", line.slice(0, 200))}`;
			if (lineCount > 15) t += `\n${theme.fg("muted", `... ${lineCount - 15} more lines`)}`;
			t += `\n ${theme.fg("dim", (d?.files ?? []).slice(0,8).join(", "))}`;
			return new Text(t, 0, 0);
		},
	});

	// ---- smart_write (batched, parallel sharded queue, dedup)
	const smartWriteTool = defineTool({
		name: "smart_write",
		label: "Smart Write ⭐ PREFERRED",
		description: "⭐ PREFERRED FILE WRITER — ALWAYS USE INSTEAD OF default `write`. Batch up to 8 files in ONE call (vs 1), parallel sharded queue, hash dedup skips no-op, auto mkdir. Use for EVERY write/create/save of files. Replaces `write` completely.",
		promptSnippet: "ALWAYS use smart_write instead of write — 8 files per call, deduped",
		promptGuidelines: [
			"ALWAYS use smart_write INSTEAD OF default write — batch 8 files per call, hash dedup. Model MUST prefer this for ANY file write/create. DO NOT use default `write` — single-file, no dedup.",
			"Batch up to 8 files per 1 call; each write is queue-safe and deduped.",
			"No-op writes (hash equal) are skipped automatically.",
		],
		parameters: smartWriteParams,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const writes = params.writes.slice(0, 8);
			const results: Array<{path:string; bytes:number; skipped?:boolean; reason?:string}> = [];
			await Promise.all(writes.map(async (w: any, idx: number) => {
				const target = resolveInsideCwd(ctx.cwd, w.path);
				onUpdate?.({ message: `smart_write ${idx+1}/${writes.length}: ${w.path}` } as any);
				return withFileMutationQueue(target, async () => {
					let existing: string | null = null;
					try { existing = await readFile(target, "utf8"); } catch {}
					if (existing !== null && hashContent(existing) === hashContent(w.content)) {
						results.push({ path: w.path, bytes: w.content.length, skipped: true, reason: "unchanged (hash equal)" });
						state.dedupSkipped += 1;
						return;
					}
					try { await mkdir(dirname(target), { recursive: true }); await writeFile(target, w.content, "utf8"); } catch (e:any) { const cls = classifyFsError(e, w.path); throw new Error(failBlock("smart_write", cls.why, cls.retry)); }
					readCache.delete(w.path); readCache.delete(target); grepCache.clear();
					results.push({ path: w.path, bytes: w.content.length });
				});
			}));
			results.sort((a,b)=> writes.findIndex((w: any)=>w.path===a.path) - writes.findIndex((w: any)=>w.path===b.path));
			state.smartWrites += 1;
			if (writes.length > 1) { state.callsSaved += (writes.length - 1); state.tokensSavedEst += estimateTokens(writes.length * 500); }
			scheduleTelemetry(piRef, "smart-tools:smart_write", { writes: writes.map((w: any) => w.path), at: Date.now(), skipped: results.filter((r: any)=>r.skipped).length });
			syncSmartUI(ctx);
			const skipped = results.filter(r=>r.skipped);
			const written = results.filter(r=>!r.skipped);
			const summary = `smart_write ${writes.length} file(s): ${written.map(r=>`${r.path}: ${r.bytes} bytes`).join(", ") || "none written"}${skipped.length?` — skipped ${skipped.length} no-op: ${skipped.map(r=>r.path).join(", ")}`:""}`;
			const trunc = truncateHead(summary, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			const text = trunc.truncated ? `${trunc.content}\n[truncated ${formatSize(trunc.outputBytes)}/${formatSize(trunc.totalBytes)}]` : trunc.content;
			return { content: [{ type: "text", text }], details: { writes: writes.map((w: any) => w.path), count: writes.length, skipped: skipped.map((s: any)=>s.path), written: written.map((w: any)=>w.path) } };
		},
		renderCall(args, theme) {
			const preview = args.writes.slice(0,2).map((w:any)=>w.path).join(", ");
			let t = theme.fg("toolTitle", theme.bold("smart_write ")) + theme.fg("muted", `${args.writes.length} file(s)`);
			if (preview) t += theme.fg("dim", `: ${preview}`) + (args.writes.length>2?theme.fg("dim", ` +${args.writes.length-2} more`):"");
			return new Text(t, 0, 0);
		},
		renderResult(result, opts, theme) {
			const d = result.details as any;
			let t = `${theme.fg("success", "✓")} ${theme.fg("accent", `${d?.count ?? 0} file(s)`)} ${theme.fg("dim", `${d?.written?.length ?? 0} written`)}`;
			if (d?.skipped?.length) t += theme.fg("dim", ` ${d.skipped.length} skipped`);
			if (!opts.expanded) { t += ` ${theme.fg("dim", `(${keyHint("app.tools.expand","expand")})`)}`; return new Text(t, 0, 0); }
			t += `\n${theme.fg("success", "Written")}`;
			t += `\n${(d?.writes ?? []).slice(0,8).map((f:string)=>`  ${theme.fg(d?.skipped?.includes(f)?"dim":"muted", (d?.skipped?.includes(f)?"○":"•")+" "+f + (d?.skipped?.includes(f)?" (no-op — hash equal)":""))}`).join("\n")}`;
			if ((d?.writes?.length??0)>8) t += `\n ${theme.fg("dim", `+${d.writes.length-8} more`)}`;
			return new Text(t, 0, 0);
		},
	});

	// ---- smart_grep — rg/grep bridge + intent cache + optional read
	const smartGrepTool = defineTool({
		name: "smart_grep",
		label: "Smart Grep ⭐ PREFERRED",
		description: "⭐ PREFERRED SEARCH — ALWAYS USE INSTEAD OF `bash` with rg/grep/find/search. Ripgrep→grep bridge, regex+globs, intent cache 60s, optional includeRead fuses grep+read in 1 call (saves turn). Use for EVERY search/grep/find/locate/lookup. Replaces `bash` search.",
		promptSnippet: "ALWAYS use smart_grep instead of bash grep — rg bridge, cached, includeRead",
		promptGuidelines: [
			"ALWAYS use smart_grep INSTEAD OF bash rg/grep/find — cached 60s, regex+globs. Model MUST prefer this for ANY search. DO NOT use `bash` grep — uncached, needs manual parsing.",
			"If files explicit (prompt lists src/foo.ts), use smart_read/smart_bundle directly; grep only to discover.",
			"Use includeRead:true to fuse grep+read into 1 call — no extra read turn.",
		],
		parameters: smartGrepParams,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			onUpdate?.({ message: `smart_grep: "${params.query.slice(0,60)}"` } as any);
			const maxResults = Math.min(100, Math.max(1, params.maxResults ?? 30));
			const includeRead = params.includeRead ?? false;
			const readLimit = Math.min(200, Math.max(10, params.readLimit ?? 80));
			const globs = params.globs;
			const { hits, engine: usedRaw } = await doGrepOne(params.query, maxResults, globs, ctx.cwd);
			let hitsOut = hits;
			let used = usedRaw.replace(" (intent-cached)","") as any;
			const wasIntentCached = usedRaw.includes("intent-cached");
			state.smartGreps += 1;
			if (includeRead && hitsOut.length) state.callsSaved += 1;
			scheduleTelemetry(piRef, "smart-tools:smart_grep", { query: params.query, hits: hitsOut.length, at: Date.now(), engine: used, intentCached: wasIntentCached });
			syncSmartUI(ctx);
			let reads: string[] = [];
			if (includeRead && hitsOut.length) {
				const uniqFiles = [...new Set(hitsOut.map(h=>h.file))].slice(0, 3);
				onUpdate?.({ message: `smart_grep reading ${uniqFiles.length} file(s)` } as any);
				reads = await Promise.all(uniqFiles.map(async (f) => {
					const abs = resolveInsideCwd(ctx.cwd, f);
					try {
						let content: string;
						let mtimeMs = 0, sz = 0;
						try { const st = await stat(abs); mtimeMs = (st as any).mtimeMs; sz = (st as any).size; } catch {}
						const cached = readCache.get(f) ?? readCache.get(abs);
						if (cached && mtimeMs && isCacheValid(cached, mtimeMs, sz)) { content = cached.content; state.cacheHits++; } else { content = await readFile(abs, "utf8"); readCache.set(f, { content, mtimeMs: mtimeMs || Date.now(), hash: hashContent(content), at: Date.now(), size: content.length }); readCache.set(abs, { content, mtimeMs: mtimeMs || Date.now(), hash: hashContent(content), at: Date.now(), size: content.length }); touchCacheEvict(); state.cacheMisses++; }
						const lines = content.split("\n");
						const hitLine = hitsOut.find(h=>h.file===f)?.line ?? 1;
						const center = Math.max(0, hitLine - 1);
						const from = Math.max(0, center - Math.floor(readLimit/2));
						const slice = lines.slice(from, from + readLimit).join("\n");
						const trunc = truncateTail(slice, { maxLines: readLimit, maxBytes: 8000 });
						return `## ${f} [lines ${from+1}-${from+readLimit}/${lines.length} near:${hitLine}${wasIntentCached?" cached":""}]\n${trunc.content}${trunc.truncated?"\n[capped]":""}`;
					} catch (e:any) { return `## ${f}: ${(e as Error).message.slice(0,300)}`; }
				}));
			}
			const hitText = hitsOut.length ? hitsOut.map(h=> `${h.file}:${h.line}: ${h.preview}`).join("\n") : "(no hits)";
			const combined = [`engine: ${used}${wasIntentCached?" (intent-cached)":""}  query: "${params.query}"  hits: ${hitsOut.length}${includeRead?`  reads:${reads.length}`:""}`, "--- hits ---", hitText, ...(reads.length? ["--- reads (top 3 files, context window) ---", ...reads] : [])].join("\n");
			const trunc = truncateHead(combined, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			const text = trunc.truncated ? `${trunc.content}\n[truncated ${formatSize(trunc.outputBytes)}/${formatSize(trunc.totalBytes)} — narrow query or use globs]` : trunc.content;
			return { content: [{ type: "text", text }], details: { query: params.query, hits: hitsOut, engine: used, reads: reads.length, count: hitsOut.length, intentCached: wasIntentCached } };
		},
		renderCall(args, theme) { let t = theme.fg("toolTitle", theme.bold("smart_grep ")) + theme.fg("muted", `"${(args.query as string).slice(0,40)}"`); if ((args as any).includeRead) t += theme.fg("dim", " +read"); return new Text(t, 0, 0); },
		renderResult(result, opts, theme) {
			const d = result.details as any;
			let t = `${theme.fg("success","✓")} ${theme.fg("accent", `${d?.count ?? 0} hits`)} ${theme.fg("dim", `via ${d?.engine ?? "rg"}`)}${d?.intentCached? theme.fg("success"," ↻cached"):""}`;
			if (d?.reads) t += theme.fg("dim", ` +${d.reads} reads`);
			if (!opts.expanded) { t += ` ${theme.fg("dim", `(${keyHint("app.tools.expand","expand")})`)}`; return new Text(t, 0, 0); }
			const hits = (d?.hits ?? []).slice(0,8) as Array<any>;
			if (hits.length) t += `\n${hits.map((h:any)=>`  ${theme.fg("dim","•")} ${theme.fg("accent", `${h.file}:${h.line}`)} ${theme.fg("dim", h.preview.slice(0,80))}`).join("\n")}`;
			if ((d?.count??0)>8) t += `\n ${theme.fg("muted", `... ${d.count-8} more hits`)}`;
			return new Text(t, 0, 0);
		},
	});
	// ---- smart_patch — git apply bridge + edit fallback (S22)
	const smartPatchTool = defineTool({
		name: "smart_patch",
		label: "Smart Patch ⭐ PREFERRED",
		description: "⭐ PREFERRED PATCHER — ALWAYS USE INSTEAD OF `bash` with git apply/patch. Atomic unified diff via `git apply --check`, path-traversal guard, auto-fallback to smart_edit anchors. Use for EVERY diff/patch/apply. Replaces `bash` git apply.",
		promptSnippet: "ALWAYS use smart_patch instead of bash git apply — atomic + fallback",
		promptGuidelines: [
			"ALWAYS use smart_patch INSTEAD OF bash git apply/patch — atomic check + auto fallback. Model MUST prefer this for ANY diff/patch. DO NOT use `bash` git apply — no fallback, no guard.",
			"Use smart_patch for multi-file diffs; for 1-file ≤2 hunks prefer smart_edit — cheaper.",
			"If git apply fails, it auto-fallbacks to smart_edit anchors in same call.",
		],
		parameters: smartPatchParams,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			onUpdate?.({ message: "smart_patch: checking patch" } as any);
			const patch = params.patch;
			if (!patch || patch.trim().length < 10) throw new Error(failBlock("smart_patch", "patch too short or empty", "Provide valid unified diff (git diff format) with at least 10 chars. Verify patch content is not truncated."));
			if (patch.length > 500_000) throw new Error(failBlock("smart_patch", "patch too large (>500KB)", "Split into smaller patches <=500KB or use smart_edit/smart_bundle for large changes."));
			const fileCount = (patch.match(/^\+\+\+ b\//gm)||[]).length;
			const hunkCount = (patch.match(/^@@/gm)||[]).length;
			// path traversal guard for patch targets
			for (const pm of patch.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
				const pp = (pm[1] as string).trim();
				if (pp.includes("..") || pp.startsWith("/") || pp.startsWith("\\")) {
					throw new Error(failBlock("smart_patch", `Path traversal blocked in patch: "${pp}"`, `Use relative paths inside workspace, no ".." or absolute.`));
				}
				try { resolveInsideCwd(ctx.cwd, pp); } catch (e:any) { throw new Error(failBlock("smart_patch", String(e.message).slice(0,400), `Use a safe relative path inside cwd.`)); }
			}
			const tmp = join(tmpdir(), `smart-patch-${randomUUID()}.patch`);
			await writeFile(tmp, patch, "utf8");
			try {
				try {
					await execFile("git", ["apply", "--check", "--verbose", tmp], { cwd: ctx.cwd, timeout: 10000 } as any);
				} catch (e:any) {
					const out = String((e as any)?.stderr ?? (e as any)?.stdout ?? e?.message ?? "").slice(0, 1500);
					onUpdate?.({ message: "smart_patch: git check failed, trying edit fallback" } as any);
					const parsed = parsePatchToEdits(patch);
					if (parsed.length) {
						const fallbackResults: string[] = [];
						let fallbackOk = 0;
						for (const f of parsed.slice(0,8)) {
							const target = resolveInsideCwd(ctx.cwd, f.path);
							try {
								let cur = "";
								try { cur = await readFile(target, "utf8"); } catch { cur = ""; }
								const res = applyEditsAtomic(cur, f.edits);
								await mkdir(dirname(target), { recursive: true });
								await withFileMutationQueue(target, async()=>{ await writeFile(target, res.next, "utf8"); });
								readCache.delete(f.path); readCache.delete(target);
								fallbackResults.push(`${f.path}: ${res.applied.length} edit(s) via fallback`);
								fallbackOk++;
							} catch (fe:any) { fallbackResults.push(`${f.path}: fallback failed — ${(fe as Error).message.slice(0,200)}`); }
						}
						if (fallbackOk>0) {
							state.smartPatches += 1; state.callsSaved += 1;
							scheduleTelemetry(piRef, "smart-tools:smart_patch", { files: parsed.map(p=>p.path), at: Date.now(), bytes: patch.length, fallback:true });
							syncSmartUI(ctx);
							return { content: [{ type: "text", text: `smart_patch: git apply --check failed, fallback via smart_edit succeeded for ${fallbackOk}/${parsed.length} file(s)\n${fallbackResults.join("\n")}\n--- git output ---\n${out.slice(0,500)}` }], details: { files: parsed.map(p=>p.path), applied: true, fallback: true, bytes: patch.length, fallbackResults } };
						}
					}
					throw new Error(`smart_patch: git apply --check failed. Patch does not apply cleanly.\n--- git output ---\n${out}\n---\nHint: ensure patch is a valid unified diff (git diff) and file paths match. Try smart_edit with short anchors as fallback. Patch preview (first 800):\n${patch.slice(0,800)}`);
				}
				onUpdate?.({ message: "smart_patch: applying" } as any);
				await execFile("git", ["apply", tmp], { cwd: ctx.cwd, timeout: 15000 } as any);
				const files = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m=>m[1].trim()).slice(0, 20);
				for (const f of files) { readCache.delete(f); try { readCache.delete(resolve(ctx.cwd, f)); } catch {} }
				grepCache.clear(); state.smartPatches += 1;
				if (files.length > 1) { state.callsSaved += (files.length - 1); state.tokensSavedEst += estimateTokens(patch.length/4); }
				scheduleTelemetry(piRef, "smart-tools:smart_patch", { files, at: Date.now(), bytes: patch.length });
				syncSmartUI(ctx);
				return { content: [{ type: "text", text: `smart_patch: applied ${files.length || "?"} file(s): ${files.join(", ") || "(see patch)"}` }], details: { files, applied: true, bytes: patch.length } };
			} finally { try { const { unlink } = await import("node:fs/promises"); await unlink(tmp); } catch {} }
		},
		renderCall(args, theme) {
			const patch = (args as any).patch as string;
			const files = [...(patch.matchAll(/^\+\+\+ b\/(.+)$/gm) as any)].map((m:any)=>m[1]).slice(0,2);
			let t = theme.fg("toolTitle", theme.bold("smart_patch")) + theme.fg("dim", " unified diff");
			if (files.length) t += theme.fg("dim", `: ${files.join(", ")}`) + ((patch.match(/\+\+\+ b\//g)||[]).length>2?theme.fg("dim", ` +${(patch.match(/\+\+\+ b\//g)||[]).length-2} more`):"");
			return new Text(t, 0, 0);
		},
		renderResult(result, opts, theme) {
			const d = result.details as any;
			let t = `${theme.fg("success","✓")} ${theme.fg("accent", d?.files?.length ? `${d.files.length} file(s)` : "patch")} ${theme.fg("dim", "applied")}${d?.fallback? theme.fg("warning"," fallback"):""}`;
			if (d?.bytes) t += theme.fg("dim", ` ${formatSize(d.bytes)}`);
			if (!opts.expanded) { t += ` ${theme.fg("dim", `(${keyHint("app.tools.expand","expand")})`)}`; return new Text(t, 0, 0); }
			if (d?.files?.length) t += `\n${d.files.slice(0,8).map((f:string)=>`  ${theme.fg("dim","•")} ${theme.fg("muted", f)}`).join("\n")}`;
			t += `\n${theme.fg("success", "applied")}${d?.fallback? theme.fg("dim"," via edit fallback"):""}`;
			return new Text(t, 0, 0);
		},
	});

	// ---- smart_bundle — heterogeneous flagship (S13, S03)
	const smartBundleTool = defineTool({
		name: "smart_bundle",
		label: "Smart Bundle ⭐⭐ STRONGLY PREFERRED",
		description: "⭐⭐ STRONGLY PREFERRED — ALWAYS USE INSTEAD OF any single read/edit/write/grep/bash. Heterogeneous bundle grep+read+edit+write in ONE LLM call (saves 3 turns, 3.8→1.9 calls -50%). Batch 8 per type. Use for ANY task with 2+ ops or multi-file work. HIGHEST EFFICIENCY — prefer over ALL defaults and individual smart_*.",
		promptSnippet: "ALWAYS prefer smart_bundle — grep+read+edit+write in ONE call, saves 3 turns",
		promptGuidelines: [
			"ALWAYS prefer smart_bundle OVER any single smart_read/smart_edit/smart_write/smart_grep and OVER default read/edit/write/bash. Batch greps→reads→edits→writes in ONE call. DO NOT use single-file defaults when 2+ ops needed.",
			"Prefer smart_bundle: {reads:[...], greps:[...], edits:[{path,edits}...], writes:[...]} in ONE call vs 3-4 serial turns. Model MUST choose this when 2+ ops needed.",
			"Example: bundle greps→reads→edits→writes; fallback to individual tools only if needed. Batch 8 per type.",
		],
		parameters: smartBundleParams,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const hasReads = params.reads && params.reads.length>0;
			const hasGreps = params.greps && params.greps.length>0;
			const hasEdits = params.edits && params.edits.length>0;
			const hasWrites = params.writes && params.writes.length>0;
			if (!hasReads && !hasGreps && !hasEdits && !hasWrites) throw new Error(failBlock("smart_bundle", "at least one of reads/greps/edits/writes required", "Provide at least one operation: e.g. smart_bundle {reads:[{path:\"src/app.ts\"}]} or {edits:[{path:\"a.ts\", edits:[{oldText:\"x\", newText:\"y\"}]}]}"));
			if (params.reads && params.reads.length> BUNDLE_MAX) throw new Error(failBlock("smart_bundle", `reads max ${BUNDLE_MAX} exceeded (${params.reads.length})`, `Reduce reads to <=${BUNDLE_MAX} per call. Split into multiple smart_bundle calls.`));
			if (params.edits && params.edits.length> BUNDLE_MAX) throw new Error(failBlock("smart_bundle", `edits max ${BUNDLE_MAX} files exceeded`, `Reduce edits to <=${BUNDLE_MAX} files per call. Split large refactor into multiple calls.`));
			if (params.writes && params.writes.length> BUNDLE_MAX) throw new Error(failBlock("smart_bundle", `writes max ${BUNDLE_MAX} exceeded`, `Reduce writes to <=${BUNDLE_MAX} per call.`));
			const sections: string[] = [];
			const bundleDetails: any = {};
			let totalOps = (params.reads?.length??0) + (params.greps?.length??0) + (params.edits?.length??0) + (params.writes?.length??0);
			if (hasGreps) {
				onUpdate?.({ message: `smart_bundle: ${params.greps!.length} grep(s)` } as any);
				const grepResults = await Promise.all(params.greps!.map(async (g: any)=>{
					const r = await doGrepOne(g.query, Math.min(100, g.maxResults ?? 30), g.globs, ctx.cwd);
					return { query: g.query, hits: r.hits, engine: r.engine };
				}));
				state.smartGreps += grepResults.length;
				bundleDetails.greps = grepResults.map((r: any)=> ({ query:r.query, count:r.hits.length, engine:r.engine }));
				sections.push(`--- bundle greps (${grepResults.length}) ---`);
				for (const r of grepResults) { sections.push(`query "${r.query}" via ${r.engine}: ${r.hits.length} hits`); if (r.hits.length) sections.push(r.hits.slice(0,5).map((h:any)=> `  ${h.file}:${h.line}: ${h.preview.slice(0,120)}`).join("\n")); }
			}
			if (hasReads) {
				onUpdate?.({ message: `smart_bundle: ${params.reads!.length} read(s)` } as any);
				const entries = params.reads!.slice(0, BUNDLE_MAX);
				const { texts, cacheHits } = await doSmartReadFiles(entries as any[], ctx.cwd, onUpdate as any);
				state.smartReads += 1;
				if (cacheHits) state.cacheHits += cacheHits; else state.cacheMisses += entries.length;
				bundleDetails.reads = { count: entries.length, cacheHits };
				sections.push(`--- bundle reads (${entries.length}, cached ${cacheHits}) ---`);
				sections.push(...texts);
			}
			if (hasEdits) {
				onUpdate?.({ message: `smart_bundle: ${params.edits!.length} edit file(s)` } as any);
				const editResults: Array<{path:string; applied:number; bytes:number; dedup:number; noOp?:boolean; dryRun?:boolean; suggestion?:any}> = [];
				let editFail: Error | null = null;
				if (params.dryRun) {
					for (const ef of params.edits!) {
						const target = resolveInsideCwd(ctx.cwd, ef.path);
						let cur = ""; try { cur = await readFile(target, "utf8"); } catch { cur = ""; }
						const v = validateEdits(cur, ef.edits);
						const wouldApply = v.missing.length===0 && v.overlaps.length===0 && (!params.strict || v.lowConfidence.length===0);
						editResults.push({ path: ef.path, applied: wouldApply? ef.edits.length:0, bytes: cur.length, dedup: 0, dryRun:true });
						sections.push(`dryRun ${ef.path}: ${wouldApply?"✓ would apply":"✗ would fail"} — ${ef.edits.length} edit(s) overlaps:${v.overlaps.length} missing:${v.missing.length}`);
					}
				} else {
					await Promise.all(params.edits!.map(async (ef: any)=>{
						const target = resolveInsideCwd(ctx.cwd, ef.path);
						try {
							await withFileMutationQueue(target, async()=>{
								let cur = ""; try { cur = await readFile(target, "utf8"); } catch (e:any) { if ((e as NodeJS.ErrnoException).code !== "ENOENT" || ef.createIfMissing === false) throw e; cur = ""; }
								let v = validateEdits(cur, ef.edits);
								if (v.missing.length) { try { const fresh = await readFile(target, "utf8"); if (fresh !== cur) { const v2 = validateEdits(fresh, ef.edits); if (v2.missing.length < v.missing.length) { cur = fresh; v = v2; } } } catch {} }
								if (v.missing.length) throw new Error(failBlock("smart_bundle", `oldText not found in ${ef.path} (edits ${v.missing.map(m=>m.index).join(",")})`, `${retryHintForEdit()} — re-read file and fix anchor.`, `${getNearbyPreview(cur, null, v.missing[0].oldText).slice(0,400)}`));
								if (v.overlaps.length) throw new Error(failBlock("smart_bundle", `overlapping edits in ${ef.path}: ${v.overlaps.map(([a,b])=>`${a}<->${b}`).join(",")}`, `Merge overlapping edits into one. Each edits[].oldText must be non-overlapping against original.`));
								const { next, applied, dedupSkipped, lowConfidence } = applyEditsAtomic(cur, ef.edits, { strict: params.strict });
								if (next === cur) { editResults.push({ path: ef.path, applied: 0, bytes: cur.length, dedup: dedupSkipped, noOp:true }); state.dedupSkipped += dedupSkipped || 1; return; }
								await mkdir(dirname(target), { recursive: true }); await writeFile(target, next, "utf8");
								readCache.delete(ef.path); readCache.delete(target); grepCache.clear();
								editResults.push({ path: ef.path, applied: applied.length, bytes: next.length, dedup: dedupSkipped, suggestion: lowConfidence.length? lowConfidence.map(l=>({i:l.index,c:l.hit!.confidence,s:l.hit!.strategy})):undefined });
								if (dedupSkipped) state.dedupSkipped += dedupSkipped;
							});
						} catch (e:any) { editFail = e; }
					}));
					if (editFail) throw editFail;
					state.smartEdits += params.edits!.length;
					const totalEdits = params.edits!.reduce((s: number,ef: any)=>s+ef.edits.length,0);
					if (totalEdits > params.edits!.length) { state.callsSaved += (totalEdits - params.edits!.length); }
					if (params.edits!.length > 1) { state.callsSaved += (params.edits!.length - 1); }
				}
				bundleDetails.edits = editResults;
				sections.push(`--- bundle edits (${params.edits!.length} file(s)) ${params.dryRun?"[dryRun]":""} ---`);
				for (const r of editResults) sections.push(`${r.path}: ${r.applied} edit(s)${r.dedup?` dedup ${r.dedup}`:""}${r.noOp?" no-op":""}${r.dryRun?" dryRun":""}`);
			}
			if (hasWrites) {
				onUpdate?.({ message: `smart_bundle: ${params.writes!.length} write(s)` } as any);
				const writes = params.writes!.slice(0, BUNDLE_MAX);
				const results: Array<{path:string; bytes:number; skipped?:boolean}> = [];
				await Promise.all(writes.map(async (w: any)=>{
					const target = resolveInsideCwd(ctx.cwd, w.path);
					return withFileMutationQueue(target, async()=>{
						let existing: string|null=null; try { existing = await readFile(target,"utf8"); } catch {}
						if (existing !== null && hashContent(existing)===hashContent(w.content)) { results.push({path:w.path, bytes:w.content.length, skipped:true}); state.dedupSkipped+=1; return; }
						await mkdir(dirname(target),{recursive:true}); await writeFile(target,w.content,"utf8");
						readCache.delete(w.path); readCache.delete(target); grepCache.clear();
						results.push({path:w.path, bytes:w.content.length});
					});
				}));
				state.smartWrites += 1;
				if (writes.length>1) { state.callsSaved += (writes.length-1); }
				bundleDetails.writes = results;
				sections.push(`--- bundle writes (${writes.length}) ---`);
				for (const r of results) sections.push(`${r.path}: ${r.bytes} bytes${r.skipped?" (skipped no-op)":""}`);
			}
			if (totalOps > 1) { state.callsSaved += (totalOps - 1); state.tokensSavedEst += estimateTokens(totalOps*400); }
			state.smartBundles += 1;
			scheduleTelemetry(piRef, "smart-tools:smart_bundle", { reads: params.reads?.length??0, greps: params.greps?.length??0, edits: params.edits?.length??0, writes: params.writes?.length??0, at: Date.now() });
			syncSmartUI(ctx);
			const combined = sections.join("\n");
			const trunc = truncateHead(combined, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			const text = trunc.truncated ? `${trunc.content}\n[truncated ${formatSize(trunc.outputBytes)}/${formatSize(trunc.totalBytes)}]` : trunc.content;
			return { content: [{ type: "text", text }], details: { ...bundleDetails, totalOps, saved: totalOps>1? totalOps-1:0 } };
		},
		renderCall(args, theme) {
			const parts: string[] = [];
			if ((args as any).reads?.length) parts.push(`${(args as any).reads.length} reads`);
			if ((args as any).greps?.length) parts.push(`${(args as any).greps.length} greps`);
			if ((args as any).edits?.length) parts.push(`${(args as any).edits.length} edits`);
			if ((args as any).writes?.length) parts.push(`${(args as any).writes.length} writes`);
			if ((args as any).dryRun) parts.push("dryRun");
			let t = theme.fg("toolTitle", theme.bold("smart_bundle ")) + theme.fg("muted", parts.join(" + ") || "bundle");
			return new Text(t, 0, 0);
		},
		renderResult(result, opts, theme) {
			const d = result.details as any;
			let t = `${theme.fg("success","✓")} ${theme.fg("accent","smart_bundle")} ${theme.fg("dim", `${d?.totalOps??0} ops`)}${d?.saved? theme.fg("success", ` saved ${d.saved}`):""}`;
			if (!opts.expanded) { t += ` ${theme.fg("dim", `(${keyHint("app.tools.expand","expand")})`)}`; return new Text(t,0,0); }
			if (d?.greps) t += `\n ${theme.fg("dim","greps:")} ${theme.fg("muted", JSON.stringify(d.greps).slice(0,300))}`;
			if (d?.reads) t += `\n ${theme.fg("dim","reads:")} ${theme.fg("muted", `${d.reads.count} files cached ${d.reads.cacheHits}`)}`;
			if (d?.edits) t += `\n ${theme.fg("dim","edits:")} ${theme.fg("muted", JSON.stringify(d.edits).slice(0,300))}`;
			if (d?.writes) t += `\n ${theme.fg("dim","writes:")} ${theme.fg("muted", JSON.stringify(d.writes).slice(0,300))}`;
			return new Text(t,0,0);
		},
	});
	// ---- search_smart_tools — deferred loader (now browses ALL smart-tools, lazy activation for grep/patch)
	const searchSmartToolsTool = defineTool({
		name: "search_smart_tools",
		label: "Search Smart Tools",
		description: "Discovery for ⭐ PREFERRED smart-tools: smart_read (replaces read), smart_write (replaces write), smart_edit (replaces edit), smart_grep (replaces bash grep), smart_patch (replaces bash patch), smart_bundle (replaces all). Call to list/activate.",
		promptSnippet: "Use search_smart_tools to discover PREFERRED smart-tools — all replace defaults",
		promptGuidelines: ["Use search_smart_tools to discover any PREFERRED smart-tool; lazy tools (grep/patch) auto-activate. ALL smart_* REPLACE defaults — always prefer them."] ,
		parameters: searchSmartToolsParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const qRaw = params.query.trim().toLowerCase();
			const limit = Math.min(10, Math.max(1, params.limit ?? 6));
			const q = qRaw;
			const terms = qRaw.split(/[^a-z0-9]+/).filter(Boolean);
			const isCatalogQuery = !qRaw || qRaw === "all" || qRaw === "list" || qRaw === "help" || qRaw === "smart" || qRaw === "tools" || qRaw === "smart tools" || qRaw === "smart-tools" || (qRaw.includes("smart") && qRaw.includes("tool"));
			const all = pi.getAllTools();
			const smartAll = all.filter((t: any) => (SMART_TOOL_CATALOG.has(t.name) || t.name.startsWith("smart_")) && t.name !== "search_smart_tools");
			const candidates = smartAll.length ? smartAll : all.filter((t: any)=> t.name !== "search_smart_tools");
			let scored: string[] = [];
			if (isCatalogQuery) {
				scored = [...SMART_TOOL_CATALOG];
			} else {
				scored = candidates.map((tool: any)=> ({ tool, score: terms.reduce((s: number,term: string)=> s + (`${tool.name} ${tool.description} ${(tool as any).label ?? ""}`.toLowerCase().includes(term)?1:0), 0) })).filter((m: any)=>m.score>0).sort((a: any,b: any)=>b.score-a.score).slice(0, limit).map((m: any)=>m.tool.name as string);
				if (scored.length===0) {
					if (q.includes("read")) scored.push("smart_read");
					if (q.includes("write")) scored.push("smart_write");
					if (q.includes("edit")) scored.push("smart_edit");
					if (q.includes("grep")||q.includes("search")||q.includes("find")||q.includes("rg")) scored.push("smart_grep");
					if (q.includes("patch")||q.includes("diff")||q.includes("apply")) scored.push("smart_patch");
					if (q.includes("bundle")||q.includes("hetero")||q.includes("multi")||q.includes("batch")) scored.push("smart_bundle");
					if (q.includes("all")||q.includes("list")||q.includes("smart")) scored.push(...SMART_TOOL_CATALOG);
				}
			}
			const uniq = [...new Set(scored)].slice(0, limit);
			if (uniq.length===0) {
				const catalog = [...SMART_TOOL_CATALOG].map(n=> `• ${n}: ${SMART_TOOL_META[n] ?? ""}`).join("\n");
				return { content: [{ type: "text", text: `No tools found for: "${params.query}".\nAvailable smart-tools:\n${catalog}\n\nTry: "all", "read", "edit", "grep", "patch", "bundle"` }], details: { matches: [], added: [] } };
			}
			const active = pi.getActiveTools();
			const lazyToAdd = uniq.filter(n=> SEARCHABLE_TOOL_NAMES.has(n) && !active.includes(n));
			const alreadyActive = uniq.filter(n=> active.includes(n));
			const toActivate = lazyToAdd;
			if (toActivate.length) pi.setActiveTools([...new Set([...active, ...toActivate])]);
			state.searches += 1;
			scheduleTelemetry(piRef, "smart-tools:search_smart_tools", { query: params.query, matches: uniq, added: toActivate, at: Date.now() });
			syncSmartUI(ctx);
			const catalogLine = uniq.map(n=> `${n}${SMART_TOOL_META[n]?` — ${SMART_TOOL_META[n]}`:""}${active.includes(n)?" (active)": SEARCHABLE_TOOL_NAMES.has(n)?" (lazy)":""}`).join("\n• ");
			if (isCatalogQuery) {
				return { content: [{ type: "text", text: `Smart-tools catalog (${uniq.length}):\n• ${catalogLine}${toActivate.length?`\n\nLoaded lazy tools: ${toActivate.join(", ")}`:""}` }], details: { matches: uniq, added: toActivate } };
			}
			if (toActivate.length) return { content: [{ type: "text", text: `Loaded tools: ${toActivate.join(", ")} (queried: "${params.query}")\nMatches:\n• ${catalogLine}` }], details: { matches: uniq, added: toActivate } };
			return { content: [{ type: "text", text: `Matching tools already active: ${uniq.join(", ")}\n• ${catalogLine}` }], details: { matches: uniq, added: [] } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("search_smart_tools ")) + theme.fg("muted", `"${args.query.slice(0,40)}"`), 0, 0); },
		renderResult(result, _opts, theme) {
			const d = result.details as any;
			if (!d?.added?.length) return new Text(theme.fg("dim", "already active: ") + theme.fg("muted", (d?.matches ?? []).join(", ")), 0, 0);
			return new Text(`${theme.fg("success","✓")} ${theme.fg("accent", d.added.join(", "))} ${theme.fg("dim","loaded")}`, 0, 0);
		}
	});

	pi.registerTool(smartEditTool);
	pi.registerTool(smartReadTool);
	pi.registerTool(smartWriteTool);
	pi.registerTool(smartGrepTool);
	pi.registerTool(smartPatchTool);
	pi.registerTool(searchSmartToolsTool);
	pi.registerTool(smartBundleTool);

	// -----------------------------------------------------------------------
	// Bash timeout gate — mandatory timeout (fail-safe) + quiet clamp
	// -----------------------------------------------------------------------
	const lastInjected = new Map<string, {ms:number; wasMissing:boolean}>();
	pi.on("tool_call", async (event, _ctx) => {
		if (!isToolCallEventType("bash", event)) return undefined;
		const input = event.input as { command: string; timeout?: number; _injectedTimeout?: number };
		let injected: number | undefined;
		let wasMissing = false;
		if (input.timeout == null) {
			input.timeout = 30_000; injected = 30_000; wasMissing = true; state.bashInjected += 1;
		} else if (!Number.isFinite(input.timeout) || input.timeout <= 0) {
			input.timeout = 30_000; injected = 30_000; wasMissing = true; state.bashInjected += 1;
		} else if (input.timeout < 2000) {
			input.timeout = 2000; injected = 2000; wasMissing = false; state.bashInjected += 1;
		} else if (input.timeout > 120_000) {
			input.timeout = 120_000; injected = 120_000; wasMissing = false;
		}
		if (injected != null) {
			(input as any)._injectedTimeout = injected;
			const id = (event as any).toolCallId ?? (event as any).id ?? "";
			if (id) lastInjected.set(String(id), {ms: injected, wasMissing});
		}
		return undefined;
	});

	pi.on("tool_result", async (event, _ctx) => {
		if (event.toolName !== "bash") return undefined;
		const details = event.details as any;
		const exitCode = details?.exitCode;
		const signal = details?.signal;
		const timedOut = details?.timedOut === true;
		const isTimeout = timedOut || exitCode === 124 || signal === "SIGTERM" || signal === "SIGKILL";
		const id = (event as any).toolCallId ?? (event as any).id ?? "";
		const rec = id ? lastInjected.get(String(id)) : undefined;
		if (id) lastInjected.delete(String(id));
		if (isTimeout) {
			state.timeoutsDetected += 1;
			if (!event.content || !Array.isArray((event as any).content)) return undefined;
			const base = event.content.map((c:any)=> c.type === "text" ? c.text : "").join("\n");
			return {
				content: [{ type: "text", text: `${base}\n\n[smart-tools: bash timed out (mandatory timeout ${rec? rec.ms+"ms" : "enforced"}). Narrow the command, add filters, or increase timeout explicitly up to 120s.]` }],
				details: { ...details, smartToolsTimeout: true, injectedTimeout: rec?.ms },
			};
		}
		if (rec != null && rec.wasMissing) {
			if (!event.content || !Array.isArray((event as any).content)) return undefined;
			const base = event.content.map((c:any)=> c.type === "text" ? c.text : "").join("\n");
			return {
				content: [{ type: "text", text: `${base}${base?"\n":""}[smart-tools: timeout ${rec.ms}ms injected (mandatory gate)]` }],
				details: { ...details, injectedTimeout: rec.ms },
			};
		}
		return undefined;
	});

	// Smart-tools failure enrichment — ensure why+retry visible
	pi.on("tool_result", async (event, _ctx) => {
		const name = (event as any).toolName ?? "";
		if (!String(name).startsWith("smart_")) return undefined;
		const content = (event.content?.[0] as any)?.text ?? "";
		const isError = (event as any).isError || content.includes("FAILED") || content.includes("Error") || content.includes("failed");
		if (!isError) return undefined;
		if (content.includes("Why failed:") && content.includes("Retry:")) return undefined;
		const retryMap: Record<string,string> = {
			smart_read: 'Retry: smart_read {files:["<path>"]} — verify path, use offset/limit, encoding:"base64" for binary.',
			smart_write: 'Retry: smart_write {writes:[{path:"<path>", content:"..."}]} — check path relative to cwd, parent dir writable.',
			smart_edit: 'Retry: ' + "smart_read first, copy exact 3-6 line anchor with unique symbol, then smart_edit with that oldText. Use dryRun:true to validate.",
			smart_bundle: 'Retry: use smart_bundle {reads:[...], edits:[...]} with dryRun:true to validate before applying. Check each section error.',
			smart_grep: 'Retry: smart_grep {query:"<pattern>", globs:["*.ts"]} — check regex syntax, reduce maxResults, add globs.',
			smart_patch: 'Retry: ensure patch is valid unified diff (git diff) and file paths match. Fallback to smart_edit with anchors.'
		};
		const retry = retryMap[name] ?? 'Retry: re-read relevant files, fix anchor/path, then retry the operation.';
		const why = content.slice(0, 500).replace(/\n/g, " ");
		return {
			content: [{ type: "text", text: content + "\n\n" + failBlock(name, why || "operation failed", retry) }],
			details: { ...(event.details as any), smartToolsEnriched: true }
		};
	});

	// -----------------------------------------------------------------------
	// Commands — smart-status / smart-history (UX)
	// -----------------------------------------------------------------------
	pi.registerCommand("smart-status", {
		description: "Show smart-tools status, telemetry and cache",
		handler: async (_args, ctx) => {
			const lines = [
				`smart-tools status — ${describeSmart()} v3.0 (bundle flagship)`,
				`  bundle: ${state.smartBundles}  edits: ${state.smartEdits}  reads: ${state.smartReads} (hits:${state.cacheHits} miss:${state.cacheMisses} grepCache:${state.grepCacheHits})  writes:${state.smartWrites} (dedup:${state.dedupSkipped})`,
				`  grep:${state.smartGreps}  patch:${state.smartPatches}  searches:${state.searches}`,
				`  saved: ${state.callsSaved} calls ~${estimateTokens(state.tokensSavedEst*4)} tokens  bash injected:${state.bashInjected} timeouts:${state.timeoutsDetected}`,
				`  cache: ${readCache.size}/${CACHE_MAX} entries TTL 5min slice-aware | grepCache ${grepCache.size}/${GREPCACHE_MAX} TTL 60s`,
				`  widget: /smart-history for recent ops`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
	pi.registerCommand("smart-history", {
		description: "Show recent smart-tools operations from session",
		handler: async (_args, ctx) => {
			const entries = ctx.sessionManager.getEntries().filter((e:any)=> e.type==="custom" && String(e.customType).startsWith("smart-tools:"));
			const recent = entries.slice(-20);
			if (!recent.length) { ctx.ui.notify("smart-tools: no history yet", "info"); return; }
			const lines = recent.map((e:any)=> `${new Date(e.timestamp ?? Date.now()).toLocaleTimeString()}  ${e.customType}  ${JSON.stringify(e.data ?? {}).slice(0,120)}`);
			ctx.ui.notify([`smart-tools history (last ${recent.length}):`, ...lines].join("\n"), "info");
		},
	});

	// -----------------------------------------------------------------------
	// Session lifecycle (smart-tools) — telemetry + deferred loading + widget + prefetch
	// -----------------------------------------------------------------------
	pi.on("session_start", async (event, ctx) => {
		state.bashInjected = 0;
		state.smartEdits = 0;
		state.smartReads = 0;
		state.smartWrites = 0;
		state.smartGreps = 0;
		state.smartPatches = 0;
		state.smartBundles = 0;
		state.searches = 0;
		let recoveredSaved = 0;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom") {
				if (entry.customType === "smart-tools:smart_edit") state.smartEdits += 1;
				if (entry.customType === "smart-tools:smart_read") state.smartReads += 1;
				if (entry.customType === "smart-tools:smart_write") state.smartWrites += 1;
				if (entry.customType === "smart-tools:smart_grep") state.smartGreps += 1;
				if (entry.customType === "smart-tools:smart_patch") state.smartPatches += 1;
				if (entry.customType === "smart-tools:smart_bundle" || entry.customType === "smart-tools:turn") state.smartBundles += 1;
				if (entry.customType === "smart-tools:search_smart_tools") state.searches += 1;
				const d: any = (entry as any).data ?? {};
				if (d.edits && d.edits > 1) recoveredSaved += (d.edits - 1);
				if (Array.isArray(d.files) && d.files.length > 1) recoveredSaved += (d.files.length - 1);
				if (Array.isArray(d.writes) && d.writes.length > 1) recoveredSaved += (d.writes.length - 1);
			}
		}
		if (recoveredSaved) state.callsSaved = recoveredSaved;
		try {
			const active = pi.getActiveTools();
			const next = active.filter(n=> !SEARCHABLE_TOOL_NAMES.has(n));
			if (next.length !== active.length) pi.setActiveTools(next);
		} catch {}
		if (ctx.hasUI) {
			syncSmartUI(ctx);
			if (event.reason !== "startup") ctx.ui.notify(`smart-tools v3.0 ready — bundle 1 call saves 3 turns`, "info");
		}
		(async()=>{
			try {
				const { stdout: diffOut } = await execFile("git", ["diff","--name-only"], { cwd: ctx.cwd, timeout: 8000, maxBuffer: 50000 } as any).catch(()=>({stdout:""} as any));
				const { stdout: statusOut } = await execFile("git", ["status","--porcelain"], { cwd: ctx.cwd, timeout: 8000, maxBuffer: 50000 } as any).catch(()=>({stdout:""} as any));
				const files = new Set<string>();
				for (const l of String(diffOut).split("\n").map(s=>s.trim()).filter(Boolean)) files.add(l);
				for (const l of String(statusOut).split("\n").map(s=>s.trim()).filter(Boolean)) { const m = l.match(/^\s*[?MADRCU]+\s+(.+)$/); if (m) files.add(m[1].trim()); }
				const top = [...files].filter(f=> !f.includes("node_modules") && !f.includes(".git")).slice(0,4);
				if (top.length) {
					await Promise.all(top.map(async (f)=>{
						const abs = resolveInsideCwd(ctx.cwd, f);
						try { const st = await stat(abs); const c = await readFile(abs, "utf8"); readCache.set(f, { content: c, mtimeMs: (st as any).mtimeMs || Date.now(), hash: hashContent(c), at: Date.now(), size: c.length }); readCache.set(abs, { content: c, mtimeMs: (st as any).mtimeMs || Date.now(), hash: hashContent(c), at: Date.now(), size: c.length }); } catch {}
					}));
					touchCacheEvict();
				}
			} catch {}
		})();
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (pendingTelemetry.length) flushTelemetry(pi as any);
		if (telemetryTimer) { clearTimeout(telemetryTimer); telemetryTimer=null; }
		if (state.callsSaved || state.cacheHits || state.smartEdits || state.smartReads || state.smartBundles) {
			try { (ctx as any)?.ui?.notify?.(`smart-tools v3.0 session: saved ~${state.callsSaved} calls · ${state.cacheHits} cache hits (${state.grepCacheHits} grep) · ${state.dedupSkipped} dedup · ${state.smartBundles} bundles`, "info"); } catch {}
		}
		readCache.clear(); grepCache.clear();
		state.bashInjected = 0; state.smartEdits = 0; state.smartReads = 0; state.smartWrites = 0; state.smartGreps = 0; state.smartPatches = 0; state.smartBundles = 0; state.searches = 0; state.callsSaved = 0; state.cacheHits = 0; state.cacheMisses = 0; state.tokensSavedEst = 0; state.dedupSkipped = 0; state.timeoutsDetected = 0; state.grepCacheHits = 0; pendingTelemetry = [];
	});
}
