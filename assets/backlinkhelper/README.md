# BacklinkHelper runtime (bundled)

## 这份 README 解决什么问题

告诉你这份 bundled runtime 现在是什么、主链怎么跑、哪些事实已经收敛、哪些东西不要再误读成生产路径。

## 这是什么

BacklinkHelper 现在是一个**evidence-first、bounded single-site operator runtime**。

它负责：
- task queue / lease / follow_up lane
- shared CDP browser runtime
- scout / replay / finalization
- task / artifact / account / credential / playbook 落盘
- operator 主链的确定性壳层

它**不负责**：
- 站点点击剧本
- campaign 策略规划
- source-only tmp helper 的 site-flow 决策

## 当前稳定主链

```text
claim-next-task
-> task-prepare
-> operator / browser-use loop
-> task-record-agent-trace
-> task-finalize
```

`run-next` 只是 fail-fast 占位，不是生产入口。
`drain-worker` 仍然保持 disabled，因为旧实现会把站点决策固化进 source-only helper。

## 先记住这几个 runtime 事实

### 1. 热路径脚本现在默认直接跑 `dist`

`package.json` 的热路径脚本不再每次自动 `build`。

原因：
- build 属于代码变更后的准备动作
- 不应该成为每个 claim / prepare / finalize tick 的固定壳层成本

所以现在的习惯应该是：
- 代码改完后手动 build 一次
- 日常运行直接执行 `node dist/cli/index.js ...` 对应的脚本

### 2. enqueue 阶段已经有 exact-host duplicate preflight

系统现在按下面这组身份看 queue identity：
- `submission.promoted_profile.hostname`
- `target exact hostname`

结果不是只有“创建新任务”一种：
- `accept_new_task`
- `reused_existing_task`
- `reactivated_existing_task`
- `blocked_duplicate_task`

也就是说，同一 promoted host + 同一 exact target host，不应该再平行开新任务。

### 3. active 队列不再是纯 FIFO

READY / RETRYABLE active 任务现在先看：
- `queue_priority_score`
- 再看 `created_at`

单槽 active 的优化重点，是把更值得做的任务排在前面，而不是让所有任务机械按时间顺序等死。

### 4. 任务现在会写阶段时间戳

至少包含：
- `enqueued_at`
- `claimed_at`
- `prepare_started_at`
- `prepare_finished_at`
- `trace_recorded_at`
- `finalize_started_at`
- `finalize_finished_at`

这让 throughput 诊断不再只能靠 artifact 时间戳反推。

### 5. CDP endpoint 不要写死成某个端口事实

runtime 会通过 `resolveBrowserRuntime()` 决定 canonical CDP endpoint。

你可以显式设置：
- `BACKLINK_BROWSER_CDP_URL`

如果不设，runtime 会尝试常见 loopback 端口并做 autodiscovery。

## 最短可运行路径

### 1. 启动一个外部 Chrome

例子：

```bash
open -na "/Applications/Google Chrome.app" --args \
  --remote-debugging-port=9223 \
  '--remote-allow-origins=*' \
  --user-data-dir=/tmp/chrome-cdp \
  about:blank
```

这只是示例，不代表 `9223` 是 runtime 唯一真相。

### 2. 准备环境

```bash
cd <repo-root>/assets/backlinkhelper
export BACKLINK_BROWSER_CDP_URL=http://127.0.0.1:9223
export BACKLINER_VAULT_KEY='replace-with-a-stable-secret'
node dist/cli/index.js preflight
```

如果你改过 `src/`：

```bash
tsc -p tsconfig.json
```

### 3. enqueue 一个任务

```bash
node dist/cli/index.js enqueue-site -- \
  --task-id demo-futuretools \
  --target-url https://futuretools.io/ \
  --flow-family saas_directory \
  --promoted-url https://exactstatement.com/ \
  --submitter-email-base support@exactstatement.com \
  --confirm-submit
```

输出现在是结构化结果，包含：
- `outcome`
- `reason`
- `task`
- 可能的 `duplicate_of_task_id`

### 4. claim / prepare / record / finalize

```bash
node dist/cli/index.js claim-next-task -- --owner local-debug
node dist/cli/index.js task-prepare -- --task-id demo-futuretools
node dist/cli/index.js task-record-agent-trace -- --task-id demo-futuretools --payload-file /tmp/demo-futuretools-trace.json
node dist/cli/index.js task-finalize -- --task-id demo-futuretools
```

## 代码地图

- `src/control-plane/`
  - queue / claim / prepare / finalize / follow_up
- `src/control-plane/target-preflight.ts`
  - enqueue-time target preflight、exact-host duplicate preflight、queue priority scoring
- `src/shared/task-timing.ts`
  - task stage timestamp helper
- `src/execution/`
  - scout / replay / finalization / ownership lock
- `src/memory/`
  - task / artifact / account / credential / playbook store
- `src/shared/`
  - browser runtime / preflight / mailbox / verifier / progress helpers

## 先看哪份文档

- 想看当前语义：`docs/runtime-semantics.md`
- 想看为什么核心 skill 要保持薄：`references/runtime-philosophy-hardening.md`
- 想看这轮非并行优化：`references/non-parallel-optimization-plan.md`
- 想看当前已知缺口：`references/runtime-known-gaps.md`
- 想看吞吐诊断：`references/throughput-diagnostics.md`
