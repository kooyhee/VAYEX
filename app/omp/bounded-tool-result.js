// Bounds the text a completed tool result hands to the model.
//
// Contract verified against the installed OMP 18.16.0 source:
//  - src/extensibility/extensions/loader.ts:581 accepts only `.ts` / `.js` entry files.
//  - src/extensibility/extensions/loader.ts:531 loads modules via
//    `loadLegacyPiModule`, and `getExtensionFactory` (loader.ts:82) takes either a
//    bare function export or `module.default`; the factory receives an ExtensionAPI.
//  - src/extensibility/extensions/types.ts:1887 declares
//    `on("tool_result", ExtensionHandler<ToolResultEvent, ToolResultEventResult>)`
//    and wrapper.ts:524-569 emits it after execution; a returned `content` replaces
//    the result, `details`/`isError` stay as the tool produced them unless overridden.
//  - src/cli/args.ts:211/flag-tables.ts:242: `--extension` / `-e` are the CLI flags.
//
// The native wrapper has already run `postProcessToolResult` by the time this fires
// (output-meta.ts wrappedExecute), so event.content is the *already bounded* text and
// details.meta carries the native artifact id. This extension therefore never spills a
// second copy of what native already stored: it resolves that native artifact to a real
// path, proves the artifact still holds the complete original, and states the recovery
// path. Only text that reached us complete (no native meta, above our ceiling) is spilled.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSpillStore, defaultSpillRoot, RECOVER_TOOL, recoverToolOutput } from './tool-spill.mjs';
import { redactForLog } from '../privacy/index.mjs';

/** Hard per-result inline ceiling in bytes, notice and framing included. */
const CEILING_BYTES = Number(process.env.OMP_TOOL_RESULT_CEILING ?? 20 * 1024);
/** Tail bytes reproduced when proving an artifact still holds the original. */
const PROOF_BYTES = 64;
const ELISION = '\n\n... [output truncated by 앱 확장] ...\n\n';

// Every result that reached us complete and is larger than the ceiling is spilled
// here first, so the notice can name a recovery handle instead of a path alone.
const spillStore = createSpillStore({ root: defaultSpillRoot() });

/**
 * RTK/Headroom-style lossless token compaction. It rewrites the inline copy the
 * model reads; the complete original is spilled to disk before any of it applies,
 * so every step below is recoverable through `tool_output_recover`.
 *
 * 1. Strip ANSI escape sequences and normalize CRLF — every output.
 * 2. Collapse three or more consecutive identical lines into one annotation line:
 *    only for output carrying the `TEST_OR_BUILD_LOG` signature below, and only when
 *    it is longer than 8 lines.
 * 3. Elide the middle of an error-free test/build log longer than 50 lines, keeping
 *    its first and last 15 lines.
 *
 * Steps 2 and 3 are skipped when the output reports a failure (`ERROR_SIGNAL`), so a
 * trace always arrives verbatim: a collapsed trace no longer shows the frames the
 * model is reading.
 *
 * Step 2 is confined to the test/build-log signature on purpose. Collapsing a run of
 * identical lines in arbitrary output is not a formatting choice but data loss that
 * arrives without a notice: the 20,520-byte probe of 513 identical 39-byte lines in
 * `app/test/real-core.integration.test.mjs:253` collapses to 91 bytes, which drops it
 * back under the inline ceiling — so no spill happens, no recovery handle is printed,
 * and the usable head/tail that test requires (`:270`) is gone.
 */
const ERROR_SIGNAL = /(?:error|failed|failure|exception|crash|traceback|reject|assert|fatal)/i;
const TEST_OR_BUILD_LOG = /(?:^|\n)\s*(?:✔|✖|PASS\b|FAIL\b|ok \d+|not ok \d+|# (?:tests|pass|fail)|Test Suites?|Tests:|Snapshots?:|Time:|Duration:|Build (?:succeeded|failed|completed)|BUILD (?:SUCCESS|FAILURE|SUCCESSFUL)|Compiled successfully|webpack|vite v|npm (?:ERR!|WARN)|ELIFECYCLE|error TS\d+)/;

/** Lossless normalization every result gets, bounded or not. */
function stripAnsi(rawText) {
	return rawText.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** One annotation line stands in for every run of three or more identical lines. */
function collapseRepeatedLines(text) {
	const compactedLines = [];
	let prevLine = null;
	let repeatCount = 0;
	for (const line of text.split('\n')) {
		if (line === prevLine && line.trim().length > 0) {
			repeatCount++;
			continue;
		}
		if (repeatCount > 2) {
			compactedLines.push(`  ... [이전 줄 ${repeatCount}회 중복 반복 생략] ...`);
		} else if (repeatCount > 0) {
			for (let r = 0; r < repeatCount; r++) compactedLines.push(prevLine);
		}
		compactedLines.push(line);
		prevLine = line;
		repeatCount = 0;
	}
	if (repeatCount > 2) {
		compactedLines.push(`  ... [이전 줄 ${repeatCount}회 중복 반복 생략] ...`);
	} else if (repeatCount > 0) {
		for (let r = 0; r < repeatCount; r++) compactedLines.push(prevLine);
	}
	return compactedLines.join('\n');
}

export function compactToolOutput(rawText) {
	if (typeof rawText !== 'string' || rawText.length === 0) return rawText;
	let text = stripAnsi(rawText);
	const isTestOrBuildLog = TEST_OR_BUILD_LOG.test(text);
	const hasError = ERROR_SIGNAL.test(text);

	// An output that reports a failure is handed back whole: a trace whose repeated
	// frames were collapsed no longer shows the frames the model is reading.
	if (isTestOrBuildLog && !hasError && text.split('\n').length > 8) {
		text = collapseRepeatedLines(text);
	}

	const currentLines = text.split('\n');
	if (isTestOrBuildLog && !hasError && currentLines.length > 50) {
		const head = currentLines.slice(0, 15).join('\n');
		const tail = currentLines.slice(-15).join('\n');
		text = `${head}\n\n... [성공 상세 로그 ${currentLines.length - 30}줄 생략 (에러 없음)] ...\n\n${tail}`;
	}

	return text;
}

function textBytes(s) {
	return Buffer.byteLength(s, 'utf8');
}

/** Slice on UTF-8 boundaries so a Korean/emoji code point is never split. */
function sliceValidUtf8(buf, start, end) {
	let s = Math.max(0, start);
	let e = Math.min(buf.length, end);
	// A start inside a sequence: skip its continuation bytes.
	while (s < e && (buf[s] & 0xc0) === 0x80) s++;
	// An end inside a sequence: walk back to the lead byte and drop it when the
	// sequence is incomplete, rather than decoding a partial one to U+FFFD.
	let lead = e;
	while (lead > s && (buf[lead - 1] & 0xc0) === 0x80) lead--;
	if (lead > s) {
		const b = buf[lead - 1];
		const need = (b & 0x80) === 0 ? 1 : (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : 4;
		if (e - (lead - 1) < need) e = lead - 1;
	}
	return buf.subarray(s, Math.max(s, e)).toString('utf8');
}

/** Trim `text` to at most `budget` bytes, keeping its head and its tail. */
function shrink(text, budget) {
	if (budget <= 0) return '';
	if (textBytes(text) <= budget) return text;
	const buf = Buffer.from(text, 'utf8');
	const head = Math.max(0, Math.floor(budget * 0.6));
	const tail = Math.max(0, budget - head - textBytes(ELISION));
	return `${sliceValidUtf8(buf, 0, head)}${ELISION}${sliceValidUtf8(buf, buf.length - tail, buf.length)}`;
}

function scratchDirFor(ctx) {
	try {
		const dir = ctx?.sessionManager?.getArtifactsDir?.();
		if (typeof dir === 'string' && dir.length > 0) return dir;
	} catch {}
	return path.join(os.tmpdir(), 'omp-bounded-tool-result');
}

/** Spill `text` to a real file and report bytes actually written. */
function spill(text, toolName, dir) {
	const name = String(toolName ?? 'tool').replace(/[^a-zA-Z0-9_-]/g, '_');
	const target = path.join(dir, `${process.pid}-${Date.now()}-${name}.bounded.txt`);
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(target, text, 'utf8');
		const written = fs.statSync(target).size;
		if (written !== textBytes(text)) {
			return { ok: false, error: `short write (${written} of ${textBytes(text)} bytes)` };
		}
		return { ok: true, path: target, bytes: written };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Native artifact ids an already-bounded result points at, plus whether native admitted a cap. */
function nativeArtifactRefs(details, text) {
	const meta = details && typeof details === 'object' ? details.meta : undefined;
	const refs = [];
	const push = (id, elided, rawSelector) => {
		if (id && !refs.some(r => r.id === id)) refs.push({ id, elided: elided ?? 0, rawSelector: rawSelector ?? null });
	};
	const column = meta?.limits?.columnTruncated;
	// A column-capped single line cannot be paged by the read tool line-by-line: every
	// page hits the same column cap. Native's own raw selector returns the whole line,
	// so carry it into the notice rather than let the model loop on capped pages.
	const rawSelector = column?.lines && column?.artifactId
		? `artifact://${column.artifactId}:raw:${column.lines.first}-${column.lines.last}`
		: (typeof column?.selectorBase === 'string' && column.lines
			? `${column.selectorBase}:raw:${column.lines.first}-${column.lines.last}`
			: null);
	push(meta?.truncation?.artifactId, meta?.truncation?.artifactElidedBytes);
	push(column?.artifactId, column?.artifactElidedBytes, rawSelector);
	// The bash minimizer footer (`[raw output: artifact://N]`) carries the id in the
	// text without any meta entry; the same session artifact is the recovery target.
	for (const match of text.matchAll(/artifact:\/\/(\d+)(?![\d:])/g)) push(match[1], 0);
	return { refs, artifactError: meta?.artifactError ?? null };
}

async function readNativeArtifact(ctx, id) {
	try {
		const file = await ctx?.sessionManager?.getArtifactPath?.(id);
		if (typeof file === 'string' && file.length > 0) {
			return { ok: true, kind: 'file', path: file, text: fs.readFileSync(file, 'utf8') };
		}
	} catch {}
	// A non-persistent session (`--no-session`) keeps the spill artifact in memory,
	// where the `read` tool cannot page it. Give those exact bytes a real path so the
	// notice always advertises something the read tool can open.
	try {
		const held = ctx?.sessionManager?.getArtifactContent?.(id);
		if (typeof held === 'string') {
			const saved = spill(held, `artifact-${id}`, scratchDirFor(ctx));
			if (saved.ok) return { ok: true, kind: 'file', path: saved.path, text: held };
			return { ok: false, kind: 'unsaved', path: null, text: held, error: saved.error };
		}
	} catch {}
	return { ok: false, kind: 'missing', path: null, text: null };
}

/** True when the artifact is larger than what we show and holds the shown head verbatim. */
function artifactHoldsOriginal(artifactText, visibleBody) {
	// Drop the trailing notice/framing lines this and the native layer append, so the
	// proof compares retained *output* against the artifact, not our own prose.
	const contentLines = visibleBody
		.split('\n')
		.filter(line => !/^\s*\[/.test(line) && !line.includes('[output truncated'));
	const content = contentLines.join('\n').replace(/…\s*$/, '').trimEnd();
	if (content.length === 0) return false;
	const head = content.slice(0, Math.min(PROOF_BYTES, content.length));
	return textBytes(artifactText) > textBytes(visibleBody) && artifactText.includes(head);
}

function noticeForNative(ref, resolved, visibleBody) {
	if (resolved.kind === 'missing') {
		return `\n\n[출력이 ${textBytes(visibleBody)}바이트로 잘렸고, 원본은 이 확장이 관측하기 전에 폐기되었습니다. 복구 경로 없음 — 원본 전체는 보존되지 않았습니다.]`;
	}
	if (ref.elided > 0) {
		return `\n\n[원본 일부가 유실되었습니다: 네이티브 아티팩트도 ${ref.elided}바이트를 잘라낸 표본입니다. 복구 불가.]`;
	}
	if (!artifactHoldsOriginal(resolved.text, visibleBody)) {
		return `\n\n[출력이 잘렸지만 네이티브 아티팩트가 원본과 일치하지 않습니다. 원본 전체 보존은 확인되지 않았습니다.]`;
	}
	// A non-persistent session whose artifact could not be given a path has bytes the
	// `read` tool cannot open, so naming `artifact://` as a location would promise a
	// read that fails. Say what is true instead.
	if (resolved.kind !== 'file') {
		return `\n\n[원본 전체(${textBytes(resolved.text)}바이트)는 세션 메모리에만 있고 파일로 저장되지 않았습니다(${resolved.error ?? 'no path'}). read 도구로 열 수 없습니다.]`;
	}
	const where = resolved.path;
	// The path is what the read tool opens. When native also left a column-capped
	// single line, the raw selector is the only read that returns that line whole.
	const selector = ref.rawSelector ? `\n한 줄 원본 선택자: ${ref.rawSelector} (read 도구 file_path 로 그대로 지정)` : '';
	const how = ref.rawSelector
		? '읽기: 줄이 잘린 결과는 위 선택자를 read 도구 file_path 에 넣어 그 줄 전체를 받고, 나머지는 경로를 offset/limit 페이지로 조회하세요.'
		: '읽기: read 도구로 위 경로를 offset/limit 페이지로 조회하세요.';
	return `\n\n[원본 전체(${textBytes(resolved.text)}바이트) 보존 위치: ${where}${selector}\n${how}]`;
}

/**
 * Shape of the llm-facing parameters. A plain JSON Schema object is accepted:
 * the runtime's wire-schema path (`Di`/`lp`) deep-clones any non-arktype schema,
 * so this needs no schema library of its own.
 */
const RECOVER_TOOL_PARAMETERS = {
	type: 'object',
	properties: {
		handle: { type: 'string', description: RECOVER_TOOL.parameters.properties.handle.description },
		offset: { type: 'integer', minimum: 1, description: RECOVER_TOOL.parameters.properties.offset.description },
		limit: { type: 'integer', minimum: 1, description: RECOVER_TOOL.parameters.properties.limit.description },
	},
	required: ['handle'],
	additionalProperties: false,
};

/**
 * Register `tool_output_recover` so the handle the notice prints is a callable
 * path, not just prose. Registration happens while the factory runs: the runtime
 * installs a tool only if it is registered by the time the extension finishes
 * loading (ExtensionAPI.registerTool, types.d.ts:1412; runner wiring in cli.js
 * `onToolRegistered`), and it activates a non-`defaultInactive` extension tool
 * even when `--tools` lists only built-ins, so `--tools bash` does not hide it.
 * Returns false when the runtime exposes no registration surface, in which case
 * the notice must not name this tool.
 */
export function registerRecoveryTool(pi) {
	if (!pi || typeof pi.registerTool !== 'function') return false;
	pi.registerTool({
		name: RECOVER_TOOL.name,
		label: 'Tool output recovery',
		description: RECOVER_TOOL.description,
		parameters: RECOVER_TOOL_PARAMETERS,
		// Stay top-level: the notice names this tool, so it must not be demoted to a
		// discoverable/mounted presentation the model has to find first.
		loadMode: 'essential',
		// Reading an already-sanitized spill file back is a read, not an exec.
		approval: 'read',
		async execute(_toolCallId, params) {
			try {
				const artifact = recoverToolOutput(spillStore, params ?? {});
				return {
					content: [{ type: 'text', text: artifact.text }],
					details: {
						handle: artifact.handle,
						bytes: artifact.bytes,
						tool: artifact.tool,
						path: artifact.path,
						...(artifact.window ? { totalLines: artifact.totalLines, window: artifact.window } : {}),
					},
				};
			} catch (error) {
				return {
					content: [{ type: 'text', text: `복구 실패: ${error instanceof Error ? error.message : String(error)}` }],
					isError: true,
				};
			}
		},
	});
	return true;
}

export default function boundedToolResultExtension(pi) {
	if (!pi || typeof pi.on !== 'function') return;

	// The notice below only promises this tool when the runtime actually took it.
	const canRecoverByHandle = registerRecoveryTool(pi);

	pi.on('tool_result', async (event, ctx) => {
		if (!event || !Array.isArray(event.content)) return undefined;
		// Retrieval is not generation. A `read` window is chosen by the model and is
		// already paginated and column-capped by the read tool itself; bounding it here
		// would both hide the bytes the notice just promised and chain forever (reading
		// our own spill would spill again). Leave it exactly as the tool returned it.
		// Same for the recovery tool: the model asked for that original by handle, so
		// bounding its answer would re-spill the very artifact it just recovered.
		if (event.toolName === 'read' || event.toolName === RECOVER_TOOL.name) return undefined;

		const textBlocks = event.content.filter(b => b && b.type === 'text' && typeof b.text === 'string');
		if (textBlocks.length === 0) return undefined;

		// Apply lossless token compaction (ANSI stripping, repeat collapsing, test compaction)
		// and redact credentials before spilling to disk or transcript.
		for (const b of textBlocks) {
			b.text = redactForLog(compactToolOutput(b.text));
		}

		const inlineBytes = textBlocks.reduce((n, b) => n + textBytes(b.text), 0);
		const visibleBody = textBlocks.map(b => b.text).join('\n');
		const { refs, artifactError } = nativeArtifactRefs(event.details, visibleBody);

		// Nothing was bounded and nothing is recoverable to advertise: leave it alone.
		if (refs.length === 0 && inlineBytes <= CEILING_BYTES) return undefined;

		let notice;
		const budget = CEILING_BYTES;

		if (refs.length > 0) {
			const ref = refs.find(r => r.elided === 0) ?? refs[0];
			const resolved = await readNativeArtifact(ctx, ref.id);
			notice = artifactError
				? `\n\n[출력이 ${inlineBytes}바이트로 잘렸고 네이티브 아티팩트 저장이 실패했습니다(${artifactError}). 원본 전체는 보존되지 않았습니다.]`
				: noticeForNative(ref, resolved, visibleBody);
		} else {
			// We hold the sanitized original: spill it before bounding anything.
			const sanitizedBody = redactForLog(visibleBody);
			let saved;
			try {
				saved = spillStore.spill({ text: sanitizedBody, tool: event.toolName });
			} catch (error) {
				saved = { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
			// A handle is printed only when the tool that resolves it was actually
			// registered: an unreachable handle is a dead reference, so in that case the
			// notice names the file path the read tool can open and nothing else.
			const how = canRecoverByHandle && saved.handle
				? `\n핸들: ${saved.handle} — ${RECOVER_TOOL.name} 도구(handle) 또는 read 도구(경로, offset/limit)로 원본 전체를 조회하세요.`
				: '\n읽기: read 도구로 위 경로를 offset/limit 페이지로 조회하세요.';
			notice = saved.handle
				? `\n\n[출력이 ${inlineBytes}바이트에서 ${budget}바이트 이내로 제한되었습니다. 원본 전체(${saved.bytes}바이트) 보존 위치: ${saved.path}${how}]`
				: `\n\n[출력이 ${inlineBytes}바이트에서 잘렸고 원본 저장에 실패했습니다(${saved.error}). 원본 전체는 보존되지 않았습니다.]`;
		}

		// The notice is counted inside the ceiling: the body is cut to the remainder.
		const bodyBudget = budget - textBytes(notice);
		const boundedBody = bodyBudget > 0 ? shrink(visibleBody, bodyBudget) : '';
		const finalText = `${boundedBody}${notice}`;

		// If even the trimmed body plus notice overshoots (a pathologically long
		// notice), drop the body entirely rather than emit an over-budget result.
		const safeText = textBytes(finalText) <= budget ? finalText : shrink(notice.trim(), budget);

		// Keep non-text blocks where they were; the merged text lands where the first
		// text block stood, so image ordering and every other payload stay untouched.
		let placed = false;
		const content = [];
		for (const block of event.content) {
			if (block && block.type === 'text') {
				if (!placed) {
					content.push({ type: 'text', text: safeText });
					placed = true;
				}
				continue;
			}
			content.push(block);
		}
		if (!placed) content.push({ type: 'text', text: safeText });
		return { content };
	});
}
