// 面板正文渲染层的形状测试。
//
// 这里守的不是"文案好不好看"，而是几条会直接伤人的硬约束：
//   ① 缺失的文件必须显眼（编路径是最容易发生、也最伤信任的错）；
//   ② 空的 decisions / artifacts 不许留下空 `- ` 行；
//   ③ 只用 MarkdownText 真支持的语法 —— 原始 HTML 会被当字符串吐出来，任务列表
//      不会变复选框，这两样一旦混进来就是"面板上出现一堆尖括号"。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	renderArtifacts,
	renderCheckBadges,
	renderCheckFindings,
	renderCheckpointDetail,
	renderDecisions,
	renderRecon,
	renderStartDetail,
	shortCheckName,
} from '../plugin/render.mjs'

const RECON = {
	cwd: 'H:\\ws\\demo',
	files: ['CONTEXT.md', 'package.json'],
	hasAdr: true,
	topLevel: 7,
	hasContext: true,
	hasManifest: true,
}

const CHECKS = {
	python: 'python',
	results: [
		{ name: 'CONTEXT.md 术语表', verdict: 'PASS', counts: { PASS: 3 } },
		{ name: 'ADR 目录', verdict: 'PASS', counts: { PASS: 2 } },
		{ name: '术语↔代码一致性', verdict: 'WARN', counts: { dead: 1 }, findings: ['dead-glossary: 「Ghost」代码里没用到'] },
	],
}

test('recon 把路径、文档、ADR 都在一段里说清', () => {
	const text = renderRecon(RECON)
	assert.match(text, /开工前读到的/)
	assert.match(text, /H:\\ws\\demo/)
	assert.match(text, /顶层 7 项/)
	assert.match(text, /CONTEXT\.md、package\.json/)
	assert.match(text, /ADR 目录：有/)
})

test('recon 在空目录时如实说"一个都没有"，不装', () => {
	const text = renderRecon({ cwd: 'C:\\x', files: [], hasAdr: false, topLevel: 0, hasContext: false, hasManifest: false })
	assert.match(text, /一个都没有/)
	assert.match(text, /ADR 目录：没有/)
	assert.doesNotMatch(text, /术语题不用问/)
})

test('brief 变成引用块，多行也逐行进引用', () => {
	const text = renderStartDetail({ brief: '第一行\n第二行', info: RECON })
	assert.match(text, /^> 第一行\n> 第二行/m)
})

test('没有 brief 时正文干净，不留空引用块', () => {
	const text = renderStartDetail({ brief: '   ', info: RECON })
	assert.doesNotMatch(text, /^> /m)
	assert.match(text, /开工前读到的/)
})

test('产出：有行数就写行数，没有才退回体积', () => {
	const text = renderArtifacts([
		{ entry: 'a.mjs', exists: true, lines: 120, bytes: 4096 },
		{ entry: 'b.mjs', exists: true, bytes: 300 },
	])
	assert.match(text, /`a\.mjs` · 120 行/)
	assert.match(text, /`b\.mjs` · 300 B/)
})

test('产出：缺失的文件必须带粗体缺失，不许静默略过', () => {
	const text = renderArtifacts([{ entry: 'src/gone.js', exists: false }])
	assert.match(text, /`src\/gone\.js` · \*\*缺失\*\*/)
})

test('产出：缺失时要写清按哪个路径找过，别让人以为它在骗人', () => {
	const text = renderArtifacts([
		{ entry: 'plugin/render.mjs', exists: false, resolved: 'H:\\work\\plugin\\render.mjs' },
	])
	assert.match(text, /\*\*缺失\*\*（按 `H:\\work\\plugin\\render\.mjs` 找过）/)
})

test('产出：在子目录里找到的时候说明是在哪一层找到的', () => {
	const text = renderArtifacts([
		{ entry: 'plugin/render.mjs', exists: true, lines: 171, note: '在 `dsh-ratchet/` 下' },
	])
	assert.match(text, /171 行 · 在 `dsh-ratchet\/` 下/)
})

test('产出为空时明确说"没有落任何文件"，而不是空标题', () => {
	assert.match(renderArtifacts([]), /这一段没有落任何文件/)
	assert.match(renderArtifacts(undefined), /这一段没有落任何文件/)
})

test('decisions 过滤空白，不留空 bullet', () => {
	const text = renderDecisions(['不引入 OCR', '   ', '', '只用 stdlib'])
	assert.match(text, /- 不引入 OCR/)
	assert.match(text, /- 只用 stdlib/)
	assert.doesNotMatch(text, /^- *$/mu)
})

test('decisions 全空时返回空串，调用方用 filter 丢掉', () => {
	assert.equal(renderDecisions([]), '')
	assert.equal(renderDecisions(['  ']), '')
})

test('校验徽章把三个名字压成一行', () => {
	const text = renderCheckBadges(CHECKS)
	assert.match(text, /术语表 ✓/)
	assert.match(text, /ADR ✓/)
	assert.match(text, /一致性 !/)
})

test('全部跳过时不摆一排破折号，而是说出为什么没跑', () => {
	const text = renderCheckBadges({
		results: [{ name: 'CONTEXT.md 术语表', skipped: true, reason: '没有 CONTEXT.md（这段还没建术语表）' }],
	})
	assert.doesNotMatch(text, /–/, '一排破折号读起来像零件坏了')
	assert.doesNotMatch(text, /\?/)
	assert.match(text, /都没跑/)
	assert.match(text, /没有 CONTEXT\.md/)
})

test('全部跳过且原因各不相同时逐条列出来，不糊成一句', () => {
	const text = renderCheckBadges({
		results: [
			{ name: 'CONTEXT.md 术语表', skipped: true, reason: '没有 CONTEXT.md' },
			{ name: 'ADR 目录', skipped: true, reason: '没有 docs/adr/' },
		],
	})
	assert.match(text, /2 个校验器都没跑/)
	assert.match(text, /^- 没有 CONTEXT\.md$/m)
	assert.match(text, /^- 没有 docs\/adr\/$/m)
})

test('全部跳过但原因相同时只写一遍，别重复三次', () => {
	const reason = '找不到可用的 python 解释器'
	const text = renderCheckBadges({
		results: ['CONTEXT.md 术语表', 'ADR 目录', '术语↔代码一致性'].map((name) => ({ name, skipped: true, reason })),
	})
	assert.equal(text.split(reason).length - 1, 1)
	assert.match(text, /3 个校验器都没跑/)
})

test('部分跳过时仍然用徽章，跳过的那个带破折号', () => {
	const text = renderCheckBadges({
		results: [
			{ name: 'CONTEXT.md 术语表', verdict: 'PASS' },
			{ name: 'ADR 目录', skipped: true, reason: '没有 docs/adr/' },
		],
	})
	assert.match(text, /术语表 ✓/)
	assert.match(text, /ADR –/)
})

test('校验徽章在没有任何校验器时给一句实话', () => {
	assert.match(renderCheckBadges({ results: [] }), /没有可跑的校验器/)
})

test('findings 只列有问题的，通过的校验不占阅读预算', () => {
	const text = renderCheckFindings(CHECKS)
	assert.match(text, /Ghost/)
	assert.doesNotMatch(text, /术语表/)
})

test('findings 超出上限时折叠成"另有 N 条"', () => {
	const text = renderCheckFindings(
		{ results: [{ name: 'X', verdict: 'WARN', findings: ['a', 'b', 'c', 'd', 'e'] }] },
		2,
	)
	assert.equal(text.split('\n').filter((line) => line.startsWith('- ')).length, 3)
	assert.match(text, /另有 3 条/)
})

test('findings 在全是 PASS 时返回空串', () => {
	assert.equal(renderCheckFindings(CHECKS.results ? { results: [CHECKS.results[0]] } : { results: [] }), '')
})

test('checkpoint 正文三段齐全：结论、产出与取舍、校验', () => {
	const text = renderCheckpointDetail({
		stageIndex: 2,
		stage: '接入校验器',
		summary: '把三个 linter 接进来，面板上能看见结论。',
		artifacts: [{ entry: 'plugin/validators.mjs', exists: true, lines: 337 }],
		decisions: ['校验失败不阻断，只上色'],
		checks: CHECKS,
		next: '补回归测试',
	})
	assert.match(text, /第 2 段 · 接入校验器/)
	assert.match(text, /把三个 linter 接进来/)
	assert.match(text, /`plugin\/validators\.mjs` · 337 行/)
	assert.match(text, /#### 定下的/)
	assert.match(text, /术语表 ✓/)
	assert.match(text, /\*\*下段\*\*　补回归测试/)
	// 段间用 hr 切开，长正文才有可视分层。
	assert.ok(text.split('\n\n---\n\n').length >= 3)
})

test('checkpoint 的段标题用引用块，和正文区分开', () => {
	const text = renderCheckpointDetail({
		stageIndex: 1,
		stage: '起步',
		summary: 'x',
		artifacts: [],
		decisions: [],
		checks: CHECKS,
	})
	assert.match(text, /^> \*\*第 1 段 · 起步\*\*/m)
})

test('不是 ratchet_start 开的流程时要提示段号从 1 起算', () => {
	const text = renderCheckpointDetail({
		stageIndex: 1,
		stage: 's',
		summary: '',
		artifacts: [],
		decisions: [],
		checks: CHECKS,
		strayed: true,
	})
	assert.match(text, /这不是通过 ratchet_start 开的流程/)
})

test('上一段和本段同名时不啰嗦地重复', () => {
	const same = renderCheckpointDetail({
		stageIndex: 1,
		stage: 's',
		summary: '',
		artifacts: [],
		decisions: [],
		checks: CHECKS,
		previousStage: 's',
	})
	assert.doesNotMatch(same, /上一段是/)
	const diff = renderCheckpointDetail({
		stageIndex: 2,
		stage: 'b',
		summary: '',
		artifacts: [],
		decisions: [],
		checks: CHECKS,
		previousStage: 'a',
	})
	assert.match(diff, /上一段是「a」/)
})

test('checkpoint 正文不含原始 HTML 与任务列表 —— MarkdownText 不认', () => {
	const text = renderCheckpointDetail({
		stageIndex: 1,
		stage: 's',
		summary: 'x',
		artifacts: [{ entry: 'a', exists: true, lines: 1 }],
		decisions: ['d'],
		checks: CHECKS,
		next: 'n',
	})
	assert.doesNotMatch(text, /<[a-z][a-z0-9]*[\s>/]/i)
	assert.doesNotMatch(text, /^\s*- \[[ x]\]/m)
})

test('短名映射是纯展示，未知名字原样返回', () => {
	assert.equal(shortCheckName('CONTEXT.md 术语表'), '术语表')
	assert.equal(shortCheckName('不认识的名字'), '不认识的名字')
})

test('分区标签用四级标题，不是粗体段落 —— 粗体在 13px 正文里分不出层级', () => {
	const text = renderCheckpointDetail({
		stageIndex: 1,
		stage: 's',
		summary: 'x',
		artifacts: [{ entry: 'a', exists: true, lines: 1 }],
		decisions: ['d'],
		checks: CHECKS,
	})
	for (const label of ['产出', '定下的', '文档校验']) {
		assert.match(text, new RegExp(`^#### ${label}$`, 'm'), `「${label}」应该是四级标题`)
		assert.doesNotMatch(text, new RegExp(`^\\*\\*${label}\\*\\*`, 'm'), `「${label}」不该退回粗体段落`)
	}
})

test('校验徽章没有校验器时也给四级标题，形状和别处一致', () => {
	const text = renderCheckBadges({ results: [] })
	assert.match(text, /^#### 文档校验$/m)
	assert.match(text, /没有可跑的校验器/)
})
