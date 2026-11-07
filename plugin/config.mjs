// dsh-ratchet 的配置面。
//
// 两个职责：
//   ① 导出 `Config` —— schemastery schema。DSH 的设置页只认这个形状：
//      `entry.fiber.runtime.Config` 必须存在、带 `toJSON()`、且至少一个字段带 volatile。
//      volatile 字段才是"可写"的：非 volatile 的字段既不会出现在表单里，写了也会被拒。
//   ② 提供 `liveConfig()` —— 一层取值代理，让调用点永远拿到**当前**值。
//
// 为什么需要 ②：设置页的写入是热更新的，进程不重启、`apply()` 不会再跑一遍。
// 如果在装配时把 `config.maxQuestions` 抄进一个普通对象，用户改完设置会毫无反应，
// 直到他重启 —— 那这个设置页等于假的。cordis 把 volatile 字段包成带 `get()` 的
// 引用对象（cosmokit 的 `isVolatile` 判据是 `'write' in value`），所以每次读都
// 重新 `.get()` 一次，就能拿到最新值。

import z from '@deepseek-ai/schemastery'

/** 全部配置项的默认值。`apply()` 收到的 config 缺哪项就用这里的。 */
export const DEFAULTS = {
	enabled: true,
	maxQuestions: 5,
	validatorTimeoutMs: 20000,
	pythonPath: '',
	stageLimit: 5,
	policyText: '',
}

/**
 * 配置 schema。
 *
 * 六个字段全部 volatile：它们都该能在设置页里改，而且都不需要重启。
 * `enabled` 的处理特殊一点 —— 关掉它之后，已经注册的工具会拒绝执行、纪律段会消失，
 * 但装配期就带 `enabled: false` 的话仍然是什么都不注册（那种情况本来就不该占 token）。
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

/** cordis 的 volatile 字段是带 `get()` 的引用对象；普通值原样返回。 */
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
 * 一层取值代理：属性访问即读当前值。
 *
 * 这样 `index.mjs` 里的 `settings.maxQuestions` 之类一行都不用改，
 * 而语义从"装配时快照"变成"每次用都是最新的"。
 *
 * @param {object | undefined} source - `apply(ctx, config)` 收到的 config。
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
