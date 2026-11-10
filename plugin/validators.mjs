// Host-side wrapper around the three document validators.
//
// These scripts were Python tools in the grill-with-docs skill that "the model was
// trusted to run" (stdlib-only, see plugin/vendor/). The plugin's value is turning
// "trusted to" into "runs on every checkpoint": if the model skips them, no verdict
// reaches the panel, and the user never has to believe a self-reported "I checked".
//
// Design constraints:
//   1. No step may throw and take the tool call down with it — validation is extra
//      information, not a precondition. Missing python, missing file, timeout, bad
//      JSON: all degrade to { skipped, reason }.
//   2. No @deepseek-ai/* imports, only Node built-ins, so the plugin loads with zero
//      runtime dependencies.
//   3. Subprocesses must carry a timeout and be killed when the parent signal aborts.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const VENDOR_DIR = join(HERE, 'vendor')

export const SCRIPTS = {
	context: join(VENDOR_DIR, 'context_md_linter.py'),
	adr: join(VENDOR_DIR, 'adr_scanner.py'),
	glossary: join(VENDOR_DIR, 'glossary_code_consistency.py'),
}

/** Candidate code roots for the glossary↔code consistency check. First one that exists wins. */
const CODE_ROOTS = ['src', 'lib', 'app', 'plugin', 'pkg', 'scripts']

let cachedPython

/**
 * Probe for a usable Python interpreter.
 * The result is cached at module level: one probe per session, not per checkpoint.
 * @param {string} [configured] - explicit path from config, highest priority.
 * @returns {{ command: string, prefix: string[], label: string } | null}
 */
export function resolvePython(configured) {
	const explicit = (configured ?? '').trim() || (process.env.RATCHET_PYTHON ?? '').trim()
	if (explicit !== '') return { command: explicit, prefix: [], label: explicit }
	if (cachedPython !== undefined) return cachedPython

	const candidates = [
		{ command: 'python', prefix: [], label: 'python' },
		{ command: 'python3', prefix: [], label: 'python3' },
		{ command: 'py', prefix: ['-3'], label: 'py -3' },
	]
	// The DSH bundled runtime ships a python that is known good on the author's
	// machine; on other machines it simply is not there and gets skipped.
	const bundled = join(process.env.DSH_INSTALL_ROOT ?? 'H:\\Deepseekstudio', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'python', 'python.exe')
	if (existsSync(bundled)) candidates.push({ command: bundled, prefix: [], label: 'dsh-bundled' })

	for (const candidate of candidates) {
		try {
			const probe = spawnSync(candidate.command, [...candidate.prefix, '-c', 'print(1)'], {
				timeout: 5000,
				encoding: 'utf8',
				windowsHide: true,
			})
			if (probe.status === 0 && (probe.stdout ?? '').trim() === '1') {
				cachedPython = candidate
				return cachedPython
			}
		} catch {
			// Try the next candidate.
		}
	}
	cachedPython = null
	return null
}

/**
 * Run one vendor script and parse its `--output json` payload.
 * @returns {Promise<{ ok: boolean, code: number | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
function runScript(python, script, args, cwd, timeoutMs, signal) {
	return new Promise((settle) => {
		if (signal?.aborted === true) {
			settle({ ok: false, code: null, stdout: '', stderr: 'aborted', timedOut: false })
			return
		}
		let child
		try {
			child = spawn(python.command, [...python.prefix, script, ...args], {
				cwd,
				windowsHide: true,
				stdio: ['ignore', 'pipe', 'pipe'],
			})
		} catch (error) {
			settle({ ok: false, code: null, stdout: '', stderr: String(error?.message ?? error), timedOut: false })
			return
		}
		let stdout = ''
		let stderr = ''
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			try {
				child.kill('SIGKILL')
			} catch {
				// The child may already have exited.
			}
		}, timeoutMs)
		const onAbort = () => {
			try {
				child.kill('SIGKILL')
			} catch {
				// Same as above.
			}
		}
		signal?.addEventListener?.('abort', onAbort, { once: true })
		child.stdout?.setEncoding('utf8')
		child.stderr?.setEncoding('utf8')
		child.stdout?.on('data', (chunk) => {
			stdout += chunk
		})
		child.stderr?.on('data', (chunk) => {
			stderr += chunk
		})
		child.on('error', (error) => {
			clearTimeout(timer)
			signal?.removeEventListener?.('abort', onAbort)
			settle({ ok: false, code: null, stdout, stderr: `${stderr}${String(error?.message ?? error)}`, timedOut })
		})
		child.on('close', (code) => {
			clearTimeout(timer)
			signal?.removeEventListener?.('abort', onAbort)
			settle({ ok: code === 0, code, stdout, stderr, timedOut })
		})
	})
}

/** Dig the JSON object out of stdout (scripts print JSON only, but tolerate leading noise). */
function parseJson(stdout) {
	const text = (stdout ?? '').trim()
	if (text === '') return undefined
	try {
		return JSON.parse(text)
	} catch {
		const start = text.indexOf('{')
		const end = text.lastIndexOf('}')
		if (start === -1 || end <= start) return undefined
		try {
			return JSON.parse(text.slice(start, end + 1))
		} catch {
			return undefined
		}
	}
}

/** Collapse one finding into a single line. */
function formatFinding(finding) {
	const level = String(finding?.level ?? '?')
	const rule = String(finding?.rule ?? '?')
	const message = String(finding?.message ?? '')
	const file = typeof finding?.file === 'string' ? `${finding.file} ` : ''
	const marker = level === 'FAIL' ? 'FAIL' : level === 'WARN' ? 'warn' : 'ok'
	return `[${marker}] ${file}${rule}: ${message}`
}

/**
 * The standard shape every validator returns.
 * @typedef {object} CheckResult
 * @property {string} name
 * @property {boolean} skipped
 * @property {string} [reason]
 * @property {string} [verdict]
 * @property {Record<string, number>} [counts]
 * @property {string[]} [findings]
 */

/** Check the CONTEXT.md glossary format. */
async function checkContext(ctx) {
	const path = join(ctx.cwd, 'CONTEXT.md')
	if (!existsSync(path)) return { name: 'CONTEXT.md 术语表', skipped: true, reason: '没有 CONTEXT.md（这段还没建术语表）' }
	const run = await runScript(ctx.python, SCRIPTS.context, [path, '--output', 'json'], ctx.cwd, ctx.timeoutMs, ctx.signal)
	const parsed = parseJson(run.stdout)
	if (parsed === undefined) return { name: 'CONTEXT.md 术语表', skipped: true, reason: collapse(run, 'JSON 解析失败') }
	return {
		name: 'CONTEXT.md 术语表',
		skipped: false,
		verdict: String(parsed.verdict ?? '?'),
		counts: parsed.counts ?? {},
		findings: (parsed.findings ?? []).filter((f) => f?.level !== 'PASS').map(formatFinding),
	}
}

/** Check the numbering and structure under docs/adr/. */
async function checkAdr(ctx) {
	const dir = join(ctx.cwd, 'docs', 'adr')
	if (!existsSync(dir)) return { name: 'ADR 目录', skipped: true, reason: '没有 docs/adr/（这段不需要决策记录）' }
	const run = await runScript(ctx.python, SCRIPTS.adr, [dir, '--output', 'json'], ctx.cwd, ctx.timeoutMs, ctx.signal)
	const parsed = parseJson(run.stdout)
	if (parsed === undefined) return { name: 'ADR 目录', skipped: true, reason: collapse(run, 'JSON 解析失败') }
	return {
		name: 'ADR 目录',
		skipped: false,
		verdict: String(parsed.verdict ?? '?'),
		counts: { adr: Number(parsed.adr_count ?? 0), ...(parsed.counts ?? {}) },
		findings: (parsed.findings ?? []).filter((f) => f?.level !== 'PASS').map(formatFinding),
	}
}

/** Check whether the glossary and the code use the same words (dead glossary / code-only nouns). */
async function checkGlossary(ctx) {
	const contextPath = join(ctx.cwd, 'CONTEXT.md')
	if (!existsSync(contextPath)) return { name: '术语↔代码一致性', skipped: true, reason: '没有 CONTEXT.md' }
	const codeRoot = CODE_ROOTS.map((name) => join(ctx.cwd, name)).find((candidate) => existsSync(candidate))
	if (codeRoot === undefined) return { name: '术语↔代码一致性', skipped: true, reason: '没找到代码目录（src/lib/app/…）' }
	const run = await runScript(
		ctx.python,
		SCRIPTS.glossary,
		[
			'--context',
			contextPath,
			'--code',
			codeRoot,
			// The vendor directory holds copied upstream sample data (Order/Customer/
			// Product); leaving it in makes those pose as this project's undefined domain
			// nouns and drowns the real signal.
			'--exclude',
			'vendor',
			'--output',
			'json',
		],
		ctx.cwd,
		ctx.timeoutMs,
		ctx.signal,
	)
	const parsed = parseJson(run.stdout)
	if (parsed === undefined) return { name: '术语↔代码一致性', skipped: true, reason: collapse(run, 'JSON 解析失败') }
	const scanned = Number(parsed.files_scanned ?? 0)
	if (scanned === 0) return { name: '术语↔代码一致性', skipped: true, reason: '代码目录里没有可扫的源文件' }

	// This script emits no verdict/findings (only the first two do), so the verdict is
	// synthesized from its four raw fields.
	const dead = Array.isArray(parsed.dead_glossary_terms) ? parsed.dead_glossary_terms : []
	const codeOnly = Array.isArray(parsed.code_only_proper_nouns) ? parsed.code_only_proper_nouns : []
	const findings = []
	for (const term of dead) findings.push(`[warn] dead-glossary: 「${String(term)}」在术语表里，代码里一次都没用到 —— 改名了，还是压根没实现？`)
	for (const each of codeOnly) {
		const noun = Array.isArray(each) ? each[0] : each?.noun
		const count = Array.isArray(each) ? each[1] : each?.count
		findings.push(`[warn] code-only: 代码里的「${String(noun)}」出现 ${String(count)} 次，术语表里没有 —— 是该定义的领域词，还是普通词？`)
	}
	return {
		name: '术语↔代码一致性',
		skipped: false,
		verdict: findings.length === 0 ? 'PASS' : 'WARN',
		counts: { files: scanned, terms: Number(parsed.glossary_term_count ?? 0), dead: dead.length, codeOnly: codeOnly.length },
		findings,
	}
}

/** Reduce a failure state to one plain sentence. */
function collapse(run, fallback) {
	if (run.timedOut) return '超时'
	const stderr = (run.stderr ?? '').trim().split('\n')[0]
	if (stderr === 'aborted') return '被中断'
	// A failed spawn (ENOENT/EACCES) and "the script ran but printed nonsense" are two
	// different things. Merging them produces "JSON 解析失败：spawn ... ENOENT", which
	// reads as a broken parser rather than a broken interpreter path.
	if (stderr.includes('ENOENT')) return 'python 起不来（找不到这个解释器）'
	if (stderr.includes('EACCES')) return 'python 起不来（没有执行权限）'
	return stderr === '' ? fallback : `${fallback}：${stderr}`
}

/**
 * Run all three validators.
 * @param {object} options
 * @param {string} options.cwd - project root (absolute path).
 * @param {string} [options.pythonPath] - explicit python path.
 * @param {number} [options.timeoutMs] - per-script timeout.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ python: string | null, results: CheckResult[], allSkipped: boolean }>}
 */
export async function runAllChecks(options) {
	const python = resolvePython(options.pythonPath)
	if (python === null) {
		const reason = '找不到可用的 python 解释器（可用 config.pythonPath 或 RATCHET_PYTHON 指定）'
		return {
			python: null,
			results: [
				{ name: 'CONTEXT.md 术语表', skipped: true, reason },
				{ name: 'ADR 目录', skipped: true, reason },
				{ name: '术语↔代码一致性', skipped: true, reason },
			],
			allSkipped: true,
		}
	}
	const ctx = {
		cwd: options.cwd,
		python,
		timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20000,
		signal: options.signal,
	}
	const results = []
	for (const check of [checkContext, checkAdr, checkGlossary]) {
		try {
			results.push(await check(ctx))
		} catch (error) {
			results.push({ name: '校验器', skipped: true, reason: String(error?.message ?? error) })
		}
	}
	return { python: python.label, results, allSkipped: results.every((entry) => entry.skipped === true) }
}

/**
 * Render the validators into one block of panel body text.
 *
 * Kept for callers that want a plain list; the checkpoint panel now prefers
 * render.mjs's badge row. Still covered by tests, so it must not rot.
 *
 * @param {{ python: string | null, results: CheckResult[] }} outcome
 * @param {number} [maxFindings] - max findings listed per validator.
 * @returns {string}
 */
export function renderChecks(outcome, maxFindings = 4) {
	const lines = ['### 文档校验']
	for (const result of outcome.results) {
		if (result.skipped === true) {
			lines.push(`- ${result.name}: 跳过 —— ${result.reason ?? '不适用'}`)
			continue
		}
		const counts = result.counts ?? {}
		const countsText = Object.entries(counts)
			.filter(([, value]) => typeof value === 'number')
			.map(([key, value]) => `${key} ${value}`)
			.join(' / ')
		lines.push(`- ${result.name}: **${result.verdict ?? '?'}**${countsText === '' ? '' : ` (${countsText})`}`)
		const shown = (result.findings ?? []).slice(0, maxFindings)
		for (const finding of shown) lines.push(`  - ${finding}`)
		const hidden = (result.findings ?? []).length - shown.length
		if (hidden > 0) lines.push(`  - …另有 ${hidden} 条`)
	}
	return lines.join('\n')
}

/** Read a file's line and byte counts, so the panel can show something real. */
export function describeFile(absolutePath) {
	try {
		const info = statSync(absolutePath)
		if (!info.isFile()) return { path: absolutePath, exists: true, note: '不是普通文件' }
		let lines
		if (info.size <= 2 * 1024 * 1024) {
			try {
				lines = readFileSync(absolutePath, 'utf8').split('\n').length - 1
			} catch {
				lines = undefined
			}
		}
		return { path: absolutePath, exists: true, bytes: info.size, lines, mtime: new Date(info.mtimeMs).toISOString() }
	} catch {
		return { path: absolutePath, exists: false }
	}
}

/** Resolve one relative artifact path against the working directory. */
export function absoluteFrom(cwd, entry) {
	return resolve(cwd, entry)
}
