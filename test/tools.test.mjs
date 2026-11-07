// 端到端：把两个工具的 execute() 真跑一遍，用一个假的 userQuestions 记录面板内容。
// 这层的目的是把"面板里到底出现了什么"钉死 —— 题目、选项、推荐章、产出核实、校验段，
// 这些东西错一个，用户在界面上就会看到一句错话。

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { NEXT_REDIRECT, NEXT_STOP, NEXT_CONTINUE, apply } from '../plugin/index.mjs'

/** 一个假环境：目录是真的，服务是假的，面板请求被记录下来。 */
function makeEnv({ answer = { answers: [] }, askThrows = null, withPanel = true } = {}) {
	const project = mkdtempSync(join(tmpdir(), 'ratchet-e2e-'))
	writeFileSync(join(project, 'CONTEXT.md'), ['# C', '', '## Language', '', '**Sample**: 一条采样。', '', '_Avoid_: record', ''].join('\n'))
	writeFileSync(join(project, 'package.json'), '{}\n')
	mkdirSync(join(project, 'src'), { recursive: true })
	writeFileSync(join(project, 'src', 'a.js'), 'export const a = 1\n')

	const panels = []
	const registered = { sections: [], projections: [], commands: [], tools: [] }

	const services = {
		systemPrompt: {
			section(definition) {
				registered.sections.push(definition)
			},
			getSectionOrder: () => 500,
		},
		sessionProjections: {
			register(definition) {
				registered.projections.push(definition)
			},
			// 返回 undefined，逼 readState 走内存镜像：这一层测工具逻辑，
			// 投影折叠在 index.test.mjs 里单独测。
			stateOf() {
				return undefined
			},
		},
		commands: {
			register(definition) {
				registered.commands.push(definition)
			},
		},
		tools: {
			register(definition) {
				registered.tools.push(definition)
			},
		},
		workingDirectory: {
			async ensure() {
				return project
			},
		},
	}
	if (withPanel) {
		services.userQuestions = {
			async ask(request) {
				panels.push(request)
				if (askThrows !== null) throw askThrows
				return answer
			},
		}
	}

	const ctx = {
		logger: { warn() {}, info() {} },
		...services,
		get(name) {
			return services[name]
		},
		inject(names, callback) {
			if (names.some((entry) => services[entry] === undefined)) return
			callback(ctx)
		},
	}

	const session = {
		header: { cwd: project },
		append() {
			throw new Error('自有事件不该走 session.append()')
		},
	}

	apply(ctx, { pythonPath: 'C:\\no-such-python\\python.exe' })

	const exec = {
		agent: { session },
		signal: undefined,
		callId: 'call-1',
		concluded: false,
		concludeTurn() {
			exec.concluded = true
		},
	}

	const tool = (name) => registered.tools.find((entry) => entry.name === name)
	return { project, session, exec, registered, panels, tool }
}

/* ---------------------------------------------------------------- *
 * 面板路径
 * ---------------------------------------------------------------- */

test('ratchet_start：面板里只有一题一栏，题目里带着标签', async () => {
	const env = makeEnv({ withPanel: true })
	await env.tool('ratchet_start').execute({ topic: '做个下载器', brief: '我猜你要本地的' }, env.exec)
	assert.equal(env.panels.length, 1)
	const [request] = env.panels
	assert.ok(Array.isArray(request.questions))
	assert.ok(request.questions.length >= 1 && request.questions.length <= 5, '一轮最多 5 题')
	assert.equal(request.agent, env.exec.agent)
	const direction = request.questions.find((entry) => entry.id === 'direction')
	assert.ok(direction)
	assert.match(direction.question, /做个下载器/)
	assert.match(direction.detail, /我猜你要本地的/, 'brief 要出现在正文里，让用户能纠正偏差')
})

test('ratchet_start：每题第一个选项都盖推荐章', async () => {
	const env = makeEnv()
	await env.tool('ratchet_start').execute({ topic: 't' }, env.exec)
	for (const question of env.panels[0].questions) {
		assert.ok(question.options?.length > 0, `${question.id} 没有选项`)
		assert.match(question.options[0].label, /（推荐）$/, `${question.id} 首项没有推荐章`)
	}
})

test('ratchet_start：目录里已有 package.json 就不问技术栈', async () => {
	const env = makeEnv()
	await env.tool('ratchet_start').execute({ topic: 't' }, env.exec)
	const ids = env.panels[0].questions.map((entry) => entry.id)
	assert.equal(ids.includes('stack'), false)
})

test('ratchet_start：面板正文里列出开工前读到的文件', async () => {
	const env = makeEnv()
	await env.tool('ratchet_start').execute({ topic: 't' }, env.exec)
	const detail = env.panels[0].questions[0].detail
	assert.match(detail, /开工前读到的/)
	assert.match(detail, /CONTEXT\.md/)
	assert.match(detail, /package\.json/)
})

test('ratchet_start：deep 模式只问一题', async () => {
	const env = makeEnv()
	await env.tool('ratchet_start').execute({ topic: 't', mode: 'deep' }, env.exec)
	assert.equal(env.panels[0].questions.length, 1)
})

test('ratchet_start：extraQuestions 会被合进来并去重', async () => {
	const env = makeEnv()
	await env.tool('ratchet_start').execute(
		{
			topic: 't',
			extraQuestions: [
				{ id: 'direction', question: '重复的 id' },
				{ id: 'deploy', question: '部署到哪？', options: ['本地', '服务器'] },
			],
		},
		env.exec,
	)
	const ids = env.panels[0].questions.map((entry) => entry.id)
	assert.equal(ids.filter((id) => id === 'direction').length, 1, 'direction 不该重复')
	const deploy = env.panels[0].questions.find((entry) => entry.id === 'deploy')
	assert.ok(deploy)
	assert.match(deploy.options[0].label, /本地（推荐）/)
})

test('ratchet_start：答案回显成「已对齐」', async () => {
	const env = makeEnv({
		answer: { answers: [{ id: 'direction', selected: ['先做最小可用版，跑通再说（推荐）'] }] },
	})
	const result = await env.tool('ratchet_start').execute({ topic: 't' }, env.exec)
	assert.equal(result.action, 'aligned')
	assert.match(result.text, /### 已对齐/)
	assert.match(result.next, /ratchet_checkpoint/)
})

test('ratchet_start：用户取消时标记 cancelled 并收尾', async () => {
	const cancelled = Object.assign(new Error('cancelled'), { code: 'ASK_CANCELLED' })
	const env = makeEnv({ askThrows: cancelled })
	const result = await env.tool('ratchet_start').execute({ topic: 't' }, env.exec)
	assert.equal(result.action, 'cancelled')
	assert.equal(env.exec.concluded, true)
})

test('ratchet_start：子 agent 弹不出面板时降级，不抛', async () => {
	const delegated = Object.assign(new Error('delegated'), { code: 'DELEGATED_CALLER' })
	const env = makeEnv({ askThrows: delegated })
	const result = await env.tool('ratchet_start').execute({ topic: '做个下载器' }, env.exec)
	assert.equal(result.action, 'inline')
	assert.match(result.text, /子 agent 弹不出面板/)
	assert.match(result.text, /做个下载器/)
})

test('ratchet_start：没有面板服务时也降级', async () => {
	const env = makeEnv({ withPanel: false })
	const result = await env.tool('ratchet_start').execute({ topic: '做个下载器' }, env.exec)
	assert.equal(result.action, 'inline')
	assert.match(result.text, /对齐问题/)
})

/* ---------------------------------------------------------------- *
 * 验收路径
 * ---------------------------------------------------------------- */

test('ratchet_checkpoint：产出路径读得到就贴体积行数，读不到标缺失', async () => {
	const env = makeEnv()
	await env.tool('ratchet_checkpoint').execute(
		{ stage: '第一段', summary: '做完了', artifacts: ['src/a.js', 'src/不存在.js'] },
		env.exec,
	)
	const detail = env.panels[0].questions[0].detail
	assert.match(detail, /第 1 段 · 第一段/)
	assert.match(detail, /`src\/a\.js` · 1 行/)
	assert.match(detail, /`src\/不存在\.js` · \*\*缺失\*\*/)
})

test('ratchet_checkpoint：校验器跑不起来时如实写跳过', async () => {
	const env = makeEnv()
	await env.tool('ratchet_checkpoint').execute({ stage: '第一段', summary: '做完了' }, env.exec)
	const detail = env.panels[0].questions[0].detail
	assert.match(detail, /\*\*文档校验\*\*/)
	assert.match(detail, /术语表 –/)
})

test('ratchet_checkpoint：正文带上「定下的」，空白条目被过滤', async () => {
	const env = makeEnv()
	await env.tool('ratchet_checkpoint').execute(
		{ stage: 's', summary: 'x', decisions: ['不引入 OCR', '   ', '只用 stdlib'] },
		env.exec,
	)
	const detail = env.panels[0].questions[0].detail
	assert.match(detail, /\*\*定下的\*\*/)
	assert.match(detail, /- 不引入 OCR/)
	assert.match(detail, /- 只用 stdlib/)
	assert.doesNotMatch(detail, /^- *$/mu)
})

test('ratchet_checkpoint：选项里第一项是「继续下一步」并带 description', async () => {
	const env = makeEnv()
	await env.tool('ratchet_checkpoint').execute({ stage: 's', summary: 'x', next: '处理双栏' }, env.exec)
	const [question] = env.panels[0].questions
	assert.equal(question.options[0].label, NEXT_CONTINUE)
	assert.equal(question.options[0].description, '处理双栏')
	assert.ok(question.options.some((entry) => entry.label === NEXT_REDIRECT))
	assert.ok(question.options.some((entry) => entry.label === NEXT_STOP))
})

test('ratchet_checkpoint：nextOptions 插在继续和换方向之间', async () => {
	const env = makeEnv()
	await env.tool('ratchet_checkpoint').execute({ stage: 's', summary: 'x', nextOptions: ['先补测试'] }, env.exec)
	const labels = env.panels[0].questions[0].options.map((entry) => entry.label)
	assert.equal(labels[0], NEXT_CONTINUE)
	assert.equal(labels[1], '先补测试')
	assert.equal(labels[2], NEXT_REDIRECT)
})

test('ratchet_checkpoint：选「继续」时把 next 交回去', async () => {
	const env = makeEnv({ answer: { answers: [{ id: 'checkpoint', selected: [NEXT_CONTINUE] }] } })
	const result = await env.tool('ratchet_checkpoint').execute({ stage: 's', summary: 'x', next: '处理双栏' }, env.exec)
	assert.equal(result.action, 'continue')
	assert.equal(result.next, '处理双栏')
	assert.equal(result.stageIndex, 1)
})

test('ratchet_checkpoint：选「换个方向」并写字时进 redirect', async () => {
	const env = makeEnv({ answer: { answers: [{ id: 'checkpoint', selected: [NEXT_REDIRECT], custom: '改成 CLI' }] } })
	const result = await env.tool('ratchet_checkpoint').execute({ stage: 's', summary: 'x' }, env.exec)
	assert.equal(result.action, 'redirect')
	assert.equal(result.feedback, '改成 CLI')
	assert.match(result.text, /改成 CLI/)
})

test('ratchet_checkpoint：选「停在这里」时进 stop', async () => {
	const env = makeEnv({ answer: { answers: [{ id: 'checkpoint', selected: [NEXT_STOP] }] } })
	const result = await env.tool('ratchet_checkpoint').execute({ stage: 's', summary: 'x' }, env.exec)
	assert.equal(result.action, 'stop')
	assert.match(result.text, /停在这里/)
})

test('ratchet_checkpoint：自定义选项被选中时按 continue 处理，next 用那个标签', async () => {
	const env = makeEnv({ answer: { answers: [{ id: 'checkpoint', selected: ['先补测试'] }] } })
	const result = await env.tool('ratchet_checkpoint').execute({ stage: 's', summary: 'x', nextOptions: ['先补测试'] }, env.exec)
	assert.equal(result.action, 'continue')
	assert.equal(result.next, '先补测试')
})

test('ratchet_checkpoint：段号跟着镜像涨', async () => {
	const env = makeEnv({ answer: { answers: [{ id: 'checkpoint', selected: [NEXT_CONTINUE] }] } })
	const tool = env.tool('ratchet_checkpoint')
	const first = await tool.execute({ stage: '一', summary: 'x' }, env.exec)
	const second = await tool.execute({ stage: '二', summary: 'y' }, env.exec)
	assert.equal(first.stageIndex, 1)
	assert.equal(second.stageIndex, 2)
})

test('ratchet_checkpoint：用户取消时不动下一段', async () => {
	const cancelled = Object.assign(new Error('cancelled'), { code: 'ASK_CANCELLED' })
	const env = makeEnv({ askThrows: cancelled })
	const result = await env.tool('ratchet_checkpoint').execute({ stage: 's', summary: 'x' }, env.exec)
	assert.equal(result.action, 'cancelled')
	assert.match(result.text, /不要自己往下做/)
	assert.equal(env.exec.concluded, true)
})

test('ratchet_checkpoint：没有面板服务时把同一份正文降级出去', async () => {
	const env = makeEnv({ withPanel: false })
	const result = await env.tool('ratchet_checkpoint').execute({ stage: '第一段', summary: '做完了' }, env.exec)
	assert.equal(result.action, 'inline')
	assert.match(result.text, /第 1 段 · 第一段/)
	assert.match(result.text, /文档校验/)
})

/* ---------------------------------------------------------------- *
 * 卡片
 * ---------------------------------------------------------------- */

test('两个工具的 presentCall 都给得出卡片', () => {
	const env = makeEnv()
	for (const tool of env.registered.tools) {
		const card = tool.presentCall(tool.name === 'ratchet_start' ? { topic: 't' } : { stage: 's', summary: 'x' })
		assert.equal(card.card, 'generic')
		assert.ok(Array.isArray(card.content))
	}
})

/* ---------------------------------------------------------------- *
 * 送到浏览器端的结构化快照（block.meta 的来源）
 * ---------------------------------------------------------------- */

test('ratchet_start 的 presentationMeta 是纯 JSON，带 kind/topic/mode', () => {
	const env = makeEnv()
	const tool = env.tool('ratchet_start')
	const value = { action: 'inline', text: 'x' }
	const meta = tool.output.presentationMeta({ topic: '做下载器', mode: 'deep' }, value)
	assert.doesNotThrow(() => JSON.parse(JSON.stringify(meta)))
	assert.equal(meta.ratchet.kind, 'start')
	assert.equal(meta.ratchet.topic, '做下载器')
	assert.equal(meta.ratchet.mode, 'deep')
})

test('ratchet_start 没给 meta 时也不返回 undefined —— 否则宿主要抛', () => {
	const env = makeEnv()
	const meta = env.tool('ratchet_start').output.presentationMeta({ topic: 't' }, { text: '' })
	assert.equal(typeof meta, 'object')
	assert.equal(meta.ratchet.kind, 'start')
})

test('ratchet_checkpoint 的 presentationMeta 带上段号、产出与校验结论', async () => {
	const env = makeEnv({ answer: { answers: [{ id: 'checkpoint', selected: [NEXT_CONTINUE] }] } })
	const tool = env.tool('ratchet_checkpoint')
	const value = await tool.execute(
		{ stage: '第一段', summary: '做完了', artifacts: ['src/a.js', 'src/不存在.js'], next: '做二段' },
		env.exec,
	)
	const meta = tool.output.presentationMeta({ stage: '第一段' }, value)
	assert.equal(meta.ratchet.kind, 'checkpoint')
	assert.equal(meta.ratchet.stage, '第一段')
	assert.equal(meta.ratchet.stageIndex, 1)
	assert.equal(meta.ratchet.action, 'continue')
	assert.equal(meta.ratchet.next, '做二段')
	assert.equal(meta.ratchet.artifacts.length, 2)
	assert.equal(meta.ratchet.artifacts[0].exists, true)
	assert.equal(meta.ratchet.artifacts[0].lines, 1)
	assert.equal(meta.ratchet.artifacts[1].exists, false)
	// 校验结论必须是 4 个固定词之一，浏览器端靠它上色。
	for (const check of meta.ratchet.checks) {
		assert.ok(['PASS', 'WARN', 'FAIL', 'SKIP'].includes(check.verdict), `unexpected verdict ${check.verdict}`)
	}
})

test('ratchet_checkpoint 的 meta 只留纯 JSON（宿主的 snapshotProjection 会卡）', async () => {
	const env = makeEnv()
	const tool = env.tool('ratchet_checkpoint')
	const value = await tool.execute({ stage: 's', summary: 'x', artifacts: ['src/a.js'] }, env.exec)
	const meta = tool.output.presentationMeta({ stage: 's' }, value)
	const roundTrip = JSON.parse(JSON.stringify(meta))
	assert.deepEqual(roundTrip, meta)
	assert.doesNotMatch(JSON.stringify(meta), /"undefined"/)
})

test('没有 meta 的降级返回值也能过 presentationMeta', async () => {
	const env = makeEnv({ withPanel: false })
	const tool = env.tool('ratchet_checkpoint')
	const value = await tool.execute({ stage: 's', summary: 'x' }, env.exec)
	const meta = tool.output.presentationMeta({ stage: 's' }, value)
	assert.equal(meta.ratchet.kind, 'checkpoint')
})
