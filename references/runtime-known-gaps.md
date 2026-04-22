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

## 5. Correctness 仍比 throughput 更脆弱

已知高风险点：
- verifier false negative
- `DONE` 与 `link_verification` 冲突
- finalization 时 host drift / tab drift

在这些点没完全收敛前，任何成功率 / 吞吐统计都要以 structured evidence 为主，少相信 free-text 总结。
