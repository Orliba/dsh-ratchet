// 三个 ratchet 文档校验器的 host 侧封装。
//
// 这些脚本原本是 grill-with-docs skill 里"靠模型自觉去跑"的 Python 工具
// （stdlib-only，见 plugin/vendor/）。插件的价值就是把"自觉"变成"每次 checkpoint 必跑"：
// 模型不跑，就没有校验结果进面板，用户也就不需要相信模型自称的"我检查过了"。
//
// 设计约束：
//   1. 任何一步失败都不许抛出去把工具调用打挂 —— 校验是附加信息，不是前置条件。
//      缺 python、缺文件、超时、JSON 解析失败，一律降级成 { skipped, reason }。
//   2. 不 import 任何 @deepseek-ai/* 包，只用 node 内建，保证插件可零依赖加载。
//   3. 子进程必须带 timeout，并且被父 signal 打断时一起杀掉。

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

/** 候选代码根目录，用于 glossary↔code 一致性检查。按顺序取第一个存在的。 */
const CODE_ROOTS = ['src', 'lib', 'app', 'plugin', 'pkg', 'scripts']

let cachedPython

/**
 * 探测一个可用的 Python 解释器。
 * 结果缓存在模块级变量里：一次会话只付一次探测成本。
 * @param {string} [configured] - 配置里的显式路径，优先级最高。
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
	// DSH 自带运行时里有一份 python，作者机器上是确定可用的；别的机器上不存在就跳过。
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
			// 换下一个候选。
		}
	}
	cachedPython = null
	return null
}

/**
 * 跑一个 vendor 脚本并解析它的 `--output json` 输出。
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
				// 子进程可能已经退出。
			}
		}, timeoutMs)
		const onAbort = () => {
			try {
				child.kill('SIGKILL')
			} catch {
				// 同上。
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

/** 从脚本 stdout 里抠出 JSON 对象（脚本只印 JSON，但防御性取最后一个 '{' 开头）。 */
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

/** 把一条 finding 压成一行。 */
function formatFinding(finding) {
	const level = String(finding?.level ?? '?')
	const rule = String(finding?.rule ?? '?')
	const message = String(finding?.message ?? '')
	const file = typeof finding?.file === 'string' ? `${finding.file} ` : ''
	const marker = level === 'FAIL' ? 'FAIL' : level === 'WARN' ? 'warn' : 'ok'
	return `[${marker}] ${file}${rule}: ${message}`
}

/**
 * 一个校验器的标准返回形状。
 * @typedef {object} CheckResult
 * @property {string} name
 * @property {boolean} skipped
 * @property {string} [reason]
 * @property {string} [verdict]
 * @property {Record<string, number>} [counts]
 * @property {string[]} [findings]
 */

/** 检查 CONTEXT.md 术语表格式。 */
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

/** 检查 docs/adr/ 的编号与结构。 */
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

/** 检查术语表与代码用词是否一致（dead glossary / code-only 专有名词）。 */
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
			// vendor 里是复制来的上游样例数据（Order/Customer/Product），不排掉会冒充
			// 本项目的"未定义领域词"，把真正的信号淹掉。
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

	// 这个脚本不输出 verdict/findings（前两个脚本才输出），得自己从四个字段合成。
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

/** 把失败态收成一句人话。 */
function collapse(run, fallback) {
	if (run.timedOut) return '超时'
	const stderr = (run.stderr ?? '').trim().split('\n')[0]
	if (stderr === 'aborted') return '被中断'
	// spawn 失败（ENOENT/EACCES）跟"脚本跑了但输出不对"是两件事，别混成
	// 「JSON 解析失败：spawn ... ENOENT」这种让人以为解析器有问题的说法。
	if (stderr.includes('ENOENT')) return 'python 起不来（找不到这个解释器）'
	if (stderr.includes('EACCES')) return 'python 起不来（没有执行权限）'
	return stderr === '' ? fallback : `${fallback}：${stderr}`
}

/**
 * 跑全部三个校验器。
 * @param {object} options
 * @param {string} options.cwd - 项目根目录（绝对路径）。
 * @param {string} [options.pythonPath] - 显式 python 路径。
 * @param {number} [options.timeoutMs] - 单个脚本超时。
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
 * 把校验结果渲染成面板正文里的一段。
 * @param {{ python: string | null, results: CheckResult[] }} outcome
 * @param {number} [maxFindings] - 每个校验器最多列几条。
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

/** 读一个文件的行数与字节数，给面板贴"真产出"。 */
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

/** 解析 artifacts 里的一条相对路径。 */
export function absoluteFrom(cwd, entry) {
	return resolve(cwd, entry)
}
