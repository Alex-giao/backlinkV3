# Learning Loop / Sedimentation Mechanism

用途：定义 V3 如何把“真实跑站经验”从一次任务，沉淀成可复用知识。

这份文档回答的不是“要不要沉淀”，而是：
- 从哪里拿原始事实
- 谁负责分拣
- 什么该进 references
- 什么只该留在 runtime state / playbook
- 什么时候升级成稳定知识

## 结论先说

V3 现在有两层机制：

1. 底层自动留痕机制：已经有
- 每次 run 会留下 task / artifacts / trace / finalize / execution_state
- `task-finalize` 会保存站点级 trajectory playbook
- 这些是“原始经验池”

2. 上层经验升级机制：现在明确化了
- 真实跑站后的经验，不是直接口头说“以后沉淀”
- 而是必须先 triage，再路由到正确容器
- 默认用 `references/post-run-review-helper.md` 做每次有价值 run 的 review 模板

如果没有第 2 层，references 再多也会空转。

## Layer 0：自动留痕（每次 run 默认发生）

V3 的自动沉淀底座包括：
- `data/backlink-helper/tasks/*.json`
- `data/backlink-helper/artifacts/*`
- `data/backlink-helper/runtime/*`
- `data/backlink-helper/playbooks/sites/*.json`
- task 内的 `execution_state`

其中：
- `execution_state` 负责保存 frontier / blockers / evidence / discovered_actions / reusable_fragments
- `task-record-agent-trace` + `task-finalize` 负责把这轮 operator truth 写回 repo state
- `task-finalize` 还能把站点级 trajectory playbook 落到 `playbooks/sites/*.json`

也就是说：
V3 不是没有沉淀底座，而是已经有自动留痕底座。

## Layer 1：经验分拣（每次“有价值 run”后做一次）

不是每次 run 都要改文档。

只有出现下面几类“有价值 run”时，才触发一次 learning-loop review：
- 首次成功打通一个新 surface family / 新平台类型
- 首次识别出可复用的 anti-spam 模式
- 首次发现一个 bounded reverse-engineering 路径有效/无效
- 某站点/某类站点的邮箱/OAuth/identity 策略被证明确实有规律
- 某平台的 live link / rel 结果与旧印象明显冲突
- 同一失败模式在多个 hostname 上重复出现
- runtime/finalize/queue 语义出现结构性偏差，而不是一次性事故

## 每次 review 的最小输入

至少读这些：
1. 当前任务 task JSON
2. 最新 finalization artifact
3. agent trace / operator evidence
4. 如存在：对应 hostname 的 playbook
5. 如存在：相关 family reference / pattern reference

不要只凭聊天记忆升级知识。

## 分拣路由表

### A. 只适用于单 hostname / 单站点路径
放这里：
- `data/backlink-helper/playbooks/sites/*.json`
- `execution_state`
- runtime docs / casebook

典型内容：
- 某站点具体 hidden field 名
- 某站点 submit path 的顺序
- 某站点必须先进哪个 tab/入口
- 某站点一次性 workaround

规则：
- 单站经验默认不要直接进全局 references

### B. 适用于一个 family 的经验
放这里：
- `references/families/forum-profile.md`
- `references/families/wp-comments.md`
- `references/families/dev-blog.md`

典型内容：
- family 常见状态语义
- 哪类字段通常决定真实性/完成度
- 哪类 live verification 最关键

### C. 跨站复用的 anti-spam 经验
放这里：
- `references/patterns/anti-spam.md`

只有满足下面之一才升级：
- 已在 2 个以上 hostname 观察到同类机制
- 或虽只见 1 次，但因果链极清楚，且明显属于系统级/插件级机制

### D. 跨站复用的前端逆向经验
放这里：
- `references/patterns/reverse-eng.md`

升级条件：
- 是“方法模式”而不是某站点 endpoint 本身
- 比如：先看 form.action、hidden input、inline scripts、bundle route/action、再做同语义调用

### E. 账号 / 邮箱 / OAuth 经验
放这里：
- `references/accounts.md`

升级条件：
- 这条规律不是某一个邮箱地址的偶然事件
- 而是对 identity / alias / mailbox / OAuth 路径的稳定策略修正

### F. dofollow / rel 经验
放这里：
- `references/dofollow-notes.md`

升级条件：
- 是“实测口径”或“验证原则”的更新
- 不是瞬时平台榜单

### G. 平台/表面类型经验
放这里：
- `references/platforms.md`

升级条件：
- 属于 surface type 的稳定识别和处理方式
- 不是某站点一次性入口笔记

### H. runtime 语义 / kernel 级经验
放这里：
- `assets/backlinkhelper/docs/runtime-semantics.md`
- 必要时改 runtime code / tests

典型内容：
- system state vs business outcome 语义
- retry/finalize/classifier 分层
- family success semantics

## 升级阈值

默认不要“一次跑站就改全局文档”。

推荐阈值：
- 单站点：先留 playbook / execution_state
- 跨 2 个以上 hostname 重复出现：可以考虑升到 references
- 如果是强因果、强机制、可解释性很高的模式：单次也可升级，但必须明确写成“模式”，不是“站点记忆”

## 写法要求

升级到 references 时，必须：
- 去站点名、去一次性路径、去临时账号
- 保留因果链
- 写成“识别条件 -> 操作原则 -> 停止条件 / 验证方式”
- 不写成流水账 transcript

坏写法：
- “昨天在 xxx.com 我点了 3 次按钮不行，后来刷新好了”

好写法：
- “当 comment textarea 仅在真实键盘事件下才触发前端校验时，优先使用原生输入/逐字输入，而不是直接设值；若仍失败，再判断是否值得做 bounded reverse-engineering”

## 最小 review 输出模板

每次有价值 run 后，做一个 5 分钟分拣：

1. 这次新学到了什么？
2. 这是：
- 单站点经验
- family 经验
- anti-spam 模式
- reverse-eng 模式
- accounts/mailbox 策略
- dofollow/rel 口径
- runtime 语义
- 一次性噪音
3. 它该落在哪里？
4. 是否达到升级阈值？
5. 如果升级，写成哪种抽象表述？

## 当前状态判断

所以答案不是“没有机制”。

而是：
- 自动留痕机制：已经有
- 正式分拣/升级机制：现在通过这份文档明确下来

后续如果不按这份机制做 review，references 当然会变成空口白话；
但如果每次真实 run 后按这个路由走，沉淀就是有抓手的，不是口号。
