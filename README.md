# dsh-ratchet

把 `grill-with-docs` 的访谈纪律，蒸馏成 DeepSeek Harness 里**能管住节奏**的插件。

它解决的不是「模型会不会提问」，而是模型**根本不停下来问**：一句"我理解你的意思了"就开始写代码，写完三百行才发现方向不对。提示词可以劝它停，但劝不住。所以这件事得由代码强制。

## 为什么叫 ratchet

棘轮（ratchet）是一种只能朝一个方向转的齿轮，每转过一格就被棘爪卡住，**退不回去**。这正是这套流程的形状：

- **单向**：只往前走，不回头重做——开工前对齐一次，比事后返工便宜得多。
- **分格**：一格就是一个 stage，转一格响一声，那声"咔"就是 checkpoint。
- **卡住**：没有你的确认，下一格转不动。不是模型"记得"要问你，是机制让它问不了就前进不了。

三个字都有机械上的对应物，不是硬凑的比喻。

## 它强制的三件事

| | skill 的做法 | 本插件的做法 |
|---|---|---|
| **问方向** | 在聊天里逐条问 | 弹面板（`ctx.userQuestions.ask`），问题必须出现在界面上，不能散在聊天里 |
| **分段** | 靠模型自己把握 | 显式 stage，段号可数，写进提示词——「当前进度：第 N 段」 |
| **验收** | 靠模型自己记得 | `ratchet_checkpoint`：不确认就没有下一段，且验收面板里的产出是**插件读文件核实过的** |

第三条是重点。模型说"我改了三个文件"，插件去 `statSync` 那三个路径，读不到就标 **缺失**，不读它的自述。同一张面板里还附上 `CONTEXT.md` 术语表、`docs/adr` 编号、术语↔代码一致性三项校验——这三个 Python 校验器原本在 skill 里靠模型自觉跑，现在每次 checkpoint 必跑。

## 装

工具定义手写成 raw JSON Schema，所以没有 zod、没有 `dsh-tools` 依赖。唯一的包依赖是 `@deepseek-ai/schemastery`（声明在 `peerDependencies`，用宿主的副本）——因为设置页的 `Config` 必须是一个能被宿主 `describe()` 认出来的 schema。`peerDependencies` 而不是 `dependencies` 是硬要求：宿主对被 link 进来的插件只按 `peerDependencies` 放行 `@deepseek-ai/*` 的解析。

在 profile 的 `package.json` 里挂上：

```json
{
  "dependencies": {
    "dsh-ratchet": "link:H:/Deepseekstudio/workspace2/dsh-ratchet"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-ratchet"]
    }
  }
}
```

然后在该 profile 目录跑 `pnpm install` 生成 junction，重启 DSH。

配置**不用手改文件**：装好之后进「设置 → 插件 → dsh-ratchet → 配置」，六个值都能在那儿改，保存即生效（不重启）。底下的 `cordis.patch.yml` 只是初始值。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时一个东西都不注册；运行中关掉则 `/ratchet`、两个工具、提示词段立刻失效 |
| `maxQuestions` | `5` | 一轮最多几题（1–5） |
| `validatorTimeoutMs` | `20000` | 单个校验脚本的超时（最小 1000） |
| `pythonPath` | `''` | 显式 python 路径；留空则探测 `python` / `python3` / `py -3` / DSH 自带运行时 |
| `stageLimit` | `5` | 一次流程建议的段数，写进提示词（1–12） |
| `policyText` | `''` | 覆盖默认纪律文案；留空用内置那六条 |

改完立刻生效靠的是 `plugin/config.mjs` 的 `liveConfig()`：它给每个字段装 getter，读的时候才去取 cordis 的 volatile 引用，所以不用重新 `apply()`、不用重启。

## 用

### 1. 开一条流程

```
/ratchet 做一个能把论文 PDF 批量转 markdown 的小工具
```

`/ratchet off` 退出。不带话题时只进流程、不给标题——它会明确告诉你「这一轮还没定要做什么」，让你补一句，而不是拿一个像「未命名任务」的占位词冒充方向。

### 2. 弹对齐面板

模型调 `ratchet_start`：

```json
{ "topic": "PDF 批量转 markdown", "mode": "kickoff", "brief": "我猜你要的是能跑在本地、不要联网的方案" }
```

插件先扫目录（`CONTEXT.md` / `CONTEXT-MAP.md` / `README.md` / `package.json` / `pyproject.toml` / `AGENTS.md` / `CLAUDE.md` / `docs/adr`），把**已经能读出来的答案从句子里剔掉**：有 `package.json` 就不问技术栈，有 `CONTEXT.md` 就不问术语。面板顶部会列出「开工前读到的」，让你看得见模型到底读了什么——它要是没读，你一眼就知道。

默认四到五题：方向 / 验收 / 改动边界 / 节奏（缺依赖清单时补一题技术栈）。每题第一个选项都带 **（推荐）**，不选也能直接回车。

### 3. 一段做完，出验收面板

```json
{
  "stage": "先把 PDF 抽取跑通",
  "summary": "用 pypdf 抽文本，已能处理单栏论文；双栏顺序还是乱的，留到下一段。",
  "artifacts": ["src/extract.py", "test/test_extract.py"],
  "next": "处理双栏排版",
  "decisions": ["不引入 OCR，扫描件这一版不支持"]
}
```

出面板（正文是渲染后的 markdown，不是原始文本）：

```
> **第 1 段 · 先把 PDF 抽取跑通**

用 pypdf 抽文本，已能处理单栏论文；双栏顺序还是乱的，留到下一段。

**产出**

- `src/extract.py` · 96 行
- `test/test_extract.py` · 31 行

**定下的**

- 不引入 OCR，扫描件这一版不支持

---

**文档校验**　术语表 !　ADR –　一致性 –

- no-avoid: 术语「Session」缺 `_Avoid_` 行

> 上一段是「对齐方向」。

> **下段**　处理双栏排版
```

三个校验器压成一行徽章（`✓` 通过 / `!` 有问题 / `×` 失败 / `–` 跳过），只有出问题的项才展开细节，最多三条，其余折成「另有 N 条」。整段正文包在一个带底色和边框的分区里，不再直接糊在卡片上。

产出那一栏的路径不是照抄模型说的话，而是插件真去磁盘上找了一遍。相对路径按三级解析：绝对路径原样 → 工作目录直下 → 工作目录的**一级子目录**（跳过 `node_modules` 和点目录，最多扫 16 个）。第三级是专门为这个坑准备的：模型说"我改了 `plugin/render.mjs`"时，它心里的根目录常常是项目子目录，而工作目录在上一层，直接拼接就会得到一个不存在的路径，把真实存在的文件标成"缺失"——用户看到的是"它在骗我"。真找不到时也不只说"缺失"，而是把找过的绝对路径一起写出来（`**缺失**（按 \`H:\work\plugin\render.mjs\` 找过）`），子目录命中的会注明是在哪一层找到的（`· 171 行 · 在 \`dsh-ratchet/\` 下`）。

选项：`继续下一步（推荐）`（描述里带下一段做什么）/ 你额外给的路线 / `换个方向`（输入框写新方向）/ `停在这里`。

选「换个方向」时写的内容会进状态，下一段按新方向走；选「停在这里」流程关闭，纪律段不再注入。

## 界面

插件带一个浏览器端半边（`plugin/client.js`），做两件事：

**工具行卡片。** `ratchet_start` / `ratchet_checkpoint` 在会话里的工具行不再是一坨原始参数 JSON，而是自己的卡片：一条状态点（蓝=进行中、绿=通过、黄=有问题、灰=跳过）、阶段标题、校验徽章、产出文件清单（缺失的标红）、可展开的「下段」。数据来自工具的 `output.presentationMeta`，结构化 JSON 直接投影到 `block.meta`，不靠模型复述。

**问题面板正文。** 面板卡本身是宿主的，插件改不了它的结构，但可以用注入的 CSS 给正文区加一层：底色 `--dsw-alias-bg-module-platform`、圆角、内边距，并把宿主的 markdown 默认间距（标题 `32px`）收紧到面板能用的尺度。选择器靠 `[data-question-scroll] > div:first-child:not([role])` 精确命中正文，不碰选项列表。

**设置页。** 挂在「设置 → 插件 → dsh-ratchet → 配置」（keyed 槽 `plugins.bundle.config`，key 就是包名），走宿主的 `configForms` 表单：五个标量用 `SettingsFormModel` 管草稿与冲突重试，`enabled` 这个开关宿主没有原语，就自己攒一个 draft，保存时**先存表单、再拿表单写完后的新 revision 存开关**。

这两步必须是两次写、不能合成一次：`SettingsFormModel.save()` 内部会用自己的 baseline revision 推进一版，把开关的 op 拼进去等于拿旧 revision 去写，必被 `SETTINGS_CONFLICT` 挡回。测试里用「第二次写必须带 `revision === 2`」把这个顺序钉住了。

表单失败时也不偷偷写开关——开关留在他拨的位置，另外提示一句「开关没写进去，请再试一次」，不装作成功。关掉开关后 `/ratchet`、两个工具、提示词段立刻失效，不用重启。

CSS 只用 `--dsw-alias-*` 主题令牌，不硬编码颜色，深浅两套主题都跟着走。宿主改版导致 class 名变化时卡片会退回一行极简样式，不会报错；设置页原语版本不匹配时那一页干脆不挂，工具行照常工作。

## 三处刻意没做的事

**不做"新任务自动进对齐模式"。** 自动嗅探"这算不算新任务"会误伤闲聊和无害问题，而且一旦误判，用户每次对话都先挨一张面板。所以只 `/ratchet` 显式进入，代价是用户要记一个命令；换来的是这个插件永远不会在不该出现的时候出现。

**不用 `plan-review` intent。** 那套 intent 会和 plan-mode 的审批态互掐（它要求 `approve` 命中某个 option label）。这里只用普通题目 + `detail` 承载正文。

**子 agent 弹不出面板时不硬来。** `userQuestions` 只接受 root agent，子 agent 会抛 `DELEGATED_CALLER`。捕获它，把同样的内容降级成聊天里的一段文本，让子 agent 转述、由用户回话——而不是让工具调用直接失败。

## 开发

```bash
npm run check   # 六个文件的语法检查
npm test        # node --test，118 个用例
```

测试分三层。第一层不开 DSH：用假 ctx 跑注册路径，验「未激活时纪律段返回空串」（否则常驻上下文白烧 token）、`mergeQuestions` 的去重裁剪、投影四个 op 的折叠、以及校验器在缺 python / 缺文件 / 超时 / abort 时**永不抛**。第二层验正文渲染：`render.mjs` 的输出结构（徽章、缺失标注、折叠计数、不含原始 HTML 和任务列表——宿主的 MarkdownText 不支持 GFM）。第三层（`test/integration.test.mjs`）用真 `Session` / 真 cordis `Context` / 真 `SessionProjectionRegistry` / 真 `appendPluginRecord` 跑一遍，验三件只有真包才验得了的事：record type 过得了宿主的类型正则、投影能从真 event log 里把状态折叠回来、无关事件不换引用（换了宿主就白重算 view）。`test/client.test.mjs` 用 `new Function` 造一个假 `window`/`document` 把浏览器半边跑起来，验它注册了哪两个 key、样式有没有注入和清理、拿不到 `block.meta` 时会不会崩。

裸 node 里 `@deepseek-ai/*` 解析不到（profile 的 node_modules 没有这个 scope，靠宿主启动时装的 ResolutionRouter 才通），所以 `test/register.mjs` + `test/host-resolver.mjs` 是一层只给测试用的 ESM 解析钩子，把 specifier 指到宿主安装目录。生产代码不依赖它 —— 解析不到时 `writeState` 会退回内存镜像，这是设计好的降级路径。

`plugin/vendor/` 里是从 `H:\Deepseekstudio-data\skills\grill-with-docs\scripts` 复制的三个 stdlib-only Python 校验器（MIT，Matt Pocock 上游）。源目录只读，改动请改 vendor 副本。

## 文件

```
package.json
cordis.patch.yml
plugin/
  index.mjs       段 + 命令 + 两个工具
  config.mjs      六个可改字段的 schema + liveConfig 热读取
  render.mjs      面板正文的排版（只产出 MarkdownText 支持的语法）
  client.js       浏览器半边：工具行卡片 + 面板 CSS + 设置页
  state.mjs       投影 + plugin record 读写
  validators.mjs  三个校验器的封装（降级永不抛）
  vendor/*.py     CONTEXT.md / ADR / 术语↔代码 校验器
test/
  index.test.mjs        段 + 命令 + 组装
  render.test.mjs       面板正文的排版
  client.test.mjs       浏览器半边：卡片注册、样式注入、设置页读写
  validators.test.mjs   三个校验器的降级行为
  tools.test.mjs        两个工具的 execute 全路径（假面板）
  integration.test.mjs  真宿主：Session + cordis + 投影注册表
  register.mjs          测试用解析钩子注册
  host-resolver.mjs     把 @deepseek-ai/* 指到宿主安装目录
```

MIT.
