// The browser half of dsh-ratchet.
//
// Three things, all of them strictly about what is *visible*:
//   (1) tool.call.toolview — takes over the ratchet_start / ratchet_checkpoint tool
//       rows and turns them from "unknown tool · a blob of raw argument JSON" into a
//       small card with a stage number, artifacts and verdict marks. The data comes
//       from output.presentationMeta, projected to block.meta.ratchet.
//   (2) The question panel body (.wnLwla_detail) — the host gives it nothing but
//       margin:0 2px 8px, so long markdown sits directly on a dark grey card as one
//       lump. This adds padding, a background and a radius, and collapses markdown's
//       32px heading margins so it reads like a conclusion rather than an article.
//   (3) The settings page — mounted in the config area of the "dsh-ratchet details"
//       page (keyed slot plugins.bundle.config, key = package name), exposing
//       enabled / maxQuestions / validatorTimeoutMs / pythonPath / stageLimit /
//       policyText for editing through the host's configForms form; writes are hot
//       (host side liveConfig re-reads the latest value every time).
//
// No ESM import here: the host loads this file as a same-origin classic script and
// only recognises window.__ModuleLoader__.load({ id, factory }).

window.__ModuleLoader__.load({
	id: 'dsh-ratchet',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const h = React.createElement

		// ── styles ──────────────────────────────────────────────────────────────
		// Colours always come from theme tokens, never hard-coded. Light/dark switching
		// is the host's job.
		const CSS = `
.drt-card {
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 10px 12px 11px;
	border: 1px solid var(--dsw-alias-border-l1);
	border-radius: var(--dsw-radius-lg);
	background: var(--dsw-alias-bg-layer-1);
	transition: border-color .12s ease, background-color .12s ease;
}
.drt-card:hover { border-color: var(--dsw-alias-border-l3); }

.drt-head {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
}
.drt-dot {
	flex: none;
	width: 6px;
	height: 6px;
	border-radius: 999px;
	background: var(--dsw-alias-state-business-primary);
}
.drt-dot[data-tone='warn'] { background: var(--dsw-alias-state-warn-primary); }
.drt-dot[data-tone='error'] { background: var(--dsw-alias-state-error-primary); }
.drt-dot[data-tone='muted'] { background: var(--dsw-alias-label-dimmed); }

.drt-title {
	flex: 1 1 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 13px;
	line-height: 20px;
	font-weight: 500;
	color: var(--dsw-alias-label-primary);
}
.drt-eyebrow {
	flex: none;
	font-size: 11px;
	line-height: 16px;
	color: var(--dsw-alias-label-tertiary);
	font-variant-numeric: tabular-nums;
}

.drt-tag {
	flex: none;
	display: inline-flex;
	align-items: center;
	height: 18px;
	padding: 0 7px;
	border-radius: var(--dsw-radius-sm);
	font-size: 11px;
	line-height: 18px;
	font-weight: 500;
	background: var(--dsw-alias-state-business-tertiary);
	color: var(--dsw-alias-state-business-primary);
}
.drt-tag[data-tone='warn'] {
	background: var(--dsw-alias-state-warn-tertiary);
	color: var(--dsw-alias-state-warn-label);
}
.drt-tag[data-tone='error'] {
	background: var(--dsw-alias-state-error-tertiary);
	color: var(--dsw-alias-state-error-primary);
}
.drt-tag[data-tone='muted'] {
	background: var(--dsw-alias-bg-overlay);
	color: var(--dsw-alias-label-tertiary);
}

.drt-checks {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px 12px;
	font-size: 11px;
	line-height: 16px;
	color: var(--dsw-alias-label-secondary);
}
.drt-check { display: inline-flex; align-items: baseline; gap: 4px; }
.drt-check svg { flex: none; align-self: center; }
.drt-check[data-verdict='PASS'] { color: var(--dsw-alias-state-success-primary); }
.drt-check[data-verdict='WARN'] { color: var(--dsw-alias-state-warn-label); }
.drt-check[data-verdict='FAIL'] { color: var(--dsw-alias-state-error-primary); }
.drt-check[data-verdict='SKIP'] { color: var(--dsw-alias-label-dimmed); }
/* All-skipped collapses to one honest sentence, longer than a row of dashes, so let it wrap. */
.drt-checks[data-all-skipped='yes'] .drt-check { line-height: 17px; white-space: normal; }

.drt-files {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
	font-family: var(--ds-font-family-code);
	font-size: 11px;
	line-height: 16px;
}
.drt-file {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	max-width: 100%;
	padding: 1px 7px 1px 6px;
	border-radius: var(--dsw-radius-sm);
	background: var(--dsw-alias-markdown-inline-code);
	border: .5px solid var(--dsw-alias-border-l1);
	color: var(--dsw-alias-label-secondary);
}
.drt-file[data-missing='yes'] {
	border-color: var(--dsw-alias-state-error-primary);
	color: var(--dsw-alias-state-error-primary);
}
.drt-file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drt-file-size { color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }

.drt-more {
	align-self: flex-start;
	background: none;
	border: none;
	padding: 0;
	cursor: pointer;
	font-size: 11px;
	line-height: 16px;
	color: var(--dsw-alias-label-tertiary);
}
.drt-more:hover { color: var(--dsw-alias-label-primary); text-decoration: underline dotted; }

.drt-next {
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-secondary);
	padding-left: 12px;
	border-left: 2px solid var(--dsw-alias-border-l2);
}

/* ── Question panel body: the host gives only margin:0 2px 8px, so long markdown smears ── */
/* Three layers: card #2c2c2e → body block #353638 (one step lighter) + a 3px accent bar.
   The border uses l3 (#ffffff29) rather than l1 (#ffffff0f) — l1 is nearly invisible on a
   dark ground, and brightness alone still reads as "one single block". */
[data-question-key] [data-question-scroll] > div:first-child:not([role]) {
	margin: 12px 14px 4px;
	padding: 12px 14px 12px 15px;
	border-radius: var(--dsw-radius-lg);
	background: var(--dsw-alias-bg-module-platform);
	border: 1px solid var(--dsw-alias-border-l3);
	border-left: 3px solid var(--dsw-alias-state-business-primary);
}
[data-question-key] [data-question-scroll] > div:first-child:not([role]) > :first-child { margin-top: 0; }
[data-question-key] [data-question-scroll] > div:first-child:not([role]) > :last-child { margin-bottom: 0; }
[data-question-key] [data-question-scroll] > div:first-child:not([role]) :is(h1, h2, h3, h4) {
	margin: 14px 0 6px;
	font-size: 13px;
	line-height: 20px;
	font-weight: 600;
	color: var(--dsw-alias-label-primary);
}
/* h4 doubles as a section label: small, letter-spaced, tertiary grey.
   At body size the only difference would be weight, which is invisible on dark. */
[data-question-key] [data-question-scroll] > div:first-child:not([role]) h4 {
	margin: 14px 0 5px;
	font-size: 11px;
	line-height: 16px;
	font-weight: 600;
	letter-spacing: .06em;
	color: var(--dsw-alias-label-tertiary);
}
[data-question-key] [data-question-scroll] > div:first-child:not([role]) :is(h1, h2, h3, h4):first-child { margin-top: 0; }
[data-question-key] [data-question-scroll] > div:first-child:not([role]) p,
[data-question-key] [data-question-scroll] > div:first-child:not([role]) :is(ul, ol) {
	margin: 8px 0;
	font-size: 13px;
	line-height: 20px;
}
[data-question-key] [data-question-scroll] > div:first-child:not([role]) :is(ul, ol) { padding-left: 18px; }
[data-question-key] [data-question-scroll] > div:first-child:not([role]) li:not(:first-child) { margin-top: 3px; }
/* With h4 doing the sectioning, hr no longer carries the structure — dim it so the two
   separators do not fight. */
[data-question-key] [data-question-scroll] > div:first-child:not([role]) hr {
	margin: 10px 0;
	height: .5px;
	background: var(--dsw-alias-border-l1);
}
[data-question-key] [data-question-scroll] > div:first-child:not([role]) blockquote {
	margin: 10px 0 0;
	padding-left: 10px;
	border-left: 2px solid var(--dsw-alias-state-business-primary);
	color: var(--dsw-alias-label-secondary);
}
[data-question-key] [data-question-scroll] > div:first-child:not([role]) blockquote > :is(p, ul, ol) {
	margin: 4px 0;
	font-size: 12px;
	line-height: 18px;
}

/* ── Settings page: the config area inside the plugin details ── */
.drt-settings {
	display: flex;
	flex-direction: column;
	gap: 10px;
}
.drt-settings-intro {
	margin: 0;
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-tertiary);
}
.drt-toggle {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 8px 0;
	border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.drt-toggle-label {
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
}
.drt-toggle-title {
	font-size: 13px;
	line-height: 20px;
	font-weight: 500;
	color: var(--dsw-alias-label-primary);
}
.drt-toggle-hint {
	font-size: 11px;
	line-height: 16px;
	color: var(--dsw-alias-label-tertiary);
}
.drt-multiline {
	display: flex;
	flex-direction: column;
	gap: 4px;
}
.drt-multiline > label {
	font-size: 13px;
	line-height: 20px;
	font-weight: 500;
	color: var(--dsw-alias-label-primary);
}
.drt-multiline > textarea {
	width: 100%;
	box-sizing: border-box;
	min-height: 96px;
	padding: 8px 10px;
	resize: vertical;
	border: 1px solid var(--dsw-alias-border-l2);
	border-radius: var(--dsw-radius-md);
	background: var(--dsw-alias-bg-layer-2);
	color: var(--dsw-alias-label-primary);
	font-family: var(--ds-font-family-code);
	font-size: 12px;
	line-height: 18px;
}
.drt-multiline > textarea:focus-visible {
	outline: 2px solid var(--dsw-focus-ring-color);
	outline-offset: 1px;
}
.drt-multiline > p {
	margin: 0;
	font-size: 11px;
	line-height: 16px;
	color: var(--dsw-alias-label-tertiary);
}
.drt-settings-status {
	margin: 0;
	font-size: 11px;
	line-height: 16px;
	color: var(--dsw-alias-state-warn-label);
}
`

		// ── tiny icons (inline SVG; no icon package, so a rename upstream cannot blank us) ──
		function glyph(verdict) {
			const size = 12
			const common = {
				width: size,
				height: size,
				viewBox: '0 0 12 12',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1.6,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
			}
			if (verdict === 'PASS') {
				return h('svg', common, h('path', { d: 'M2.4 6.3 4.8 8.7 9.6 3.9' }))
			}
			if (verdict === 'WARN') {
				return h('svg', common, h('path', { d: 'M6 2.6v4.1' }), h('path', { d: 'M6 9.3h.01' }))
			}
			if (verdict === 'FAIL') {
				return h('svg', common, h('path', { d: 'M3.3 3.3 8.7 8.7' }), h('path', { d: 'M8.7 3.3 3.3 8.7' }))
			}
			return h('svg', common, h('path', { d: 'M2.6 6h6.8' }))
		}

		const CHECK_SHORT = {
			'CONTEXT.md 术语表': '术语表',
			'ADR 目录': 'ADR',
			'术语↔代码一致性': '一致性',
		}

		const ACTION_TAG = {
			aligned: { text: '已对齐', tone: '' },
			continue: { text: '继续', tone: '' },
			redirect: { text: '换方向', tone: 'warn' },
			stop: { text: '停在这里', tone: 'muted' },
			cancelled: { text: '取消', tone: 'muted' },
			inline: { text: '未弹面板', tone: 'warn' },
		}

		function toneOf(checks) {
			if (!Array.isArray(checks) || checks.length === 0) return ''
			if (checks.some((each) => each.verdict === 'FAIL')) return 'error'
			if (checks.some((each) => each.verdict === 'WARN')) return 'warn'
			if (checks.every((each) => each.verdict === 'SKIP')) return 'muted'
			return ''
		}

		/** Keep only the last two path segments; a long path blows this row apart. */
		function tailPath(path) {
			const parts = String(path).split(/[\\/]+/).filter((part) => part !== '')
			if (parts.length <= 2) return parts.join('/')
			return `…/${parts.slice(-2).join('/')}`
		}

		function sizeOf(file) {
			if (typeof file.lines === 'number') return `${file.lines} 行`
			if (typeof file.bytes === 'number') {
				return file.bytes < 1024 ? `${file.bytes} B` : `${(file.bytes / 1024).toFixed(1)} KB`
			}
			return ''
		}

		function useLocalDisclosure() {
			const [expanded, setExpanded] = React.useState(false)
			return { expanded, toggle: () => setExpanded((value) => !value) }
		}

		/**
		 * The tool row for ratchet_start / ratchet_checkpoint.
		 * The owner object the host passes in may lack useDisclosure, so keep a fallback.
		 */
		function RatchetCard(props) {
			const block = props.block ?? {}
			const meta = block.meta !== null && typeof block.meta === 'object' ? block.meta.ratchet : undefined
			const disclose = typeof props.useDisclosure === 'function' ? props.useDisclosure : useLocalDisclosure
			const { expanded, toggle } = disclose()

			const kind = meta !== null && typeof meta === 'object' ? meta.kind : undefined
			const isCheckpoint = kind === 'checkpoint'
			const action = meta !== null && typeof meta === 'object' ? meta.action : undefined
			const tag = ACTION_TAG[action]
			const checks = meta !== null && typeof meta === 'object' && Array.isArray(meta.checks) ? meta.checks : []
			const files = meta !== null && typeof meta === 'object' && Array.isArray(meta.artifacts) ? meta.artifacts : []
			const tone = toneOf(checks)

			// No meta (old session, degradation path): fall back to a minimal one-liner.
			if (meta === null || typeof meta !== 'object') {
				const raw = props.toolName ?? 'ratchet'
				return h(
					'div',
					{ className: 'drt-card' },
					h(
						'div',
						{ className: 'drt-head' },
						h('span', { className: 'drt-dot', 'data-tone': 'muted' }),
						h('span', { className: 'drt-title' }, raw),
						h('span', { className: 'drt-eyebrow' }, block.state === 'ok' ? '已完成' : '进行中'),
					),
				)
			}

			// An empty string needs its own fallback: `??` only catches undefined/null, and
			// '/ratchet' with no topic sets topic to '', which would render a title-less card.
			const topicLabel = typeof meta.topic === 'string' && meta.topic.trim() !== '' ? meta.topic : '对齐方向'
			const title = isCheckpoint ? `第 ${meta.stageIndex ?? 1} 段 · ${meta.stage ?? ''}` : topicLabel
			const more = files.length > 2 || (isCheckpoint && typeof meta.next === 'string' && meta.next !== '')

			// When everything skipped, do not lay out a row of dashes — three `–` marks read
			// like broken parts, while the truth is that this directory has no CONTEXT.md or
			// docs/adr yet. Compress it into one plain sentence and name the reason.
			const allSkipped = checks.length > 0 && checks.every((each) => each.verdict === 'SKIP')
			const skipReasons = [...new Set(checks.map((each) => (typeof each.reason === 'string' && each.reason !== '' ? each.reason : '不适用')))]

			return h(
				'div',
				{ className: 'drt-card' },
				h(
					'div',
					{ className: 'drt-head' },
					h('span', { className: 'drt-dot', 'data-tone': tone }),
					h('span', { className: 'drt-eyebrow' }, isCheckpoint ? 'ratchet 验收' : 'ratchet 对齐'),
					h('span', { className: 'drt-title' }, title),
					tag === undefined ? null : h('span', { className: 'drt-tag', 'data-tone': tag.tone }, tag.text),
				),

				checks.length === 0
					? null
					: allSkipped
						? h(
								'div',
								{ className: 'drt-checks', 'data-all-skipped': 'yes' },
								h(
									'span',
									{ className: 'drt-check', 'data-verdict': 'SKIP', title: skipReasons.join('\n') },
									glyph('SKIP'),
									skipReasons.length === 1
										? `没跑校验 —— ${skipReasons[0]}`
										: `${checks.length} 个校验器都没跑 —— 这个目录还没有它们要查的东西`,
								),
							)
						: h(
								'div',
								{ className: 'drt-checks' },
								...checks.map((each) =>
									h(
										'span',
										{
											className: 'drt-check',
											'data-verdict': each.verdict,
											key: each.name,
											title: typeof each.reason === 'string' && each.reason !== '' ? each.reason : undefined,
										},
										glyph(each.verdict),
										CHECK_SHORT[each.name] ?? each.name,
									),
								),
							),

				files.length === 0
					? null
					: h(
							'div',
							{ className: 'drt-files' },
							...files.slice(0, expanded ? files.length : 2).map((file) =>
								h(
									'span',
									{
										className: 'drt-file',
										'data-missing': file.exists === true ? 'no' : 'yes',
										key: file.entry,
										title:
											file.exists === true
												? typeof file.note === 'string' && file.note !== ''
													? `${file.resolved ?? file.entry}（${file.note}）`
													: (file.resolved ?? file.entry)
												: `${file.entry} 没找到 —— 按 ${file.resolved ?? file.entry} 找过`,
									},
									h('span', { className: 'drt-file-name' }, tailPath(file.entry)),
									file.exists === true
										? h('span', { className: 'drt-file-size' }, sizeOf(file))
										: h('span', { className: 'drt-file-size' }, '缺失'),
								),
							),
						),

				expanded && isCheckpoint && typeof meta.next === 'string' && meta.next !== ''
					? h('div', { className: 'drt-next' }, `下段　${meta.next}`)
					: null,

				more
					? h(
							'button',
							{ className: 'drt-more', type: 'button', onClick: toggle },
							expanded ? '收起' : `展开${files.length > 2 ? ` · 共 ${files.length} 个文件` : ''}`,
						)
					: null,
			)
		}

		// ── Settings page ───────────────────────────────────────────────────────
		// The six values fall into two classes:
		//   (1) the five scalars go through the host's SettingsFormModel — it already keeps
		//       the ledger of "what changed, can it be saved, keep it on failure", so there
		//       is no reason to invent another.
		//   (2) `enabled` is a switch, and the host has no boolean field primitive; the
		//       official pattern (settings-subagent) is to accumulate a draft yourself and
		//       mutate it together with the form's ops on save.
		const SETTINGS = {
			ns: 'ratchet',
			zoomKey: 'ratchetSettings',
		}

		const COPY = {
			intro: '这些值写进当前 profile 的 cordis.patch.yml 之上，保存即生效，不用重启。',
			enabled: '启用 ratchet 流程',
			enabledHint: '关掉之后 /ratchet、ratchet_start、ratchet_checkpoint 都直接拒绝，提示词段也不再出现。',
			maxQuestions: '一轮最多几题',
			maxQuestionsHint: '1–5。摊开的题超过这个数会按优先级裁掉。',
			validatorTimeoutMs: '单个校验脚本超时（毫秒）',
			validatorTimeoutMsHint: '三个 stdlib 校验器各自的上限，低于 1000 会被配置校验挡回。',
			pythonPath: 'Python 解释器',
			pythonPathHint: '留空自动探测（RATCHET_PYTHON、python、py -3、DSH 自带 Python 依次尝试）。',
			stageLimit: '一次流程的段数上限',
			stageLimitHint: '写进提示词，只影响建议节奏，不会硬砍你的分段。',
			policyText: '覆盖默认纪律文案',
			policyTextHint: '留空用内置那六条。填了就整段替换提示词里的 ratchet 纪律。',
			overridden: '已覆盖',
			reset: '恢复默认',
			invalidNumber: '填数字；留空表示用默认值。',
			unavailable: '这个部署读不到 ratchet 的设置，暂时改不了。',
			readOnly: '当前部署的设置为只读。',
			saveFailed: '没接受这次修改，值留着给你改。',
			save: '保存',
			saving: '保存中…',
			toggleFailed: '开关没写进去，请再试一次。',
		}

		/** Labels for the form shell (the host SettingsForm labels contract). */
		const FORM_LABELS = {
			unavailable: COPY.unavailable,
			readOnly: COPY.readOnly,
			saveFailed: COPY.saveFailed,
			save: COPY.save,
			saving: COPY.saving,
		}

		/**
		 * Stitch the host form and the self-managed switch into one card.
		 * SettingsFormModel only understands scalar fields, so `enabled` is kept apart.
		 */
		function createSettingsFace(scope, primitives) {
			const { SettingsFormModel, settingsNumberField, settingsTextField } = primitives

			const form = new SettingsFormModel(scope, [
				settingsNumberField('maxQuestions'),
				settingsNumberField('validatorTimeoutMs'),
				settingsNumberField('stageLimit'),
				settingsTextField('pythonPath'),
				settingsTextField('policyText'),
			])

			let draftEnabled
			let draftRevision
			let toggleFailed = false
			let disposed = false

			const store = form.bind(() => projection())
			const unsubscribe = scope.subscribe(() => {
				if (disposed) return
				// Someone else (or another window) changed the settings: follow along if no
				// draft is held; if one is, check whether it already landed.
				if (draftEnabled !== undefined && scope.getSnapshot().revision !== draftRevision) {
					const landed = scope.getSnapshot().value?.enabled
					if (landed === draftEnabled) {
						draftEnabled = undefined
						draftRevision = undefined
					}
				}
				publish()
			})

			function snapshotValue() {
				return scope.getSnapshot()
			}

			function currentEnabled() {
				return snapshotValue().value?.enabled ?? true
			}

			function projection() {
				const shell = form.shell()
				const enabledDirty = draftEnabled !== undefined && draftEnabled !== currentEnabled()
				return {
					...shell,
					// The switch counts as a change too, or "Save" stays grey when only it moved.
					dirty: shell.dirty || enabledDirty,
					enabled: draftEnabled ?? currentEnabled(),
					draftEnabled: draftEnabled !== undefined,
					toggleFailed,
					maxQuestions: form.field('maxQuestions'),
					validatorTimeoutMs: form.field('validatorTimeoutMs'),
					stageLimit: form.field('stageLimit'),
					pythonPath: form.field('pythonPath'),
					policyText: form.field('policyText'),
				}
			}

			function publish() {
				store.set(projection())
			}

			function beginDraft() {
				if (draftEnabled === undefined) {
					draftEnabled = currentEnabled()
					draftRevision = snapshotValue().revision
				}
			}

			function toggleEnabled() {
				const snapshot = snapshotValue()
				if (disposed || snapshot.status !== 'ready' || !snapshot.writable) return
				beginDraft()
				draftEnabled = !draftEnabled
				toggleFailed = false
				publish()
			}

			async function save() {
				const snapshot = snapshotValue()
				if (disposed || snapshot.status !== 'ready' || !snapshot.writable) return

				const enabledChanged = draftEnabled !== undefined && draftEnabled !== currentEnabled()
				// Save the host form's own fields first — its revision baseline, conflict
				// detection and keep-on-failure behaviour are all already tested.
				const formPending = typeof form.plan === 'function' && form.plan().length > 0
				await form.actions().save()
				if (disposed) return
				if (form.shell().failed) {
					// The form did not save, so the switch must not be written either. But leave
					// the switch where the user just put it (that is their intent) and say
					// plainly that it did not land, or the UI looks like it is already off.
					toggleFailed = true
					publish()
					return
				}
				if (!enabledChanged) {
					toggleFailed = false
					publish()
					return
				}

				const desired = draftEnabled
				// The form just wrote once, so the revision has advanced; writing with the
				// stale value captured when the switch was flipped would hit a conflict.
				const revision = formPending || draftRevision === undefined ? snapshotValue().revision : draftRevision
				const accepted = await scope.mutate([{ op: 'set', path: ['enabled'], value: desired }], revision)
				if (disposed) return
				const landed = (snapshotValue().value?.enabled ?? true) === desired
				if (accepted && landed) {
					draftEnabled = undefined
					draftRevision = undefined
					toggleFailed = false
				} else {
					toggleFailed = !landed
				}
				publish()
			}

			function discard() {
				draftEnabled = undefined
				draftRevision = undefined
				toggleFailed = false
				form.actions().discard()
				publish()
			}

			return {
				inject() {
					return {
						hooks: { [SETTINGS.zoomKey]: store },
						edit: form.actions().edit,
						resetField: form.actions().resetField,
						toggleEnabled,
						save,
						discard,
					}
				},
				dispose() {
					disposed = true
					unsubscribe()
					form.dispose()
				},
			}
		}

		/** The settings card: summary for the list, page for the details view. */
		function RatchetSettingsCard(props) {
			if (props.view === 'summary') return '开工前对齐方向、分段交付、每段停下来确认。'
			const primitives = props.primitives
			const state = props.useRatchetSettings === undefined ? undefined : props.useRatchetSettings((snapshot) => snapshot)
			if (state === undefined) return null
			if (!state.available) return h('p', { className: 'drt-settings-intro' }, COPY.unavailable)

			const { SettingsForm, SettingsValueField, Switch } = primitives
			const disabled = !state.writable || state.saving

			return h(
				'div',
				{ className: 'drt-settings' },
				h('p', { className: 'drt-settings-intro' }, COPY.intro),

				h(
					'div',
					{ className: 'drt-toggle' },
					h(
						'div',
						{ className: 'drt-toggle-label' },
						h('span', { className: 'drt-toggle-title' }, COPY.enabled),
						h('span', { className: 'drt-toggle-hint' }, COPY.enabledHint),
					),
					h(Switch, {
						checked: state.enabled,
						label: COPY.enabled,
						disabled,
						onChange: props.toggleEnabled,
					}),
				),

				state.toggleFailed ? h('p', { className: 'drt-settings-status', role: 'status' }, COPY.toggleFailed) : null,

				h(
					SettingsForm,
					{ labels: FORM_LABELS, state, onSave: props.save, onDiscard: props.discard },
					field(SettingsValueField, {
						id: 'drt-max-questions',
						label: COPY.maxQuestions,
						hint: COPY.maxQuestionsHint,
						numeric: true,
						disabled,
						state,
						name: 'maxQuestions',
						onEdit: props.edit,
						onReset: props.resetField,
					}),
					field(SettingsValueField, {
						id: 'drt-validator-timeout',
						label: COPY.validatorTimeoutMs,
						hint: COPY.validatorTimeoutMsHint,
						numeric: true,
						disabled,
						state,
						name: 'validatorTimeoutMs',
						onEdit: props.edit,
						onReset: props.resetField,
					}),
					field(SettingsValueField, {
						id: 'drt-stage-limit',
						label: COPY.stageLimit,
						hint: COPY.stageLimitHint,
						numeric: true,
						disabled,
						state,
						name: 'stageLimit',
						onEdit: props.edit,
						onReset: props.resetField,
					}),
					field(SettingsValueField, {
						id: 'drt-python-path',
						label: COPY.pythonPath,
						hint: COPY.pythonPathHint,
						disabled,
						state,
						name: 'pythonPath',
						onEdit: props.edit,
						onReset: props.resetField,
						placeholder: 'python',
					}),
					h(
						'div',
						{ className: 'drt-multiline', key: 'policyText' },
						h('label', { htmlFor: 'drt-policy-text' }, COPY.policyText),
						h('textarea', {
							id: 'drt-policy-text',
							value: state.policyText.text,
							disabled,
							rows: 5,
							onChange: (event) => props.edit('policyText', event.target.value),
						}),
						h('p', null, COPY.policyTextHint),
					),
				),
			)
		}

		/** Expanded form of SettingsValueField: the host's label copy is the same every time. */
		function field(SettingsValueField, options) {
			const state = options.state
			const slice = state[options.name]
			if (slice === undefined) return null
			return h(SettingsValueField, {
				id: options.id,
				label: options.label,
				hint: options.hint,
				numeric: options.numeric === true,
				disabled: options.disabled,
				placeholder: options.placeholder,
				text: slice.text,
				overridden: slice.overridden,
				invalid: slice.invalid,
				overriddenLabel: COPY.overridden,
				resetLabel: COPY.reset,
				invalidLabel: COPY.invalidNumber,
				onEdit: (text) => options.onEdit(options.name, text),
				onReset: () => options.onReset(options.name),
			})
		}

		// ── assembly ────────────────────────────────────────────────────────────
		const plugin = {
			name: 'dsh-ratchet',
			// Only `slots` is a hard dependency: the tool row card is the core, the settings
			// page is a bonus. configForms is fetched optionally — if the host ever stops
			// providing it, the card must not disappear along with the page.
			inject: ['slots'],
			async apply(ctx) {
				let styleEl = null
				try {
					styleEl = document.createElement('style')
					styleEl.setAttribute('data-plugin-css', 'dsh-ratchet')
					styleEl.textContent = CSS
					document.head.appendChild(styleEl)
					ctx.effect(() => () => {
						if (styleEl !== null && styleEl.parentNode !== null) {
							try {
								styleEl.parentNode.removeChild(styleEl)
							} catch {
								styleEl = null
							}
						}
					})
				} catch (error) {
					console.error(`[dsh-ratchet] failed to inject styles: ${String((error && error.message) || error)}`)
				}

				const slots = ctx.get === undefined ? undefined : ctx.get('slots')
				if (slots === undefined || slots === null) return

				for (const toolName of ['ratchet_start', 'ratchet_checkpoint']) {
					slots.inject('tool.call.toolview', () =>
						slots.register(
							{ name: 'tool.call.toolview', key: toolName, locale: 'conversation' },
							RatchetCard,
						),
					)
				}

				// The settings page. primitives can only be required at runtime — it has no
				// standalone package and is one entry in the host's seed whitelist; if it is
				// missing, simply do not register this page and keep the tool rows working.
				let primitives
				try {
					primitives = require('@deepseek-ai/dsh-client-ui-primitives')
				} catch (error) {
					console.error(`[dsh-ratchet] cannot reach the settings primitives, skipping the settings page: ${String((error && error.message) || error)}`)
					return
				}
				if (
					primitives === null ||
					typeof primitives !== 'object' ||
					typeof primitives.SettingsFormModel !== 'function' ||
					typeof primitives.SettingsForm !== 'function' ||
					typeof primitives.SettingsValueField !== 'function'
				) {
					console.error('[dsh-ratchet] host primitives are the wrong version (missing SettingsForm/SettingsValueField), skipping the settings page')
					return
				}

				const mountSettings = (configForms) => {
					if (configForms === undefined || configForms === null || typeof configForms.get !== 'function') return
					const face = createSettingsFace(configForms.get(SETTINGS.ns), primitives)
					ctx.effect(() => () => {
						face.dispose()
					})
					const SettingsCard = (props) => RatchetSettingsCard({ ...props, primitives })
					slots.inject('plugins.bundle.config', () =>
						slots.register(
							{
								name: 'plugins.bundle.config',
								key: 'dsh-ratchet',
								inject: () => face.inject(),
							},
							SettingsCard,
						),
					)
				}

				// The same trap as registerProjection on the host side: at assembly time
				// configForms may not be provided yet, and `ctx.get` returning undefined once
				// skips the registration forever — the settings page then vanishes entirely
				// with no error at all. So when ctx.inject is available, wait for it.
				if (typeof ctx.inject === 'function') {
					ctx.inject(['configForms'], (configCtx) => {
						mountSettings(configCtx.configForms ?? configCtx.get?.('configForms'))
					})
				} else {
					mountSettings(ctx.get === undefined ? undefined : ctx.get('configForms'))
				}
			},
		}

		exports.default = plugin
		exports.apply = plugin.apply
		exports.inject = plugin.inject
		return module.exports
	},
})
