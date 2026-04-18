# BacklinkHelper V3 第三轮“哲学收尾”实施计划

> 给 Hermes：按 TDD 执行本计划；每个任务先写失败测试，再做最小实现，再跑针对性测试，最后跑全量回归。

目标：把剩余的关键词/信号词主导路径继续降级，统一改成“structured outcome + typed facts + visual/link evidence + family semantic contract”优先。

架构方向：
1. 站点入口与页面理解继续以结构化候选、视觉证据、链接验证为主。
2. 状态推进继续从 raw text 触发，改为消费 typed facts / structured checkpoints。
3. family 配置不再主要描述关键词包，而改为描述证据要求、checkpoint 类型和成功定义。
4. 文本信号只保留为低优先级 audit hint；不能单独驱动 next_status / bucket / business outcome。

技术范围：TypeScript、node:test、现有 build/test 流程（corepack pnpm build / corepack pnpm test）。

已知环境事实：当前目录不是 git repo，所以本计划不包含 git commit 步骤；完成后以文件改动 + 测试结果作为验证。

相关核心文件：
- src/shared/types.ts
- src/shared/task-progress.ts
- src/shared/task-progress.test.ts
- src/execution/takeover.ts
- src/execution/takeover.test.ts
- src/control-plane/task-queue.ts
- src/control-plane/task-queue.test.ts
- src/shared/business-outcomes.ts
- src/shared/business-outcomes.test.ts
- src/families/types.ts
- src/families/saas-directory.ts
- src/families/non-directory.ts


## Task 1：定义统一的 typed facts / typed checkpoints

Objective：给 task-progress、takeover、task-queue 提供同一套结构化事实输入，减少各自重复扫文本。

Files:
- Modify: src/shared/types.ts
- Modify: src/execution/takeover.ts
- Modify: src/shared/task-progress.ts
- Test: src/execution/takeover.test.ts
- Test: src/shared/task-progress.test.ts

新增/调整的数据结构建议：
- TerminalEvidenceFacts
  - has_visible_submit_surface?: boolean
  - has_visible_auth_gate?: boolean
  - has_visible_form_fields?: boolean
  - has_captcha_boundary?: boolean
  - has_paid_boundary?: boolean
  - has_missing_required_inputs?: boolean
  - has_email_verification_checkpoint?: boolean
  - has_live_link_verified?: boolean
  - has_reciprocal_requirement?: boolean
  - publication_state?: "unknown" | "draft_saved" | "submitted_pending" | "published_without_link" | "live_with_verified_link"
  - evidence_confidence?: "low" | "medium" | "high"

Step 1: 写失败测试
- 在 takeover.test.ts 和 task-progress.test.ts 各补至少 1 个测试，断言：
  - generic marketing copy 不能单独生成 typed fact
  - visual/link evidence 可以生成 typed fact

Step 2: 跑单测，确认失败
Run:
- corepack pnpm test -- --testNamePattern='typed facts|marketing copy|visual evidence'
Expected:
- FAIL，提示新字段/新行为尚未实现

Step 3: 最小实现
- 在 types.ts 增加 typed facts 结构
- 在 takeover.ts / task-progress.ts 内新增从现有结构化证据生成 typed facts 的 helper
- 禁止直接从自由文本生成高置信 typed fact

Step 4: 跑针对测试
Run:
- corepack pnpm test -- --testNamePattern='typed facts|marketing copy|visual evidence'
Expected:
- PASS

验证标准：
- typed facts 可以被稳定生成
- raw text 不再直接冒充 structured fact


## Task 2：task-queue 去掉“文本直接驱动 bucket/reason”主路径

Objective：让 task-queue 优先消费 structured outcome / typed facts / wait_reason / skip_reason / visual/link evidence，而不是 inferReasonFromText。

Files:
- Modify: src/control-plane/task-queue.ts
- Test: src/control-plane/task-queue.test.ts

设计要求：
- 优先级顺序改为：
  1. artifact 中的 structured outcome / early_terminal_classifier / visual_verification / link_verification
  2. task.wait.wait_reason_code / task.skip_reason_code / terminal_class
  3. typed facts
  4. 低优先级文本 audit hint（只允许输出 low-confidence note，不允许直接决定 bucket）
- inferReasonFromText 若仍保留，只能返回 audit hint，不应直接返回最终 reason code 参与状态跃迁

Step 1: 写失败测试
至少补 3 个：
1. generic sponsor/pricing copy 不能把 WAITING_RETRY_DECISION 直接打进 terminal_policy
2. stale notes / stale last_takeover_outcome 不能覆盖 fresh wait_reason/status
3. structured early_terminal_classifier / typed fact 存在时，应覆盖文本摘要

Step 2: 跑针对测试确认失败
Run:
- corepack pnpm test -- --testNamePattern='generic sponsor|stale notes|structured early terminal'
Expected:
- FAIL

Step 3: 最小实现
- 在 task-queue.ts 中把 inferReasonFromText 从主决策链里下移
- 如果保留 inferReasonFromText，则返回 audit-only 结果，且必须有显式 guard，不能直接映射 bucket
- buildRetryDecisionPlan 直接吃 structured hints / typed facts

Step 4: 跑针对测试
Run:
- corepack pnpm test -- --testNamePattern='generic sponsor|stale notes|structured early terminal'
Expected:
- PASS

验证标准：
- task-queue 不再因为摘要文案误分桶
- reason/bucket 主要由结构化证据决定


## Task 3：takeover family-specific checkpoint 去词表主导化

Objective：把 forum_profile / wp_comment / dev_blog 的 pending/draft/published/anti-spam 分类，从 containsConfiguredSignal 主导改成 typed checkpoint + evidence 主导。

Files:
- Modify: src/execution/takeover.ts
- Test: src/execution/takeover.test.ts
- Potentially Modify: src/shared/types.ts

设计要求：
- forum_profile：
  - “profile saved” 不能直接算 pending；要结合 live profile path / link verification / visual confirmation / settings surface 等证据
- wp_comment：
  - moderation / anti-spam / published_without_link 需优先依赖 live thread verification、comment surface 证据、link verification
- dev_blog：
  - draft_saved / submitted_pending / published_without_link 需优先依赖 editor state、review queue evidence、public article verification
- containsConfiguredSignal 如保留，只能作为 low-confidence corroboration，不应单独给出 final classification

Step 1: 写失败测试
至少补 4 个：
1. forum_profile 的 generic success sentence 不能直接变 PROFILE_PUBLICATION_PENDING
2. wp_comment 的 generic “thank you” 不能直接变 COMMENT_MODERATION_PENDING
3. dev_blog 的 marketing copy 不能直接变 ARTICLE_DRAFT_SAVED 或 ARTICLE_SUBMITTED_PENDING_EDITORIAL
4. verified_link_present 仍可稳定得到 DONE

Step 2: 跑针对测试确认失败
Run:
- corepack pnpm test -- --testNamePattern='forum_profile|wp_comment|dev_blog|verified non-directory'
Expected:
- FAIL

Step 3: 最小实现
- 抽出 family checkpoint resolver，输入 typed facts / visual / link verification / page assessment
- 把 containsConfiguredSignal 从“主判断器”降成“辅助佐证器”

Step 4: 跑针对测试
Run:
- corepack pnpm test -- --testNamePattern='forum_profile|wp_comment|dev_blog|verified non-directory'
Expected:
- PASS

验证标准：
- takeover family 判定不再主要依赖 body text 命中
- live link verification / page evidence 成为第一判断层


## Task 4：task-progress 继续瘦身，改为只消费 typed facts / status / wait / visual

Objective：让 inferContextType / inferSignals 从“文本模式识别器”进一步收敛成“结构化状态映射器”。

Files:
- Modify: src/shared/task-progress.ts
- Test: src/shared/task-progress.test.ts

设计要求：
- context_type 的主要输入应为：
  - typed facts
  - wait_reason_code
  - taskStatus
  - terminalClass
  - visual classification
- title/url/text 最多作为 boundary corroboration 或 audit evidence，不再自己产生主要 state signal
- signal 输出改为：
  - 结构化 signal
  - typed fact 映射 signal
  - wait/status signal
  - 低优先级 audit signal（如需）

Step 1: 写失败测试
至少补 3 个：
1. landing page marketing copy 不能生成 confirmation_surface / auth_surface / submit_surface
2. stale title/body text 不能让 READY/RUNNING surface 漂移
3. typed facts 存在时，应稳定得到正确 context_type / evidence signal

Step 2: 跑针对测试确认失败
Run:
- corepack pnpm test -- --testNamePattern='marketing copy|surface drift|typed facts'
Expected:
- FAIL

Step 3: 最小实现
- 给 inferContextType / inferSignals 增加 typed facts 输入
- 删除或下移依赖 raw text 的主判定逻辑

Step 4: 跑针对测试
Run:
- corepack pnpm test -- --testNamePattern='marketing copy|surface drift|typed facts'
Expected:
- PASS

验证标准：
- task-progress 只反映结构化状态，不再被宣传文案牵着走


## Task 5：families 配置从 signal arrays 转成 semantic contract

Objective：把 families/*.ts 从“关键词词表包”重构为“证据要求 + checkpoint contract”。

Files:
- Modify: src/families/types.ts
- Modify: src/families/saas-directory.ts
- Modify: src/families/non-directory.ts
- Potentially Modify: consumers in task-progress / takeover / task-queue

建议的新配置形态：
- FamilySemanticContract
  - requires_live_link_verification_for_success: boolean
  - supported_checkpoints: string[]
  - pending_checkpoint_types: string[]
  - resumable_checkpoint_types: string[]
  - policy_boundary_types: string[]
  - terminal_success_requires: string[]
  - allowed_evidence_sources: string[]

保留：
- completeness / dossier requirements
- auth / anti-bot / evidence semantics

删除或显著弱化：
- submitSignals
- formSignals
- authSignals
- confirmationSignals
- terminalSuccessSignals
- pendingSignals
- publishedSignals
- draftSignals

Step 1: 写失败测试
- 给至少一个 family contract consumer 写测试，验证新 contract 可被消费，旧 signal array 不再是必须字段

Step 2: 跑测试确认失败
Run:
- corepack pnpm test -- --testNamePattern='family contract|semantic contract'
Expected:
- FAIL

Step 3: 最小实现
- types.ts 改 interface
- saas-directory.ts / non-directory.ts 改配置结构
- 更新所有消费者

Step 4: 跑针对测试
Run:
- corepack pnpm test -- --testNamePattern='family contract|semantic contract'
Expected:
- PASS

验证标准：
- family 配置表达的是“语义 contract”，不是“词表包”


## Task 6：business-outcomes 对 typed checkpoints 对齐

Objective：让 business outcome 总结继续以结构化 checkpoint 为主，而不是通过历史 wait/text 间接猜。

Files:
- Modify: src/shared/business-outcomes.ts
- Test: src/shared/business-outcomes.test.ts

设计要求：
- non-directory family 的 success / unknown / review 分类继续优先吃 verified_link_present 和 publication_state
- WAITING_RETRY_DECISION / RETRYABLE 的归类不要被旧文本污染
- outcome summary 对 pending / draft / published_without_link 的区分，要与新的 family contract 一致

Step 1: 写失败测试
至少补 2 个：
1. publication_state=draft_saved 不应进入 submitted_success
2. live_with_verified_link 应稳定进入 submitted_success

Step 2: 跑针对测试确认失败
Run:
- corepack pnpm test -- --testNamePattern='publication_state|verified_link_present'
Expected:
- FAIL

Step 3: 最小实现
- business-outcomes 读取 typed checkpoint / link verification / family contract

Step 4: 跑针对测试
Run:
- corepack pnpm test -- --testNamePattern='publication_state|verified_link_present'
Expected:
- PASS

验证标准：
- business outcome 与新的 evidence-first 语义保持一致


## Task 7：补第三轮 anti-misclassification 回归墙

Objective：用反误判测试把哲学固化，防止以后再次回退到词表驱动。

Files:
- Modify: src/shared/task-progress.test.ts
- Modify: src/execution/takeover.test.ts
- Modify: src/control-plane/task-queue.test.ts
- Modify: src/shared/business-outcomes.test.ts

必须覆盖的误判样本：
1. marketing copy 噪声
- submit your tool
- thank you
- continue with google
出现在 landing page copy 中

2. sponsor/pricing 噪声
- sponsored by stripe
- analytics starts at $49
- subscription for readers

3. family 错位语义
- forum_profile 上出现 directory thank-you phrase
- wp_comment 上出现 generic success phrase
- dev_blog 上出现 draft/publish marketing copy

4. stale pollution
- stale wait_reason_code
- stale notes
- stale last_takeover_outcome

5. insufficient evidence
- 证据不足时必须落到 conservative outcome，而不是自信推进

Step 1: 逐组加测试
Step 2: 每组测试先单跑，确认 FAIL
Step 3: 修实现
Step 4: 单跑通过

Run:
- corepack pnpm test -- --testNamePattern='marketing copy|sponsor|pricing|stale|insufficient evidence|family'

验证标准：
- 误判样本全被拦住


## Task 8：最终验证

Objective：确认第三轮改造整体稳定，没有回归。

Files:
- No code changes expected

Step 1: 跑 build
Run:
- corepack pnpm build
Expected:
- PASS

Step 2: 跑第三轮新增针对性测试
Run:
- corepack pnpm test -- --testNamePattern='typed facts|semantic contract|marketing copy|sponsor|pricing|stale|family|publication_state'
Expected:
- PASS

Step 3: 跑全量测试
Run:
- corepack pnpm test
Expected:
- PASS

完成定义：
- 不再有任何 raw text matcher 可以单独主导：
  - terminal_success
  - manual_auth
  - policy
  - paid
  - pending
  - published
  - draft
  这些业务状态跃迁
- raw text 最多只能作为 audit hint / corroboration
- family 配置主要表达 semantic contract，而不是 signal arrays
- 全量测试通过


## 风险与注意事项

1. 不要一次性大改所有 family；先从 task-queue / takeover / task-progress 的消费侧切入，再反推配置收口。
2. 所有“看起来只是换字段名”的重构，也必须先写失败测试，不要跳过 RED。
3. 一旦出现第三次以上连续修补还在冒新耦合点，要停下来重新审视 contract 设计，而不是继续堆 patch。
4. 对 non-directory family，live link verification 仍然是最高优先级成功证据，不要被任何文本信号覆盖。


## 推荐执行顺序

1. Task 2：task-queue
2. Task 3：takeover
3. Task 4：task-progress
4. Task 5：families semantic contract
5. Task 6：business-outcomes 对齐
6. Task 7：anti-misclassification 回归墙
7. Task 8：最终验证

这样排的原因：先消灭最终分流器，再消灭 takeover 主分类器，再收 families 配置；可以最大化减少中间回归面。