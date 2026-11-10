// dsh-ratchet — distils the grill-with-docs interview discipline into a DSH plugin
// that actually governs the rhythm of the work.
//
// The problem it solves is not "will the model ask questions" but "the model never
// stops to ask". So three things have to be enforced by code rather than requested
// in a prompt:
//   (1) open a panel (ctx.userQuestions.ask) — questions must appear in the UI, not
//       be scattered through chat;
//   (2) cut the work into stages — one thing per stage, numbered;
//   (3) force a review at every stage end (ratchet_checkpoint) — no confirmation,
//       no next stage.
//
// The prompt half (one question at a time, every question carries a recommendation,
// read the code before asking) lives in the ratchet:policy section, injected only
// while the flow is active; inactive returns an empty string, the section is
// dropped, and it costs no context.
//
// The only package dependency is `@deepseek-ai/schemastery`: the DSH settings page
// recognises nothing else (entry.fiber.runtime.Config must have toJSON() and carry
// volatile fields to be writable). Everything else is dependency-free: tool
// definitions are hand-written raw JSON Schema, panel services are taken off ctx,
// and python is merely an optional external program (running the three validators
// under vendor/).

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULTS, liveConfig } from './config.mjs'
import { renderCheckpointDetail, renderStartDetail } from './render.mjs'
import { PROJECTION_KEY, ratchetProjection, readState, writeState } from './state.mjs'
import { describeFile, runAllChecks } from './validators.mjs'

export const name = 'dsh-ratchet'

/** Hard dependency on systemPrompt only; commands / tools / sessionProjections / userQuestions are optional. */
export const inject = ['systemPrompt']

export const SECTION_NAME = 'ratchet:policy'

/** Config schema (drives the settings form, and validates every write). */
export { Config, DEFAULTS } from './config.mjs'

/** Marker appended to a panel option to mark it as the recommendation. */
export const RECOMMEND = '（推荐）'
export const NEXT_CONTINUE = `继续下一步${RECOMMEND}`
export const NEXT_REDIRECT = '换个方向'
export const NEXT_STOP = '停在这里'

const KICKOFF_STAGE = '对齐方向'

/**
 * Assemble the plugin.
 * @param {any} ctx - Cordis context.
 * @param {object} [config]
 * @param {boolean} [config.enabled] - false registers nothing at all.
 * @param {number} [config.maxQuestions] - questions per round (hard cap 5).
 * @param {number} [config.validatorTimeoutMs] - timeout per validator script.
 * @param {string} [config.pythonPath] - explicit python interpreter.
 * @param {number} [config.stageLimit] - suggested stage cap for one flow (goes into the prompt).
 * @param {string} [config.policyText] - overrides the built-in discipline text.
 */
export function apply(ctx, config = {}) {
	// A proxy rather than `{...DEFAULTS, ...config}`: settings writes are hot, with no
	// restart and no second apply() call, so a snapshot would make the user's edit do
	// nothing until the next launch.
	const settings = liveConfig(config)
	if (settings.enabled === false) return

	registerSection(ctx, settings)
	registerProjection(ctx)
	registerCommand(ctx, settings)
	registerTools(ctx, settings)
}

/* ------------------------------------------------------------------ *
 * Prompt section
 * ------------------------------------------------------------------ */

/** The discipline text injected while the flow is active. Short, because it is paid for on every request. */
function buildPolicyText(settings) {
	return `## Ratchet
这个会话在 ratchet 流程里：先对齐方向，再一段一段做，每段结束必须让用户验收。
- 只做当前这一段，做完立刻调用 \`ratchet_checkpoint\` 把成果摆出来；不要一口气跑完整件事。
- 一次流程建议不超过 ${settings.stageLimit} 段。方向没定下来就不要开始写代码。
- 面板里的选择就是授权：拿到结果直接干活，不要复述一遍确认。
- 术语定下来就顺手写进 \`CONTEXT.md\`；决策难以回头才建 ADR，其余记在 checkpoint 正文里。
- 需要问的事优先用 \`ratchet_start\` 弹面板，不要在聊天里列问题清单。`
}

function registerSection(ctx, settings) {
	const prompt = ctx.get('systemPrompt')
	if (prompt === undefined || typeof prompt.section !== 'function') {
		ctx.logger?.warn?.('dsh-ratchet: no systemPrompt service, discipline section not registered')
		return
	}
	const base = typeof prompt.getSectionOrder === 'function' ? prompt.getSectionOrder('PLAN_POLICY') : 500
	const order = (typeof base === 'number' ? base : 500) + 150
	const fallback = buildPolicyText(settings)
	prompt.section({
		name: SECTION_NAME,
		order,
		interpolate: false,
		text: (context) => {
			const agent = context?.agent
			if (agent === undefined) return ''
			if (settings.enabled === false) return ''
			const state = readState(ctx, agent.session)
			if (state.active !== true) return ''
			const stage = state.stage === '' ? KICKOFF_STAGE : state.stage
			const text = typeof settings.policyText === 'string' && settings.policyText.trim() !== '' ? settings.policyText : fallback
			return `${text}\n- 当前进度：第 ${state.stageIndex + 1} 段，标题「${stage}」。`
		},
	})
}

function registerProjection(ctx) {
	// Must go through ctx.inject instead of reading ctx.get in apply(): at assembly time
	// sessionProjections may not be provided yet, and getting undefined once means
	// skipping the registration forever — whose consequence is "progress resets after
	// resume", a bug visible only when a session is restored.
	ctx.inject(['sessionProjections'], (projectionCtx) => {
		const projections = projectionCtx.sessionProjections ?? projectionCtx.get?.('sessionProjections')
		if (projections === undefined || typeof projections.register !== 'function') {
			ctx.logger?.warn?.('dsh-ratchet: no sessionProjections service, progress lives in memory only (resets on resume)')
			return
		}
		projections.register(ratchetProjection)
	})
}

/* ------------------------------------------------------------------ *
 * /ratchet command
 * ------------------------------------------------------------------ */

function registerCommand(ctx, settings) {
	ctx.inject(['commands'], (commandCtx) => {
		const commands = commandCtx.commands ?? commandCtx.get?.('commands')
		if (commands === undefined || typeof commands.register !== 'function') return
		commands.register({
			name: 'ratchet',
			description: '进入 ratchet 流程：先对齐方向，再分段交付并逐段验收',
			input: { hint: '[off|topic]' },
			handler: ({ agent, rawInput }) => {
				const message = (rawInput ?? '').trim()
				if (settings.enabled === false) {
					return { kind: 'error', text: 'ratchet 流程已在设置里关掉（设置 → 插件 → ratchet flow → 启用），打开后再用 /ratchet。' }
				}
				const session = agent?.session
				if (session === undefined) return { kind: 'error', text: '当前没有会话，/ratchet 无处落脚' }
				if (message === 'off') {
					void writeState(ctx, session, { op: 'stop', note: '手动退出' })
					return { kind: 'success', text: 'ratchet 流程已退出，纪律段不再注入。' }
				}
				// No placeholder title when no topic is given: "（未命名任务）" would then hang
				// in the prompt section, looking like the flow knows what it is doing when in
				// fact it knows nothing.
				const topic = message === '' ? '' : message
				void writeState(ctx, session, {
					op: 'start',
					topic,
					mode: 'kickoff',
					stage: KICKOFF_STAGE,
				})
				const head = topic === '' ? 'ratchet 流程已开启（这一轮还没定要做什么）。' : `ratchet 流程已开启：${topic}`
				const ask = topic === ''
					? '下一步：先说一句这次要做的事（或重开 `/ratchet <一句话>`），我再调 ratchet_start 弹对齐面板。'
					: '下一步：调用 ratchet_start 弹出对齐面板（我会先扫一遍目录，把已经能读出来的答案从题目里剔掉）。'
				return { kind: 'success', text: `${head}\n${ask}` }
			},
		})
	})
}

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

function registerTools(ctx, settings) {
	ctx.inject(['tools'], (toolCtx) => {
		const tools = toolCtx.tools ?? toolCtx.get?.('tools')
		if (tools === undefined || typeof tools.register !== 'function') return
		tools.register(createStartTool(ctx, settings))
		tools.register(createCheckpointTool(ctx, settings))
	})
}

/** Resolve the working directory: workingDirectory service, then session.header.cwd, then process.cwd(). */
async function resolveCwd(ctx, agent, signal) {
	const directories = ctx.get('workingDirectory')
	if (directories !== undefined && typeof directories.ensure === 'function') {
		try {
			return await directories.ensure(agent, signal)
		} catch {
			// Fall through to the fallbacks below.
		}
	}
	const fromHeader = agent?.session?.header?.cwd
	if (typeof fromHeader === 'string' && fromHeader !== '') return fromHeader
	return process.cwd()
}

/** Scan the directory and read out everything already readable — what a file can answer never becomes a question. */
function recon(cwd) {
	const files = ['CONTEXT.md', 'CONTEXT-MAP.md', 'README.md', 'package.json', 'pyproject.toml', 'AGENTS.md', 'CLAUDE.md']
	const present = []
	for (const file of files) {
		try {
			if (statSync(join(cwd, file)).isFile()) present.push(file)
		} catch {
			// Absent.
		}
	}
	let topLevel = 0
	try {
		topLevel = readdirSync(cwd).length
	} catch {
		topLevel = 0
	}
	return {
		cwd,
		files: present,
		hasAdr: existsSync(join(cwd, 'docs', 'adr')),
		topLevel,
		hasContext: present.includes('CONTEXT.md'),
		hasManifest: present.includes('package.json') || present.includes('pyproject.toml'),
	}
}

/**
 * Resolve an "artifact path" to where the file actually is on disk.
 *
 * Why not just join(cwd, entry): when the model says "I changed plugin/render.mjs",
 * the root in its head is often the project *subdirectory* while the working
 * directory sits one level above. A plain join produces a non-existent path and the
 * panel marks a real file as missing — which reads to the user as "it is lying".
 *
 * So search in three steps: absolute path → directly under the working directory →
 * one level of subdirectories (skipping node_modules and dot directories, at most
 * 16 of them). If nothing hits, return the plain resolution so the panel can
 * honestly say "searched this path" and leave the judgement to the human.
 */
function locateArtifact(cwd, entry) {
	if (/^([A-Za-z]:|\\\\|\/)/.test(entry)) return { path: entry }
	const direct = join(cwd, entry)
	if (existsSync(direct)) return { path: direct }
	let children = []
	try {
		children = readdirSync(cwd, { withFileTypes: true })
			.filter((each) => each.isDirectory())
			.map((each) => each.name)
			.filter((name) => !name.startsWith('.') && name !== 'node_modules')
			.slice(0, 16)
	} catch {
		children = []
	}
	for (const name of children) {
		const nested = join(cwd, name, entry)
		if (existsSync(nested)) return { path: nested, where: name }
	}
	return { path: direct }
}

/** Build one option; the first one is marked as the recommendation by its label. */
function option(label, description) {
	return { label, description }
}

/** Default kickoff slots (aligned with project-kickoff's seven, compressed to four). */
function kickoffQuestions(topic, reconInfo) {
	const questions = [
		{
			id: 'direction',
			header: '方向',
			question: `「${topic}」这一轮要做到什么程度？`,
			options: [
				option(`先做最小可用版，跑通再说${RECOMMEND}`, '范围最小、最快看到结果，后面再扩'),
				option('先做一个切片验证可行性', '不确定的部分先探路，不做完整实现'),
				option('要长期能用的方案，别赶工', '允许这一段耗时更长，结构优先'),
			],
		},
		{
			id: 'acceptance',
			header: '验收',
			question: '这一段怎样算过关？',
			options: [
				option(`能跑通 + 我能看懂${RECOMMEND}`, '给我可运行的产物和一句人话解释'),
				option('要有可复现的证据', '测试、日志或前后对比，能自己验'),
				option('先出样子，标准之后再定', '这一段只看方向对不对'),
			],
		},
	]
	if (reconInfo.hasManifest !== true) {
		questions.push({
			id: 'stack',
			header: '技术选型',
			question: '用什么技术栈？（目录里没有依赖清单，只能问你）',
			options: [
				option(`你用着顺手的那个${RECOMMEND}`, '我按当前环境已有的能力选，不额外装东西'),
				option('按我指定的来', '在下面直接写技术栈'),
			],
		})
	}
	questions.push(
		{
			id: 'boundary',
			header: '改动边界',
			question: '我可以动哪些地方？',
			options: [
				option(`只在当前目录里改${RECOMMEND}`, '不碰别处，不动别人的仓库'),
				option('可以把周边一起顺了', '顺手统一风格、补文档'),
				option('先别动任何文件，只出方案', '这一段只要设计，不要落地'),
			],
		},
		{
			id: 'rhythm',
			header: '节奏',
			question: '分段验收要多久一次？',
			options: [
				option(`每段都停下来给我看${RECOMMEND}`, '一段一件事，做完就出面板'),
				option('两段一看，别太碎', '合并相邻的小段'),
			],
		},
	)
	return questions
}

/** deep mode: exactly one question — "one at a time" is the original discipline, so no pile-up while digging. */
function deepQuestions(topic) {
	return [
		{
			id: 'direction',
			header: '方向复核',
			question: `「${topic}」的方向还成立吗？`,
			options: [
				option(`成立，继续往下挖${RECOMMEND}`, '保持当前方向，只精修细节'),
				option('偏了，我改一下', '在下面写新的方向'),
			],
		},
	]
}

/**
 * Merge the model's extra questions, dedupe by id, and trim to maxQuestions.
 * @returns {object[]}
 */
function mergeQuestions(base, extra, max) {
	const seen = new Set(base.map((entry) => entry.id))
	const merged = [...base]
	for (const entry of Array.isArray(extra) ? extra : []) {
		if (typeof entry !== 'object' || entry === null) continue
		const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : `extra-${merged.length}`
		if (seen.has(id)) continue
		const question = typeof entry.question === 'string' ? entry.question.trim() : ''
		if (question === '') continue
		const options = (Array.isArray(entry.options) ? entry.options : [])
			.filter((each) => typeof each === 'string' ? each.trim() !== '' : typeof each?.label === 'string')
			.slice(0, 4)
			.map((each, index) => (typeof each === 'string' ? option(index === 0 ? `${each.trim()}${RECOMMEND}` : each.trim(), '') : each))
		seen.add(id)
		merged.push({
			id,
			header: typeof entry.header === 'string' && entry.header !== '' ? entry.header : '补充',
			question,
			...(options.length === 0 ? {} : { options }),
		})
		if (merged.length >= max) break
	}
	return merged.slice(0, Math.max(1, max))
}

/** Pull one answer out of the ask() result. */
function pickAnswer(answer, id) {
	const entries = Array.isArray(answer?.answers) ? answer.answers : []
	const hit = entries.find((entry) => entry?.id === id)
	if (hit === undefined) return { selected: [], custom: undefined }
	return {
		selected: Array.isArray(hit.selected) ? hit.selected.filter((each) => typeof each === 'string') : [],
		custom: typeof hit.custom === 'string' && hit.custom.trim() !== '' ? hit.custom.trim() : undefined,
	}
}

/**
 * Degradation path when no panel is available: hand the same content to the model
 * and have it present that in chat. Sub-agents always take this path — userQuestions
 * only accepts a root agent (throws DELEGATED_CALLER).
 */
function degrade(reason, body) {
	return {
		action: 'inline',
		feedback: '',
		next: '',
		text: `${reason}\n\n${body}\n\n把上面这段原样发给用户，等用户回话再继续；不要自己替他选。`,
	}
}

/**
 * Uniform answer once `enabled` is switched off from the settings page.
 *
 * Assembling with `enabled: false` means "register nothing" and never reaches here;
 * what reaches here is being switched off *at runtime* — the tools are still in the
 * tool table (they cannot be unregistered, registration happens at assembly), so
 * the switch has to be honoured here or the user thinks the setting did nothing.
 */
function switchedOff(what) {
	return {
		action: 'disabled',
		feedback: '',
		next: '',
		text: `${what}没有执行：ratchet 流程已在设置里关掉（设置 → 插件 → ratchet flow → 启用）。`,
	}
}

function createStartTool(ctx, settings) {
	return {
		name: 'ratchet_start',
		description:
			'Enter ratchet alignment: scan the working directory first (CONTEXT.md / docs/adr / dependency manifest), drop every question the files already answer, then ask the rest through a panel. Use it only when the direction is unsettled or the user says "ask before building"; at most 5 questions per round, each carrying a recommended option.',
		parameters: {
			type: 'object',
			properties: {
				topic: {
					type: 'string',
					description: 'What this round is about, in one sentence. It is pasted into the questions verbatim.',
				},
				mode: {
					type: 'string',
					enum: ['kickoff', 'deep'],
					description: 'kickoff = align before starting (default, up to 5 questions); deep = dig in mid-flight (a single question).',
				},
				brief: {
					type: 'string',
					description: 'Your current understanding, one or two sentences. Shown in the panel body so the user can correct you directly.',
				},
				extraQuestions: {
					type: 'array',
					description: 'Project-specific extra questions (0-2). Each item looks like { id, header, question, options }; the **first** option is marked as the recommendation automatically.',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string' },
							header: { type: 'string' },
							question: { type: 'string' },
							options: { type: 'array', items: { type: 'string' } },
						},
					},
				},
			},
			required: ['topic'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					action: { type: 'string' },
					feedback: { type: 'string' },
					next: { type: 'string' },
					text: { type: 'string' },
					meta: { type: 'object' },
				},
			},
			render: (_args, value) => [{ type: 'text', text: value.text ?? '' }],
			// Structured snapshot for the browser-side tool.call.toolview card (block.meta).
			presentationMeta: (args, value) => ({
				ratchet: value.meta ?? {
					kind: 'start',
					topic: typeof args?.topic === 'string' ? args.topic : '',
					mode: args?.mode === 'deep' ? 'deep' : 'kickoff',
					...(typeof value.action === 'string' ? { action: value.action } : {}),
				},
			}),
		},
		presentCall: (args) => ({
			card: 'generic',
			title: `ratchet：${args.topic ?? ''}`,
			kind: 'align',
			content: [{ type: 'text', text: '对齐方向' }],
		}),
		async execute(args, exec) {
			if (settings.enabled === false) return switchedOff('对齐面板')
			const session = exec.agent?.session
			if (session === undefined) return degrade('当前会话不可用，面板打不开。', '请直接在聊天里问用户。')
			const cwd = await resolveCwd(ctx, exec.agent, exec.signal)
			const info = recon(cwd)
			const mode = args.mode === 'deep' ? 'deep' : 'kickoff'
			// topic is a required parameter, but the model occasionally sends an empty
			// string; use a neutral fallback rather than a "未命名任务"-style placeholder
			// that looks like known information while saying nothing.
			const topic = typeof args.topic === 'string' && args.topic.trim() !== '' ? args.topic.trim() : '这次任务'
			const brief = typeof args.brief === 'string' ? args.brief.trim() : ''

			const base = mode === 'deep' ? deepQuestions(topic) : kickoffQuestions(topic, info)
			const max = Math.min(5, Math.max(1, Number(settings.maxQuestions) || 5))
			const questions = mergeQuestions(base, args.extraQuestions, max)

			const detail = renderStartDetail({ brief, info })
			const payload = questions.map((entry) => ({
				id: entry.id,
				header: entry.header,
				question: entry.question,
				detail,
				...(entry.options === undefined ? {} : { options: entry.options }),
			}))

			await writeState(ctx, session, { op: 'start', topic, mode, stage: KICKOFF_STAGE })

			const interaction = ctx.get('userQuestions')
			if (interaction === undefined || typeof interaction.ask !== 'function') {
				const fallback = ['### 对齐问题（逐条回答即可）', ...payload.map((q, index) => `${index + 1}. ${q.question}${(q.options ?? []).length === 0 ? '' : `\n   选项：${q.options.map((o) => o.label).join(' / ')}`}`)].join('\n')
				return degrade('面板服务不可用。', fallback)
			}

			let answer
			try {
				answer = await interaction.ask({ questions: payload, agent: exec.agent, signal: exec.signal })
			} catch (cause) {
				if (cause?.code === 'ASK_CANCELLED') {
					exec.concludeTurn?.()
					return { action: 'cancelled', feedback: '', next: '', text: '用户取消了这次对齐，先不要动工。' }
				}
				if (cause?.code === 'DELEGATED_CALLER') {
					const fallback = ['### 对齐问题（逐条回答即可）', ...payload.map((q, index) => `${index + 1}. ${q.question}${(q.options ?? []).length === 0 ? '' : `\n   选项：${q.options.map((o) => o.label).join(' / ')}`}`)].join('\n')
					return degrade('子 agent 弹不出面板（人机交互只接受主会话）。', fallback)
				}
				throw cause
			}

			const collected = payload.map((question) => {
				const picked = pickAnswer(answer, question.id)
				return { id: question.id, header: question.header, ...picked }
			})
			const lines = ['### 已对齐', ...collected.map((entry) => {
				const value = entry.custom ?? entry.selected[0] ?? '（未答）'
				return `- ${entry.header}：${value}`
			})]
			return {
				action: 'aligned',
				feedback: collected.map((entry) => `${entry.header}=${entry.custom ?? entry.selected.join('|')}`).join('; '),
				next: mode === 'deep' ? '按复核后的方向继续深挖' : '按上面的约束做第一段，做完调用 ratchet_checkpoint',
				text: lines.join('\n'),
				meta: { kind: 'start', topic, mode, action: 'aligned', answered: collected.length },
			}
		},
	}
}

function createCheckpointTool(ctx, settings) {
	return {
		name: 'ratchet_checkpoint',
		description:
			'Call this when one stage is done: it combines the real artifacts of this stage (file paths, line counts) with the document checks (CONTEXT.md glossary / docs/adr numbering / glossary-vs-code consistency) into a single panel where the user decides to continue, change direction, or stop. Never list work that has not landed as an artifact.',
		parameters: {
			type: 'object',
			properties: {
				stage: {
					type: 'string',
					description: 'What this stage did, in one sentence. It becomes the panel title.',
				},
				summary: {
					type: 'string',
					description: 'The outcome of this stage in two or three plain sentences: what changed, why that way, what is still unfinished. Do not restate what the user said.',
				},
				artifacts: {
					type: 'array',
					items: { type: 'string' },
					description: 'Paths that really landed (relative to the working directory, or absolute). The plugin stats them for size and line count; an invented path shows up as "missing".',
				},
				next: {
					type: 'string',
					description: 'If the user continues, what the next stage does. One sentence.',
				},
				nextOptions: {
					type: 'array',
					items: { type: 'string' },
					description: 'Extra routes you want to offer beyond the default three (0-2 of them).',
				},
				decisions: {
					type: 'array',
					items: { type: 'string' },
					description: 'Trade-offs settled in this stage that should not be reopened later (0-3). They are written into the panel body.',
				},
			},
			required: ['stage', 'summary'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					action: { type: 'string' },
					feedback: { type: 'string' },
					next: { type: 'string' },
					stageIndex: { type: 'number' },
					text: { type: 'string' },
					meta: { type: 'object' },
				},
			},
			render: (_args, value) => [{ type: 'text', text: value.text ?? '' }],
			// Structured snapshot for the browser-side tool.call.toolview card (block.meta).
			presentationMeta: (_args, value) => ({ ratchet: value.meta ?? { kind: 'checkpoint' } }),
		},
		presentCall: (args) => ({
			card: 'generic',
			title: `ratchet 验收：${args.stage ?? ''}`,
			kind: 'checkpoint',
			content: [{ type: 'text', text: String(args.summary ?? '') }],
		}),
		async execute(args, exec) {
			if (settings.enabled === false) return switchedOff('验收面板')
			const session = exec.agent?.session
			if (session === undefined) return degrade('当前会话不可用，面板打不开。', '请在聊天里把这段成果发给用户。')
			const state = readState(ctx, session)
			const cwd = await resolveCwd(ctx, exec.agent, exec.signal)
			const stage = typeof args.stage === 'string' && args.stage.trim() !== '' ? args.stage.trim() : '未命名阶段'
			const summary = typeof args.summary === 'string' ? args.summary.trim() : ''
			const stageIndex = state.stageIndex + 1

			const inspected = []
			for (const entry of Array.isArray(args.artifacts) ? args.artifacts : []) {
				if (typeof entry !== 'string' || entry.trim() === '') continue
				const trimmed = entry.trim()
				const found = locateArtifact(cwd, trimmed)
				const described = describeFile(found.path)
				inspected.push({
					entry: trimmed,
					exists: described.exists === true,
					resolved: found.path,
					...(found.where === undefined ? {} : { note: `在 \`${found.where}/\` 下` }),
					...(typeof described.lines === 'number' ? { lines: described.lines } : {}),
					...(typeof described.bytes === 'number' ? { bytes: described.bytes } : {}),
				})
			}

			const checks = await runAllChecks({
				cwd,
				pythonPath: settings.pythonPath,
				timeoutMs: Number(settings.validatorTimeoutMs) || 20000,
				signal: exec.signal,
			})

			const nextText = typeof args.next === 'string' ? args.next.trim() : ''
			const body = renderCheckpointDetail({
				stageIndex,
				stage,
				summary,
				artifacts: inspected,
				decisions: args.decisions,
				checks,
				previousStage: state.stage,
				strayed: state.active !== true,
				next: nextText,
			})

			// Structured snapshot for the browser card: never enters model context, only block.meta.
			const meta = {
				kind: 'checkpoint',
				stage,
				stageIndex,
				artifacts: inspected,
				checks: (Array.isArray(checks?.results) ? checks.results : []).map((result) => ({
					name: result.name,
					verdict: result.skipped === true ? 'SKIP' : (result.verdict ?? '?'),
					...(result.skipped === true ? { skipped: true } : {}),
					// Skips must carry their reason: a row of dashes on the card says nothing.
					...(typeof result.reason === 'string' && result.reason.trim() !== ''
						? { reason: result.reason.trim() }
						: {}),
				})),
				...(nextText === '' ? {} : { next: nextText }),
			}

			const continueLabel = `继续下一步${RECOMMEND}`
			const extraOptions = (Array.isArray(args.nextOptions) ? args.nextOptions : [])
				.filter((each) => typeof each === 'string' && each.trim() !== '')
				.slice(0, 2)
				.map((each) => ({ label: each.trim(), description: '' }))
			const options = [
				{
					label: continueLabel,
					description: typeof args.next === 'string' && args.next.trim() !== '' ? args.next.trim() : '按当前方向做下一段',
				},
				...extraOptions,
				{ label: NEXT_REDIRECT, description: '方向要改，下面的输入框里写新方向' },
				{ label: NEXT_STOP, description: '这一段收掉，先不动下一步' },
			]

			const interaction = ctx.get('userQuestions')
			if (interaction === undefined || typeof interaction.ask !== 'function') {
				return degrade('面板服务不可用。', body)
			}

			let answer
			try {
				answer = await interaction.ask({
					questions: [
						{
							id: 'checkpoint',
							header: `第 ${stageIndex} 段验收`,
							question: '这一段就这样，还是改方向？',
							detail: body,
							options,
						},
					],
					agent: exec.agent,
					signal: exec.signal,
				})
			} catch (cause) {
				if (cause?.code === 'ASK_CANCELLED') {
					exec.concludeTurn?.()
					return { action: 'cancelled', feedback: '', next: '', stageIndex, text: '用户取消了验收，先停在这段，不要自己往下做。' }
				}
				if (cause?.code === 'DELEGATED_CALLER') return degrade('子 agent 弹不出面板（人机交互只接受主会话）。', body)
				throw cause
			}

			const picked = pickAnswer(answer, 'checkpoint')
			const verdict = picked.custom !== undefined ? NEXT_REDIRECT : (picked.selected[0] ?? NEXT_STOP)
			if (verdict === NEXT_STOP) {
				await writeState(ctx, session, { op: 'stop', stage, note: '用户选择停在这里' })
				return { action: 'stop', feedback: '', next: '', stageIndex, text: `第 ${stageIndex} 段已收尾，用户选择停在这里。不要再开新的一段。`, meta: { ...meta, action: 'stop' } }
			}
			if (verdict === NEXT_REDIRECT || picked.custom !== undefined) {
				const feedback = picked.custom ?? '用户想要换方向（没写字）'
				await writeState(ctx, session, { op: 'redirect', stage, note: feedback })
				return {
					action: 'redirect',
					feedback,
					next: '',
					stageIndex,
					text: `用户要换方向：${feedback}\n按这个新方向调整，已经做好的部分保留还是重做由新方向决定；调整完再走一次 ratchet_checkpoint。`,
					meta: { ...meta, action: 'redirect' },
				}
			}
			const next = verdict === continueLabel ? (typeof args.next === 'string' ? args.next.trim() : '') : verdict
			await writeState(ctx, session, { op: 'checkpoint', stage, verdict: 'continue', note: next })
			return {
				action: 'continue',
				feedback: '',
				next,
				stageIndex,
				text: `第 ${stageIndex} 段通过。下一段：${next === '' ? '（用户没指定，按上一段的节奏继续）' : next}`,
				meta: { ...meta, action: 'continue' },
			}
		},
	}
}

/** Internals exposed for tests. */
export const internals = { recon, mergeQuestions, kickoffQuestions, deepQuestions, buildPolicyText, locateArtifact, PROJECTION_KEY }
