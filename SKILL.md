---
name: web-backlinker-v3-operator
description: "Operate BacklinkHelper V3 through one consolidated skill package: bounded single-task execution, campaign/queue drain modes, runtime fallback playbooks, and necessary runtime facts under one thin entry point."
version: 1.3.2
metadata:
  hermes:
    tags: [backlink, operator, browser-automation, bounded-work, thin-skill]
    category: openclaw-imports
---

# Web Backlinker V3 Operator

## When to Use

Use this skill when:
- 需要在 BacklinkHelper V3 里执行一个 bounded 的单站点 backlink submission task（可落在 directory / forum profile / WP comment / dev blog article 等 family）。
- 需要在同一套 V3 runtime 下执行 campaign / queue drain / guarded drain / READY queue drain，只是不希望再暴露额外 sibling skills。
- 任务目标由自然语言 brief 定义，而 skill 只负责稳定护栏、最小完备工具集、必要事实与对内支撑文档索引。
- 需要在 repo-native `task-prepare -> browser-use / evidence -> task-record-agent-trace -> task-finalize` 闭环内完成一次 operator tick，或围绕这个闭环搭建批量运行模式。
- 需要维护 runtime 的“evidence-first / text-audit-only”哲学，避免让自由文本重新主导 bucket、terminal state 或 family checkpoint 判定（见 `references/runtime-philosophy-hardening.md`）。

Do not use it for:
- 纯 campaign 策略设计、调度架构讨论、与当前 runtime 无关的抽象产品规划。
- 把具体站点案例经验写成通用操作手册并继续堆厚 `SKILL.md`。
- 与 BacklinkHelper V3 runtime 无关的独立研发任务。

## Overview

这是 V3 的统一入口 skill，不是把每一种运行变体再拆成平级 skill 的目录。

它只做三件事：
- 校准 agent 在 backlink 提交任务中的思考方式
- 说明最小完备工具集及其能力边界
- 说明必要的客观事实与安全边界

它不负责替 brief 规定 campaign 策略。

v3 的基本原则是：
- 用自然语言 brief 定义目标、优先级、允许/禁止边界、资源来源、输出要求
- 用 skill 提供稳定护栏
- 用 repo 状态层保存执行记忆
- 用 runtime kernel 只承担生命周期、状态机、验证与安全边界；family-specific cues 应进入 family config，而不是继续长成核心代码里的经验分支

当前 skill 主体内已 vendored 一份裁剪后的 backlinkhelper runtime，位于 `assets/backlinkhelper/`（通常解析为 `~/.hermes/skills/openclaw-imports/web-backlinker-v3-operator/assets/backlinkhelper/`）。除非用户明确指定其他同步 clone，否则默认把这份 bundled runtime 当作 repo root。

与 V3 直接相关的批量运行、异常兜底、post-run 复盘辅助、runtime 语义与演进说明，统一下沉在本 skill 包内部：
- `references/run-modes/queue-and-guarded-drain.md`
- `references/runtime-fallbacks.md`
- `references/post-run-review-helper.md`
- `references/runtime-semantics.md`
- `references/dev/runtime-evolution.md`

这些内容现在属于同一个 skill 的支撑层，不再作为平级 sibling skills 暴露。

## Strategy Philosophy

### 1. 目标优先于流程

优先追求：
- 成功提交
- 否则正确收口
- 不制造脏状态

不要为了“继续尝试”而继续尝试。

### 2. 让证据驱动判断

优先围绕这些状态原语思考：
- frontier
- blockers
- evidence
- discovered_actions
- reusable_fragments

不要依赖站点经验故事或固定模板来替代判断。
不要用 source-only 临时脚本、硬编码关键词词表或 click choreography 去框定真实站点上的提交流程；脚本最多只负责 queue cadence、artifact 收集、状态读写等确定性外壳，站点入口发现、页面理解、下一步动作选择必须回到 agent 基于 fresh DOM / link candidates / screenshot / visual evidence 的现场判断。

### 3. 低置信时先补证据

当页面可达但语义不清时：
- 优先补充截图、DOM、页面文本、当前 URL、可见 CTA、iframe/modal/overlay 线索
- 再决定继续推进、正确分流、还是停止

不要在低置信状态下凭经验硬判。

### 4. 单任务 bounded work

每次 invocation 只处理一个 bounded site task。
批量执行靠 queue / dispatcher / 多 worker 完成，不靠单个长会话吞多个 URL。

### 4.5 前端失灵时，先做一次 bounded reverse-engineering

如果目标明显是真实 submit / register / vote / profile surface，且失败点主要是前端交互层：
- 按钮点不动
- modal 不弹
- 多 input 组件不吃自动化输入
- XHR 提交前端链路失效

不要立刻把它当作“站点不可做”。

优先做一次 bounded reverse-engineering：
- 看 inline scripts / bundle 里暴露的 endpoint 线索
- 看表单真实 action、hidden inputs、XHR/fetch 目标
- 看当前 session / cookie 下是否存在同语义的后端入口

但边界要清楚：
- 只允许继续同一个站点原本就提供的公开业务动作
- 不猜测未知参数，不暴力 fuzz，不越过付费/验证码/人工认证硬边界
- 如果 API 路径仍然不清楚，或继续会制造脏状态，就停止并正确收口

### 5. 记忆外置，不靠长上下文

执行记忆必须进入 repo 状态层，而不是依赖聊天上下文延续：
- trace
- execution_state
- playbook / fragment
- account / credential
- artifacts

## Minimal Complete Toolset

下面这些能力构成 v3 的最小完备工具集。
描述的是能力边界，不是固定用法剧本。

### 1. browser-use CLI

主交互推进层。

用途：
- 页面探索
- CTA 点击
- 表单推进
- 注册 / 登录后的继续动作
- 提交动作前的交互推进

### 2. Shared CDP Chrome on 9224

统一浏览器 runtime。

用途：
- 让主交互、scout、replay、finalize 共享同一浏览器状态基座

### 3. Playwright

辅助控制与 authoritative 收口层。

用途：
- scout
- replay
- finalize
- runtime health-check
- 证据确认 / 截图补全

不要把 Playwright 当默认主交互层。

### 4. Visual assistance

视觉识别辅助属于最小完备能力的一部分。

它是证据补全能力，不是默认主路径。

当文本证据不足、页面状态低置信或需要可视确认时，可调用 agent 原生视觉能力补证。

若 brief 对视觉确认口径有明确覆盖，以 brief 为准。

### 5. Google Workspace skill

标准邮件与验证链路入口。

用途：
- 验证码邮件
- magic link
- 确认邮件
- 提交通知
- 账号注册后的邮箱链路处理

它属于正式主路径能力，不是补救旁路。

实践补充：
- 不要把 `gog` 二进制是否存在当成唯一判断。某些运行环境里 `gog` 不在 PATH，但 bundled repo 的 `mailbox-triage` 仍可通过已安装的 Google Workspace skill / Gmail adapter 正常工作。
- 当 shell 里直接跑 `gog ...` 失败时，优先改用 bundled repo 命令 `corepack pnpm mailbox-triage -- ...` 做候选邮件筛选；若还需要读取正文/HTML，调用已安装的 Google Workspace skill 暴露的 Gmail search/get 能力，不要再硬编码依赖其他 skill 的脚本路径。
- `mailbox-triage` 会为了召回率混入 `recent_unread` 候选，因此它适合“先找可疑邮件”，不适合单独作为“严格 query 命中/未命中”的最终裁决。若任务需要写回“没有该站验证邮件”这类 authoritative 结论，应通过已安装的 Google Workspace skill 再做一次 exact query confirm；若 `mailbox-triage` 有候选而精确 search 为空，应以精确 search 结果为准，并把 `mailbox-triage` 候选视为噪声而不是站点邮件命中。

### 6. Bundled backlinkhelper runtime

skill 主体内已包含一份裁剪后的 backlinkhelper repo，用于迁移与维护便利。

路径：
- `assets/backlinkhelper/`

保留内容：
- `dist/`
- `src/`
- `scripts/`
- `README.md`
- `package.json`
- `pnpm-lock.yaml`
- `tsconfig.json`

默认规则：
- 若没有其他显式指定 repo root，就把这份 bundled runtime 当作 canonical repo root。
- 跑 `task-prepare` / `task-record-agent-trace` / `task-finalize` / `mailbox-triage` 这类 repo-native 命令时，优先在这份 bundled runtime 下执行。
- 这份 vendored repo 用于代码与 CLI 维护，不用于承载 live data / node_modules / tmp / .git 历史。

### 7. Repo state layer

统一持久化执行状态。

用途：
- 保存 trace / execution_state / artifacts
- 沉淀 playbook / fragment
- 保存 account / credential 关联
- 支持跨短会话连续推进

## Necessary Facts

以下是 v3 operator 的必要事实说明。
它们是推理原料和硬边界，不是经验剧本。

### Default campaign boundaries

除非用户在本次 brief 中明确覆盖，否则默认按以下 campaign 边界执行：

- 一直允许自动注册
- 一直允许邮箱验证码 / magic link
- 一直允许 Google chooser / OAuth 继续
- 默认优先成功率：在不突破硬安全边界的前提下，优先继续推进并尽量把任务推到更深一层，而不是过早保守收口
- 遇到人工认证相关表面时，优先继续走到更深一层；只有在已经拿到足够证据证明无法继续自动推进时，才收口到人工相关状态
- 成功定义默认是“成功提交即完成”：只要页面给出明确 submission accepted / pending review / awaiting approval / thank-you-for-submitting 等强确认信号，就应按业务成功处理；目录站后续人工审核、是否最终上线、审核耗时都不属于本 skill 的完成判定范围
- 进一步地，在业务上以“模拟真人视角”判断时，强视觉确认 + 无明显报错/验证码/登录阻塞，也应默认视为成功提交；不要因为前端是 client-side thank-you state 就机械降回 `OUTCOME_NOT_CONFIRMED`
- 但这条“提交即完成”的默认口径主要适用于 directory family。对 `forum_profile` / `wp_comment` / `dev_blog` 这类非 directory family，业务成功应优先看 public/live backlink 是否已验证存在；如果只有“submitted / pending / waiting_site_response”而没有 live link evidence，默认不要直接算成最终成功，应收口到需要复核或继续验证的结果层。
- 默认汇报只需要汇总；同时应尽量留下可复查的明细文件（trace / artifacts / repo 状态 / 必要时独立结果文件）

### Runtime facts

保留在 skill 本体中的，只应是稳定 runtime invariants 与判断优先级：

- 浏览器端口只用 `http://127.0.0.1:9224`
- 每个任务必须使用 task-scoped browser-use session
- 单任务默认 timebox：10 分钟
- 默认：1 URL = 1 worker session
- 默认 repo root 为 skill 主体内的 bundled runtime：`assets/backlinkhelper/`；只有在用户明确指定其他同步 clone 时才覆盖
- 共享浏览器 / Playwright runtime 异常时，先做 health-check 与清理，不要把 runtime 故障误判成站点失败
- fresh 健康会话中的 DOM / screenshot / 当前 URL / 可见字段，优先级高于旧 scout、旧 artifact 或历史低置信结论
- 当结论主要依赖截图或视觉判断时，必须补足 `visual_verification` 并一并写回 trace / finalize
- 对 `forum_profile` / `wp_comment` / `dev_blog` 一类 surface，`task-finalize` 阶段应优先补一轮 shared link verification：记录 live page URL、target link URL、anchor text、visibility、rel flags（如 `ugc` / `nofollow` / `sponsored`），再决定 business outcome。不要只凭 submit 成功页或 pending 文案就宣布任务业务成功。
- 非 directory family 的阶段语义要分清：`forum_profile` 的 `profile updated / changes saved` 只是 `PROFILE_PUBLICATION_PENDING`；`wp_comment` 的 `awaiting moderation / comment submitted` 只是 `COMMENT_MODERATION_PENDING`，若 live comment 出现但链接没落地应视为 `COMMENT_PUBLISHED_NO_LINK`，反垃圾/反滥用表面（如 Akismet/CleanTalk 类信号）应优先归到 policy/review 层；`dev_blog` 的 `draft saved` 只是 `ARTICLE_DRAFT_SAVED`，`submitted for review` 只是 `ARTICLE_SUBMITTED_PENDING_EDITORIAL`，`published` 但没目标链接应视为 `ARTICLE_PUBLISHED_NO_LINK`。只有 verifier 命中 live backlink，才应把这些 family 收口成最终成功。
- `community/content host` 不能只按 hostname 粗暴打回 community-strategy：当 `flow_family` 已明确是 `forum_profile` / `wp_comment` / `dev_blog` 时，应优先尊重 family contract 继续执行；同理，强视觉 confirmation 直接判成功的默认口径只适用于 directory family，不应把它机械套到 `wp_comment` / `forum_profile` / `dev_blog`。
- 多 family 扩展时，优先一次性补共享 substrate：shared verifier、business outcome 口径、missing-input schema、finalize persistence。若 dossier/update CLI 现有机制已能泛型承载新字段，就不要为了“看起来完整”机械改动这些文件。
- Phase C 的共享命名约定已经中性化：completeness 层统一用 `flow_ready` / `missing_flow_fields` / `flow_ready_fields`，execution-state form fragment 统一用 `frag_form_surface_v1`；后续不要把新的 family 扩展再写回 `directory_ready*`、`missing_directory_fields`、`frag_listing_form_v1` 这类旧词汇。
- CLI 输入面也已切成“中性 canonical + 兼容 alias”模式：默认使用 `--target-url`，`--directory-url` 仅作为 legacy alias；README/example/brief 若需要演示多 family，用 `--target-url` + `--flow-family` 明示 family contract，同时保持旧调用不被打断。
- Playwright、视觉辅助、mailbox 能力是 authoritative 补位与 continuation 能力，不是默认主交互层
- 遇到 tab 污染、截图/状态分裂、captcha/auth/register gate、表单状态失真、paid/policy surface、finalize 偏差等细分异常时，查阅 `[references/runtime-failure-taxonomy.md](references/runtime-failure-taxonomy.md)`；这些内容属于 case taxonomy，不应继续堆回核心 skill 正文

### Queue / activation facts

- 如果当前 queue 没有 READY 任务，不要“假装有 READY”并直接开打
- 先做 campaign 级 preflight，确认 unresolved_fields 等阻塞项
- 只有在 preflight 证明输入充分后，才从 WAITING_RETRY_DECISION 等候选中挑高概率任务重新激活
- 重新激活应优先选择：传统 directory submit flow、无 captcha、无硬付费墙、此前主要因为证据不足而停下的站点

### Safety / policy facts

默认禁止：
- 付费决策
- CAPTCHA bypass / managed human verification 代做
- 2FA / passkey / 手机确认
- 隐藏 input 注入
- 绕过 repo 的 lease / ownership / finalize 语义

### Persistence facts

每个任务都必须：
- 留 trace
- 留 handoff
- 调 `task-record-agent-trace`
- 调 `task-finalize`
- 把结果写回 repo 状态层
- 如果是手工组装 operator envelope，`handoff.agent_trace_ref` 要指向 repo 最终 trace artifact 路径（即 `task-record-agent-trace` 会写入的标准 artifact 路径），不要指向临时 runtime envelope 文件；否则 execution_state / evidence_refs 可能落到不存在的路径
- 若 `task-prepare` 已经把任务 stop / settle / replay 到非 agent-loop 终点，也仍要做一次 post-prepare 验证；在 repo 没有现成 `show-task` CLI 时，直接读取 `data/backlink-helper/tasks/<taskId>.json` 作为 authoritative task state，确认 `status`、`wait`、`terminal_class`、`execution_state` 是否已正确写回，而不是只凭 prepare 命令 stdout 做口头判断

不允许无痕失败。

## Run Contract

v3 保留最小运行闭环：

1. 获取一个待执行 task（通常来自 queue / dispatcher）
2. `task-prepare`
3. 若任务已在 prepare/replay 阶段收口，则退出
4. 若进入主交互阶段，则用 browser-use CLI 推进
5. 形成 trace + handoff
6. `task-record-agent-trace`
7. `task-finalize`
8. 退出

这个闭环是稳定护栏，不是 campaign 策略说明。

## Support Docs / Consolidated Layout

为了保持单入口而不把 `SKILL.md` 写厚，下面这些内容全部作为本 skill 的包内支撑层维护：

### A. 运行前必读 / 作战知识
- `references/iron-rules.md`
  - operator 铁律；真实跑站前先过一遍
- `references/learning-loop.md`
  - 跑站经验如何从 task/artifact/playbook 升级到 references/docs 的正式沉淀机制
- `references/post-run-review-helper.md`
  - 每次有价值 run 后的 3~5 分钟复盘模板；帮助把经验路由到正确容器
- `references/accounts.md`
  - submitter identity、mailbox、OAuth、alias、账号隔离策略
- `references/platforms.md`
  - 按 surface family 组织的平台/表面速查
- `references/dofollow-notes.md`
  - dofollow / nofollow / ugc / sponsored 的实测口径
- `references/families/forum-profile.md`
- `references/families/wp-comments.md`
- `references/families/dev-blog.md`
- `references/patterns/anti-spam.md`
- `references/patterns/reverse-eng.md`
- `references/verification/link-verification.md`
- `references/runtime-failure-taxonomy.md`
- `references/brief-template.md`
- `references/dossier-template.md`
  - 正式提交前的 dossier / submitter defaults 模板与 missing-input gate

### B. 运行模式
- `references/run-modes/campaign-drain.md`
  - campaign / queue drain / guarded drain / READY queue drain

### C. runtime fallback
- `references/runtime-fallbacks.md`
  - manual probe、manual envelope、maintenance page、captcha evidence、native validity 等 fallback

### D. runtime semantics and evolution
- `assets/backlinkhelper/docs/runtime-semantics.md`
  - V3 的稳定 runtime 语义、classifier / queue / business outcome 分层
- `assets/backlinkhelper/docs/runtime-evolution.md`
  - classifier / queue / finalize 相关改造的保留开发说明与 TDD 演进笔记

默认原则：
- 能力属于 V3 主入口，但细节只要不是所有运行都必需，就优先下沉到这些 support docs
- 跑真实站点前，先读 `references/iron-rules.md`，再按 family / pattern / fallback 需要查阅对应 reference
- 不要因为某个运行变体、兜底分支或 phase 改造存在，就再拆回新的 sibling skill

## Expected Brief Schema

自然语言 brief 应说明：
- 目标
- 成功优先级（如果本次要覆盖默认成功率优先策略）
- 允许 / 禁止边界（如果本次要覆盖默认 campaign 边界）
- 视觉触发偏好（如果本次要覆盖默认“低置信再补视觉”的策略）
- promoted profile / submitter email / mailbox 资源来源
- 执行范围（queue 或站点清单）
- 输出要求（如果本次要覆盖默认“汇总 + 可复查明细文件”）

如果 brief 没有显式覆盖，则沿用本 skill 的默认 campaign 边界。
如果 brief 与旧经验冲突，以当前 brief + repo 事实边界为准。

参考模板见：[references/brief-template.md](references/brief-template.md)

## Pitfalls

- 不要把旧 scout / 旧 artifact / 旧 finalize 结论覆盖 fresh 健康会话中的一手证据。
- 不要把 runtime 污染、tab 污染、viewport 异常、截图链路失稳误判成站点失败。
- 不要因为 skill 已经积累了大量必要事实，就继续把单站点个案、偶发故障、局部 workaround 直接堆回 `SKILL.md`；优先放入 repo docs、playbook、fragment、execution_state 或 casebook。
- 不要把 Playwright、视觉辅助或 mailbox 工具升格成固定主路径；它们应服务于证据确认、authoritative 补位和必要 continuation，而不是替代证据驱动判断。
- 不要为了“多推进一步”而编造资料、越过付费/验证码/人工认证边界，或绕开 repo 的 prepare/trace/finalize 语义。

## Verification

在把一次 bounded operator tick 视为完成前，至少确认：
- 任务已经经过 `task-prepare`，并根据 prepare 结果正确进入退出、主交互或后续 finalize 路径。
- 若进入主交互阶段，已经留下足够的 trace / handoff / operator-evidence，且低置信视觉结论已补足 `visual_verification`。
- 已调用 `task-record-agent-trace` 与 `task-finalize`，没有无痕失败。
- 对 `forum_profile` / `wp_comment` / `dev_blog` 等非 directory family，repo 状态或 finalize artifact 中能看到 authoritative 的 `link_verification` 结果；若只有 submit/pending 信号而没有 live link evidence，不应把它当作最终业务成功。
- repo 状态层中能看到 authoritative task state 回写；必要时直接检查 `data/backlink-helper/tasks/<taskId>.json` 的 `status`、`wait`、`terminal_class`、`execution_state`。
- 若最终汇报与 repo 最终状态存在偏差，已明确区分“operator 实测结论”与“repo 当前最终收口”。

## What Must Stay Out of This Skill

以下内容不应进入 v3 skill：
- 具体站点案例故事
- 大量视觉提问模板
- “某类页面通常怎么做”的经验脚本
- 本应由 repo 状态承载的执行记忆
- vendored repo 之外的大体量运行垃圾：`data/`、`node_modules/`、`tmp/`、`.git/`、临时 runtime artifacts
- 把 campaign drain、runtime fallback、phase 演进这类本可下沉到包内 docs/references 的内容再拆回平级 sibling skills

如果某类经验已经稳定，应优先进入：
- references/runtime-failure-taxonomy.md（运行时异常分类与细分 heuristics）
- references/families/forum-profile.md、references/families/wp-comments.md、references/families/dev-blog.md（family 经验）
- references/patterns/anti-spam.md、references/patterns/reverse-eng.md、references/verification/link-verification.md
- repo docs
- playbook / fragment
- execution_state

而不是继续把 skill 写厚。
