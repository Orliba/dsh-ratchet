// dsh-ratchet —— 把 grill-with-docs 的访谈纪律，蒸馏成 DSH 里能"管住节奏"的插件。
//
// 它解决的不是"模型会不会提问"，而是模型**根本不停下来问**。所以三件事必须由代码强制，
// 而不是写进提示词求模型配合：
//   ① 弹面板（ctx.userQuestions.ask）—— 问题必须出现在界面上，不能散在聊天里；
//   ② 分段（stage）—— 一段只做一件事，段号可数；
//   ③ 每段强制验收（ratchet_checkpoint）—— 不确认就没有下一段。
//
// 提示词那一半（一次一问、每题带推荐、能查代码就别问）作为 ratchet:policy 段存在，
// 只在流程激活时注入；未激活时返回空串，段被丢弃，不占常态上下文。
//
// 唯一的包依赖是 `@deepseek-ai/schemastery`：DSH 的设置页只认它做的 schema
// （`entry.fiber.runtime.Config` 要能 `toJSON()`、且字段带 volatile 才可写）。
// 其余一切零依赖：工具定义手写成 raw JSON Schema，面板服务从 ctx 上取，
// python 只是可选的外部程序（跑 vendor/ 里的三个校验器）。

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULTS, liveConfig } from './config.mjs'
import { renderCheckpointDetail, renderStartDetail } from './render.mjs'
import { PROJECTION_KEY, ratchetProjection, readState, writeState } from './state.mjs'
import { describeFile, runAllChecks } from './validators.mjs'

export const name = 'dsh-ratchet'

/** 只强依赖 systemPrompt；commands / tools / sessionProjections / userQuestions 都按需取。 */
export const inject = ['systemPrompt']

export const SECTION_NAME = 'ratchet:policy'

/** 配置 schema（设置页靠它渲染表单，也靠它做写入校验）。 */
export { Config, DEFAULTS } from './config.mjs'

/** 面板选项里的确认标记。 */
export const RECOMMEND = '（推荐）'
export const NEXT_CONTINUE = `继续下一步${RECOMMEND}`
export const NEXT_REDIRECT = '换个方向'
export const NEXT_STOP = '停在这里'

const KICKOFF_STAGE = '对齐方向'

/**
 * 装配。
 * @param {any} ctx - Cordis 上下文。
 * @param {object} [config]
 * @param {boolean} [config.enabled] - false 时什么都不注册。
 * @param {number} [config.maxQuestions] - 一轮最多几题（硬上限 5）。
 * @param {number} [config.validatorTimeoutMs] - 单个校验脚本的超时。
 * @param {string} [config.pythonPath] - 显式 python 解释器。
 * @param {number} [config.stageLimit] - 一次流程建议的最大段数（写进提示词）。
 * @param {string} [config.policyText] - 覆盖默认纪律文案。
 */
export function apply(ctx, config = {}) {
	// 用代理而不是 `{...DEFAULTS, ...config}`：设置页写配置是热更新，不重启、
	// 也不会再跑一遍 apply，快照会让用户的修改直到重启都毫无反应。
	const settings = liveConfig(config)
	if (settings.enabled === false) return

	registerSection(ctx, settings)
	registerProjection(ctx)
	registerCommand(ctx, settings)
	registerTools(ctx, settings)
}

/* ------------------------------------------------------------------ *
 * 提示词段
 * ------------------------------------------------------------------ */

/** 流程激活时注入的纪律文案。短，因为它按每次请求付费。 */
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
		ctx.logger?.warn?.('dsh-ratchet: 没有 systemPrompt 服务，纪律段未注册')
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
	// 必须走 ctx.inject 而不是在 apply 里直接 ctx.get：装配时序上 sessionProjections
	// 可能还没提供，直接 get 拿到 undefined 就会永久跳过注册 —— 而这一步跳过的后果是
	// "resume 之后进度归零"，是个只在恢复会话时才暴露的隐蔽 bug。
	ctx.inject(['sessionProjections'], (projectionCtx) => {
		const projections = projectionCtx.sessionProjections ?? projectionCtx.get?.('sessionProjections')
		if (projections === undefined || typeof projections.register !== 'function') {
			ctx.logger?.warn?.('dsh-ratchet: 没有 sessionProjections 服务，进度只存在内存里（resume 后归零）')
			return
		}
		projections.register(ratchetProjection)
	})
}

/* ------------------------------------------------------------------ *
 * /ratchet 命令
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
				// 不带 topic 时不编一个占位标题 —— 「（未命名任务）」会在系统提示词段里
				// 一直挂着，看起来像流程已经知道要做什么、其实什么都不知道。
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
 * 工具
 * ------------------------------------------------------------------ */

function registerTools(ctx, settings) {
	ctx.inject(['tools'], (toolCtx) => {
		const tools = toolCtx.tools ?? toolCtx.get?.('tools')
		if (tools === undefined || typeof tools.register !== 'function') return
		tools.register(createStartTool(ctx, settings))
		tools.register(createCheckpointTool(ctx, settings))
	})
}

/** 解析工作目录：优先 workingDirectory 服务，其次 session.header.cwd，最后 process.cwd()。 */
async function resolveCwd(ctx, agent, signal) {
	const directories = ctx.get('workingDirectory')
	if (directories !== undefined && typeof directories.ensure === 'function') {
		try {
			return await directories.ensure(agent, signal)
		} catch {
			// 落到下面的兜底。
		}
	}
	const fromHeader = agent?.session?.header?.cwd
	if (typeof fromHeader === 'string' && fromHeader !== '') return fromHeader
	return process.cwd()
}

/** 扫一遍目录，把能读出来的事实先读出来 —— 能靠读文件回答的，就不该变成问题。 */
function recon(cwd) {
	const files = ['CONTEXT.md', 'CONTEXT-MAP.md', 'README.md', 'package.json', 'pyproject.toml', 'AGENTS.md', 'CLAUDE.md']
	const present = []
	for (const file of files) {
		try {
			if (statSync(join(cwd, file)).isFile()) present.push(file)
		} catch {
			// 不存在。
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
 * 把一个"产出路径"落到磁盘上真正的位置。
 *
 * 为什么不能只 join(cwd, entry)：模型说"我改了 plugin/render.mjs"时，它心里的
 * 根目录常常是**项目子目录**，而工作目录在上一层。直接 join 会得到一个不存在的
 * 路径，面板上就把真实存在的文件标成"缺失" —— 用户看到的是"它在骗我"。
 *
 * 所以按三步找：绝对路径 → 工作目录直下 → 工作目录的一级子目录（跳过 node_modules
 * 和点目录，最多扫 SKIP 个）。找不到就返回原始解析结果，让面板如实说"按这个路径
 * 找过"，把判断权交回给人。
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

/** 构造一个选项：第一个自动加「（推荐）」。 */
function option(label, description) {
	return { label, description }
}

/** kickoff 模式的默认题目槽位（对齐 project-kickoff 的七个槽，压到四题）。 */
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

/** deep 模式：只问一句 —— 一次一问是原 skill 的纪律，别在深挖时又堆题。 */
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
 * 合并模型额外给的题目，去掉答案已能从目录读出的槽位，裁到 maxQuestions。
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

/** 从 ask 的结果里抽一条答案。 */
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
 * 面板不可用时的降级：把同一份内容交给模型，让它在聊天里摆出来。
 * 子 agent 一定走这条路 —— userQuestions 只接受 root agent（会抛 DELEGATED_CALLER）。
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
 * 设置页把 `enabled` 关掉之后的统一答复。
 *
 * 装配期就带 `enabled: false` 的情况是"什么都不注册"，走不到这里；
 * 能走到这里的是**运行中**被关掉 —— 工具还在工具表里（摘不掉，注册是装配期的事），
 * 所以得自己认这个开关，否则用户会以为设置没生效。
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
			'进入 ratchet 对齐：先扫一遍工作目录（CONTEXT.md / docs/adr / 依赖清单），把已经能读出来的答案从题目里剔掉，再用面板问剩下的问题。只在方向没定、或用户说"先问清楚再动手"时调用；一轮最多 5 题，每题都带推荐项。',
		parameters: {
			type: 'object',
			properties: {
				topic: {
					type: 'string',
					description: '这一轮要做的事，一句话。会被原样放进题目里。',
				},
				mode: {
					type: 'string',
					enum: ['kickoff', 'deep'],
					description: 'kickoff = 开工前对齐（默认，最多 5 题）；deep = 过程中深挖（只问 1 题）。',
				},
				brief: {
					type: 'string',
					description: '你对这件事当前的理解，一到两句。会显示在面板正文里，让用户能直接纠正你的偏差。',
				},
				extraQuestions: {
					type: 'array',
					description: '项目特有的补充问题（0~2 个）。每个对象形如 { id, header, question, options }，options 里**第一个**会被自动标成推荐项。',
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
			// 结构化快照，供浏览器端的 tool.call.toolview 卡片读取（block.meta）。
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
			// topic 是必填参数，但模型偶尔会传空串；用中性说法兜底，别在题目里
			// 塞一个「未命名任务」这种看着像已知其实什么都没说的占位词。
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
			'一段做完就调用：把这一段的真实产出（文件路径、行数）和文档校验结果（CONTEXT.md 术语表 / docs/adr 编号 / 术语与代码一致性）合成一张面板，让用户决定继续、换方向还是停下。不许把没落地的改动写成产出。',
		parameters: {
			type: 'object',
			properties: {
				stage: {
					type: 'string',
					description: '这一段做了什么，一句话，会成为面板标题。',
				},
				summary: {
					type: 'string',
					description: '这一段的结果，两三句人话：改了什么、为什么这么改、有什么没做完。不要复述用户说过的话。',
				},
				artifacts: {
					type: 'array',
					items: { type: 'string' },
					description: '真实落地的文件路径（相对工作目录或绝对路径）。插件会读它们的体积和行数贴在面板上，编的路径会显示成"缺失"。',
				},
				next: {
					type: 'string',
					description: '如果继续，下一段做什么。一句话。',
				},
				nextOptions: {
					type: 'array',
					items: { type: 'string' },
					description: '除默认三项之外，你希望额外给出的路线（0~2 个）。',
				},
				decisions: {
					type: 'array',
					items: { type: 'string' },
					description: '这一段定下的、以后不该再翻的取舍（0~3 条）。会写进面板正文。',
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
			// 结构化快照，供浏览器端的 tool.call.toolview 卡片读取（block.meta）。
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

			// 给浏览器端卡片的结构化快照：不进模型上下文，只贴到 block.meta。
			const meta = {
				kind: 'checkpoint',
				stage,
				stageIndex,
				artifacts: inspected,
				checks: (Array.isArray(checks?.results) ? checks.results : []).map((result) => ({
					name: result.name,
					verdict: result.skipped === true ? 'SKIP' : (result.verdict ?? '?'),
					...(result.skipped === true ? { skipped: true } : {}),
					// 跳过要带上原因：卡片上摆一排破折号等于什么都没说。
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

/** 供外部测试用的内部件。 */
export const internals = { recon, mergeQuestions, kickoffQuestions, deepQuestions, buildPolicyText, locateArtifact, PROJECTION_KEY }
