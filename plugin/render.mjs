// 面板正文的渲染层 —— 专门负责"给人看"的那一份。
//
// 为什么要和 index.mjs 里的 text 分开：
//   text  回给模型 —— 要点齐、结构死板，模型读得懂就行；
//   detail 贴在面板上 —— 要一眼看清「这段做完了什么、有没有问题、下一步」。
// 之前两者共用一份 body，结果是满屏等权重的条目堆在深灰底上，视觉上就是一团。
//
// 这里只用 MarkdownText 确认支持的语法：heading / paragraph / list / blockquote /
// thematicBreak / strong / inlineCode。不用表格（没有 GFM 扩展）、不用任务列表、
// 不用原始 HTML。

/** 校验结论的记号：比 emoji 克制，在等宽与正文里都不会糊。 */
export const VERDICT_MARK = { PASS: '✓', WARN: '!', FAIL: '×', SKIP: '–' }

const SHORT_NAME = {
	'CONTEXT.md 术语表': '术语表',
	'ADR 目录': 'ADR',
	'术语↔代码一致性': '一致性',
}

/** 校验器的短名：面板上横排的时候，长名字会把一行撑爆。 */
export function shortCheckName(name) {
	return SHORT_NAME[name] ?? name
}

/** 把一段文字整体变成引用块（多行也逐行加 `>`，否则只有第一行进引用）。 */
function quote(text) {
	return String(text)
		.split('\n')
		.map((line) => `> ${line}`)
		.join('\n')
}

/** 字节数只在没有行数时兜底，避免面板上出现「0.0 KB」这种噪音。 */
function formatBytes(bytes) {
	if (typeof bytes !== 'number') return ''
	if (bytes < 1024) return `${bytes} B`
	return `${(bytes / 1024).toFixed(1)} KB`
}

/**
 * 开工前读到的事实。让用户看见"模型到底读了什么"，也是"能读就不问"的证据。
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
 * ratchet_start 的面板正文：一句"我猜你要什么" + 读到的事实。
 * @param {{brief?:string, info:object}} input
 */
export function renderStartDetail({ brief, info }) {
	const head = typeof brief === 'string' && brief.trim() !== '' ? quote(brief.trim()) : ''
	return [head, renderRecon(info)].filter((part) => part !== '').join('\n\n')
}

/**
 * 产出清单。缺失的文件要显眼 —— 编路径是最容易发生、也最伤信任的错。
 *
 * 但"缺失"必须说清是**按哪个目录解析的**：相对路径是按工作目录算的，模型给了
 * `plugin/render.mjs` 而工作目录在上一层时，文件明明在，面板却报缺失 —— 用户看到
 * 的是"它在骗我"。所以缺失行一律把解析后的绝对路径摆出来，判断权交回给人。
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
 * 这一段定下的取舍。空数组直接返回空串，调用方用 filter 丢掉。
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
 * 校验结论压成一行徽章：术语表 ✓　ADR ✓　一致性 !
 *
 * 用 `####` 而不是粗体段落：面板上四个分区（产出 / 定下的 / 文档校验 / 提示）
 * 都靠标题撑出层级，粗体只有 600 字重，在 13px 正文里几乎看不出来。
 *
 * 全跳过时**不摆一排破折号**：`– – –` 读起来像零件坏了，其实只是这个目录还没建
 * CONTEXT.md / docs/adr/。改成一句实话 + 各自的原因，信息量更大。
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

/** 一条跳过原因，缺了就说不适用，不留空。 */
function skipReason(result) {
	return typeof result.reason === 'string' && result.reason.trim() !== '' ? result.reason.trim() : '不适用'
}

/**
 * 去重跳过原因，顺便吃掉"没有 CONTEXT.md"是"没有 CONTEXT.md（这段还没建术语表）"
 * 前缀的重复 —— 同一个缺失说两遍读起来像两件事。
 */
function dedupeReasons(reasons) {
	const unique = [...new Set(reasons)]
	return unique.filter(
		(reason) => !unique.some((other) => other !== reason && other.startsWith(reason) && other.length > reason.length),
	)
}

/**
 * 只列有问题的条目：通过的校验不该占用户的阅读预算。
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
 * ratchet_checkpoint 的面板正文。
 *
 * 三段式：结论（标题 + 一段人话）→ 产出与取舍 → 校验结论。段间用 `---` 切开，
 * 让长正文在深色卡上有可视分层，而不是一坨连续段落。
 *
 * @param {object} input
 * @param {number} input.stageIndex
 * @param {string} input.stage
 * @param {string} input.summary
 * @param {Array<object>} input.artifacts
 * @param {string[]} input.decisions
 * @param {object} input.checks
 * @param {string} [input.previousStage]
 * @param {boolean} [input.strayed] - 不是 ratchet_start 开的流程
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
