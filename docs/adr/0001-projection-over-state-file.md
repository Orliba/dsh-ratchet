# 进度存进 session 投影，不写自己的状态文件

一次 ratchet 跨多个回合、可能中途重启或分叉会话，进度必须活过进程。选择用 `sessionProjections` 把它折进会话事件流（`plugin:dsh-ratchet/state`），而不是在仓库里写一个 `.ratchet.json`：投影天然跟着 fork/resume 走，也不给用户的工作目录留垃圾。代价是投影只能在事件到达时被动折叠，写状态必须先 `appendPluginRecord` 再等 `drive()` 回调，读状态则要处理"服务还没装配好"的时序（`ctx.inject` 而非 `ctx.get`）。
