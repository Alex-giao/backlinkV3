# Post-Run Review Helper

用途：这是 `web-backlinker-v3-operator` 的收尾复盘 helper。

它不是独立 skill，也不是独立工作流。
它依赖 V3 单任务执行上下文：
- task JSON
- finalization artifact
- agent trace / operator evidence
- execution_state
- playbook（如果有）

所以它应作为本 skill 包内 reference 使用，而不是新的 sibling skill。

## 何时使用

在这些场景下，完成一次 bounded run 后做 3~5 分钟 review：
- 首次打通一个新 surface / 新 family / 新平台类型
- 同类失败在多个 hostname 上重复出现
- 发现一个值得复用的 anti-spam / reverse-engineering / accounts / rel 模式
- operator 实测结论与 repo 最终收口明显有偏差
- 你直觉觉得“这次值得学点东西”，而不是只把它当一次随机事故

不要在这些场景浪费时间：
- 明显的一次性噪音
- 没有新信息的重复成功
- 只是照既有路径跑通，没有新增模式或偏差

## 先读哪些输入

每次 review 至少看：
1. `data/backlink-helper/tasks/<taskId>.json`
2. 最新 finalization artifact
3. agent trace / operator evidence
4. 对应 hostname 的 playbook（如存在）
5. 当前 family / pattern reference（如相关）

不要只凭聊天记忆做复盘。

## 复盘模板

### 1. Run Summary
- task family:
- hostname / surface type:
- 目标是什么:
- 最终 outcome:
- repo 最终状态是什么:
- operator 实测结论与 repo 是否一致:

### 2. What Worked
- 哪些现有哲学/工具/事实是有效的？
- 哪些部分不需要改？

### 3. What Failed or Felt Weak
- agent 在哪里犹豫、误判、重试、补了很多 ad hoc 说明？
- 哪些 signal 说明当前 knowledge 不够？

### 4. Failure Triage
主因是哪一类？
- [ ] family 经验缺口
- [ ] anti-spam 模式缺口
- [ ] reverse-engineering 模式缺口
- [ ] accounts / mailbox / OAuth 策略缺口
- [ ] dofollow / rel 口径缺口
- [ ] runtime semantics / finalize / queue 语义缺口
- [ ] 单站点 playbook 即可
- [ ] 一次性噪音，无需升级

说明：
- 为什么是这一类？
- 有什么直接证据支持？

### 5. Correct Destination
这次经验最小正确容器是什么？
- [ ] playbook / execution_state
- [ ] `references/families/*.md`
- [ ] `references/patterns/anti-spam.md`
- [ ] `references/patterns/reverse-eng.md`
- [ ] `references/accounts.md`
- [ ] `references/dofollow-notes.md`
- [ ] `references/platforms.md`
- [ ] `assets/backlinkhelper/docs/runtime-semantics.md`
- [ ] nowhere — one-off noise

说明：
- 为什么这里是最小正确容器？

### 6. Proposed Upgrade
- 要提炼成什么模式？
- 它是稳定规律，还是站点局部 workaround？
- 如果写入全局 reference，怎样去站点名、去临时路径、去一次性细节？

### 7. Overfitting Check
在升级前回答：
- 这会帮助第二个 hostname 吗？
- 这会帮助第十次调用吗？
- 这是“判断支持”，还是“脆弱步骤脚本”？
- 它应该进 reference，还是只该留在 playbook？

### 8. Verification Plan
如果要升级，未来怎么判断它真的有帮助？
- 哪类任务应该更顺？
- 哪类误判应减少？
- 哪个 artifact / signal 能证明补丁有效？

### 9. Final Decision
- [ ] patch reference now
- [ ] patch runtime semantics now
- [ ] 只写入 playbook / execution_state
- [ ] 只保留在 artifact / repo state
- [ ] 不做任何 durable change

Decision note:

## 快速判断口诀

一句话判断：
- 单站点才成立 -> playbook
- 同 family 常见 -> family reference
- 跨站反垃圾 -> anti-spam
- 跨站前端失灵方法 -> reverse-eng
- 身份/邮箱/OAuth 规律 -> accounts
- live link / rel 口径 -> dofollow notes
- classifier/finalize/queue 语义 -> runtime semantics
- 只有这一次奇怪 -> nowhere

## 和 learning-loop 的关系

- `references/learning-loop.md` 负责定义“沉淀机制和升级路由”
- 本文件负责提供“每次 run 后怎么实际做 review 的操作模板”

前者是制度，后者是表单。

## Pitfalls

- 不要把单站点 workaround 直接升成全局规则
- 不要把一次随机事故包装成稳定模式
- 不要在没有读 task/finalize/trace 的情况下凭印象 patch reference
- 不要因为想沉淀，就强行每次 run 都改文档

## Verification

当你完成一次 post-run review，至少确认：
- 已经读过 task + finalization + trace
- 已经明确这次经验属于哪一层
- 已经给出“落在哪个容器”的决定
- 如果升级为 reference，写法已经抽象成模式，而不是流水账
