// 测试专用解析钩子：让 `@deepseek-ai/*` 在裸 node 里也能解析到宿主安装目录。
//
// 为什么需要：真宿主会在启动时装 ResolutionRouter，改写插件里对 `@deepseek-ai/*`
// 的解析（profile 的 node_modules 里根本没有这个 scope 的一部分包）。裸 node 没有
// 这一层，所以 `state.mjs` 的懒加载 import 会失败、退回内存镜像 —— 那个降级路径
// 本身是对的，但这样就测不到"真的写进 log"那条主路径了。
//
// 这个钩子只做一件事：把 specifier 指到宿主包里，其余原样交给 node。
// 生产代码一行都不用为此改动。
//
// 解析顺序（与 node 自己的 exports 语义对齐，够用即可）：
//   ① 照包里的 `exports` 找 `import` / `default` 分支；
//   ② 退回 `module` 字段；
//   ③ 退回 `lib/index.mjs`；
//   ④ 退回 `lib/index.js`（老包只有这个）。
// 少了 ② ③ 的话，像 `@deepseek-ai/schemastery`（只有 `lib/index.mjs`）会被漏掉。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.env.DSH_INSTALL_ROOT ?? 'H:\\Deepseekstudio'
const HOST_MODULES = join(ROOT, 'resources', 'app', 'dsh', 'node_modules')
const PROFILE_MODULES = join(ROOT + '-data', 'profiles', 'desktop', 'node_modules')

/** 在宿主目录与 profile 目录里找包，先宿主后 profile。 */
function packageDir(specifier) {
	for (const base of [HOST_MODULES, PROFILE_MODULES]) {
		const dir = join(base, specifier)
		if (existsSync(dir)) return dir
	}
	return undefined
}

/** 从 package.json 里挑出入口文件的相对路径。 */
function entryOf(dir, specifier) {
	let manifest = {}
	try {
		manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
	} catch {
		manifest = {}
	}
	const exports = manifest.exports
	// 子路径导出（`@pkg/x/sub`）不处理，本仓库用不到。
	const wantsRoot = specifier === manifest.name || !specifier.startsWith(manifest.name + '/')
	if (wantsRoot && exports !== undefined) {
		const root = typeof exports === 'string' ? exports : (exports['.'] ?? exports)
		if (typeof root === 'string') return root
		if (root !== null && typeof root === 'object') {
			for (const key of ['import', 'module', 'default']) {
				const value = root[key]
				if (typeof value === 'string') return value
			}
		}
	}
	if (typeof manifest.module === 'string') return manifest.module
	if (typeof manifest.main === 'string') return manifest.main
	for (const guess of ['lib/index.mjs', 'lib/index.js', 'index.mjs', 'index.js']) {
		if (existsSync(join(dir, guess))) return guess
	}
	return undefined
}

export async function resolve(specifier, context, nextResolve) {
	if (specifier.startsWith('@deepseek-ai/')) {
		const dir = packageDir(specifier)
		if (dir !== undefined) {
			const entry = entryOf(dir, specifier)
			if (entry !== undefined) {
				const file = join(dir, entry)
				if (existsSync(file)) {
					const format = file.endsWith('.mjs') || file.endsWith('.js') ? 'module' : undefined
					return { url: pathToFileURL(file).href, shortCircuit: true, format }
				}
			}
		}
	}
	return nextResolve(specifier, context)
}
