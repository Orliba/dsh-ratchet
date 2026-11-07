// 校验器封装的测试：只验"降级永不抛"和"红线不被越过"，
// 不依赖 python 一定存在（作者的机器上有，CI 上可能没有 —— 两种都得过）。

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { SCRIPTS, VENDOR_DIR, describeFile, resolvePython, runAllChecks, renderChecks } from '../plugin/validators.mjs'

/** 造一个最小的合规项目：CONTEXT.md + docs/adr + src。 */
function makeProject() {
	const dir = mkdtempSync(join(tmpdir(), 'ratchet-proj-'))
	writeFileSync(
		join(dir, 'CONTEXT.md'),
		['# Context', '', '## Language', '', '**Sample**: 一条采样记录。', '', '_Avoid_: record, item', ''].join('\n'),
	)
	mkdirSync(join(dir, 'docs', 'adr'), { recursive: true })
	writeFileSync(join(dir, 'docs', 'adr', '0001-use-window.md'), '# 用窗口\n\n## 背景\n先这样。\n')
	mkdirSync(join(dir, 'src'), { recursive: true })
	writeFileSync(join(dir, 'src', 'data.py'), 'class Sample:\n    pass\n')
	return dir
}

test('三个 vendor 脚本都指向真实文件', () => {
	assert.match(VENDOR_DIR, /vendor$/)
	for (const [key, path] of Object.entries(SCRIPTS)) {
		assert.match(path, /\.py$/, `${key} 不是 py 文件`)
	}
})

test('resolvePython 对显式配置直接采信，不做探测', () => {
	const resolved = resolvePython('C:\\nowhere\\python.exe')
	assert.equal(resolved.command, 'C:\\nowhere\\python.exe')
	assert.deepEqual(resolved.prefix, [])
})

test('resolvePython 对不存在的工作目录也返回结果或 null，不抛', () => {
	// 只要求"不抛"：有无 python 取决于机器。
	const resolved = resolvePython('')
	assert.ok(resolved === null || typeof resolved.command === 'string')
})

test('describeFile 认得真文件', () => {
	const dir = mkdtempSync(join(tmpdir(), 'ratchet-file-'))
	const file = join(dir, 'a.txt')
	writeFileSync(file, 'one\ntwo\nthree\n')
	const info = describeFile(file)
	assert.equal(info.exists, true)
	assert.equal(info.lines, 3)
	assert.ok(info.bytes > 0)
})

test('describeFile 对缺失文件返回 exists:false，不抛', () => {
	const info = describeFile(join(tmpdir(), 'ratchet-nope-xyz.txt'))
	assert.equal(info.exists, false)
})

test('describeFile 对目录返回 exists:true 并标注不是普通文件', () => {
	const info = describeFile(tmpdir())
	assert.equal(info.exists, true)
	assert.equal(info.note, '不是普通文件')
})

test('runAllChecks 在空目录里把三项全跳过，而不是抛', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'ratchet-empty-'))
	const outcome = await runAllChecks({ cwd: dir, timeoutMs: 5000 })
	assert.equal(outcome.results.length, 3)
	for (const result of outcome.results) {
		assert.equal(result.skipped, true, `${result.name} 应该是跳过`)
		assert.equal(typeof result.reason, 'string')
	}
	assert.equal(outcome.allSkipped, true)
})

test('runAllChecks 遇到不存在的 cwd 也不抛', async () => {
	const outcome = await runAllChecks({ cwd: join(tmpdir(), 'ratchet-missing-cwd-xyz'), timeoutMs: 2000 })
	assert.equal(outcome.results.length, 3)
	assert.equal(outcome.allSkipped, true)
})

test('runAllChecks 对已 abort 的 signal 立即返回', async () => {
	const controller = new AbortController()
	controller.abort()
	const outcome = await runAllChecks({ cwd: makeProject(), timeoutMs: 5000, signal: controller.signal })
	assert.equal(outcome.results.length, 3)
})

test('renderChecks 把跳过、判定、计数都摆出来', () => {
	const text = renderChecks({
		python: 'python',
		results: [
			{ name: 'A', skipped: true, reason: '没有文件' },
			{ name: 'B', skipped: false, verdict: 'WARN', counts: { PASS: 3, WARN: 1 }, findings: ['[warn] r1: 缺东西', '[ok] r2: 好'] },
		],
	})
	assert.match(text, /### 文档校验/)
	assert.match(text, /A: 跳过 —— 没有文件/)
	assert.match(text, /B: \*\*WARN\*\* \(PASS 3 \/ WARN 1\)/)
	assert.match(text, /\[warn\] r1: 缺东西/)
})

test('renderChecks 会折叠超出的 findings', () => {
	const findings = Array.from({ length: 9 }, (_, index) => `[warn] r${index}`)
	const text = renderChecks({ python: 'python', results: [{ name: 'X', skipped: false, verdict: 'WARN', counts: {}, findings }] }, 3)
	assert.match(text, /另有 6 条/)
	assert.equal(text.split('\n').filter((line) => line.includes('[warn] r')).length, 3)
})

test('合规项目在有 python 时能跑出非跳过结果', async (t) => {
	const python = resolvePython('')
	if (python === null) {
		t.skip('这台机器没有可用的 python')
		return
	}
	const outcome = await runAllChecks({ cwd: makeProject(), timeoutMs: 15000 })
	const context = outcome.results.find((entry) => entry.name.includes('CONTEXT'))
	assert.ok(context)
	assert.equal(context.skipped, false, `CONTEXT.md 校验不该被跳过：${context.reason ?? ''}`)
	assert.equal(typeof context.verdict, 'string')
})

test('一致性校验自己能合成 verdict，不会掉成问号', async (t) => {
	const python = resolvePython('')
	if (python === null) {
		t.skip('这台机器没有可用的 python')
		return
	}
	const dir = makeProject()
	// 加一个术语表里有、代码里一个字都没有的词：必须被判成 dead glossary。
	writeFileSync(
		join(dir, 'CONTEXT.md'),
		[
			'# Context',
			'',
			'## Language',
			'',
			'**Sample**: 一条采样记录。',
			'',
			'_Avoid_: record, item',
			'',
			'**Ghost**: 术语表里有，代码里没有。',
			'',
			'_Avoid_: phantom',
			'',
		].join('\n'),
	)
	const outcome = await runAllChecks({ cwd: dir, timeoutMs: 15000 })
	const consistency = outcome.results.find((entry) => entry.name.includes('一致性'))
	assert.ok(consistency)
	assert.equal(consistency.skipped, false, `一致性校验不该被跳过：${consistency.reason ?? ''}`)
	// 这个脚本不输出 verdict，之前没合成时这里就是 "?"。
	assert.notEqual(consistency.verdict, '?')
	assert.equal(consistency.verdict, 'WARN')
	assert.ok(consistency.findings.some((line) => line.includes('Ghost')), '该报出 Ghost 是死术语')
})
