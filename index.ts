// @ts-nocheck
/**
 * smart-tools — batching + fuzzy edits + productivity suite
 *
 * Gaps solved:
 *  1. edit/read/write N:1 batching + whitespace -> smart_edit/smart_read/smart_write (8 per 1 LLM call, fuzzy, queue-safe)
 *  2. bash without timeout     -> tool_call gate (mandatory timeout inject, visible)
 *  3. agent blind retries      -> dryRun/strict/overlap/confidence + actionable errors (nearbyPreview)
 *  4. tail-only reads          -> offset/limit/binary guard + adaptive truncation (budget-aware)
 *  5. serial writes + no dedup -> parallel sharded writes + hash dedup + no-op skip
 *  6. grep→read 2 calls        -> smart_grep (rg/grep bridge + optional read)
 *  7. diff patch gap           -> smart_patch (git apply bridge, deferred)
 *  8. prompt bloat             -> deferred loading via search_smart_tools
 *  9. invisible cost           -> LRU read cache (32/5min) + telemetry (saved calls/tokens/cache hits)
 *  10. cryptic UX              -> rich status widget + /smart-status + /smart-history + streaming
 *
 * Generic: works for any workflow. All new params optional, back-compat.
 * Load: pi -e ./index.ts  (or ./.pi/extensions/smart-tools/index.ts)
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
import { dirname, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { createHash } from "node:crypto";
import { execFile as execFileCb, exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const execFile = promisify(execFileCb);
const exec = promisify(execCb);

// ---------------------------------------------------------------------------
// State + telemetry + cache
// ---------------------------------------------------------------------------
interface SmartState {
	bashInjected: number;
	smartEdits: number;
	smartReads: number;
	smartWrites: number;
	smartGreps: number;
	smartPatches: number;
	searches: number;
	callsSaved: number;
	cacheHits: number;
	cacheMisses: number;
	tokensSavedEst: number;
	dedupSkipped: number;
	timeoutsDetected: number;
}
const state: SmartState = {
	bashInjected: 0,
	smartEdits: 0,
	smartReads: 0,
	smartWrites: 0,
	smartGreps: 0,
	smartPatches: 0,
	searches: 0,
	callsSaved: 0,
	cacheHits: 0,
	cacheMisses: 0,
	tokensSavedEst: 0,
	dedupSkipped: 0,
	timeoutsDetected: 0,
};

const MAX_OLDTEXT = 50_000;
const CACHE_MAX = 32;
const CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCHABLE_TOOL_NAMES = new Set(["smart_grep", "smart_patch"]);

interface CacheEntry { content: string; mtimeMs: number; hash: string; at: number; size: number; }
const readCache = new Map<string, CacheEntry>();

function hashContent(s: string): string {
	return createHash("sha1").update(s, "utf8").digest("hex").slice(0, 12);
}
function estimateTokens(bytes: number): number { return Math.ceil(bytes / 4); }
// --- Polished UI: single source of truth, no duplication ---
// Status = minimal dot + label (no numbers) — persistent footer, never duplicates widget
// Widget = rich dashboard (all numbers once) — above editor, theme-aware
function renderStatus(theme: any): string {
	const hasActivity = state.callsSaved > 0 || state.smartReads > 0 || state.smartEdits > 0;
	const dot = hasActivity ? theme.fg("success", "●") : theme.fg("dim", "○");
	const label = theme.fg("accent", " smart-tools");
	const hint = hasActivity ? theme.fg("dim", " · active") : theme.fg("dim", " · ready");
	return `${dot}${label}${hint}`;
}
function renderWidgetLines(theme: any): string[] {
	const idle = state.smartEdits===0 && state.smartReads===0 && state.smartWrites===0 && state.smartGreps===0 && state.smartPatches===0 && state.callsSaved===0;
	if (idle) {
		return [ `${theme.fg("dim", "◇")} ${theme.fg("accent","smart-tools")} ${theme.fg("dim","·")} ${theme.fg("muted","batch 8:1 · fuzzy edits · queue-safe · 30s timeout")}` ];
	}
	const parts: string[] = [];
	if (state.smartEdits) parts.push(`${theme.fg("muted","edits")} ${theme.fg("accent", String(state.smartEdits))}`);
	if (state.smartReads) parts.push(`${theme.fg("muted","reads")} ${theme.fg("accent", String(state.smartReads))}${state.cacheHits ? theme.fg("success", ` ↻${state.cacheHits}`) : ""}`);
	if (state.smartWrites) parts.push(`${theme.fg("muted","writes")} ${theme.fg("accent", String(state.smartWrites))}${state.dedupSkipped ? theme.fg("dim", ` ≡${state.dedupSkipped}`) : ""}`);
	if (state.smartGreps) parts.push(`${theme.fg("muted","grep")} ${theme.fg("accent", String(state.smartGreps))}`);
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
// Backward compat shims (no duplication — used only for plain-text fallback)
function describeSmart(): string { return `smart-tools · ${state.callsSaved ? state.callsSaved + " saved" : "ready"}`; }
function widgetLines(): string[] {
	const a: string[] = [];
	a.push(`smart-tools  edits:${state.smartEdits}  reads:${state.smartReads}${state.cacheHits ? ` (${state.cacheHits} cache hit)` : ""}  writes:${state.smartWrites}${state.dedupSkipped ? ` (${state.dedupSkipped} no-op skip)` : ""}`);
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
		// themed widget via callback (reactive to theme), fallback to strings
		const lines = renderWidgetLines(theme);
		if ((ctx.ui as any).setWidget) {
			// prefer callback form for theme reactivity; fallback to string[] if not supported
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
function isCacheValid(entry: CacheEntry, mtimeMs: number): boolean {
	return Date.now() - entry.at < CACHE_TTL_MS && entry.mtimeMs === mtimeMs;
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
	// collapsed fallback — per-line collapsed compare
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
		// try to locate partial token for hint — first word of needle
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
		if (e.oldText.length > MAX_OLDTEXT) throw new Error(`smart_edit: oldText too large (${e.oldText.length} > ${MAX_OLDTEXT}). Use a shorter unique anchor (3-6 lines).`);
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
	// overlaps: intervals against original content, appends never overlap
	const overlaps: Array<[number,number]> = [];
	for (let a=0;a<resolved.length;a++) for (let b=a+1;b<resolved.length;b++) {
		const ra = resolved[a], rb = resolved[b];
		if (ra.isAppend || rb.isAppend) continue;
		if (!ra.hit || !rb.hit) continue;
		const s1 = ra.hit.idx, e1 = ra.hit.idx + ra.hit.length;
		const s2 = rb.hit.idx, e2 = rb.hit.idx + rb.hit.length;
		if (s1 < e2 && s2 < e1) overlaps.push([ra.index, rb.index]);
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

function applyEditsAtomic(content: string, edits: Array<{oldText:string;newText:string}>, opts: { strict?: boolean } = {}): { next: string; applied: ValidatedEdit[]; dedupSkipped: number } {
	if (edits.length === 0) return { next: content, applied: [], dedupSkipped: 0 };
	const v = validateEdits(content, edits);
	if (v.missing.length > 0) {
		const m = v.missing[0];
		const preview = getNearbyPreview(content, null, m.oldText);
		const hint = m.oldText.length > 400 ? "Hint: use a shorter unique anchor (3-6 lines) instead of a large block." : "Hint: re-read the file and copy the exact block (including indentation).";
		throw new Error(`smart_edit: oldText not found (edit ${m.index}). Tried exact + line-trim + collapsed.\n--- missing oldText (first 500) ---\n${m.oldText.slice(0,500)}\n--- nearby preview ---\n${preview}\n---\n${hint}\nIf you used offset/limit, the slice may not contain the anchor — read a wider window.`);
	}
	if (v.overlaps.length > 0) {
		const list = v.overlaps.map(([a,b])=>`${a}↔${b}`).join(", ");
		throw new Error(`smart_edit: overlapping edits against original file: ${list}. Edits must be non-overlapping when matched against the original content. Merge overlapping edits into one. Dedup identical edits first.`);
	}
	if (opts.strict && v.lowConfidence.length > 0) {
		const low = v.lowConfidence[0];
		const preview = getNearbyPreview(content, low.hit, low.oldText);
		const sugg = suggestedOldText(content, low.hit);
		throw new Error(`smart_edit: strict mode rejected fuzzy match (edit ${low.index} confidence ${low.hit!.confidence} strategy ${low.hit!.strategy}).\n--- suggested exact oldText ---\n${sugg.slice(0,600)}\n--- nearby preview ---\n${preview}\n---\nRe-read and use the suggested exact block, or retry with strict:false.`);
	}
	// dedup identical (same oldText+newText) — keep first occurrence
	const seen = new Set<string>();
	const deduped: ValidatedEdit[] = [];
	let dedupSkipped = 0;
	for (const r of v.resolved) {
		const key = `${r.oldText}@@${r.newText}`;
		if (seen.has(key)) { dedupSkipped++; continue; }
		seen.add(key); deduped.push(r);
	}
	// split appends vs in-file
	const appends = deduped.filter(r=>r.isAppend);
	const infile = deduped.filter(r=>!r.isAppend).sort((a,b)=> (b.hit!.idx - a.hit!.idx));
	let next = content;
	for (const r of infile) {
		const h = r.hit!;
		if (h.strategy === "exact") {
			next = next.slice(0, h.idx) + r.newText + next.slice(h.idx + r.oldText.length);
		} else {
			// line-trim / collapsed: replace line range
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
	return { next, applied: deduped, dedupSkipped };
}

// Legacy exact apply for reference (kept internal)
function applyEdits(content: string, edits: Array<{ oldText: string; newText: string }>): string {
	return applyEditsAtomic(content, edits).next;
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

// ---------------------------------------------------------------------------
// Main extension
// ---------------------------------------------------------------------------
export default function smartTools(pi: ExtensionAPI): void {
	const piRef = pi;

	// ---- smart_edit — dryRun/strict/overlap/confidence/actionable errors
	const smartEditTool = defineTool({
		name: "smart_edit",
		label: "Smart Edit",
		description: "ALWAYS use instead of edit: whitespace-tolerant (fuzzy line-trim/collapsed), queue-safe, dryRun+strict, overlap detection, actionable errors. Batched per file.",
		promptSnippet: "ALWAYS use smart_edit instead of edit — whitespace-tolerant, batch in one call",
		promptGuidelines: [
			"ALWAYS use smart_edit instead of edit — even for single edits, it handles whitespace mismatch via fuzzy trim match and is file-queue safe.",
			"Batch multiple edits to the SAME file in one smart_edit call (edits[]). One file per call, 8 edits max advised.",
			"Use dryRun:true to validate without writing; strict:true rejects low-confidence fuzzy (<0.85). Prefer short 3-6 line anchors.",
			"Edits are matched against the ORIGINAL file and must be non-overlapping; they apply atomically (sorted descending).",
		],
		parameters: smartEditParams,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const target = resolve(ctx.cwd, params.path);
			// read outside queue for dryRun preview when possible
			let current = "";
			let existed = true;
			try { current = await readFile(target, "utf8"); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT" || params.createIfMissing === false) throw error;
				current = ""; existed = false;
			}
			// pre-validate before queue (fail fast, no I/O)
			let validation: ValidateResult | null = null;
			try { validation = validateEdits(current, params.edits); } catch (e) { throw e; }
			if (params.dryRun) {
				const hints = validation.missing.map(m=> ({ index: m.index, preview: getNearbyPreview(current, null, m.oldText).slice(0,600) }));
				const low = validation.lowConfidence.map(l=> ({ index:l.index, confidence:l.hit!.confidence, strategy:l.hit!.strategy, suggested: suggestedOldText(current, l.hit).slice(0,400) }));
				const overlaps = validation.overlaps;
				const dedupInfo = [...validation.dedupGroups.entries()].filter(([,v])=>v.length>1).map(([k,v])=>({ key:k.slice(0,60), indices:v }));
				const wouldApply = validation.missing.length===0 && (validation.overlaps.length===0 || false) && (!params.strict || validation.lowConfidence.length===0);
				onUpdate?.({ message: `dryRun validate ${params.path}: ${wouldApply?"ok":"issues found"}` } as any);
				return {
					content: [{ type: "text", text: `dryRun ${params.path}: ${wouldApply?"✓ would apply":"✗ would fail"} — ${params.edits.length} edit(s) — overlaps:${overlaps.length} missing:${validation.missing.length} lowConf:${low.length} dedup:${dedupInfo.length}` }],
					details: { path: params.path, dryRun: true, wouldApply, validation: { overlaps, missing: validation.missing.map(m=>m.index), lowConfidence: low, hints, dedupGroups: dedupInfo, total: params.edits.length }, bytesBefore: current.length },
				};
			}
			return withFileMutationQueue(target, async () => {
				await mkdir(dirname(target), { recursive: true });
				// re-read inside queue to avoid race
				let curInside = current;
				try { curInside = await readFile(target, "utf8"); } catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT" || params.createIfMissing === false) throw error;
					curInside = "";
				}
				const { next, applied, dedupSkipped } = applyEditsAtomic(curInside, params.edits, { strict: params.strict });
				if (next === curInside && existed) {
					state.dedupSkipped += 1;
					state.smartEdits += 1;
					piRef.appendEntry("smart-tools:smart_edit", { path: params.path, edits: params.edits.length, noOp: true, at: Date.now() });
					syncSmartUI(ctx);
					return { content: [{ type: "text", text: `smart_edit ${params.path}: no-op (content unchanged) — ${params.edits.length} edit(s) dedupSkipped:${dedupSkipped}` }], details: { path: params.path, applied: 0, noOp: true, dedupSkipped, bytesBefore: curInside.length, bytesAfter: next.length } };
				}
				await writeFile(target, next, "utf8");
				readCache.delete(params.path);
				readCache.delete(target);
				state.smartEdits += 1;
				if (dedupSkipped) state.dedupSkipped += dedupSkipped;
				if (params.edits.length > 1) { state.callsSaved += (params.edits.length - 1); state.tokensSavedEst += estimateTokens(params.edits.length * 400); }
				piRef.appendEntry("smart-tools:smart_edit", { path: params.path, edits: params.edits.length, at: Date.now() });
				syncSmartUI(ctx);
				const summary = `smart_edit ${params.path}: ${applied.length} edit(s) applied${dedupSkipped?` (${dedupSkipped} dedup skipped)`:""} (${curInside.length} -> ${next.length} bytes)`;
								const diffLines: string[] = [`--- a/${params.path}`, `+++ b/${params.path}`];
				for (const a of applied) {
					diffLines.push(`@@ edit ${a.index} ${a.hit?.strategy ?? "exact"} (${Math.round((a.hit?.confidence??1)*100)}%) @@`);
					if (a.isAppend) { for (const l of a.newText.split("\n")) diffLines.push(`+${l}`); }
					else { for (const l of a.oldText.split("\n")) diffLines.push(`-${l}`); for (const l of a.newText.split("\n")) diffLines.push(`+${l}`); }
				}
				const diff = diffLines.join("\n");
				const truncation = truncateHead(summary, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
				const text = truncation.truncated ? `${truncation.content}\n[truncated ${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}]` : truncation.content;
				return {
					content: [{ type: "text", text }],
					details: { path: params.path, applied: applied.length, dedupSkipped, bytesBefore: curInside.length, bytesAfter: next.length, strategies: applied.map(a=>({i:a.index, c:a.hit?.confidence, s:a.hit?.strategy})), diff },
				};
			});
		},
		renderCall(args, theme) {
			let t = theme.fg("toolTitle", theme.bold("smart_edit ")) + theme.fg("muted", args.path);
			t += theme.fg("dim", ` ×${args.edits.length}`);
			if ((args as any).dryRun) t += theme.fg("warn", " dryRun");
			if ((args as any).strict) t += theme.fg("warn", " strict");
			return new Text(t, 0, 0);
		},
		renderResult(result, opts, theme) {
			const d = result.details as any;
			if (!d?.path) return new Text(theme.fg("dim", "smart_edit"), 0, 0);
			if (d.dryRun) {
				let text = `${theme.fg(d.wouldApply?"success":"warn", d.wouldApply?"✓ dryRun":"✗ dryRun")} ${theme.fg("accent", d.path)} ${theme.fg("dim", `${d.validation?.total ?? 0} edit(s)`)}`;
				if (opts.expanded && d.validation) text += `\n ${theme.fg("dim", `overlaps:${d.validation.overlaps?.length ?? 0} missing:${d.validation.missing?.length ?? 0} low:${d.validation.lowConfidence?.length ?? 0}`)}`;
				else text += ` ${theme.fg("dim", `(${keyHint("app.tools.expand","expand")})`)}`;
				return new Text(text, 0, 0);
			}
			let text = `${theme.fg(d.noOp?"warn":"success", d.noOp?"○":"✓")} ${theme.fg("accent", d.path)} ${theme.fg("dim", `${d.applied ?? 0} edit(s)`)}`;
			if (d.bytesBefore != null && d.bytesAfter != null) {
				const delta = d.bytesAfter - d.bytesBefore;
				text += theme.fg("dim", ` ${d.bytesBefore}→${d.bytesAfter} (${delta>0?"+" : ""}${delta}B)`);
			}
			if (d.dedupSkipped) text += theme.fg("dim", ` (+${d.dedupSkipped} dedup)`);
			if (!opts.expanded) {
				if (d.diff) {
					let add=0, rem=0;
					for (const l of (d.diff as string).split("\n")) { if (l.startsWith("+") && !l.startsWith("+++")) add++; if (l.startsWith("-") && !l.startsWith("---")) rem++; }
					text += ` ${theme.fg("success", `+${add}`)}${theme.fg("dim", " / ")}${theme.fg("error", `-${rem}`)}`;
				}
				text += ` ${theme.fg("dim", `(${keyHint("app.tools.expand","expand")})`)}`;
				return new Text(text, 0, 0);
			}
			if (d.diff) {
				const diffLines = (d.diff as string).split("\n").slice(0, 30);
				let add=0, rem=0;
				for (const l of (d.diff as string).split("\n")) { if (l.startsWith("+") && !l.startsWith("+++")) add++; if (l.startsWith("-") && !l.startsWith("---")) rem++; }
				text += ` ${theme.fg("success", `+${add}`)}${theme.fg("dim", " / ")}${theme.fg("error", `-${rem}`)}`;
				for (const line of diffLines) {
					if (line.startsWith("+") && !line.startsWith("+++")) text += `\n${theme.fg("success", line)}`;
					else if (line.startsWith("-") && !line.startsWith("---")) text += `\n${theme.fg("error", line)}`;
					else text += `\n${theme.fg("dim", line)}`;
				}
				if ((d.diff as string).split("\n").length > 30) text += `\n${theme.fg("muted", `... ${(d.diff as string).split("\n").length - 30} more diff lines`)}`;
			} else {
				if (d.strategies) text += `\n ${theme.fg("muted", d.strategies.map((s:any)=>`#${s.i}:${s.s}(${(s.c*100|0)}%)`).join(" "))}`;
			}
			return new Text(text, 0, 0);
		},
	});

	// ---- smart_read (batched, offset/limit, binary guard, adaptive, cache, streaming)
	const smartReadTool = defineTool({
		name: "smart_read",
		label: "Smart Read",
		description: "ALWAYS use instead of read: batched up to 8 files per 1 LLM call, offset/limit, binary guard, adaptive budget, LRU cache, streaming. Saves N LLM calls.",
		promptSnippet: "ALWAYS use smart_read instead of read — 8 files per 1 call, supports offset/limit",
		promptGuidelines: [
			"ALWAYS use smart_read instead of read — even for 1 file — batch up to 8 files per 1 LLM call to save calls.",
			"Supports per-file offset/limit: files:[{path, offset, limit}] for random access (e.g., after grep). Back-compat: files:['a.ts'].",
			"Adaptive truncation shares budget across files; cache (32 entries, 5min) auto-skips re-reads. Pairs with smart_write/smart_edit for N:1 batching.",
		],
		parameters: smartReadParams,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const entries = params.files.slice(0, 8).map((f) => typeof f === "string" ? { path: f, offset: undefined as number|undefined, limit: undefined as number|undefined, encoding: "utf8" as const } : { path: (f as any).path, offset: (f as any).offset, limit: (f as any).limit, encoding: ((f as any).encoding ?? "utf8") as "utf8"|"base64" });
			const budget = Math.max(4096, DEFAULT_MAX_BYTES - 2048);
			const perFileBudget = Math.floor(budget / Math.max(1, entries.length));
			let cacheHitsThisCall = 0;
			const reads = await Promise.all(
				entries.map(async (entry, idx) => {
					const file = entry.path;
					const abs = resolve(ctx.cwd, file);
					onUpdate?.({ message: `smart_read ${idx+1}/${entries.length}: ${file}` } as any);
					try {
						let mtimeMs = 0; let st: any = null;
						try { st = await stat(abs); mtimeMs = st.mtimeMs; } catch {}
						const cached = readCache.get(file) ?? readCache.get(abs);
						let content: string;
						let fromCache = false;
						if (cached && mtimeMs && isCacheValid(cached, mtimeMs) && entry.encoding === "utf8" && entry.offset == null && entry.limit == null) {
							content = cached.content;
							fromCache = true;
							cacheHitsThisCall++;
						} else {
							if (entry.encoding === "base64") {
								const buf = await readFile(abs);
								content = buf.toString("base64");
								// don't cache base64
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
						let sliceOffset = entry.offset ?? 0;
						let sliceLimit = entry.limit;
						if (sliceOffset !== 0 || sliceLimit != null) {
							const lines = sliced.split("\n");
							totalLines = lines.length;
							const from = Math.min(sliceOffset, lines.length);
							const to = sliceLimit != null ? Math.min(lines.length, from + sliceLimit) : lines.length;
							sliced = lines.slice(from, to).join("\n");
							headerLinesInfo = `lines ${from+1}-${to}/${totalLines}`;
							if (fromCache) headerLinesInfo += " (cached)";
						}
						const maxBytes = Math.min(30000, perFileBudget);
						const maxLines = sliceLimit ?? 200;
						let trunc: any;
						if (sliceOffset !== 0 || sliceLimit != null) {
							trunc = truncateHead(sliced, { maxLines, maxBytes });
						} else {
							trunc = truncateTail(sliced, { maxLines, maxBytes });
						}
						// if still truncated due to budget, keep tail semantics
						const cappedNote = trunc.truncated ? ` [capped ${formatSize(trunc.outputBytes)}/${formatSize(trunc.totalBytes)} — rerun with offset/limit or fewer files]` : "";
						const hitTag = fromCache ? " cached" : "";
						return `## ${file} (${headerLinesInfo} ${formatSize(trunc.outputBytes)}/${formatSize(trunc.totalBytes)}${hitTag})\n${trunc.content}${cappedNote}`;
					} catch (error) {
						return `## ${file}: ${(error as Error).message.slice(0, 700)}`;
					}
				}),
			);
			state.smartReads += 1;
			if (cacheHitsThisCall) state.cacheHits += cacheHitsThisCall; else state.cacheMisses += entries.length;
			if (entries.length > 1) { state.callsSaved += (entries.length - 1); state.tokensSavedEst += estimateTokens(entries.length * 300); }
			piRef.appendEntry("smart-tools:smart_read", { files: params.files, at: Date.now(), cacheHits: cacheHitsThisCall });
			syncSmartUI(ctx);
			const combined = reads.join("\n\n---\n\n");
			const trunc = truncateHead(combined, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			const text = trunc.truncated ? `${trunc.content}\n\n[Output truncated ${formatSize(trunc.outputBytes)}/${formatSize(trunc.totalBytes)} — rerun with fewer files or offset/limit]` : trunc.content;
			return {
				content: [{ type: "text", text }],
				details: { files: entries.map(e=>e.path), count: entries.length, cacheHits: cacheHitsThisCall, perFileBudget },
			};
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
			if (!opts.expanded) {
				t += ` ${theme.fg("dim", `(${keyHint("app.tools.expand","expand")})`)}`;
				return new Text(t, 0, 0);
			}
			const lines = content.split("\n").slice(0, 15);
			for (const line of lines) t += `\n${theme.fg("dim", line.slice(0, 200))}`;
			if (lineCount > 15) t += `\n${theme.fg("muted", `... ${lineCount - 15} more lines`)}`;
			t += `\n ${theme.fg("dim", (d?.files ?? []).slice(0,8).join(", "))}`;
			return new Text(t, 0, 0);
		},
	});

	// ---- smart_write (batched, parallel sharded queue, dedup, streaming)
	const smartWriteTool = defineTool({
		name: "smart_write",
		label: "Smart Write",
		description: "ALWAYS use instead of write: batched up to 8 files per 1 LLM call, parallel, queue-sharded, hash dedup (skips no-ops). Creates dirs.",
		promptSnippet: "ALWAYS use smart_write instead of write — 8 files per 1 call, deduped",
		promptGuidelines: [
			"ALWAYS use smart_write instead of write — batch up to 8 files per 1 LLM call to save calls; each write is queue-safe and deduped.",
			"No-op writes (identical content) are skipped automatically and reported.",
		],
		parameters: smartWriteParams,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const writes = params.writes.slice(0, 8);
			const results: Array<{path:string; bytes:number; skipped?:boolean; reason?:string}> = [];
			await Promise.all(writes.map(async (w, idx) => {
				const target = resolve(ctx.cwd, w.path);
				onUpdate?.({ message: `smart_write ${idx+1}/${writes.length}: ${w.path}` } as any);
				return withFileMutationQueue(target, async () => {
					let existing: string | null = null;
					try { existing = await readFile(target, "utf8"); } catch {}
					if (existing !== null && hashContent(existing) === hashContent(w.content)) {
						results.push({ path: w.path, bytes: w.content.length, skipped: true, reason: "unchanged (hash equal)" });
						state.dedupSkipped += 1;
						return;
					}
					await mkdir(dirname(target), { recursive: true });
					await writeFile(target, w.content, "utf8");
					readCache.delete(w.path); readCache.delete(target);
					results.push({ path: w.path, bytes: w.content.length });
				});
			}));
			// sort results to input order for stable output
			results.sort((a,b)=> writes.findIndex(w=>w.path===a.path) - writes.findIndex(w=>w.path===b.path));
			state.smartWrites += 1;
			if (writes.length > 1) { state.callsSaved += (writes.length - 1); state.tokensSavedEst += estimateTokens(writes.length * 500); }
			piRef.appendEntry("smart-tools:smart_write", { writes: writes.map((w) => w.path), at: Date.now(), skipped: results.filter(r=>r.skipped).length });
			syncSmartUI(ctx);
			const skipped = results.filter(r=>r.skipped);
			const written = results.filter(r=>!r.skipped);
			const summary = `smart_write ${writes.length} file(s): ${written.map(r=>`${r.path}: ${r.bytes} bytes`).join(", ") || "none written"}${skipped.length?` — skipped ${skipped.length} no-op: ${skipped.map(r=>r.path).join(", ")}`:""}`;
			const trunc = truncateHead(summary, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			const text = trunc.truncated ? `${trunc.content}\n[truncated ${formatSize(trunc.outputBytes)}/${formatSize(trunc.totalBytes)}]` : trunc.content;
			return {
				content: [{ type: "text", text }],
				details: { writes: writes.map((w) => w.path), count: writes.length, skipped: skipped.map(s=>s.path), written: written.map(w=>w.path) },
			};
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
			if (!opts.expanded) {
				t += ` ${theme.fg("dim", `(${keyHint("app.tools.expand","expand")})`)}`;
				return new Text(t, 0, 0);
			}
			t += `\n${theme.fg("success", "Written")}`;
			t += `\n${(d?.writes ?? []).slice(0,8).map((f:string)=>`  ${theme.fg(d?.skipped?.includes(f)?"dim":"muted", (d?.skipped?.includes(f)?"○":"•")+" "+f + (d?.skipped?.includes(f)?" (no-op — hash equal)":""))}`).join("\n")}`;
			if ((d?.writes?.length??0)>8) t += `\n ${theme.fg("dim", `+${d.writes.length-8} more`)}`;
			return new Text(t, 0, 0);
		},
	});

	// ---- smart_grep — rg/grep bridge + optional read
	const smartGrepTool = defineTool({
		name: "smart_grep",
		label: "Smart Grep",
		description: "ALWAYS use instead of bash rg/grep: batched search (rg→grep fallback) with optional auto-read of top hits. 1 call vs 2.",
		promptSnippet: "ALWAYS use smart_grep instead of bash rg — auto-read optional",
		promptGuidelines: [
			"ALWAYS use smart_grep instead of bash rg/grep — it collapses search+read into 1 LLM call when includeRead:true.",
			"Prefer smart_grep for codebase searches; use bash only for complex pipelines.",
		],
		parameters: smartGrepParams,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			onUpdate?.({ message: `smart_grep: "${params.query.slice(0,60)}"` } as any);
			const maxResults = Math.min(100, Math.max(1, params.maxResults ?? 30));
			const includeRead = params.includeRead ?? false;
			const readLimit = Math.min(200, Math.max(10, params.readLimit ?? 80));
			let hits: Array<{file:string; line:number; preview:string}> = [];
			let used: "rg"|"grep"|"none" = "none";
			let stderr = "";
			// try ripgrep first (no shell, sanitize via args)
			try {
				const args = ["--line-number", "--no-heading", "--color", "never", "-m", String(maxResults)];
				if (params.globs && params.globs.length) for (const g of params.globs.slice(0,5)) { args.push("--glob", g); }
				args.push("-e", params.query, ".");
				const { stdout } = await execFile("rg", args, { cwd: ctx.cwd, maxBuffer: 2_000_000, timeout: 15000 } as any);
				used = "rg";
				hits = (stdout as string).split("\n").filter(Boolean).slice(0, maxResults).map(line=>{
					const m = line.match(/^([^:]+):(\d+):(.*)$/);
					if (!m) return { file: line.slice(0,80), line: 0, preview: line.slice(0,240) };
					return { file: m[1], line: parseInt(m[2],10), preview: m[3].slice(0, 240) };
				});
			} catch (e:any) {
				const msg = String(e?.message ?? e);
				// rg not found or no hits (rg exits 1 on no hits) — distinguish
				if (msg.includes("ENOENT") || msg.includes("not found")) {
					// fallback to grep
					try {
						const grepArgs = ["-rn", "-m", String(maxResults), "--", params.query, "."];
						if (params.globs?.length) { /* grep doesn't have glob filter easily — ignore */ }
						const { stdout } = await execFile("grep", grepArgs, { cwd: ctx.cwd, maxBuffer: 2_000_000, timeout: 15000 } as any);
						used = "grep";
						hits = (stdout as string).split("\n").filter(Boolean).slice(0, maxResults).map(line=>{
							const m = line.match(/^\.\/([^:]+):(\d+):(.*)$/) || line.match(/^([^:]+):(\d+):(.*)$/);
							if (!m) return { file: line.slice(0,80), line:0, preview: line.slice(0,240) };
							return { file: m[1].replace(/^\.\//,""), line: parseInt(m[2],10), preview: m[3].slice(0,240) };
						});
					} catch (e2:any) {
						const out = String(e2?.stdout ?? "");
						if (out) {
							used = "grep";
							hits = out.split("\n").filter(Boolean).slice(0, maxResults).map(line=>{
								const m = line.match(/^\.\/([^:]+):(\d+):(.*)$/) || line.match(/^([^:]+):(\d+):(.*)$/);
								if (!m) return { file: line.slice(0,80), line:0, preview: line.slice(0,240) };
								return { file: m[1].replace(/^\.\//,""), line: parseInt(m[2],10), preview: m[3].slice(0,240) };
							});
						} else {
							stderr = String(e2?.stderr ?? e2?.message ?? "").slice(0,600);
						}
					}
				} else {
					// rg error but may have stdout with hits (rg exits 1 on no match, still stdout empty)
					const out = String((e as any)?.stdout ?? "");
					if (out) {
						used = "rg";
						hits = out.split("\n").filter(Boolean).slice(0, maxResults).map(line=>{
							const m = line.match(/^([^:]+):(\d+):(.*)$/);
							if (!m) return { file: line.slice(0,80), line:0, preview: line.slice(0,240) };
							return { file: m[1], line: parseInt(m[2],10), preview: m[3].slice(0,240) };
						});
					} else {
						stderr = String((e as any)?.stderr ?? "").slice(0,600);
						// no hits is not error
						if (String(e?.code) === "1" || String((e as any)?.status) === "1") { used = "rg"; hits = []; }
					}
				}
			}
			state.smartGreps += 1;
			// always counts as saved vs bash+read (1 vs 2 when includeRead)
			if (includeRead && hits.length) state.callsSaved += 1;
			piRef.appendEntry("smart-tools:smart_grep", { query: params.query, hits: hits.length, at: Date.now(), engine: used });
			syncSmartUI(ctx);
			let reads: string[] = [];
			if (includeRead && hits.length) {
				const uniqFiles = [...new Set(hits.map(h=>h.file))].slice(0, 3);
				onUpdate?.({ message: `smart_grep reading ${uniqFiles.length} file(s)` } as any);
				reads = await Promise.all(uniqFiles.map(async (f) => {
					const abs = resolve(ctx.cwd, f);
					try {
						let content: string;
						const st = await stat(abs).catch(()=>null);
						const mtimeMs = (st as any)?.mtimeMs ?? 0;
						const cached = readCache.get(f) ?? readCache.get(abs);
						if (cached && mtimeMs && isCacheValid(cached, mtimeMs)) {
							content = cached.content; state.cacheHits++;
						} else {
							content = await readFile(abs, "utf8");
							readCache.set(f, { content, mtimeMs: mtimeMs || Date.now(), hash: hashContent(content), at: Date.now(), size: content.length });
							readCache.set(abs, { content, mtimeMs: mtimeMs || Date.now(), hash: hashContent(content), at: Date.now(), size: content.length });
							touchCacheEvict();
							state.cacheMisses++;
						}
						const lines = content.split("\n");
						// find first hit line for context window
						const hitLine = hits.find(h=>h.file===f)?.line ?? 1;
						const center = Math.max(0, hitLine - 1);
						const from = Math.max(0, center - Math.floor(readLimit/2));
						const slice = lines.slice(from, from + readLimit).join("\n");
						const trunc = truncateTail(slice, { maxLines: readLimit, maxBytes: 8000 });
						return `## ${f} [lines ${from+1}-${from+readLimit}/${lines.length} near:${hitLine}]\n${trunc.content}${trunc.truncated?"\n[capped]":""}`;
					} catch (e:any) { return `## ${f}: ${(e as Error).message.slice(0,300)}`; }
				}));
			}
			const hitText = hits.length ? hits.map(h=> `${h.file}:${h.line}: ${h.preview}`).join("\n") : (stderr ? `(no hits — ${stderr.slice(0,200)})` : "(no hits)");
			const combined = [`engine: ${used}  query: "${params.query}"  hits: ${hits.length}${includeRead?`  reads:${reads.length}`:""}`, "--- hits ---", hitText, ...(reads.length? ["--- reads (top 3 files, context window) ---", ...reads] : [])].join("\n");
			const trunc = truncateHead(combined, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			const text = trunc.truncated ? `${trunc.content}\n[truncated ${formatSize(trunc.outputBytes)}/${formatSize(trunc.totalBytes)} — narrow query or use globs]` : trunc.content;
			return { content: [{ type: "text", text }], details: { query: params.query, hits, engine: used, reads: reads.length, count: hits.length } };
		},
		renderCall(args, theme) {
			let t = theme.fg("toolTitle", theme.bold("smart_grep ")) + theme.fg("muted", `"${(args.query as string).slice(0,40)}"`);
			if ((args as any).includeRead) t += theme.fg("dim", " +read");
			return new Text(t, 0, 0);
		},
		renderResult(result, opts, theme) {
			const d = result.details as any;
			let t = `${theme.fg("success","✓")} ${theme.fg("accent", `${d?.count ?? 0} hits`)} ${theme.fg("dim", `via ${d?.engine ?? "rg"}`)}`;
			if (d?.reads) t += theme.fg("dim", ` +${d.reads} reads`);
			if (!opts.expanded) {
				t += ` ${theme.fg("dim", `(${keyHint("app.tools.expand","expand")})`)}`;
				return new Text(t, 0, 0);
			}
			const hits = (d?.hits ?? []).slice(0,8) as Array<any>;
			if (hits.length) t += `\n${hits.map((h:any)=>`  ${theme.fg("dim","•")} ${theme.fg("accent", `${h.file}:${h.line}`)} ${theme.fg("dim", h.preview.slice(0,80))}`).join("\n")}`;
			if ((d?.count??0)>8) t += `\n ${theme.fg("muted", `... ${d.count-8} more hits`)}`;
			return new Text(t, 0, 0);
		},
	});

	// ---- smart_patch — git apply bridge (deferred lazy)
	const smartPatchTool = defineTool({
		name: "smart_patch",
		label: "Smart Patch",
		description: "Apply a unified diff patch atomically via git apply (all hunks or none). Prefer for multi-hunk / multi-file changes. Deferred — use search_smart_tools to load.",
		promptSnippet: "Use smart_patch for unified diffs — atomic multi-file",
		promptGuidelines: [
			"Use smart_patch when you have a unified diff (git diff format) — it applies atomically via git apply.",
			"For single-file small edits, prefer smart_edit with short anchors.",
		],
		parameters: smartPatchParams,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			onUpdate?.({ message: "smart_patch: checking patch" } as any);
			const patch = params.patch;
			if (!patch || patch.trim().length < 10) throw new Error("smart_patch: patch too short or empty");
			if (patch.length > 500_000) throw new Error("smart_patch: patch too large (>500KB), split into smaller patches");
			const tmp = join(tmpdir(), `smart-patch-${randomUUID()}.patch`);
			await writeFile(tmp, patch, "utf8");
			try {
				// check first
				try {
					await execFile("git", ["apply", "--check", "--verbose", tmp], { cwd: ctx.cwd, timeout: 10000 } as any);
				} catch (e:any) {
					const out = String((e as any)?.stderr ?? (e as any)?.stdout ?? e?.message ?? "").slice(0, 1500);
					throw new Error(`smart_patch: git apply --check failed. Patch does not apply cleanly.\n--- git output ---\n${out}\n---\nHint: ensure patch is a valid unified diff (git diff) and file paths match. Try smart_edit with short anchors as fallback. Patch preview (first 800):\n${patch.slice(0,800)}`);
				}
				onUpdate?.({ message: "smart_patch: applying" } as any);
				await execFile("git", ["apply", tmp], { cwd: ctx.cwd, timeout: 15000 } as any);
				// invalidate caches for files mentioned in patch
				const files = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m=>m[1].trim()).slice(0, 20);
				for (const f of files) { readCache.delete(f); readCache.delete(resolve(ctx.cwd, f)); }
				state.smartPatches += 1;
				if (files.length > 1) { state.callsSaved += (files.length - 1); state.tokensSavedEst += estimateTokens(patch.length/4); }
				piRef.appendEntry("smart-tools:smart_patch", { files, at: Date.now(), bytes: patch.length });
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
			let t = `${theme.fg("success","✓")} ${theme.fg("accent", d?.files?.length ? `${d.files.length} file(s)` : "patch")} ${theme.fg("dim", "applied")}`;
			if (d?.bytes) t += theme.fg("dim", ` ${formatSize(d.bytes)}`);
			if (!opts.expanded) {
				t += ` ${theme.fg("dim", `(${keyHint("app.tools.expand","expand")})`)}`;
				return new Text(t, 0, 0);
			}
			if (d?.files?.length) t += `\n${d.files.slice(0,8).map((f:string)=>`  ${theme.fg("dim","•")} ${theme.fg("muted", f)}`).join("\n")}`;
			t += `\n${theme.fg("success", "applied")}`;
			return new Text(t, 0, 0);
		},
	});

	// ---- search_smart_tools — deferred loader (generic)
	const searchSmartToolsTool = defineTool({
		name: "search_smart_tools",
		label: "Search Smart Tools",
		description: "Search for and enable additional smart-tools (smart_grep, smart_patch) relevant to a task. Keeps initial prompt small.",
		promptSnippet: "Search for additional smart-tools when active tools cannot perform the task",
		promptGuidelines: ["Use search_smart_tools when you need grep/patch capabilities not currently active."] ,
		parameters: searchSmartToolsParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const terms = params.query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
			const candidates = pi.getAllTools().filter(t=> SEARCHABLE_TOOL_NAMES.has(t.name));
			const scored = candidates.map(tool=> ({ tool, score: terms.reduce((s,term)=> s + (`${tool.name} ${tool.description}`.toLowerCase().includes(term)?1:0), 0) })).filter(m=>m.score>0).sort((a,b)=>b.score-a.score).slice(0, params.limit ?? 3).map(m=>m.tool.name);
			// also keyword map for discoverability
			if (scored.length===0) {
				const q = params.query.toLowerCase();
				if (q.includes("grep")||q.includes("search")||q.includes("find")) scored.push("smart_grep");
				if (q.includes("patch")||q.includes("diff")||q.includes("apply")) scored.push("smart_patch");
			}
			const uniq = [...new Set(scored)].slice(0, params.limit ?? 3);
			if (uniq.length===0) return { content: [{ type: "text", text: `No tools found for: ${params.query}. Available lazy tools: ${[...SEARCHABLE_TOOL_NAMES].join(", ")}` }], details: { matches: [], added: [] } };
			const active = pi.getActiveTools();
			const added = uniq.filter(n=>!active.includes(n));
			if (added.length) pi.setActiveTools([...new Set([...active, ...added])]);
			state.searches += 1;
			piRef.appendEntry("smart-tools:search_smart_tools", { query: params.query, matches: uniq, added, at: Date.now() });
			syncSmartUI(ctx);
			return { content: [{ type: "text", text: added.length ? `Loaded tools: ${added.join(", ")} (queried: "${params.query}")` : `Matching tools already active: ${uniq.join(", ")}` }], details: { matches: uniq, added } };
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

	// -----------------------------------------------------------------------
	// Bash timeout gate — mandatory timeout (fail-safe) + visible injection
	// -----------------------------------------------------------------------
	// Track last injectedTimeout for tool_result annotation
	const lastInjected = new Map<string, number>();
	pi.on("tool_call", async (event, _ctx) => {
		if (!isToolCallEventType("bash", event)) return undefined;
		const input = event.input as { command: string; timeout?: number; _injectedTimeout?: number };
		let injected: number | undefined;
		if (input.timeout == null) {
			input.timeout = 30_000; injected = 30_000; state.bashInjected += 1;
		} else if (!Number.isFinite(input.timeout) || input.timeout <= 0) {
			input.timeout = 30_000; injected = 30_000; state.bashInjected += 1;
		} else if (input.timeout < 2000) {
			input.timeout = 2000; injected = 2000; state.bashInjected += 1;
		} else if (input.timeout > 120_000) {
			input.timeout = 120_000; injected = 120_000;
		}
		if (injected != null) {
			(input as any)._injectedTimeout = injected;
			// stash for result annotation if toolCallId available
			const id = (event as any).toolCallId ?? (event as any).id ?? "";
			if (id) lastInjected.set(String(id), injected);
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
		const injected = id ? lastInjected.get(String(id)) : undefined;
		if (id) lastInjected.delete(String(id));
		if (isTimeout) {
			state.timeoutsDetected += 1;
			if (!event.content || !Array.isArray((event as any).content)) return undefined;
			const base = event.content.map((c:any)=> c.type === "text" ? c.text : "").join("\n");
			return {
				content: [{ type: "text", text: `${base}\n\n[smart-tools: bash timed out (mandatory timeout ${injected? injected+"ms" : "enforced"}). Narrow the command, add filters, or increase timeout explicitly up to 120s.]` }],
				details: { ...details, smartToolsTimeout: true, injectedTimeout: injected },
			};
		}
		if (injected != null) {
			if (!event.content || !Array.isArray((event as any).content)) return undefined;
			const base = event.content.map((c:any)=> c.type === "text" ? c.text : "").join("\n");
			return {
				content: [{ type: "text", text: `${base}${base?"\n":""}[smart-tools: timeout ${injected}ms injected (mandatory gate)]` }],
				details: { ...details, injectedTimeout: injected },
			};
		}
		return undefined;
	});

	// -----------------------------------------------------------------------
	// Commands — smart-status / smart-history (UX)
	// -----------------------------------------------------------------------
	pi.registerCommand("smart-status", {
		description: "Show smart-tools status, telemetry and cache",
		handler: async (_args, ctx) => {
			const lines = [
				`smart-tools status — ${describeSmart()}`,
				`  edits: ${state.smartEdits}  reads: ${state.smartReads} (hits:${state.cacheHits} miss:${state.cacheMisses})  writes:${state.smartWrites} (dedup:${state.dedupSkipped})`,
				`  grep:${state.smartGreps}  patch:${state.smartPatches}  searches:${state.searches}`,
				`  saved: ${state.callsSaved} calls ~${estimateTokens(state.tokensSavedEst*4)} tokens  bash injected:${state.bashInjected} timeouts:${state.timeoutsDetected}`,
				`  cache: ${readCache.size}/${CACHE_MAX} entries  TTL 5min`,
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
	// Session lifecycle (smart-tools) — telemetry + deferred loading + widget
	// -----------------------------------------------------------------------
	pi.on("session_start", async (event, ctx) => {
		state.bashInjected = 0;
		state.smartEdits = 0;
		state.smartReads = 0;
		state.smartWrites = 0;
		state.smartGreps = 0;
		state.smartPatches = 0;
		state.searches = 0;
		// keep cumulative counters across restarts from entries
		let recoveredSaved = 0;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom") {
				if (entry.customType === "smart-tools:smart_edit") state.smartEdits += 1;
				if (entry.customType === "smart-tools:smart_read") state.smartReads += 1;
				if (entry.customType === "smart-tools:smart_write") state.smartWrites += 1;
				if (entry.customType === "smart-tools:smart_grep") state.smartGreps += 1;
				if (entry.customType === "smart-tools:smart_patch") state.smartPatches += 1;
				if (entry.customType === "smart-tools:search_smart_tools") state.searches += 1;
				// approx saved: sum of batched counts (heuristic)
				const d: any = (entry as any).data ?? {};
				if (d.edits && d.edits > 1) recoveredSaved += (d.edits - 1);
				if (Array.isArray(d.files) && d.files.length > 1) recoveredSaved += (d.files.length - 1);
				if (Array.isArray(d.writes) && d.writes.length > 1) recoveredSaved += (d.writes.length - 1);
			}
		}
		if (recoveredSaved) state.callsSaved = recoveredSaved;
		// deferred loading: keep lazy tools inactive initially (purely additive later via search_smart_tools)
		try {
			const active = pi.getActiveTools();
			const next = active.filter(n=> !SEARCHABLE_TOOL_NAMES.has(n));
			if (next.length !== active.length) pi.setActiveTools(next);
		} catch {}
		if (ctx.hasUI) {
			syncSmartUI(ctx);
			if (event.reason !== "startup") ctx.ui.notify(`smart-tools ready`, "info");
		}
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (state.callsSaved || state.cacheHits || state.smartEdits || state.smartReads) {
			try { (ctx as any)?.ui?.notify?.(`smart-tools session: saved ~${state.callsSaved} calls · ${state.cacheHits} cache hits · ${state.dedupSkipped} dedup skips`, "info"); } catch {}
		}
		readCache.clear();
		state.bashInjected = 0;
		state.smartEdits = 0;
		state.smartReads = 0;
		state.smartWrites = 0;
		state.smartGreps = 0;
		state.smartPatches = 0;
		state.searches = 0;
		state.callsSaved = 0;
		state.cacheHits = 0;
		state.cacheMisses = 0;
		state.tokensSavedEst = 0;
		state.dedupSkipped = 0;
		state.timeoutsDetected = 0;
	});
}
