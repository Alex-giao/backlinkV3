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

## Necessary Facts

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

### 8. mailbox capability 的判断要看 runtime 能力，不看某一个命令名

不要把“shell 里直接跑 `gog` 成功 / 失败”当成邮箱能力的唯一真相源。

当 repo 命令可用、Gmail / Google Workspace capability 可用时，应继续走 mailbox 主路径。

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
