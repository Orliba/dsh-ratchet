// Panel body rendering — the layer that exists purely for human eyes.
//
// Why it is separate from the `text` returned to the model in index.mjs:
//   text   goes to the model — complete and rigidly structured, plain is fine;
//   detail lands on the panel — must show at a glance what got done, whether
//          anything is wrong, and what comes next.
// Previously both shared one body, and the result was a wall of equally-weighted
// lines on dark grey: visually, one lump.
//
// Only syntax that MarkdownText is confirmed to support is used here: heading /
// paragraph / list / blockquote / thematicBreak / strong / inlineCode. No tables
// (there is no GFM extension), no task lists, no raw HTML.

/** Verdict marks: quieter than emoji, legible in both monospace and body text. */
export const VERDICT_MARK = { PASS: '✓', WARN: '!', FAIL: '×', SKIP: '–' }

const SHORT_NAME = {
	'CONTEXT.md 术语表': '术语表',
	'ADR 目录': 'ADR',
	'术语↔代码一致性': '一致性',
}

/** Short validator names: laid out side by side, long names blow the row apart. */
export function shortCheckName(name) {
	return SHORT_NAME[name] ?? name
}

/** Turn a block of text into a quote (every line gets `>`, or only the first renders as one). */
function quote(text) {
	return String(text)
		.split('\n')
		.map((line) => `> ${line}`)
		.join('\n')
}

/** Byte counts are only the fallback when no line count exists, so no "0.0 KB" noise. */
function formatBytes(bytes) {
	if (typeof bytes !== 'number') return ''
	if (bytes < 1024) return `${bytes} B`
	return `${(bytes / 1024).toFixed(1)} KB`
}

/**
 * What was read before starting. It shows the user what the model actually read,
 * and doubles as evidence for "we only ask what the files cannot answer".
 * @param {{cwd:string, files:string[], hasAdr:boolean, topLevel:number, hasContext:boolean, hasManifest:boolean}} info
 */
export function renderRecon(info) {
	const lines = [`**开工前读到的**　\`${info.cwd}\`（顶层 ${info.topLevel} 项）`, '']
	lines.push(`- 已有文档：${info.files.length === 0 ? '一个都没有' : info.files.join('、')}`)
	lines.push(`- ADR 目录：${info.hasAdr ? '有' : '没有'}`)
	if (info.hasContext) lines.push('- 已有 `CONTEXT.md`：术语题不用问，按现有术语表对齐')
	if (info.hasManifest) lines.push('- 已有依赖清单：技术栈题不用问')
	return lines.join('\n')
}

/**
 * The ratchet_start panel body: one guessed line about the intent, plus the facts.
 * @param {{brief?:string, info:object}} input
 */
export function renderStartDetail({ brief, info }) {
	const head = typeof brief === 'string' && brief.trim() !== '' ? quote(brief.trim()) : ''
	return [head, renderRecon(info)].filter((part) => part !== '').join('\n\n')
}

/**
 * The artifact list. Missing files have to be loud — inventing a path is the
 * easiest mistake to make and the most damaging to trust.
 *
 * But "missing" must say *which directory it resolved against*: a relative path is
 * resolved from the working directory, so when the model says `plugin/render.mjs`
 * while the working directory sits one level above, the file exists and the panel
 * still cries missing — which reads as "it is lying to me". So every missing line
 * prints the absolute path that was searched, leaving the judgement to the user.
 *
 * @param {Array<{entry:string, exists:boolean, resolved?:string, lines?:number, bytes?:number, note?:string}>} artifacts
 */
export function renderArtifacts(artifacts) {
	const list = Array.isArray(artifacts) ? artifacts : []
	if (list.length === 0) return '#### 产出\n\n（这一段没有落任何文件）'
	const lines = list.map((item) => {
		if (item.exists !== true) {
			const where = typeof item.resolved === 'string' && item.resolved !== '' ? `（按 \`${item.resolved}\` 找过）` : ''
			return `- \`${item.entry}\` · **缺失**${where}`
		}
		const detail =
			typeof item.lines === 'number'
				? `${item.lines} 行`
				: typeof item.bytes === 'number'
					? formatBytes(item.bytes)
					: ''
		const extra = [detail, item.note].filter((part) => typeof part === 'string' && part !== '').join(' · ')
		return `- \`${item.entry}\`${extra === '' ? '' : ` · ${extra}`}`
	})
	return `#### 产出\n\n${lines.join('\n')}`
}

/**
 * Trade-offs settled in this stage. An empty array returns an empty string, which
 * callers drop with filter.
 * @param {string[]} decisions
 */
export function renderDecisions(decisions) {
	const clean = (Array.isArray(decisions) ? decisions : [])
		.filter((each) => typeof each === 'string' && each.trim() !== '')
		.map((each) => each.trim())
	if (clean.length === 0) return ''
	return `#### 定下的\n\n${clean.map((each) => `- ${each}`).join('\n')}`
}

/**
 * Collapse the verdicts into one row of marks: 术语表 ✓　ADR ✓　一致性 !
 *
 * `####` rather than a bold paragraph: all four panel sections (artifacts /
 * decisions / checks / hint) get their hierarchy from headings, and bold at 600
 * weight is nearly invisible in 13px body text.
 *
 * When everything skipped, **no row of dashes**: `– – –` reads like broken
 * machinery when in fact the directory simply has no CONTEXT.md or docs/adr yet.
 * One honest sentence plus each reason carries more information.
 *
 * @param {{results: Array<{name:string, verdict?:string, skipped?:boolean, reason?:string}>}} outcome
 */
export function renderCheckBadges(outcome) {
	const results = Array.isArray(outcome?.results) ? outcome.results : []
	if (results.length === 0) return '#### 文档校验\n\n没有可跑的校验器'

	const skipped = results.filter((result) => result.skipped === true || result.verdict === 'SKIP')
	if (skipped.length === results.length) {
		const reasons = dedupeReasons(results.map(skipReason))
		if (reasons.length === 1) return `#### 文档校验\n\n${results.length} 个校验器都没跑：${reasons[0]}`
		return `#### 文档校验\n\n${results.length} 个校验器都没跑 —— 这个目录还没有它们要查的东西：\n\n${reasons
			.map((reason) => `- ${reason}`)
			.join('\n')}`
	}

	const parts = results.map((result) => {
		const mark = result.skipped === true ? VERDICT_MARK.SKIP : (VERDICT_MARK[result.verdict] ?? '?')
		return `${shortCheckName(result.name)} ${mark}`
	})
	return `#### 文档校验\n\n${parts.join('　')}`
}

/** One skip reason; if absent, say "not applicable" rather than leave it blank. */
function skipReason(result) {
	return typeof result.reason === 'string' && result.reason.trim() !== '' ? result.reason.trim() : '不适用'
}

/**
 * Deduplicate skip reasons, absorbing the case where "没有 CONTEXT.md" is a prefix
 * of "没有 CONTEXT.md（这段还没建术语表）" — saying the same absence twice reads like
 * two separate problems.
 */
function dedupeReasons(reasons) {
	const unique = [...new Set(reasons)]
	return unique.filter(
		(reason) => !unique.some((other) => other !== reason && other.startsWith(reason) && other.length > reason.length),
	)
}

/**
 * List only the problematic findings: passing checks should not spend the reader's
 * attention.
 * @param {{results: Array<object>}} outcome
 * @param {number} [max]
 */
export function renderCheckFindings(outcome, max = 3) {
	const results = Array.isArray(outcome?.results) ? outcome.results : []
	const lines = []
	for (const result of results) {
		if (result.skipped === true || result.verdict === 'PASS') continue
		const findings = Array.isArray(result.findings) ? result.findings : []
		for (const finding of findings.slice(0, max)) lines.push(`- ${finding}`)
		const hidden = findings.length - Math.min(findings.length, max)
		if (hidden > 0) lines.push(`- …另有 ${hidden} 条`)
	}
	return lines.join('\n')
}

/**
 * The ratchet_checkpoint panel body.
 *
 * Three movements: conclusion (heading plus one human paragraph) → artifacts and
 * trade-offs → check verdicts. Movements are split with `---` so a long body has
 * visible layers on a dark card instead of one continuous blob.
 *
 * @param {object} input
 * @param {number} input.stageIndex
 * @param {string} input.stage
 * @param {string} input.summary
 * @param {Array<object>} input.artifacts
 * @param {string[]} input.decisions
 * @param {object} input.checks
 * @param {string} [input.previousStage]
 * @param {boolean} [input.strayed] - the flow was not opened through ratchet_start
 * @param {string} [input.next]
 */
export function renderCheckpointDetail(input) {
	const head = [`> **第 ${input.stageIndex} 段 · ${input.stage}**`]
	if (typeof input.summary === 'string' && input.summary.trim() !== '') head.push(input.summary.trim())

	const middle = [renderArtifacts(input.artifacts), renderDecisions(input.decisions)].filter((part) => part !== '')

	const badges = renderCheckBadges(input.checks)
	const findings = renderCheckFindings(input.checks)
	const tail = [findings === '' ? badges : `${badges}\n\n${findings}`]

	const hints = []
	if (input.strayed === true) hints.push('这不是通过 ratchet_start 开的流程，段号从 1 起算。')
	if (
		typeof input.previousStage === 'string' &&
		input.previousStage !== '' &&
		input.previousStage !== input.stage
	) {
		hints.push(`上一段是「${input.previousStage}」。`)
	}
	if (hints.length > 0) tail.push(`> ${hints.join(' ')}`)

	const sections = [head.join('\n\n'), ...middle, tail.join('\n\n')].filter((part) => part !== '')
	if (typeof input.next === 'string' && input.next.trim() !== '') {
		sections.push(`> **下段**　${input.next.trim()}`)
	}
	return sections.join('\n\n---\n\n')
}
