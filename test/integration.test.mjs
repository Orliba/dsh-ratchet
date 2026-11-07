// 真集成：拿宿主的真 Session + 真 cordis Context + 真 SessionProjectionRegistry
// + 真 appendPluginRecord 跑一遍，证明"状态真的能从 event log 折叠回来"不是我在测试里想象出来的。
//
// 这一层不能少：投影的 apply 是宿主对**每个**事件调用的，record type 要过类型正则，
// writeState 的懒加载 import 要在真环境里解析成功 —— 这些都只有真包能验。
// 找不到宿主包时整组跳过（不假通过）。

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

import { PROJECTION_KEY, RECORD_TYPE, emptyState, ratchetProjection, normalizeState, readState, writeState } from '../plugin/state.mjs'

const ROOT = process.env.DSH_INSTALL_ROOT ?? 'H:\\Deepseekstudio'
const MODULES = join(ROOT, 'resources', 'app', 'dsh', 'node_modules', '@deepseek-ai')

async function hostModule(name) {
	const entry = join(MODULES, name, 'lib', 'index.js')
	if (!existsSync(entry)) return null
	return import(pathToFileURL(entry).href)
}

const sessionMod = await hostModule('dsh-session')
const projectionMod = await hostModule('dsh-session-projection')
const cordisMod = await hostModule('cordis')
const missing = sessionMod === null || projectionMod === null || cordisMod === null

/** 用真 cordis 起一个最小宿主，并装好真实的投影注册表。 */
function makeHost() {
	const ctx = new cordisMod.Context()
	const registry = new projectionMod.SessionProjectionRegistry(ctx)
	registry.register(ratchetProjection)
	// 把 registry 挂到 ctx 上，让 readState 的 ctx.get('sessionProjections') 能拿到。
	ctx.sessionProjections = registry
	return { ctx, registry }
}

test('宿主包可用（缺了就整组跳过）', (t) => {
	if (missing) t.skip('这台机器上找不到 @deepseek-ai/dsh-session / dsh-session-projection / cordis')
})

test('record type 能过宿主的类型校验，且带 ignorable', async (t) => {
	if (missing) {
		t.skip()
		return
	}
	const { Session, appendPluginRecord } = sessionMod
	const id = 'ratchet-type'
	const session = new Session(id, undefined, { version: 4, id, createdAt: Date.now(), isSeeded: false })
	assert.doesNotThrow(() => appendPluginRecord(session, RECORD_TYPE, { op: 'start', topic: 't', mode: 'kickoff' }))
	const record = session.log.at(-1)
	assert.equal(record.type, RECORD_TYPE)
	assert.equal(record.ignorable, true)
})

test('session.append 写不进 ignorable，pluginRecordOf 认不出来 —— 这就是我们走 appendPluginRecord 的原因', async (t) => {
	if (missing) {
		t.skip()
		return
	}
	const { Session, appendPluginRecord, pluginRecordOf } = sessionMod
	const id = 'ratchet-append'
	const session = new Session(id, undefined, { version: 4, id, createdAt: Date.now(), isSeeded: false })

	// append 不校验 plugin 语法，但也不盖 ignorable：事件落在会话目录之外，
	// 别的读者按"未知 type"处理，pluginRecordOf 也读不回来。
	session.append(RECORD_TYPE, { op: 'start' })
	assert.equal(pluginRecordOf(session.log.at(-1)), undefined)
	assert.notEqual(session.log.at(-1).ignorable, true)

	// appendPluginRecord 才产出合规的 record。
	appendPluginRecord(session, RECORD_TYPE, { op: 'start' })
	const record = pluginRecordOf(session.log.at(-1))
	assert.ok(record)
	assert.equal(record.type, RECORD_TYPE)
	assert.deepEqual(record.data, { op: 'start' })
})

test('投影从真 event log 折叠出完整状态；无关事件不换引用', async (t) => {
	if (missing) {
		t.skip()
		return
	}
	const { Session, appendPluginRecord } = sessionMod
	const { ctx, registry } = makeHost()
	const id = 'ratchet-fold'
	const session = new Session(id, undefined, { version: 4, id, createdAt: Date.now(), isSeeded: false })
	ctx.emit('session/created', session)
	registry.stateOf(session, PROJECTION_KEY) // 建档

	const append = (data) => {
		appendPluginRecord(session, RECORD_TYPE, data)
		ctx.emit('session/event', session, session.log.at(-1))
	}

	append({ op: 'start', topic: '做下载器', mode: 'kickoff', stage: '对齐方向' })
	append({ op: 'checkpoint', stage: '第一段', verdict: 'continue', note: '继续' })
	append({ op: 'checkpoint', stage: '第二段', verdict: 'redirect', note: '改成 CLI' })

	const state = registry.stateOf(session, PROJECTION_KEY)
	assert.equal(state.active, true)
	assert.equal(state.topic, '做下载器')
	assert.equal(state.stageIndex, 2)
	assert.equal(state.stages.length, 2)
	assert.equal(state.lastVerdict, 'redirect')

	// 无关事件不许换引用 —— 换了宿主就会白重算 view。
	const before = registry.stateOf(session, PROJECTION_KEY)
	session.append('turn/start', { turnId: 't1' })
	ctx.emit('session/event', session, session.log.at(-1))
	assert.equal(registry.stateOf(session, PROJECTION_KEY), before)

	append({ op: 'stop', note: '手动退出' })
	assert.equal(registry.stateOf(session, PROJECTION_KEY).active, false)
})

test('writeState 在真环境里落地成功（appendPluginRecord 解析得到）', async (t) => {
	if (missing) {
		t.skip()
		return
	}
	const { Session } = sessionMod
	const { ctx, registry } = makeHost()
	const id = 'ratchet-write'
	const session = new Session(id, undefined, { version: 4, id, createdAt: Date.now(), isSeeded: false })
	ctx.emit('session/created', session)

	const wrote = await writeState(ctx, session, { op: 'start', topic: '真集成', mode: 'kickoff' })
	assert.equal(wrote, true, 'writeState 应该真的写进 log')
	assert.equal(session.log.at(-1).type, RECORD_TYPE)

	// 关键：readState 必须从投影读到，而不是退回镜像。
	ctx.emit('session/event', session, session.log.at(-1))
	const state = readState(ctx, session)
	assert.equal(state.active, true)
	assert.equal(state.topic, '真集成')

	// 第二段：这一次 readState 读的是投影，段号必须接着涨。
	await writeState(ctx, session, { op: 'checkpoint', stage: '一', verdict: 'continue' })
	ctx.emit('session/event', session, session.log.at(-1))
	assert.equal(readState(ctx, session).stageIndex, 1)
})

test('宿主会把持久化状态喂给 stateSchema.parse（形状约定）', () => {
	const parsed = ratchetProjection.stateSchema.parse({ active: 1, stages: [{ stage: 'a' }] })
	assert.deepEqual(parsed, normalizeState({ active: 1, stages: [{ stage: 'a' }] }))
	assert.equal(parsed.active, false)
	assert.equal(parsed.stages.length, 1)
	// 空对象也要能过，不能抛 —— 老版本存下来的行可能是空的。
	assert.deepEqual(ratchetProjection.stateSchema.parse({}), emptyState())
})
