# Runtime known gaps

这份文档只记录**当前仍存在**、但不应继续堆进核心 `SKILL.md` 的问题。

## 1. Active 仍是单槽串行

当前优化没有处理并行扩容。

也就是说：
- `directory_active` 和 `non_directory_active` 逻辑上分 lane
- 但 active heavy work 仍然共享同一个 worker lease group / browser ownership 约束

因此主瓶颈仍然是 queue wait，而不是浏览器纯执行时长。

## 2. target preflight 现在还是启发式，不是 authoritative 可达性探测

现在的 preflight 主要看：
- URL/path
- history
- exact-host duplicate

它还没有做真正的 cheap probe。

所以：
- 它适合排序和 early warning
- 还不适合替代 scout 的 authoritative 站点判断

## 3. Queue claim 仍然基于文件状态，而不是强原子 compare-and-swap

当前 repo state 还是 JSON file store。

在单槽 active 下问题不明显；
如果未来扩成多 active worker，需要先解决：
- 双 claim
- lease race
- 状态覆盖

## 4. Runtime facts 仍可能继续漂移

特别容易漂移的内容：
- CDP port / endpoint 约定
- mailbox capability 语义
- runbook 命令示例
- 尚未真正落地的未来设计

所以核心 skill 现在只保留稳定事实；细节应该放在 references / README。

### 4.1 Shared CDP 长期复用仍是高风险面，但已有减压与熔断缓解

已观察到且仍需记住的现象：
- `http://127.0.0.1:9224/json/version` 正常
- 原始 websocket CDP 也可直接收发 `Browser.getVersion`
- 但 Playwright `connectOverCDP(...)` 仍可能在 `ws connected` 之后超时

### 4.2 Finalization 的 page 选择仍可能被共享 CDP 里的无关 tab 污染

当前 `withConnectedPage()` 在非 fresh-page 模式下，会优先复用 `preferredUrl` 精确命中的现有 page；若没命中，再退回到 shared CDP 里“最后一个非 blank page”。

这意味着：
- 如果 handoff `current_url` 还没有真实存在于共享浏览器 tab 里
- 同时共享 CDP 里又残留了 `chrome://inspect`、`chrome://omnibox-popup...` 或别的无关 regular/internal page
- `task-finalize` 可能会附着到错误 page 上
- 然后以 `FINALIZATION_PAGE_CONTEXT_MISMATCH` 形式安全退回 `RETRYABLE`

这不是目标站点证据，而是 shared-CDP page-selection gap。

当前已验证可行的 bounded 规避方式：
- 在 `task-record-agent-trace` 之后、`task-finalize` 之前，若 handoff URL 还未真实存在于 shared CDP targets 中，可先用同一 CDP 显式打开该 exact handoff/live page URL
- 然后再跑 `task-finalize`
- 这样 `withConnectedPage(... preferredUrl=handoff.current_url)` 才能命中正确 page，而不是回退到无关 tab

因此：
- 若 finalize 首次返回 `FINALIZATION_PAGE_CONTEXT_MISMATCH`，且 detail 里的 actual host 明显是 `inspect` / `chrome://...` / 其他无关残留页，优先把它当作 finalization page-pick 污染
- 不要把这种 mismatch 误汇报成目标 host drift 或站点失败
- 有界补救优先是：把 exact handoff URL 先放进 shared CDP，再重跑一次 finalize；不是改写任务结论

现场复盘表明，主因常不是 `127.0.0.1` / `localhost` 的 loopback 分裂；更常见的是：
- 长期复用的共享 Chrome / profile 留下很多 retained tabs / extension pages / internal pages
- 反复 `connectOverCDP` 后累积了 stale Playwright isolated worlds / execution contexts
- 新会话在初始化 target graph 时被 context 洪水拖慢，最终超时

当前已落地的缓解：
- `task-prepare` / `task-finalize` 改为先跑 light preflight，避免每次阶段入口都先做一次 full Playwright attach
- `runtime-health` 会读取 `/json/list`，暴露 `browser_state.suspicious` 一类 target 污染信号
- runtime 级故障会写入 `$BACKLINKHELPER_STATE_DIR/runtime/runtime-incident.json`
- 每次 auto-recovery 尝试都会写入 `$BACKLINKHELPER_STATE_DIR/runtime/runtime-recovery-status.json`，保留最近尝试、最近一次结果、清理了多少 stale targets
- `guarded-drain-status` 会把 breaker / browser pollution / last auto-recovery attempt 汇总到 `runtime_observability`
- `claim-next-task` 看到 runtime incident breaker 打开时，不会继续放量 claim；会先尝试 auto-recovery
- auto-recovery 只会在无 active browser lock、worker lease、pending-finalize 时运行；其动作是关闭 stale regular CDP page targets，然后再做一次 full Playwright recovery probe
- recovery probe 成功时会自动清 breaker，并允许同一轮继续 claim；失败时保持 `idle`
- preflight 的 alternate loopback hint 只有在两边 browser id 真不同才提示 host conflict；同一 browser 不再误报 `localhost` / `127.0.0.1` 冲突

仍未彻底解决的部分：
- auto-recovery 目前只清 regular `page` targets，不会触碰 extension / service_worker / background_page
- 若 target/context 污染不是 stale regular pages 造成，仍可能需要人工或外部调度去 recycle 9224

因此：
- `guarded-drain-status` / `runtime-health` 若显示 `browser_state.suspicious=true` 或 runtime incident 打开，优先把它当作 shared-browser-state restore 问题，而不是目标站点证据
- 若 `/json/version` 正常、raw websocket 正常、但 `connectOverCDP` 超时，要优先怀疑 target-graph / execution-context pollution
- 在无 active browser lock、worker lease、pending-finalize 时，优先让 runtime auto-recovery 先试一次；只有 auto-recovery 仍失败，再人工 recycle 9224 共享浏览器/profile
- 在 breaker 清除前，不要继续把新 READY 任务喂进 active lane
- 不要因为某个 loopback host 还能回版本字符串，就把任务误判成站点失败

## 5. Correctness 仍比 throughput 更脆弱

已知高风险点：
- verifier false negative
- `DONE` 与 `link_verification` 冲突
- finalization 时 host drift / tab drift

在这些点没完全收敛前，任何成功率 / 吞吐统计都要以 structured evidence 为主，少相信 free-text 总结。
