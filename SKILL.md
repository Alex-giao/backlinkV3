---
name: web-backlinker-v3-operator
description: operate backlinkhelper v3 for bounded single-site backlink tasks under an evidence-first philosophy. use when chatgpt needs to run the repo-native operator loop, inspect queue or follow-up state, apply runtime safeguards, or consult the bundled references for family-specific context, verification semantics, and non-parallel throughput optimization.
---

# Web Backlinker V3 Operator

这是一个**薄 skill**。

它只负责三件事：
- 校准 agent 在 backlink 任务里的策略哲学
- 说明最小完备工具集与能力边界
- 强调运行时里容易被遗忘、但必须记住的事实

不要把它写成站点步骤手册、运维流水账、bug 年鉴或临时经验集。

## Runtime Pitfalls To Remember

- CapSolver 只能证明“验证码已解并已回填/尝试提交”，不能证明“点到了正确的提交按钮”。对有站内搜索、newsletter、multi-form 混排的页面，submit selector 必须优先收敛到当前目标表单（例如 `form#commentform`、`#commentform input#submit`、`form[action*="comment"]`），不要用过宽的全页 `input[type="submit"]` / `button[type="submit"]` 兜底顺序放前面。
- 如果验证码 solve 成功后页面却跳到明显无关页面（如站内搜索 `?s=`、首页订阅确认、其他非目标表单落点），先怀疑“submit 命中错表单”，不要误判成 CapSolver 失败或站点拒绝。
- 对 comment family，验收要拆成两层：`captcha/submit path passed` 与 `comment/backlink live`。出现 `#comment-...` 只能说明提交流程大概率接受，仍要 fresh reload 做 live/backlink 验证，避免把 moderation pending 误报为成功。

## Strategy Philosophy

### 1. 先定义本轮成功标准

先判断这一次 bounded tick 想确认什么：
- 成功提交
- 正确等待外部事件
- 正确停在人工/策略边界
- 或把任务安全地退回 retryable / waiting

不要把“继续操作更多页面”误当成成功。

### 2. 先判断这个任务值不值得占 active slot

active lane 很贵。

先看：
- exact-host duplicate 是否已经存在
- target preflight 是否把它评成 promising / unclear / deprioritized
- 有没有明显等待中的旧任务更值得复用
- 历史同 exact host 是成功多，还是 fast-fail 多

不要对明显低价值目标先抢 active slot，再在 scout 里晚发现坏消息。

### 3. 选最可能直达的路径，而不是默认最熟悉的路径

从 brief、family、当前页面证据出发，选最可能直达目标的入口：
- directory 类任务，不要默认困在内容页或价格页
- forum/profile 类任务，不要因为看到登录态就立刻把它当成坏目标
- comment / dev-blog 类任务，要接受内容页、编辑页本来就是 submit surface 的一部分

路径选择是基于现场证据，不是基于刻板模板。

### 4. 每一步输出都当作证据，而不是“成功 / 失败”二元信号

重点观察：
- frontier
- blockers
- evidence
- discovered_actions
- reusable_fragments
- current url / host drift
- scout / finalization artifacts

页面缺少预期元素，不一定说明网站坏了；也可能说明当前入口不对、上下文漂移、页面还没到 submit surface。

### 5. 低置信时先补证据，再改变策略

低置信时优先补：
- screenshot
- DOM / text excerpt
- 当前 URL 与 host
- visible CTA / iframe / overlay 线索
- scout / replay / finalization 证据

不要在低置信状态下靠经验硬判。

### 6. 到达验证过的完成条件就停止

一旦已经拿到足够的 live-link / terminal / waiting evidence，就停止。

不要为了“顺手再看一页”去扩大操作面、制造 host drift 或脏状态。

## Minimal Complete Toolset

这里只说明能力边界，不规定站点剧本。

### 1. Repo state layer

repo state 是任务记忆，不是聊天记忆。

要把执行记忆写回 task / artifact / playbook / account / credential / execution_state，而不是依赖长上下文。

### 2. Target preflight + queue priority

这是 active 前的轻量 intake 能力。

用途：
- exact-host duplicate preflight
- 粗判 target 是否值得占 active slot
- 给 READY / RETRYABLE 任务提供 queue priority score

它是“先判断是否值得做”的系统能力，不是站点操作规则。

### 3. Shared CDP browser + browser-use CLI

主交互推进层。

用途：
- 页面探索
- CTA 点击
- 表单推进
- 登录 / 注册后的继续动作
- submit 前的交互推进

### 4. Playwright

辅助控制与 authoritative 收口层。

用途：
- preflight
- scout
- replay
- finalize
- 证据确认 / screenshot 补全

不要把 Playwright 当默认主交互层。

### 5. Mailbox continuation

邮箱能力是正式主路径的一部分。

用途：
- verification code
- magic link
- confirmation mail
- resend 后的 exact query confirm

优先把 continuation 写进 task state，再由下一轮 active / follow_up 继续。

### 6. Finalization + verification

finalization 负责 authoritative 收口，不负责替 agent 发明成功故事。

尤其是 non-directory family：
- 只有拿到 live backlink verification，才算真正完成
- 不能把 stale tab、错 host、旧 JSON 里的 verifier 结果当成当前任务的成功证据

### 7. CapSolver unattended continuation

无人值守模式下，受支持的 CAPTCHA 不再是默认人工边界。

用途：
- reCAPTCHA v2 token solve
- Cloudflare Turnstile token solve
- image/security-code OCR solve

能力细节与配置在 `references/capsolver-unattended.md`；最终仍以 live-link / confirmation / wait evidence 收口，不能把“solver 返回 token/text”本身当成提交成功。

## Necessary Facts

### 0. Runtime state lives outside the skill code tree

默认结构化运行状态根目录是 `$HERMES_HOME/state/backlinkhelper-v3`（通常为 `/home/gc/.hermes/state/backlinkhelper-v3`）。

兼容环境变量：
- `BACKLINER_DATA_ROOT`：旧变量，最高优先级
- `BACKLINKHELPER_STATE_DIR`：新变量，指向外置 state root

不要再把 task / artifacts / accounts / runtime locks 当成 skill 代码目录内的事实；旧 `assets/backlinkhelper/data/backlink-helper` 路径只应作为兼容 symlink 或历史引用。

### 1. Operator-only 主链是 repo-native 真相源

稳定闭环是：
- `claim-next-task`
- `task-prepare`
- operator / browser-use loop
- `task-record-agent-trace`
- `task-finalize`

`run-next` 只是 fail-fast 占位，不是生产主入口。

### 2. 当前 active work 仍然是单槽串行

现在不考虑并行扩容。

因此优化重点是：
- 降低热路径固定开销
- 提前拦住坏目标 / 重复目标
- 提高单槽 active 的利用率

### 3. queue identity 现在按 promoted host + target exact host 守护

duplicate preflight 是 **exact-host** 口径：
- `saashub.com` 与 `community.saashub.com` 不合并
- 同一 promoted host + 同一 exact target host，不应再开平行新任务
- duplicate 只在 **payload 完全等价** 时直接 reuse；这里的 payload 至少包括 target URL、effective flow family、submission/promoted-profile payload
- 若 payload 不同且任一 exact-host sibling 正在 `RUNNING`，应直接 block，而不是改写别的 sibling
- 若 payload 不同且没有 `RUNNING` sibling，可 authoritative 覆盖一个 non-running duplicate 并 reset 回 `READY`
- authoritative duplicate replacement 若省略 `flow_family`，应按 fresh enqueue 默认语义处理，而不是静默沿用旧 family
- 若存在 payload 等价的 duplicate，即使另一个 exact-host sibling 正在 `RUNNING` 且 payload 冲突，也应优先复用/重激活这个等价 duplicate

### 4. READY / RETRYABLE active 任务不再只看 FIFO

当前队列优先级同时看：
- `queue_priority_score`
- `created_at`

也就是说，值得先做的任务可以在单槽里优先被 claim。

### 5. 任务阶段时间戳现在进入 task state

至少会记录：
- `enqueued_at`
- `claimed_at`
- `prepare_started_at`
- `prepare_finished_at`
- `trace_recorded_at`
- `finalize_started_at`
- `finalize_finished_at`

后续吞吐诊断优先读这些字段，不再只靠 artifact 时间反推。

### 6. follow_up 是 continuation lane，不是 active 的替身

`WAITING_EXTERNAL_EVENT` / `WAITING_SITE_RESPONSE` 进入 follow_up。

它们会拉长任务业务闭环，但不应该继续占 active heavy slot。

### 7. canonical CDP endpoint 由 runtime 决定，不要把某个端口写死进核心判断

用 `resolveBrowserRuntime()` / runtime preflight 判断当前 canonical CDP endpoint。

不要在核心 skill 里把 `9223`、`9224`、`9333` 之类的某个端口写成永真事实。

补充：同一个 shared CDP 端口也可能出现 loopback host 差异（例如 `127.0.0.1` 与 `localhost` 表现不同）。若出现 `cdp_runtime=true` 但 `playwright=false`，且错误提示 alternate loopback host 能连上 Chrome，不要硬跑 operator loop；应把它视为 runtime 侧 blocker，按 retryable / waiting 语义收口，等待 canonical endpoint 或 listener 冲突修复。

### 8. open runtime incident / circuit breaker 会让 claim 返回 idle，不等于队列空

`guarded-drain-status` 可能显示底层 checks 都是 true（`cdp=true`, `playwright=true`, `browser_use=true`, `gog=true`），但同时 summary / blockers 里仍写着 circuit breaker open，例如来自较早一次 `task-prepare` 的 `PLAYWRIGHT_CDP_UNAVAILABLE` incident。

当前实现里，`claim-next-task` 会先看 active lease / browser ownership，再看 `runtime_incident`；只要 open incident 还没被 auto-recover 清掉，就会直接返回 `mode: "idle"`，即使 scope 内仍有 eligible `RETRYABLE` 任务。

因此：
- 不要把 `claim-next-task -> idle` 直接解释成“本 scope 没任务”
- 先看返回里的 `runtime_incident` 字段
- bounded tick 汇报里应把它报告成 runtime blocker，而不是 queue empty
- 若本轮用户要求“claim exactly one task”，在这种情况下应停在单行状态，不要强行挑第二条路径绕过状态机

### 9. queue scope 里的 `promotedUrl` 是精确字符串匹配，不是规范化 URL 语义

当前 `matchesTaskScope()` 直接比较 `task.submission.promoted_profile.url === scope.promotedUrl`。

这意味着像 `https://geometrydashjp.com` 与 `https://geometrydashjp.com/` 这种尾斜杠差异，会把本来属于同一 promoted site 的任务错误排除在 scope 外。

做 bounded status / follow-up / claim scoped run 时：
- 若未先确认 repo 里保存的 canonical promoted URL 形式，优先用 `task-id-prefix + promoted-hostname`
- 不要把 `--promoted-url` 当成天然安全的 scope 收窄器
- 若必须带 `--promoted-url`，先确认 task state 里的精确字符串

### 9. `guarded-drain-status` 不是纯只读状态查看

当前实现里它会先执行 `reapExpiredQueueState()`，因此可能顺手修复 / 停放已耗尽的任务，
例如把不再应自动重试的 `RETRYABLE` 任务改写到 `WAITING_RETRY_DECISION`。

因此：
- 不要把它当成绝对无副作用的 status probe
- 做 bounded tick 的前后对比时，要把这类 repair mutation 与真正的 follow-up continuation 区分开
- 如果你要报告“follow-up 有无变化”，优先只统计 `WAITING_EXTERNAL_EVENT` / `WAITING_SITE_RESPONSE` continuation 的增量

### 10. mailbox capability 的判断要看 runtime 能力，不看某一个命令名

不要把“shell 里直接跑 `gog` 成功 / 失败”当成邮箱能力的唯一真相源。

当 repo 命令可用、Gmail / Google Workspace capability 可用时，应继续走 mailbox 主路径。

### 9. 不要把 mutating repo CLI 子命令当成有安全 `--help` 的传统 CLI

有些 repo-native 子命令不会因为传了 `--help` 就进入帮助模式；解析器可能直接忽略它并正常执行命令。

因此：
- 不要用 `claim-next-task --help`、`task-prepare --help`、`task-finalize --help` 这类方式探参数
- 先读 `package.json`、`dist/cli/index.js` 或对应命令实现，再执行真正的命令
- 若误触发 claim / lease，先做 authoritative state restore，再继续本轮 bounded tick

## Safety Boundaries

- 不付费，不购买 sponsored listing，不替用户做 payment step。
- 不代做 2FA / passkey / 人工验证码设备操作。
- 不为了提速而绕过 lease、状态机、finalization、evidence writeback。
- 不把 source-only tmp helper 当作站点决策器。
- 不在 host drift、tab drift、page drift 明显时写入 authoritative verifier 结论。
- 不把临时 case experience 上升为核心 skill 的行为规则。

## What Must Stay Out of This Skill

不要把这些内容继续堆进核心 `SKILL.md`：
- 具体站点点击剧本
- 某一周的新坑实录
- 未来还没落地的能力设计
- 端口、环境变量、命令示例的长篇 runbook
- 单个 bug 的症状学长文

这些内容应该下沉到 references 或 repo docs。

## Reference Index

### Core runtime references
- `references/runtime-semantics.md`
- `references/runtime-philosophy-hardening.md`
- `references/runtime-fallbacks.md`
- `references/runtime-failure-taxonomy.md`
- `references/throughput-diagnostics.md`
- `references/non-parallel-optimization-plan.md`
- `references/runtime-known-gaps.md`
- `references/capsolver-unattended.md`

### Run modes
- `references/run-modes/queue-and-guarded-drain.md`

### Family cues
- `references/families/forum-profile.md`
- `references/families/wp-comments.md`
- `references/families/dev-blog.md`

### Verification / safety / reverse engineering
- `references/verification/link-verification.md`
- `references/patterns/reverse-eng.md`
- `references/patterns/anti-spam.md`

### Memory and support material
- `references/accounts.md`
- `references/learning-loop.md`
- `references/post-run-review-helper.md`
- `references/platforms.md`

## Default Working Style

- 让 brief 定义 campaign 目标、边界、优先级与资源来源
- 让 skill 提供哲学、工具边界与必要事实
- 让 repo state 保存记忆
- 让 runtime 负责生命周期、验证与安全边界

如果用户要的是**站点个案策略**、**运营复盘**、**批量调度规划**或**性能诊断**，先去对应 references，不要把那些东西重新写回核心 skill。
