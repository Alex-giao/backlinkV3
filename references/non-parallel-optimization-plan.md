# Non-parallel optimization plan

## Goal

在不做 active 多槽并行之前，先提高单槽吞吐与命中率。

核心原则：
- 不给 agent 增加更多站点步骤规则
- 先补系统层原子能力
- 让 expensive active slot 更少浪费在坏目标和重复目标上

## 已落地改动

### 1. 热路径脚本不再默认每次 `build`

`assets/backlinkhelper/package.json` 的热路径脚本已改为直接执行 `node dist/cli/index.js ...`。

影响：
- 降低每个 tick 的固定壳层开销
- build 改为代码变更后手动执行，而不是每次 claim / prepare / finalize 都重复执行

### 2. enqueue-time exact-host duplicate preflight

系统现在在 enqueue 阶段就按：
- `submission.promoted_profile.hostname`
- `target exact hostname`

做 duplicate 检查。

行为：
- 同 task id：直接 re-enqueue 原任务
- 同 promoted host + exact target host 且已有 waiting / running / ready 任务：复用旧任务
- 同 promoted host + exact target host 且旧任务是 retryable / skipped：reactivate 旧任务
- 同 promoted host + exact target host 且旧任务已经 `DONE`：阻止新建平行重复任务

### 3. target preflight + queue priority score

新增轻量 preflight，不访问站点，只基于：
- family
- target URL/path signals
- commercial / auth / content 弱信号
- exact-host 历史成功 / fast-fail / waiting 记录

输出：
- `target_preflight`
- `queue_priority_score`

READY / RETRYABLE active 任务现在按：
1. `queue_priority_score` 降序
2. `created_at` 升序

而不是纯 FIFO。

### 4. stage timing telemetry

任务现在开始记录：
- `enqueued_at`
- `claimed_at`
- `prepare_started_at`
- `prepare_finished_at`
- `trace_recorded_at`
- `finalize_started_at`
- `finalize_finished_at`

用途：
- 直接拆分 queue wait / prepare / agent loop / finalize
- 不再只靠 artifact 时间反推

## 为什么这些改动符合薄 skill 哲学

它们都不是“规定 agent 该点哪个按钮”。

它们补的是：
- 目标是否值得做
- 队列该先做谁
- 每一段到底慢在哪

也就是系统级原子能力，而不是站点级操作脚本。

## 下一步建议

### P1. 把 target preflight 从 URL heuristics 提升到 cheap network probe

当前 target preflight 仍然是轻量启发式。

下一步可以加非常克制的 network probe：
- 只看 2xx / 3xx / 4xx / 5xx
- 只看 host drift
- 只看明显 login wall / paid wall / parked domain / unrelated redirect

不要在这里引入完整浏览器自动化。

### P2. 把 scoring 与 historical evidence 绑定得更紧

当前 historical signals 主要按 exact-host 的 terminal / waiting / success 计数。

下一步可以纳入：
- `wait_reason_code`
- `terminal_class`
- fast-fail 是否发生在 scout-only
- live link verifier 的最终结果

### P3. 加 runtime fact audit

当前 skill / README / code 仍有漂移风险。

建议增加一个轻量 audit：
- 端口事实
- preflight 语义
- follow_up 语义
- queue identity 语义
- family provenance 语义

把“文档和代码是否一致”本身变成可检查项。

### P4. 修 correctness invariant

优先修：
- `DONE + link_missing`
- stale host / stale tab 上写 verifier
- visual success 与 structured verifier 冲突时的持久化策略

这不是速度优化，但会显著提升调度、复盘和报表的可信度。
