// 插件装配层的单元测试：不开 DSH，用假 ctx 把注册行为跑一遍。
//
// 重点覆盖三件容易被改坏的事：
//   1. 未激活时纪律段必须返回空串（否则常驻上下文白烧 token）；
//   2. mergeQuestions 必须去重、裁到上限、自动给第一个选项盖推荐章；
//   3. recon 不能因为目录不存在就抛。

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { DEFAULTS, SECTION_NAME, internals, apply, name as pluginName } from '../plugin/index.mjs'
import { emptyState, ratchetProjection, normalizeState, RECORD_TYPE } from '../plugin/state.mjs'

const { recon, mergeQuestions, kickoffQuestions, deepQuestions, buildPolicyText, locateArtifact } = internals

/** 造一个假 ctx：记录注册了什么，服务按名字给。`overrides` 里显式写 undefined 表示"这个服务缺席"。 */
function fakeContext(overrides = {}) {
	const registered = { sections: [], projections: [], commands: [], tools: [] }
	const systemPrompt = {
		section(definition) {
			registered.sections.push(definition)
		},
		getSectionOrder() {
			return 500
		},
	}
	const sessionProjections = {
		register(definition) {
			registered.projections.push(definition)
		},
		// 让 readState 走镜像兜底：没有投影就返回 undefined。
		stateOf() {
			return undefined
		},
	}
	const commands = {
		register(definition) {
			registered.commands.push(definition)
		},
	}
	const tools = {
		register(definition) {
			registered.tools.push(definition)
		},
	}
	const services = { systemPrompt, sessionProjections, commands, tools, ...overrides }
	const ctx = {
		logger: { warn() {}, info() {} },
		// cordis 会把已注入的服务直接挂成 ctx 上的属性，这里照做。
		...services,
		get(service) {
			return services[service]
		},
		inject(names, callback) {
			// 只要有一个服务缺席，真实 cordis 就不会回调 —— 这里照这个语义来。
			if (names.some((entry) => services[entry] === undefined)) return
			callback(ctx)
		},
	}
	return { ctx, registered, services }
}

test('包名固定为 dsh-ratchet', () => {
	assert.equal(pluginName, 'dsh-ratchet')
})

test('enabled:false 时一个东西都不注册', () => {
	const { ctx, registered, services } = fakeContext()
	apply(ctx, { enabled: false })
	assert.deepEqual(registered, { sections: [], projections: [], commands: [], tools: [] })
})

test('装配后拿到一段、一投影、一命令、两工具', () => {
	const { ctx, registered, services } = fakeContext()
	apply(ctx, {})
	assert.equal(registered.sections.length, 1)
	assert.equal(registered.sections[0].name, SECTION_NAME)
	assert.equal(registered.sections[0].order, 650, 'PLAN_POLICY(500) + 150')
	assert.equal(registered.projections.length, 1)
	assert.equal(registered.commands.length, 1)
	assert.equal(registered.commands[0].name, 'ratchet')
	assert.deepEqual(
		registered.tools.map((tool) => tool.name),
		['ratchet_start', 'ratchet_checkpoint'],
	)
})

test('两个工具都满足 tools.register 的硬校验形状', () => {
	const { ctx, registered, services } = fakeContext()
	apply(ctx, {})
	for (const tool of registered.tools) {
		assert.equal(typeof tool.description, 'string')
		assert.equal(typeof tool.execute, 'function')
		assert.equal(typeof tool.output.render, 'function')
		assert.equal(tool.parameters.type, 'object')
		assert.ok(Array.isArray(tool.parameters.required))
		const text = tool.output.render({}, { text: 'hi' })
		assert.deepEqual(text, [{ type: 'text', text: 'hi' }])
	}
})

test('纪律段：没有会话时返回空串', () => {
	const { ctx, registered, services } = fakeContext({ sessionProjections: undefined })
	apply(ctx, {})
	assert.equal(registered.sections[0].text({}), '')
})

test('纪律段：流程未激活时返回空串', () => {
	const { ctx, registered, services } = fakeContext({ sessionProjections: undefined })
	apply(ctx, {})
	const text = registered.sections[0].text({ agent: { session: {} } })
	assert.equal(text, '')
})

test('/ratchet off 能退出流程', async () => {
	const { ctx, registered, services } = fakeContext({ sessionProjections: undefined })
	apply(ctx, {})
	const result = registered.commands[0].handler({ agent: { session: {} }, rawInput: 'off' })
	assert.equal(result.kind, 'success')
	assert.match(result.text, /退出/)
	await Promise.resolve()
})

test('/ratchet 带话题时进入 kickoff', () => {
	const { ctx, registered, services } = fakeContext({ sessionProjections: undefined })
	apply(ctx, {})
	const result = registered.commands[0].handler({ agent: { session: {} }, rawInput: '做个下载器' })
	assert.equal(result.kind, 'success')
	assert.match(result.text, /做个下载器/)
	assert.match(result.text, /ratchet_start/)
})

test('没有会话时 /ratchet 返回 error 而不是抛', () => {
	const { ctx, registered, services } = fakeContext({ sessionProjections: undefined })
	apply(ctx, {})
	const result = registered.commands[0].handler({ agent: undefined, rawInput: 'x' })
	assert.equal(result.kind, 'error')
})

test('/ratchet 不带话题时不编占位标题，而是要求先说一句', () => {
	const { ctx, registered, services } = fakeContext({ sessionProjections: undefined })
	apply(ctx, {})
	const result = registered.commands[0].handler({ agent: { session: {} }, rawInput: '   ' })
	assert.equal(result.kind, 'success')
	assert.doesNotMatch(result.text, /未命名任务/, '不能拿「未命名任务」当已对齐的方向')
	assert.match(result.text, /还没定要做什么/)
	assert.match(result.text, /先说一句/)
})

test('recon 在空目录里不抛，且如实报告缺文档', () => {
	const dir = mkdtempSync(join(tmpdir(), 'ratchet-recon-'))
	const info = recon(dir)
	assert.equal(info.hasContext, false)
	assert.equal(info.hasManifest, false)
	assert.equal(info.hasAdr, false)
	assert.deepEqual(info.files, [])
})

test('recon 认得 CONTEXT.md / package.json / docs/adr', () => {
	const dir = mkdtempSync(join(tmpdir(), 'ratchet-recon-'))
	writeFileSync(join(dir, 'CONTEXT.md'), '# x\n')
	writeFileSync(join(dir, 'package.json'), '{}\n')
	mkdirSync(join(dir, 'docs', 'adr'), { recursive: true })
	const info = recon(dir)
	assert.equal(info.hasContext, true)
	assert.equal(info.hasManifest, true)
	assert.equal(info.hasAdr, true)
	assert.ok(info.files.includes('CONTEXT.md'))
})

test('recon 对不存在的目录也返回结构，不抛', () => {
	const info = recon(join(tmpdir(), 'ratchet-does-not-exist-xyz'))
	assert.equal(info.hasContext, false)
	assert.equal(info.topLevel, 0)
})

test('kickoff 已有依赖清单时不问技术栈', () => {
	const questions = kickoffQuestions('做点东西', { hasManifest: true, hasContext: true, files: [], cwd: '.', topLevel: 0, hasAdr: false })
	assert.equal(questions.some((entry) => entry.id === 'stack'), false)
})

test('kickoff 缺依赖清单时会问技术栈，且推荐项在第一个', () => {
	const questions = kickoffQuestions('做点东西', { hasManifest: false, hasContext: false, files: [], cwd: '.', topLevel: 0, hasAdr: false })
	const stack = questions.find((entry) => entry.id === 'stack')
	assert.ok(stack)
	assert.match(stack.options[0].label, /推荐/)
})

test('kickoff 每题第一个选项都是推荐项', () => {
	for (const question of kickoffQuestions('t', { hasManifest: false })) {
		assert.match(question.options[0].label, /（推荐）$/, `${question.id} 的推荐项没打章`)
	}
})

test('deep 模式只问一题', () => {
	assert.equal(deepQuestions('t').length, 1)
})

test('mergeQuestions 去重并按上限裁剪', () => {
	const base = [{ id: 'a', header: 'A', question: 'qa', options: [] }]
	const extra = [
		{ id: 'a', question: '重复了' },
		{ id: 'b', question: 'qb', options: ['选我', '选他'] },
		{ id: 'c', question: 'qc' },
		{ id: 'd', question: 'qd' },
	]
	const merged = mergeQuestions(base, extra, 3)
	assert.deepEqual(merged.map((entry) => entry.id), ['a', 'b', 'c'])
})

test('mergeQuestions 给补进来的第一个选项盖推荐章，其它不动', () => {
	const merged = mergeQuestions([], [{ id: 'x', question: 'qx', options: ['甲', '乙'] }], 5)
	assert.equal(merged[0].options[0].label, '甲（推荐）')
	assert.equal(merged[0].options[1].label, '乙')
})

test('mergeQuestions 丢掉没写问题的条目', () => {
	const merged = mergeQuestions([], [{ id: 'x', question: '   ' }, { id: 'y', question: 'qy' }], 5)
	assert.deepEqual(merged.map((entry) => entry.id), ['y'])
})

test('mergeQuestions 对非数组输入是安全的', () => {
	assert.deepEqual(mergeQuestions([], undefined, 5), [])
	assert.deepEqual(mergeQuestions([], 'nope', 5), [])
})

test('纪律文案带上段数上限', () => {
	assert.match(buildPolicyText({ stageLimit: 4 }), /不超过 4 段/)
	assert.match(buildPolicyText(DEFAULTS), /ratchet_checkpoint/)
})

test('投影：非自有事件返回同一引用', () => {
	const state = emptyState()
	assert.equal(ratchetProjection.apply(state, { type: 'user/message' }), state)
	assert.equal(ratchetProjection.apply(state, undefined), state)
})

test('投影：start 会激活并从第 0 段起算', () => {
	const next = ratchetProjection.apply(emptyState(), {
		type: RECORD_TYPE,
		data: { op: 'start', topic: '做下载器', mode: 'kickoff', stage: '对齐方向' },
	})
	assert.equal(next.active, true)
	assert.equal(next.topic, '做下载器')
	assert.equal(next.stageIndex, 0)
})

test('投影：checkpoint 的 continue 累加段号', () => {
	let state = ratchetProjection.apply(emptyState(), { type: RECORD_TYPE, data: { op: 'start', topic: 't', mode: 'kickoff' } })
	state = ratchetProjection.apply(state, { type: RECORD_TYPE, data: { op: 'checkpoint', stage: '第一段', verdict: 'continue', note: '继续' } })
	assert.equal(state.stageIndex, 1)
	assert.equal(state.stages.length, 1)
	assert.equal(state.active, true)
})

test('投影：checkpoint 的 stop 会关掉流程', () => {
	let state = ratchetProjection.apply(emptyState(), { type: RECORD_TYPE, data: { op: 'start', topic: 't', mode: 'kickoff' } })
	state = ratchetProjection.apply(state, { type: RECORD_TYPE, data: { op: 'checkpoint', stage: 'x', verdict: 'stop' } })
	assert.equal(state.active, false)
})

test('投影：redirect 保持激活并记下新方向', () => {
	let state = ratchetProjection.apply(emptyState(), { type: RECORD_TYPE, data: { op: 'start', topic: 't', mode: 'kickoff' } })
	state = ratchetProjection.apply(state, { type: RECORD_TYPE, data: { op: 'redirect', note: '改成 CLI' } })
	assert.equal(state.active, true)
	assert.equal(state.lastNote, '改成 CLI')
	assert.equal(state.lastVerdict, 'redirect')
})

test('投影：stop 关流程', () => {
	let state = ratchetProjection.apply(emptyState(), { type: RECORD_TYPE, data: { op: 'start', topic: 't', mode: 'kickoff' } })
	state = ratchetProjection.apply(state, { type: RECORD_TYPE, data: { op: 'stop', note: '手动退出' } })
	assert.equal(state.active, false)
	assert.equal(state.lastNote, '手动退出')
})

test('投影：未知 op 只留原状态', () => {
	const state = ratchetProjection.apply(emptyState(), { type: RECORD_TYPE, data: { op: 'wat' } })
	assert.deepEqual(state, emptyState())
})

test('投影 view 只暴露三样', () => {
	const view = ratchetProjection.wire.view({ active: true, stageIndex: 3, topic: 'x'.repeat(300) })
	assert.deepEqual(Object.keys(view).sort(), ['active', 'stageIndex', 'topic'])
	assert.equal(view.topic.length, 120)
})

test('normalizeState 把脏数据收干净', () => {
	const state = normalizeState({ active: 'yes', stageIndex: -5, mode: 'nope', stages: 'x' })
	assert.equal(state.active, false)
	assert.equal(state.stageIndex, 0)
	assert.equal(state.mode, '')
	assert.deepEqual(state.stages, [])
})

test('normalizeState 只保留最近 12 段', () => {
	const stages = Array.from({ length: 30 }, (_, index) => ({ stage: `s${index}` }))
	const state = normalizeState({ stages })
	assert.equal(state.stages.length, 12)
	assert.equal(state.stages.at(-1).stage, 's29')
})


/* ---------------------------------------------------------------- *
 * 产出路径定位
 * ---------------------------------------------------------------- */

test('locateArtifact：工作目录直下能找到就直接用', () => {
	const dir = mkdtempSync(join(tmpdir(), 'ratchet-locate-'))
	writeFileSync(join(dir, 'a.txt'), 'x\n')
	const found = locateArtifact(dir, 'a.txt')
	assert.equal(found.path, join(dir, 'a.txt'))
	assert.equal(found.where, undefined)
})

test('locateArtifact：工作目录里没有时，去一级子目录里找 —— 模型说的根常常是项目子目录', () => {
	const dir = mkdtempSync(join(tmpdir(), 'ratchet-locate-'))
	mkdirSync(join(dir, 'proj', 'plugin'), { recursive: true })
	writeFileSync(join(dir, 'proj', 'plugin', 'render.mjs'), 'x\n')
	const found = locateArtifact(dir, 'plugin/render.mjs')
	assert.equal(found.path, join(dir, 'proj', 'plugin', 'render.mjs'))
	assert.equal(found.where, 'proj')
})

test('locateArtifact：找不到时返回按工作目录解析的路径，让面板如实说"按这里找过"', () => {
	const dir = mkdtempSync(join(tmpdir(), 'ratchet-locate-'))
	const found = locateArtifact(dir, 'nothing/here.mjs')
	assert.equal(found.path, join(dir, 'nothing', 'here.mjs'))
	assert.equal(found.where, undefined)
})

test('locateArtifact：绝对路径原样返回，不去别处猜', () => {
	const abs = join(tmpdir(), 'ratchet-abs-probe.txt')
	const found = locateArtifact('C:\\', abs)
	assert.equal(found.path, abs)
})
