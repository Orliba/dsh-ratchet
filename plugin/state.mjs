// Session-scoped state: one projection plus a compliant way to write plugin records.
//
// Why not a module-level Map: after resume or fork the Map is empty, so the model
// believes it is still on stage three while the panel the user sees counts from
// zero again. That mismatch is exactly what this plugin exists to remove. So state
// has to land in the event log and be folded back by a projection.
//
// The record type must match `^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$`
// and may only be written through appendPluginRecord — Session.append() rejects an
// unknown type in validation.

export const RECORD_TYPE = 'plugin:dsh-ratchet/state'
export const PROJECTION_KEY = 'ratchet'

const MAX_STAGES = 12

/** @returns {object} The empty state. */
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

/** Coerce anything into a legal state (both the projection and the tools go through this). */
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
 * The projection definition. `apply` is handed *every* committed event (including
 * ignorable plugin records), so it picks out its own record and returns the same
 * reference for everything else — an unchanged reference means the projection layer
 * sees no change and skips a pointless view recomputation.
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
		// What the client sees: just "is it active, which stage, what topic" — no stage history.
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
 * Lazy-load `appendPluginRecord`. A dynamic import rather than a static one: if the
 * host package fails to resolve, the plugin still assembles, and only state falls
 * back to memory (each tool keeps a mirror) instead of `/ratchet` being unusable.
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

/** In-memory mirror: the fallback when appendPluginRecord is unavailable. Key = session. */
const mirror = new WeakMap()

/**
 * Read the current state. The projection wins (it stays accurate across
 * resume/fork); the mirror answers when the projection is absent.
 * @returns {object}
 */
export function readState(ctx, session) {
	try {
		const projections = ctx.get('sessionProjections')
		const state = projections?.stateOf?.(session, PROJECTION_KEY)
		if (state !== undefined) return normalizeState(state)
	} catch {
		// Projection service unavailable — fall through to the mirror.
	}
	return normalizeState(mirror.get(session))
}

/**
 * Write one state record.
 * @param {any} ctx - plugin context.
 * @param {any} session - target session.
 * @param {object} payload - `{ op, ... }`.
 * @returns {Promise<boolean>} whether it actually landed in the log.
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

/** Fold with the same logic, so the mirror and the projection cannot diverge. */
function ratchetProjectionStateAfter(state, payload) {
	return ratchetProjection.apply(state, { type: RECORD_TYPE, data: payload })
}
