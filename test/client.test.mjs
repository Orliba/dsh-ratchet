// 浏览器端半边的形状测试。
//
// client.js 是宿主用同源 classic script 加载的，不能 import —— 所以这里手工造一个
// window.__ModuleLoader__ + 假的 react / primitives，把 factory 跑起来，验四件事：
//   ① 外壳合规（id 对、factory 返回的 exports 带 default/apply/inject）；
//   ② 样式真的注入到 document.head 且带 data-plugin-css（卸载时能清掉）；
//   ③ 两个工具名都注册进 tool.call.toolview，key 命中才算接管了默认卡片；
//   ④ 设置页注册进 plugins.bundle.config，key 是包名，且六个值都能读写。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const SOURCE = readFileSync(join(import.meta.dirname, '..', 'plugin', 'client.js'), 'utf8')

/** 极简 React 桩：只需要 createElement / useState，组件本身不在这里渲染。 */
const reactStub = {
	createElement: (type, props, ...children) => ({ type, props, children }),
	useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
}

/** 宿主原语桩：只保留 client.js 真正用到的符号，行为按契约的最小实现来。 */
function makePrimitives() {
	const written = []

	class SettingsFormModel {
		constructor(scope, specs) {
			this.scope = scope
			this.specs = new Map(specs.map((spec) => [spec.field, spec]))
			this.staged = new Map()
		}

		shell() {
			return {
				available: this.scope.getSnapshot().status === 'ready',
				writable: this.scope.getSnapshot().writable,
				dirty: this.staged.size > 0,
				invalid: false,
				saving: false,
				failed: this.failed === true,
			}
		}

		field(name) {
			const staged = this.staged.get(name)
			if (staged !== undefined) return { text: staged, overridden: true, invalid: false }
			const value = this.scope.getSnapshot().value?.[name]
			return { text: this.specs.get(name).format(value), overridden: false, invalid: false }
		}

		actions() {
			const model = this
			return {
				edit: (name, text) => {
					model.staged.set(name, text)
				},
				resetField: (name) => {
					model.staged.delete(name)
				},
				// 照真模型的行为来：把 staged 编成 ops 写进 scope，成功才清草稿。
				save: async () => {
					const ops = model.plan().flatMap((item) => (item.op === undefined ? [] : [item.op]))
					if (ops.length === 0) return
					const accepted = await model.scope.mutate(ops, model.scope.getSnapshot().revision)
					model.failed = !accepted
					if (accepted) model.staged.clear()
				},
				discard: () => {
					model.staged.clear()
				},
			}
		}

		plan() {
			return [...this.staged.entries()].map(([name, text]) => ({
				field: name,
				op: { op: 'set', path: [name], value: this.specs.get(name).parse(text)?.value },
			}))
		}

		bind(projection) {
			let snapshot = projection()
			const listeners = new Set()
			this.scope.subscribe(() => {
				snapshot = projection()
				for (const listener of listeners) listener()
			})
			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener)
					return () => listeners.delete(listener)
				},
				set: (value) => {
					snapshot = value
					for (const listener of listeners) listener()
				},
				update: () => {},
			}
		}

		dispose() {}
	}

	return {
		written,
		SettingsFormModel,
		SettingsForm: (props) => ({ type: 'form', props }),
		SettingsValueField: (props) => ({ type: 'field', props }),
		Switch: (props) => ({ type: 'switch', props }),
		settingsNumberField: (field) => ({
			field,
			format: (value) => (typeof value === 'number' ? String(value) : ''),
			parse: (text) => {
				const trimmed = text.trim()
				if (trimmed === '') return { kind: 'clear' }
				const parsed = Number(trimmed)
				return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
			},
		}),
		settingsTextField: (field) => ({
			field,
			format: (value) => (typeof value === 'string' ? value : ''),
			parse: (text) => (text.trim() === '' ? { kind: 'clear' } : { kind: 'set', value: text.trim() }),
		}),
	}
}

/** 造一个够用的 configForms 桩：一个命名空间、一份可写的快照。 */
function makeConfigForms(primitives, options = {}) {
	const mutations = []
	const listeners = new Set()
	let reject = false
	let snapshot = {
		status: options.status ?? 'ready',
		value: {
			enabled: true,
			maxQuestions: 5,
			validatorTimeoutMs: 20000,
			pythonPath: '',
			stageLimit: 5,
			policyText: '',
		},
		revision: 1,
		writable: options.writable !== false,
	}
	const scope = {
		getSnapshot: () => snapshot,
		subscribe: (listener) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		mutate: async (ops, revision) => {
			mutations.push({ ops, revision })
			if (reject) return false
			const next = { ...snapshot.value }
			for (const op of ops) {
				if (op.op === 'set') next[op.path[0]] = op.value
				if (op.op === 'unset') delete next[op.path[0]]
			}
			snapshot = { ...snapshot, value: next, revision: snapshot.revision + 1 }
			for (const listener of listeners) listener()
			return true
		},
	}
	return {
		mutations,
		primitives,
		namespace: undefined,
		/** 让下一次（且仅下一次）写入被拒，模拟宿主 settings/rejected。 */
		rejectNext() {
			reject = true
			setTimeout(() => {
				reject = false
			}, 0)
		},
		get(namespace) {
			this.namespace = namespace
			return scope
		},
	}
}

/**
 * 模拟宿主渲染器把 inject 面折成 props：`hooks: {ratchetSettings: store}`
 * 会变成 `useRatchetSettings` 这个选择器 hook，其余动作平铺。
 */
function bindFace(face) {
	const props = {}
	for (const [name, source] of Object.entries(face)) {
		if (name !== 'hooks') {
			props[name] = source
			continue
		}
		for (const [hookName, store] of Object.entries(source)) {
			const propName = `use${hookName[0].toUpperCase()}${hookName.slice(1)}`
			props[propName] = (selector) => selector(store.getSnapshot())
		}
	}
	return props
}

/** 造一个够用的 document 桩，记录 head 上被 append 的 style。 */
function makeDocument() {
	const appended = []
	const head = {
		appendChild: (node) => {
			appended.push(node)
			node.parentNode = head
			return node
		},
		removeChild: (node) => {
			const index = appended.indexOf(node)
			if (index >= 0) appended.splice(index, 1)
			node.parentNode = null
			return node
		},
	}
	return {
		head,
		appended,
		createElement: (tag) => {
			const node = { tagName: String(tag).toUpperCase(), attributes: {}, textContent: '', parentNode: null }
			node.setAttribute = (name, value) => {
				node.attributes[name] = value
			}
			node.removeAttribute = (name) => {
				delete node.attributes[name]
			}
			return node
		},
	}
}

/** 造一个 slots 桩：记录每次 inject/register。 */
function makeSlots() {
	const injected = []
	const registered = []
	return {
		injected,
		registered,
		inject(name, factory) {
			const result = factory()
			injected.push({ name, result })
			return result
		},
		register(entry, component) {
			const handle = { entry, component }
			registered.push(handle)
			return handle
		},
	}
}

/**
 * 把 client.js 当成 classic script 跑一遍。
 * @param {{withPrimitives?: boolean, withConfigForms?: boolean}} [options]
 * @returns {{exports: object, slots: object, doc: object, effectCleanups: Function[], ctx: object, id: string,
 *   primitives: object, configForms: object}}
 */
function loadClient(options = {}) {
	const withPrimitives = options.withPrimitives !== false
	const withConfigForms = options.withConfigForms !== false
	const lateConfigForms = options.lateConfigForms === true
	let pendingInject
	const doc = makeDocument()
	const slots = makeSlots()
	const effectCleanups = []
	const primitives = makePrimitives()
	const configForms = makeConfigForms(primitives, options)
	let captured

	const sandbox = {
		window: {
			__ModuleLoader__: {
				load: ({ id, factory }) => {
					captured = { id, factory }
				},
			},
		},
		document: doc,
		console,
	}

	const run = new Function('window', 'document', 'console', 'globalThis', SOURCE)
	run(sandbox.window, sandbox.document, sandbox.console, sandbox)

	assert.ok(captured !== undefined, 'client.js 必须调用 window.__ModuleLoader__.load')
	const exportsObject = captured.factory((spec) => {
		if (spec === 'react') return reactStub
		if (spec === '@deepseek-ai/dsh-client-ui-primitives' && withPrimitives) return primitives
		throw new Error(`unexpected require: ${spec}`)
	})

	const ctx = {
		effect: (register) => {
			const cleanup = register()
			if (typeof cleanup === 'function') effectCleanups.push(cleanup)
			return cleanup
		},
		get: (name) => {
			if (name === 'slots') return slots
			// withConfigForms=false 模拟「装配那一刻 configForms 还没 provide」。
			if (name === 'configForms' && withConfigForms && lateConfigForms !== true) return configForms
			return undefined
		},
		// 真 cordis 的 ctx.inject 会在服务就绪后才跑回调；这里照同一语义：
		// 服务已在就当场跑，稍后才到就等 releaseConfigForms() 再跑。
		inject: (names, callback) => {
			const run = () => {
				const resolved = {}
				for (const name of names) {
					if (name === 'slots') resolved.slots = slots
					if (name === 'configForms') resolved.configForms = configForms
				}
				callback({ ...ctx, ...resolved })
			}
			if (!names.includes('configForms') || (withConfigForms && lateConfigForms !== true)) {
				run()
				return
			}
			pendingInject = run
		},
	}

	return {
		exports: exportsObject,
		slots,
		doc,
		effectCleanups,
		ctx,
		id: captured.id,
		primitives,
		configForms,
		/** 把「稍后才 provide」的 configForms 放出来，触发一次 inject 回调。 */
		releaseConfigForms() {
			const run = pendingInject
			pendingInject = undefined
			if (run !== undefined) run()
		},
	}
}

test('client bundle 外壳合规：id、default/apply/inject 都齐', () => {
	const loaded = loadClient()
	assert.equal(loaded.id, 'dsh-ratchet')
	assert.equal(typeof loaded.exports.default, 'object')
	assert.equal(typeof loaded.exports.apply, 'function')
	assert.deepEqual(loaded.exports.inject, ['slots'])
})

test('apply 把两个工具名都注册进 tool.call.toolview', async () => {
	const loaded = loadClient()
	await loaded.exports.apply(loaded.ctx)
	const keys = loaded.slots.registered.map((handle) => handle.entry.key)
	assert.deepEqual(keys, ['ratchet_start', 'ratchet_checkpoint', 'dsh-ratchet'])
	for (const handle of loaded.slots.registered.slice(0, 2)) {
		assert.equal(handle.entry.name, 'tool.call.toolview')
		assert.equal(handle.entry.locale, 'conversation')
		assert.equal(typeof handle.component, 'function')
	}
})

test('设置页注册进 plugins.bundle.config，key 是包名、命名空间是 ratchet', async () => {
	const loaded = loadClient()
	await loaded.exports.apply(loaded.ctx)
	const handle = loaded.slots.registered.find((each) => each.entry.name === 'plugins.bundle.config')
	assert.ok(handle !== undefined, '必须注册 plugins.bundle.config')
	assert.equal(handle.entry.key, 'dsh-ratchet')
	assert.equal(typeof handle.component, 'function')
	assert.equal(loaded.configForms.namespace, 'ratchet')
})

test('设置卡 summary 只给一句话，不进表单', async () => {
	const loaded = loadClient()
	await loaded.exports.apply(loaded.ctx)
	const handle = loaded.slots.registered.find((each) => each.entry.name === 'plugins.bundle.config')
	const summary = handle.component({ view: 'summary' })
	assert.equal(typeof summary, 'string')
	assert.match(summary, /对齐方向/)
})

test('设置卡把七个字段摊出来，并且开关能拨、能存进命名空间', async () => {
	const loaded = loadClient()
	await loaded.exports.apply(loaded.ctx)
	const handle = loaded.slots.registered.find((each) => each.entry.name === 'plugins.bundle.config')
	const face = bindFace(handle.entry.inject())
	assert.equal(typeof face.useRatchetSettings, 'function')

	const snapshot = face.useRatchetSettings((value) => value)
	assert.equal(snapshot.enabled, true)
	assert.equal(snapshot.maxQuestions.text, '5')
	assert.equal(snapshot.pythonPath.text, '')
	assert.equal(snapshot.dirty, false)

	const tree = handle.component({ view: 'page', ...face })
	const rendered = JSON.stringify(tree)
	for (const label of ['启用 ratchet 流程', '一轮最多几题', 'Python 解释器', '覆盖默认纪律文案']) {
		assert.match(rendered, new RegExp(label))
	}

	face.toggleEnabled()
	assert.equal(face.useRatchetSettings((value) => value).enabled, false)
	assert.equal(face.useRatchetSettings((value) => value).dirty, true)

	face.edit('maxQuestions', '3')
	await face.save()

	// 两次写：先让宿主表单存自己的字段，再用前进后的 revision 存开关。
	// 一次合成写会撞 revision 冲突（表单 save 内部已推进了一版）。
	assert.equal(loaded.configForms.mutations.length, 2)
	const [fieldsMutation, toggleMutation] = loaded.configForms.mutations
	assert.deepEqual(fieldsMutation.ops.map((op) => op.path.join('.')), ['maxQuestions'])
	assert.equal(fieldsMutation.ops[0].value, 3)
	assert.equal(toggleMutation.ops.length, 1)
	assert.deepEqual(toggleMutation.ops[0].path, ['enabled'])
	assert.equal(toggleMutation.ops[0].value, false)
	assert.equal(toggleMutation.revision, 2, '开关必须用表单写完之后的新 revision')
	const after = face.useRatchetSettings((value) => value)
	assert.equal(after.enabled, false)
	assert.equal(after.maxQuestions.text, '3')
	assert.equal(after.dirty, false)
})

test('表单存失败时不偷偷写开关（半成功比不成功更难查）', async () => {
	const loaded = loadClient()
	await loaded.exports.apply(loaded.ctx)
	const handle = loaded.slots.registered.find((each) => each.entry.name === 'plugins.bundle.config')
	const face = bindFace(handle.entry.inject())

	loaded.configForms.rejectNext()
	face.toggleEnabled()
	face.edit('maxQuestions', '4')
	await face.save()

	assert.equal(loaded.configForms.mutations.length, 1, '表单那次被拒，开关不该再写')
	assert.equal(loaded.configForms.mutations[0].ops[0].path[0], 'maxQuestions')
	const after = face.useRatchetSettings((value) => value)
	assert.equal(after.enabled, false, '开关还停在他拨的位置，只是没写进去')
	assert.equal(after.toggleFailed, true, '要明确说一句没写进去')
})

test('设置卡在只读部署上不做任何写入', async () => {
	const loaded = loadClient({ writable: false })
	await loaded.exports.apply(loaded.ctx)
	const handle = loaded.slots.registered.find((each) => each.entry.name === 'plugins.bundle.config')
	const face = bindFace(handle.entry.inject())
	face.toggleEnabled()
	await face.save()
	assert.equal(loaded.configForms.mutations.length, 0)
	assert.equal(face.useRatchetSettings((value) => value).enabled, true)
})

test('拿不到原语时不挂设置页，但工具行照常注册', async () => {
	const loaded = loadClient({ withPrimitives: false })
	await loaded.exports.apply(loaded.ctx)
	const names = loaded.slots.registered.map((handle) => handle.entry.name)
	assert.deepEqual(names, ['tool.call.toolview', 'tool.call.toolview'])
})

test('宿主没 provide configForms 时也只有工具行，不抛', async () => {
	const loaded = loadClient({ withConfigForms: false })
	await loaded.exports.apply(loaded.ctx)
	const names = loaded.slots.registered.map((handle) => handle.entry.name)
	assert.deepEqual(names, ['tool.call.toolview', 'tool.call.toolview'])
})

test('configForms 装配晚到也能挂上设置页（不能悄悄永久跳过）', async () => {
	const loaded = loadClient({ lateConfigForms: true })
	await loaded.exports.apply(loaded.ctx)
	assert.deepEqual(
		loaded.slots.registered.map((handle) => handle.entry.name),
		['tool.call.toolview', 'tool.call.toolview'],
		'服务还没到之前只有工具行',
	)

	loaded.releaseConfigForms()

	const names = loaded.slots.registered.map((handle) => handle.entry.name)
	assert.ok(names.includes('plugins.bundle.config'), '服务到位后设置页要补挂上')
	assert.equal(loaded.configForms.namespace, 'ratchet')
})

test('样式注入 head，带 data-plugin-css，卸载时清掉', async () => {
	const loaded = loadClient()
	await loaded.exports.apply(loaded.ctx)
	assert.equal(loaded.doc.appended.length, 1)
	const style = loaded.doc.appended[0]
	assert.equal(style.attributes['data-plugin-css'], 'dsh-ratchet')
	assert.ok(style.textContent.length > 500, '样式表不该是空壳')
	// 面板正文的分区样式必须真的在里面，否则"全黑"根本没被治。
	assert.match(style.textContent, /data-question-key/)
	assert.match(style.textContent, /\.drt-card/)
	assert.ok(loaded.effectCleanups.length >= 1)
	loaded.effectCleanups.forEach((cleanup) => cleanup())
	assert.equal(loaded.doc.appended.length, 0)
})

test('没有 slots 服务时 apply 不抛，样式照样清得掉', async () => {
	const loaded = loadClient()
	await loaded.exports.apply({ effect: (register) => register(), get: () => undefined })
	assert.equal(loaded.doc.appended.length, 1)
})

test('卡片在缺少 block.meta 时也渲染得出来（老会话 / 降级路径）', async () => {
	const loaded = loadClient()
	await loaded.exports.apply(loaded.ctx)
	const [handle] = loaded.slots.registered
	const tree = handle.component({ toolName: 'ratchet_start', block: { state: 'ok' } })
	assert.equal(tree.type, 'div')
	assert.match(JSON.stringify(tree), /ratchet_start/)
})

test('卡片：全跳过时不摆一排破折号，改成一句带原因的话', async () => {
	const loaded = loadClient()
	await loaded.exports.apply(loaded.ctx)
	const [handle] = loaded.slots.registered
	const tree = handle.component({
		toolName: 'ratchet_checkpoint',
		block: {
			state: 'ok',
			meta: {
				ratchet: {
					kind: 'checkpoint',
					stage: 's',
					stageIndex: 1,
					action: 'continue',
					checks: [
						{ name: 'CONTEXT.md 术语表', verdict: 'SKIP', skipped: true, reason: '没有 CONTEXT.md' },
						{ name: 'ADR 目录', verdict: 'SKIP', skipped: true, reason: '没有 docs/adr/' },
					],
					artifacts: [],
				},
			},
		},
	})
	const text = JSON.stringify(tree)
	assert.match(text, /个校验器都没跑/)
	assert.match(text, /没有 CONTEXT\.md/)
	// 原因各不相同时原文太长，收成一句总述，细节放 title 里。
	assert.doesNotMatch(text, /术语表 –/)
})

test('卡片：只有部分跳过时仍然一个个列徽章', async () => {
	const loaded = loadClient()
	await loaded.exports.apply(loaded.ctx)
	const [handle] = loaded.slots.registered
	const tree = handle.component({
		toolName: 'ratchet_checkpoint',
		block: {
			state: 'ok',
			meta: {
				ratchet: {
					kind: 'checkpoint',
					stage: 's',
					stageIndex: 1,
					checks: [
						{ name: 'CONTEXT.md 术语表', verdict: 'PASS' },
						{ name: 'ADR 目录', verdict: 'SKIP', skipped: true, reason: '没有 docs/adr/' },
					],
					artifacts: [],
				},
			},
		},
	})
	const text = JSON.stringify(tree)
	assert.match(text, /术语表/)
	assert.match(text, /ADR/)
	assert.match(text, /PASS/)
	assert.match(text, /SKIP/)
	assert.doesNotMatch(text, /个校验器都没跑/)
})
