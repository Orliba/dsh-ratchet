// The configuration surface of dsh-ratchet.
//
// Two jobs:
//   1. Export `Config` — the schemastery schema. This is the only shape the DSH
//      settings page recognises: `entry.fiber.runtime.Config` has to exist, carry
//      `toJSON()`, and have at least one volatile field. Only volatile fields are
//      writable; a non-volatile field neither appears in the form nor accepts a
//      write.
//   2. Provide `liveConfig()` — a value proxy so every call site reads the
//      *current* value.
//
// Why (2) is needed: settings writes are hot. The process does not restart and
// `apply()` does not run again. Copying `config.maxQuestions` into a plain object
// at assembly time would make the settings page a lie — the user edits a value and
// nothing happens until a restart. cordis wraps volatile fields in a reference
// object with `get()` (cosmokit's `isVolatile` test is `'write' in value`), so
// calling `.get()` on every read returns the latest value.

import z from '@deepseek-ai/schemastery'

/** Defaults for every option. Anything missing from `apply()`s config uses these. */
export const DEFAULTS = {
	enabled: true,
	maxQuestions: 5,
	validatorTimeoutMs: 20000,
	pythonPath: '',
	stageLimit: 5,
	policyText: '',
}

/**
 * The config schema.
 *
 * All six fields are volatile: each is meant to be editable from the settings page,
 * and none of them requires a restart. `enabled` is slightly special — turning it
 * off at runtime makes the registered tools refuse and the discipline section
 * disappear, but arriving with `enabled: false` at assembly time still registers
 * nothing at all (that case should not occupy any prompt tokens to begin with).
 */
export const Config = z.object({
	enabled: z.boolean().default(DEFAULTS.enabled).description('启用 ratchet 流程（关掉后 /ratchet 与两个工具都不工作）').volatile(),
	maxQuestions: z
		.number()
		.step(1)
		.min(1)
		.max(5)
		.default(DEFAULTS.maxQuestions)
		.description('对齐面板一轮最多几题（1-5）')
		.volatile(),
	validatorTimeoutMs: z
		.number()
		.step(1)
		.min(1000)
		.default(DEFAULTS.validatorTimeoutMs)
		.description('单个文档校验脚本的超时毫秒数（最小 1000）')
		.volatile(),
	pythonPath: z
		.string()
		.default(DEFAULTS.pythonPath)
		.description('python 解释器路径，留空则自动探测（python / python3 / py -3 / 内置）')
		.volatile(),
	stageLimit: z
		.number()
		.step(1)
		.min(1)
		.max(12)
		.default(DEFAULTS.stageLimit)
		.description('一次流程建议的最大段数（写进提示词，1-12）')
		.volatile(),
	policyText: z
		.string()
		.default(DEFAULTS.policyText)
		.description('覆盖默认的纪律文案，留空则用内置版本')
		.volatile(),
})

/** cordis volatile fields are reference objects with `get()`; plain values pass through. */
function unwrap(value) {
	if (value === null || typeof value !== 'object') return value
	if (typeof value.get !== 'function') return value
	try {
		return value.get()
	} catch {
		return undefined
	}
}

/**
 * A read-through proxy: property access returns the current value.
 *
 * This way every `settings.maxQuestions` in `index.mjs` stays untouched while its
 * meaning shifts from "a snapshot taken at assembly time" to "whatever is set
 * right now".
 *
 * @param {object | undefined} source - the config `apply(ctx, config)` received.
 */
export function liveConfig(source) {
	const raw = source !== null && typeof source === 'object' ? source : {}
	const proxy = {}
	for (const key of Object.keys(DEFAULTS)) {
		Object.defineProperty(proxy, key, {
			enumerable: true,
			get() {
				const value = unwrap(raw[key])
				return value === undefined ? DEFAULTS[key] : value
			},
		})
	}
	return proxy
}
