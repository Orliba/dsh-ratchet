# Ratchet

把「先对齐方向、分段交付、每段验收」变成代码强制的 DSH 插件，用来替代只靠模型自觉遵守的提示词纪律。术语表只收这个插件自己的概念，通用编程词汇（缓存、异常、超时）不进来。

## Language

**Ratchet**:
一次被托管的交付节奏：开工前对齐方向，之后每一段都必须停下来验收才能继续。
_Avoid_: 流程, workflow, pipeline, session

**Stage**:
两次验收之间做完的那一小块工作，有编号、有标题、有它该产出的文件。
_Avoid_: 步骤, step, phase, 阶段

**Checkpoint**:
一段结束时强制弹出的一次确认，把产出、校验结论和下一步选项摆在一起。
_Avoid_: 检查点, gate, review, 审批

**Verdict**:
单个校验器对一份文档给出的整体判定，取 PASS、WARN、FAIL 三个值之一。
_Avoid_: 分数, score, 结果, result

**Artifact**:
某一段声称落地的文件，落盘与否由插件去磁盘上核实，不采信模型口述。
_Avoid_: 交付物, deliverable, output, 产物

**Projection**:
从会话事件里折出来的当前进度，让重启或分叉之后还知道走到第几段。
_Avoid_: 状态, state, snapshot, 快照

**Policy**:
注入系统提示词的那几行节奏纪律，只在流程激活时存在，关掉后整段消失。
_Avoid_: 提示词, prompt, instruction, 规则

## Relationships

- 一个 **Ratchet** 由若干个 **Stage** 串成
- 每个 **Stage** 以一次 **Checkpoint** 结束
- 一次 **Checkpoint** 带若干 **Artifact** 和三条 **Verdict**
- **Projection** 记住当前走到第几个 **Stage**，重启后据此续上
- **Policy** 只在 **Ratchet** 激活期间出现，是它唯一能影响模型行为的常驻通道

## Example dialogue

> **Dev:** "**Ratchet** 开始之后，模型直接写代码不弹面板，算不算违规？"
> **Domain expert:** "算。**Policy** 段会要求它先调 `ratchet_start`；真跳过的话，第一次 **Checkpoint** 会显示 `strayed`，段号从 1 重算，等于把你已经走的路丢了。"
> **Dev:** "那 **Verdict** 全是 WARN 时该停下来吗？"
> **Domain expert:** "WARN 只是提示，**Checkpoint** 的真正作用是逼你看一眼 **Artifact** 到底在不在 —— 缺文件比 WARN 严重得多。"

## Flagged ambiguities

- "stage" 曾被用来同时指「一段工作」和「流水线里的部署环境」—— 本插件只取前者，部署语境一律说 environment。
- "checkpoint" 在模型训练里指权重快照 —— 这里专指人机确认点，不用来指存档。
