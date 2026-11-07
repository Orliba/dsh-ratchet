// 会话级状态：一条投影 + 一组合规的 plugin record 写入口。
//
// 为什么不用模块级 Map：resume / fork 之后 Map 是空的，模型会以为"还在第三段"，
// 用户看到的面板编号却从零开始 —— 这种错位正是本插件要消灭的东西。
// 所以状态必须落进 event log，靠 projection 折叠回来。
//
// record type 必须匹配 `^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$`，
// 并且只能走 appendPluginRecord —— Session.append() 会因未知 type 被 validate 拒掉。

export const RECORD_TYPE = 'plugin:dsh-ratchet/state'
export const PROJECTION_KEY = 'ratchet'

const MAX_STAGES = 12

/** @returns {object} 空状态。 */
export function emptyState() {
	return {
		active: false,
		topic: '',
		mode: '',
		stage: '',
		stageIndex: 0,
		lastVerdict: '',
		lastNote: '',
		stages: [],
	}
}

/** 把任意输入收成一个合法状态（投影与工具都走这里，防止半截数据进 log）。 */
export function normalizeState(value) {
	const source = typeof value === 'object' && value !== null ? value : {}
	const stages = Array.isArray(source.stages) ? source.stages : []
	return {
		active: source.active === true,
		topic: typeof source.topic === 'string' ? source.topic : '',
		mode: source.mode === 'kickoff' || source.mode === 'deep' ? source.mode : '',
		stage: typeof source.stage === 'string' ? source.stage : '',
		stageIndex: Number.isInteger(source.stageIndex) && source.stageIndex >= 0 ? source.stageIndex : 0,
		lastVerdict: typeof source.lastVerdict === 'string' ? source.lastVerdict : '',
		lastNote: typeof source.lastNote === 'string' ? source.lastNote : '',
		stages: stages
			.filter((entry) => typeof entry === 'object' && entry !== null)
			.slice(-MAX_STAGES)
			.map((entry) => ({
				stage: typeof entry.stage === 'string' ? entry.stage : '',
				verdict: typeof entry.verdict === 'string' ? entry.verdict : '',
				note: typeof entry.note === 'string' ? entry.note : '',
				at: typeof entry.at === 'string' ? entry.at : '',
			})),
	}
}

/**
 * 投影定义。apply 会被喂**每一个**已提交事件（包括 ignorable 的 plugin record），
 * 所以这里只挑自己的 record，其余原样返回同一个引用 —— 引用不变投影层就认为没变，
 * 不会触发多余的 view 重算。
 */
export const ratchetProjection = {
	key: PROJECTION_KEY,
	stateVersion: 1,
	stateSchema: { parse: (value) => normalizeState(value) },
	init: () => emptyState(),
	apply: (state, event) => {
		if (event?.type !== RECORD_TYPE) return state
		const data = event.data
		if (typeof data !== 'object' || data === null) return state
		if (data.op === 'start') {
			return normalizeState({
				active: true,
				topic: typeof data.topic === 'string' ? data.topic : '',
				mode: data.mode,
				stage: typeof data.stage === 'string' ? data.stage : '',
				stageIndex: 0,
				lastVerdict: '',
				lastNote: '',
				stages: [],
			})
		}
		if (data.op === 'checkpoint') {
			const stage = typeof data.stage === 'string' ? data.stage : state.stage
			const verdict = typeof data.verdict === 'string' ? data.verdict : ''
			const note = typeof data.note === 'string' ? data.note : ''
			const interrupted = verdict === 'stop'
			return normalizeState({
				...state,
				active: !interrupted,
				stage,
				stageIndex: state.stageIndex + 1,
				lastVerdict: verdict,
				lastNote: note,
				stages: [...state.stages, { stage, verdict, note, at: new Date().toISOString() }],
			})
		}
		if (data.op === 'redirect') {
			return normalizeState({
				...state,
				active: true,
				stage: typeof data.stage === 'string' ? data.stage : state.stage,
				lastVerdict: 'redirect',
				lastNote: typeof data.note === 'string' ? data.note : '',
			})
		}
		if (data.op === 'stop') {
			return normalizeState({ ...state, active: false, lastVerdict: 'stop', lastNote: typeof data.note === 'string' ? data.note : '' })
		}
		return state
	},
	wire: {
		// 客户端可见的那一份：只暴露"要不要显示、第几段、什么话题"，不带全量阶段史。
		viewSchema: {
			parse: (value) => value,
		},
		view: (state) => ({
			active: state.active === true,
			stageIndex: Number.isInteger(state.stageIndex) ? state.stageIndex : 0,
			topic: typeof state.topic === 'string' ? state.topic.slice(0, 120) : '',
		}),
	},
}

let appendRecord

/**
 * 懒加载 `appendPluginRecord`。
 * 用动态 import 而不是静态 import：万一宿主包解析失败，插件整体仍然能装配，
 * 只是状态退回内存（工具内保留一份 mirror），不至于整个 /ratchet 都不可用。
 * @returns {Promise<((session: any, type: string, data: any) => number) | null>}
 */
async function loadAppendRecord() {
	if (appendRecord !== undefined) return appendRecord
	try {
		const mod = await import('@deepseek-ai/dsh-session')
		const fn = mod?.appendPluginRecord
		appendRecord = typeof fn === 'function' ? fn : null
	} catch {
		appendRecord = null
	}
	return appendRecord
}

/** 内存镜像：appendPluginRecord 不可用时的兜底。key = session 对象。 */
const mirror = new WeakMap()

/**
 * 读当前状态。优先走投影（resume/fork 后依然准确），投影缺席时退回镜像。
 * @returns {object}
 */
export function readState(ctx, session) {
	try {
		const projections = ctx.get('sessionProjections')
		const state = projections?.stateOf?.(session, PROJECTION_KEY)
		if (state !== undefined) return normalizeState(state)
	} catch {
		// 投影服务不可用，走镜像。
	}
	return normalizeState(mirror.get(session))
}

/**
 * 写一条状态 record。
 * @param {any} ctx - 插件上下文。
 * @param {any} session - 目标会话。
 * @param {object} payload - `{ op, ... }`。
 * @returns {Promise<boolean>} 是否真的写进了 log。
 */
export async function writeState(ctx, session, payload) {
	const previous = readState(ctx, session)
	const next = ratchetProjectionStateAfter(previous, payload)
	mirror.set(session, next)
	const append = await loadAppendRecord()
	if (append === null) return false
	try {
		append(session, RECORD_TYPE, payload)
		return true
	} catch {
		return false
	}
}

/** 用同一份折叠逻辑算下一个状态，保证镜像与投影不会分叉。 */
function ratchetProjectionStateAfter(state, payload) {
	return ratchetProjection.apply(state, { type: RECORD_TYPE, data: payload })
}
