---
name: web-backlinker-v3-operator
description: "Operate BacklinkHelper V3 through one consolidated skill package: bounded single-task execution, campaign/queue drain modes, runtime fallback playbooks, and necessary runtime facts under one thin entry point."
version: 1.3.4
metadata:
  hermes:
    tags: [backlink, operator, browser-automation, bounded-work, thin-skill]
    category: openclaw-imports
---

# Web Backlinker V3 Operator

## Runtime Facts

- Runtime entrypoint rule: the active V3 mainline runs under Hermes Agent / operator flow. Any old OpenClaw cron compatibility path (`ensure-openclaw-cron`, `openclaw-cron`) should be treated as removed legacy, not as an alternative production entrypoint.
- Follow-up lane rule: `follow_up` is now a lightweight continuation lane, not just an email mailbox poller. It can (a) reactivate `WAITING_EXTERNAL_EVENT` tasks from Gmail evidence, including both `magic_link` and `verification_code` continuations, and (b) run positive-only lightweight `WAITING_SITE_RESPONSE` public-page rechecks that only promote to `DONE` on verified live-link evidence and otherwise restore the original waiting checkpoint.
- Continuation contract rule: email verification continuations belong in runtime/task state, not in SKILL.md choreography. Persist them on the task (for example `email_verification_continuation`) with source message metadata, observed timestamp, suggested target URL, and code/magic-link payload as applicable; expose that state through `task-prepare` so the next active run can continue without depending on chat memory.
- Queue/reporting rule: keep follow-up outcome visibility in runtime reporting. `guarded-drain-status` should expose a dedicated `follow_up_report` (for example magic-link hits, code-only hits, site-response verified, site-response still waiting) rather than burying those outcomes in generic lane totals.
- Family audit rule: flow-family provenance belongs in task/state schema, not in post-hoc operator storytelling. Preserve fields such as `flow_family_source`, `flow_family_reason`, `flow_family_updated_at`, `corrected_from_family`, and `enqueued_by` so re-enqueue corrections stay forensically traceable.
- Finalization/link-verifier integrity rule: under shared-CDP/browser-use flows, treat finalization as authoritative only when the active page host still matches the task-bound host (`handoff.current_url` / `task.hostname`). If the host drifted to another site/tab, refuse to persist `link_verification`, return a retryable context-mismatch outcome, and clear any stale verifier payload instead of falling back to the old task JSON value.
- CAPTCHA solver telemetry is currently written through `captcha_solver_attempt` in finalization artifacts.
- Structured `captcha_kind` values currently cover `recaptcha_v2`, `recaptcha_v3`, `turnstile`, `image_to_text`, and `aws_waf`.
- Image CAPTCHA and AWS WAF recognition may now follow official CapSolver recognition tasks (`ImageToTextTask`, `AwsWafClassification`) when the runtime can capture the required visible challenge images reliably.
- hCaptcha and generic Cloudflare managed-challenge detections may still appear only in free-text evidence (`visual_verification.summary`, runtime envelope excerpts, terminal/detail fields) rather than a normalized type field.
- If you need per-verification-type pass-rate analytics, add a normalized verification telemetry layer first rather than inferring solely from historical prose.
- Queue identity is now guarded by an enqueue-time duplicate preflight: V3 compares historical tasks by `promoted_profile.hostname + target exact hostname` before creating a new task.
- The duplicate preflight is intentionally exact-host based, not root-domain based: `saashub.com` and `community.saashub.com` are different buckets, while repeated submissions to the same exact hostname reuse/reactivate/block the existing task instead of creating a parallel duplicate.
- When a duplicate exact-host match is found, `enqueueSiteTask()` returns a structured result (`accept_new_task`, `reused_existing_task`, `reactivated_existing_task`, or a blocked outcome) so queue/import layers can audit what happened without inferring from free-text logs.

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
- 不猜测未知参数，不暴力 fuzz，不越过付费/人工认证硬边界；验证码默认也视为硬边界，除非当前 runtime 已明确配置并允许官方 CapSolver API 解题路径（包括 token 型与受支持的 recognition 型任务，如 `ImageToTextTask` / `AwsWafClassification`），并且后续推进仍可在 evidence-first 前提下完成
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
- 当前 runtime `preflight` 已将 Google Workspace / gws `setup.py --check` 纳入硬门禁：若邮箱能力未授权、token 失效或 refresh 失败，`preflight.ok` 应为 `false`，guarded-drain 也应直接报 `runtime unhealthy`，不要在授权失效时继续把 runtime 视为可执行。
- 对任何可能触发注册验证 / magic link 的 unattended queue 或 batch，preflight 还应检查用户是否已提供 Gmail backup 邮箱；若没有，就先 ask user once，不要等站点卡在收信阶段才补问。
- 若站点先使用自定义域名邮箱进入验证链路，但 resend + authoritative exact mailbox confirm 后，在默认首轮 2 分钟观察窗内仍收不到邮件，应把该站点优先视为域名邮箱 deliverability 可疑；若用户已提供 Gmail backup 邮箱，优先切到该 Gmail 身份从干净注册路径重做。这里的 2 分钟是默认运营阈值，不是全局不可覆盖的核心硬门禁；若当前 brief / runtime 对特定站点有更可靠窗口，应以更具体设置为准。bundled runtime 当前使用环境变量 `BACKLINK_EMAIL_FALLBACK_WAIT_SECONDS`（默认 120）作为该窗口，并会在 `task-prepare` 输出里显式暴露 Gmail fallback 注册草稿与等待秒数，供 operator 在站点明确拒绝域名邮箱或超时未收信时立即切换。
- 新近实战坑：`update-promoted-dossier` 目前主要更新 `profile.dossier_fields`，但 `missing-input-preflight` / init-gate 对 core fields 仍优先读 profile 顶层（如 `contact_email`、`primary_category`）。因此若你是靠 dossier update 回填 core fields，别只看 `dossier_fields` 里已经有值；要再确认顶层 profile JSON 也同步了这些字段，否则 preflight 仍可能误报 core missing。
- 相关连锁坑：队列任务在 enqueue 时会把 `submission.promoted_profile` 快照写进 task JSON。若你在 enqueue 之后才补 dossier / profile 字段，这些更新不会自动回灌到已入队任务；继续跑 worker 会沿用旧 snapshot。应在开跑前 re-enqueue，或显式把最新 promoted profile 同步回对应 task JSON，再启动无人值守 worker。

### 5.5 CAPTCHA solver integration (CapSolver pattern)

当 runtime 未来需要越过允许范围内的 CAPTCHA / Turnstile / reCAPTCHA 边界时，优先采用“repo 自带的薄 REST client”模式，而不是浏览器扩展或第三方 SDK。

推荐原则：
- 当任务在注册 / 登录后完善资料 / 评论提交 / 表单提交等主路径上命中 CAPTCHA、Turnstile、reCAPTCHA 时，不要立刻把它当作必然 terminal blocker。若当前 runtime 已配置 CapSolver key，且站点类型与参数提取条件满足，应先尝试一次官方 API 方案，再根据结果决定继续推进还是收口。
- 对 simple image CAPTCHA，优先走官方 `ImageToTextTask`：截图当前可见验证码图、直接把返回的 `solution.text` 填回同页可见输入框，然后继续站点原本的主提交动作；若返回空值、低置信垃圾文本、或输入框不接受该值，再按 evidence-first 原则收口。
- 对 AWS WAF 图像题，优先走官方 `AwsWafClassification`：必须先把题面映射到支持的 `question` allow-list，再根据返回的 `objects` / `box` 把动作回放到当前页面。当前已落地的 common path 是 grid/object click 与 point/box click；`distance` 类拖拽/位移题暂未纳入默认支持，命中时不要硬猜，直接收口。
- 优先直接调用 CapSolver 官方 HTTP API：主路径用 `createTask` + `getTaskResult`；仅当 reCAPTCHA 场景确实更合适时，再把 `getToken` 作为可选 fast-path。
- 不要优先依赖文档里列出的第三方 npm / Python / TS SDK。CapSolver 文档已明确说明这些库很多不是官方产物，不能保证安全性或实用性。
- 不要把 CapSolver 浏览器扩展装进共享 Chrome CDP 运行时。BacklinkHelper V3 使用共享浏览器 / 共享 profile，扩展会污染全局状态、增加 worker 串扰与调试复杂度。
- 先做站点侧参数提取，再做 solver 调用，再做 token 注入与回调触发：例如提取 `websiteKey`、`websiteURL`、Turnstile `action/cdata`、reCAPTCHA `pageAction`、`recaptchaDataSValue`、enterprise payload 等。
- solver 成功后，不要只拿 token 就停。必须把 token/cookie/callback 真正注回当前页面，并验证表单/流程是否继续推进；必要时同时写回 `userAgent`、session cookie 或 site-specific callback 数据。
- 真实站点经验（已在 Exact Statement -> Paso Market Walk / Wix site-members 上验证）：对 Wix / site-members 的 reCAPTCHA Enterprise，单纯把 token 写入 `g-recaptcha-response` 往往不够。正确推进链路应优先做：enterprise iframe/anchor 参数提取（至少 `k/sitekey`、enterprise 标记、必要时 `s`）、安全遍历 `___grecaptcha_cfg.clients` 找到与当前 sitekey 对应的内部 callback、同步 checkbox / hidden sink 状态、然后继续点一次站点原本的主提交按钮（如 `Sign Up`）。如果 solve 后已经进入登录后评论态、并能继续提交 comment / publish，则应视为 solver 链路已打通，不要再把这类站点笼统记成 `captcha_blocked`。
- 遍历页面内部 captcha config 时要防守式读取：某些站点的 `___grecaptcha_cfg` 分支会混入 cross-origin frame object；若直接读 `record.sitekey` / `Object.values(record)` 可能抛 `SecurityError`。应做 safe-read / safe-key-iteration，跳过不安全 branch，而不是让整个 solve path 因一个脏分支失败。
- 如果 solve 成功但只完成了“注册/登录后继续推进”，而还没自动完成后续主业务动作（例如评论正文填写 + Publish），要把它归类为“captcha 已打通、post-auth continuation 仍待补齐”，而不是误判成 solver 无效。
- 真实链路补充：对 `wp_comment` family，solve 后若页面已进入登录后评论态（如 `Commenting as ...`），runtime 应继续自动做 post-auth continuation：优先基于当前页面 title/body 生成与正文主题相关、像真实读者会写的 comment；若页面语境拿不到或不足以生成，再回退到 dossier 里的 `comment_body`；最后才退回事实型 fallback（`profile_bio` / `profile_signature` / promoted profile name+url）。默认目标是“相关、克制、非纯营销”，随后自动填写编辑器并点击 `Publish`。实际使用的 comment body 应保存在 task/artifact 级留痕里，不要反写污染 promoted-profile 全局 dossier。不要把这一步继续留给人工补单。
- 若验证码类型暂不支持、页面缺少关键参数、solver 返回失败、或 token 注入后流程仍未继续推进，再按 evidence-first 原则收口，不要无限重试。
- 对 CapSolver API 的访问不要走代理；其文档明确提示代理访问接口可能触发 Cloudflare WAF 封禁。
- 所有 solver 交互都应进入 evidence / trace：至少记录 captcha 类型、提取到的关键参数、solver taskId、注入方式、是否继续推进成功。

首轮实现优先级建议：
- P0：reCAPTCHA v2、Cloudflare Turnstile
- P1：reCAPTCHA v3 / Enterprise 变体
- P2：其他类型按真实队列命中率补齐

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
- 当前 P1-1（版本 A）已落地的调度壳：任务会被划到 `directory_active`、`non_directory_active`、`follow_up` 三个逻辑 lane；`claim-next-task` 支持 `--lane active_any|directory_active|non_directory_active|follow_up`
- 当前版本 A 仍是“单 heavy browser slot”口径：`directory_active` 与 `non_directory_active` 共用 `active` worker lease / 浏览器重资源，不是真双 active 并行；`follow_up` 使用独立 `follow_up` lease，不与 active worker 抢同一个 worker lease
- `guarded-drain-status` 现在会输出 `lane_report` 与 `worker_leases`，默认用它看 lane 盘面，不要只看 status counts
- `follow-up-tick` 是 follow_up lane 的轻量执行入口；当前第一版只自动处理 `WAITING_EXTERNAL_EVENT` + `EMAIL_VERIFICATION_PENDING`：先做邮箱 triage，命中 magic link 就把任务改回 `READY` 并把 `target_url` 切到 magic link；没命中则恢复原 waiting checkpoint，不要粗暴打回 `RETRYABLE`
- 默认 repo root 为 skill 主体内的 bundled runtime：`assets/backlinkhelper/`；只有在用户明确指定其他同步 clone 时才覆盖
- 共享浏览器 / Playwright runtime 异常时，先做 health-check 与清理，不要把 runtime 故障误判成站点失败
- 实战补充：某些运行环境里 browser-use CLI 会继承 `ALL_PROXY` / `HTTP_PROXY` / `HTTPS_PROXY` 等代理变量，并直接报 `Using SOCKS proxy, but the 'socksio' package is not installed`，导致 operator 误以为 browser-use/runtime 本身坏了。若 shared CDP / Playwright 健康而 browser-use 只在命令行脚本里报这个错误，优先把这些 proxy env 清空后再重试 repo-native/browser-use 驱动步骤；不要把这个环境代理问题误判成站点失败。
- fresh 健康会话中的 DOM / screenshot / 当前 URL / 可见字段，优先级高于旧 scout、旧 artifact 或历史低置信结论
- 当结论主要依赖截图或视觉判断时，必须补足 `visual_verification` 并一并写回 trace / finalize
- 经验边界：bundled backlinkhelper runtime 当前的 `src/execution/visual-verify.ts` / captcha fallback 走的是 repo 内自管的 OpenAI-compatible 请求链（读取 `resolveAgentBackendConfig()` / `OPENAI_API_KEY` 风格 env），不是 Hermes tool 层的 `vision_analyze` / `browser_vision` 调用。不要把“Hermes 主会话有视觉能力”自动等同于“bundled runtime 内的 visual-verify 已经 Hermes-native”。若任务要求明确复用 Hermes 原生视觉，需显式搭一层 bridge，而不是只改 repo 内部 env。
- 历史 artifact 里出现 `agent_backend: hermes_operator`、`visual_verification.model: vision_analyze` 的案例，说明曾经存在“外层 Hermes operator 直接补视觉证据”的路径；但这不代表当前 bundled runtime 已原生接上同一链路。区分清楚：artifact/人工 envelope 可用 Hermes-native vision，repo-native `visual-verify.ts` 默认仍是自管 API。
- 实战补充：对 reachable 的 post-submit / post-publication 页面，只要最终收口不是硬成功、硬登录墙、硬验证码，而是 `COMMENT_PUBLISHED_NO_LINK`、`OUTCOME_NOT_CONFIRMED`、模糊 pending/confirmation 之类“需要解释页面当前到底在显示什么”的结果，`task-finalize` 仍可能强制要求 `handoff.visual_verification`。不要以为仅有 DOM 文本、agent trace 里的 proposed outcome、或 link_verification=link_missing 就足够；若缺少 visual_verification，finalize 可能先降成 `VISUAL_VERIFICATION_REQUIRED`。此时应先补一条高置信视觉摘要（例如：页面上确有 live comment，但可见名称/元素未体现 promoted URL），重新 `task-record-agent-trace` 后再 `task-finalize`。
- 进一步的 runtime 细节：即使 handoff 已经带了 `visual_verification`，`task-finalize` 仍可能把任务 authoritative state 落成 `RETRYABLE + VISUAL_VERIFICATION_REQUIRED`。已实测触发条件包括：finalization 阶段抓到的 Playwright title/body 呈低置信或异常态（例如标题变成浏览器/聊天组件噪声如 `1 new message`）、`page_assessment.visual_verification_required=true` 且带有 `post_click_state_unclear` 等歧义标记，而视觉分类又只是 `marketing_or_homepage` / reachable-but-not-confirmed 这类非成功、非硬阻断信号。此时不要误以为“我已经提供 visual_verification，所以 repo 一定会解除 visual blocker”；应以最终 `data/backlink-helper/tasks/<taskId>.json` 为准，并在汇报里明确区分：现场 fresh evidence 可能已经足够说明“无 comment form / 无 live link”，但 repo authoritative 收口仍可能保持 visual blocker 待后续 runtime 处理。
- 新近实测补充：`task-finalize` 的 stdout/detail 还可能直接声称 `no visual verification payload was provided`，但同一个 task 的 `execution_state.evidence` 里其实已经落下 `visual_verification` 条目，说明 payload 在持久化链路中被看见/写回了。遇到这种“stdout 否认 visual payload、task JSON 却已有 visual evidence”时，优先信 authoritative task JSON 与 artifact 内容，并把 stdout 当作误导性症状记录为 runtime bug/异常，而不是据此重跑同样的 operator tick。
- 进一步的新坑：当前 bundled runtime 在 `task-finalize` / `runTakeoverFinalization()` 里，如果 finalization 阶段触发了 solver continuation 且 `capSolverAttempt.solved=true`，会把 `args.handoff.visual_verification` 丢掉（代码路径当前把 `inheritedVisualVerification` 置为 `undefined`），于是即使 operator envelope 明明带了高置信 visual verification、task JSON 之后也能看到 `execution_state.evidence` 里的 visual_verification / verified_link_present，finalization artifact 仍可能继续落成 `RETRYABLE + VISUAL_VERIFICATION_REQUIRED` 并声称“no visual verification payload was provided”。遇到这种组合时，要把它明确记成 runtime bug / persistence mismatch：优先汇报 fresh evidence、finalization `link_verification`、task JSON evidence 三者的一致结论，不要把这类 case误判成 operator 没补视觉证据。
- 对 `forum_profile` / `wp_comment` / `dev_blog` 一类 surface，`task-finalize` 阶段应优先补一轮 shared link verification：记录 live page URL、target link URL、anchor text、visibility、rel flags（如 `ugc` / `nofollow` / `sponsored`），再决定 business outcome。不要只凭 submit 成功页或 pending 文案就宣布任务业务成功。
- 非 directory family 的阶段语义要分清：`forum_profile` 的 `profile updated / changes saved` 只是 `PROFILE_PUBLICATION_PENDING`；`wp_comment` 的 `awaiting moderation / comment submitted` 只是 `COMMENT_MODERATION_PENDING`，并应收口到 `WAITING_SITE_RESPONSE`。实战补充：即使当前 session/pending preview 中已经能看到 comment 内的目标链接、link verification 暂时给出 `verified_link_present`，只要页面信号仍是 pending approval / awaiting moderation，就不能升级为 `DONE`；必须保持 `WAITING_SITE_RESPONSE + COMMENT_MODERATION_PENDING`，直到 public/live 线程里的 comment 和 backlink 真正可验证。若 live comment 出现但链接没落地应视为 `COMMENT_PUBLISHED_NO_LINK`，并默认直接按终态失败收口而不是继续自动重试；反垃圾/反滥用表面（如 Akismet/CleanTalk 类信号）应优先归到 policy/review 层；`dev_blog` 的 `draft saved` 只是 `ARTICLE_DRAFT_SAVED`，`submitted for review` 只是 `ARTICLE_SUBMITTED_PENDING_EDITORIAL`，`published` 但没目标链接应视为 `ARTICLE_PUBLISHED_NO_LINK`，同样默认终态失败收口；只有 verifier 命中 live target link 时，才能视作最终业务成功。 backlink，才应把这些 family 收口成最终成功。
- `community/content host` 不能只按 hostname 粗暴打回 community-strategy：当 `flow_family` 已明确是 `forum_profile` / `wp_comment` / `dev_blog` 时，应优先尊重 family contract 继续执行；同理，强视觉 confirmation 直接判成功的默认口径只适用于 directory family，不应把它机械套到 `wp_comment` / `forum_profile` / `dev_blog`。
- 多 family 扩展时，优先一次性补共享 substrate：shared verifier、business outcome 口径、missing-input schema、finalize persistence。若 dossier/update CLI 现有机制已能泛型承载新字段，就不要为了“看起来完整”机械改动这些文件。
- Phase C 的共享命名约定已经中性化：completeness 层统一用 `flow_ready` / `missing_flow_fields` / `flow_ready_fields`，execution-state form fragment 统一用 `frag_form_surface_v1`；后续不要把新的 family 扩展再写回 `directory_ready*`、`missing_directory_fields`、`frag_listing_form_v1` 这类旧词汇。
- CLI 输入面也已切成“中性 canonical + 兼容 alias”模式：默认使用 `--target-url`，`--directory-url` 仅作为 legacy alias；README/example/brief 若需要演示多 family，用 `--target-url` + `--flow-family` 明示 family contract，同时保持旧调用不被打断。
- `flow_family` 的真相是 enqueue-time caller 决定（例如外层 agent / dispatcher 调 `enqueue-site --flow-family ...`），不是 runtime 现场重新推断；如果没传，runtime 会默认回落到 `saas_directory`。因此复盘分类问题时，要先区分“显式打标”与“默认回退”。
- 审计 live queue / `flow_family` 时，优先查看已安装 skill/runtime 的真实数据目录（通常是 `~/.hermes/skills/openclaw-imports/web-backlinker-v3-operator/assets/backlinkhelper/data/backlink-helper/tasks/`），不要只看工作副本/clone 下的 `assets/backlinkhelper/data/...`；后者可能是空的或不是当前生产链路。
- 当前 task schema 只持久化 `flow_family`，不记录 `flow_family_source` / `enqueued_by` / `family_reason`。因此：`wp_comment` / `forum_profile` / `dev_blog` 这类非默认 family 可视为上游 enqueue 显式打标；但 `saas_directory` 无法仅凭 task JSON 区分“显式选择”还是“漏传后走默认回退”。做 family 审计时必须把这层不确定性单独说明。
- Playwright、视觉辅助、mailbox 能力是 authoritative 补位与 continuation 能力，不是默认主交互层
- 遇到 tab 污染、截图/状态分裂、captcha/auth/register gate、表单状态失真、paid/policy surface、finalize 偏差等细分异常时，查阅 `[references/runtime-failure-taxonomy.md](references/runtime-failure-taxonomy.md)`；这些内容属于 case taxonomy，不应继续堆回核心 skill 正文

### Queue / activation facts

- 如果当前 queue 没有 READY 任务，不要“假装有 READY”并直接开打
- 先做 campaign 级 preflight，确认 unresolved_fields 等阻塞项
- 只有在 preflight 证明输入充分后，才从 WAITING_RETRY_DECISION 等候选中挑高概率任务重新激活
- 重新激活应优先选择：传统 directory submit flow、无 captcha、无硬付费墙、此前主要因为证据不足而停下的站点
- 当前 P1-1 Version A 调度事实：runtime 已引入 3 个逻辑 lane：`directory_active`、`non_directory_active`、`follow_up`。其中 `WAITING_SITE_RESPONSE` / `WAITING_EXTERNAL_EVENT` 属于 `follow_up`，不应继续和主动提交任务混算主吞吐。
- 当前 P1-1 Version A 资源事实：`directory_active` 与 `non_directory_active` 仍共享同一个 `active` heavy slot（不是双浏览器真并行）；`follow_up` 拥有独立的 `follow_up` worker lease，可与 active worker 并行存在。
- 当前 lane 操作事实：`claim-next-task` 已支持 `--lane active_any|directory_active|non_directory_active|follow_up`；`guarded-drain-status` 会输出 `lane_report` 与 `worker_leases`。后续排障或汇报时，优先按 lane 盘面解释，而不是只看 status counts。
- 如果 scoped `guarded-drain-status` 已显示 `ready=0` 且 `retryable_eligible_now=0`，就把该 scope 视为“当前无可运行 worker”；除非用户明确要保留纯 health watch / 外部事件观察，否则不要继续维持空转的 worker/watchdog cron，应在上层非 cron 会话里 pause/remove 相关 job，而不是让空队列长期每 5m 自唤醒

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
- 实战补充：当 `missing-input-preflight` / `init-gate` 已经阻塞时，不要把它们的 `unresolved_fields` / `user_prompt` 当成完整缺口清单。它们可能只给出摘要或首要字段；若需要对人汇报“到底缺什么”，应再读取对应 task JSON（尤其 `wait.missing_fields`、`wait.resume_trigger`）作为 authoritative blocker 明细，避免漏报像 founder email 这类仍未在 preflight 摘要里完整展开的必填项

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
- `references/throughput-diagnostics.md`
  - 诊断 queue/cron 为何“看起来跑了很多，但真正闭环很少”；区分 touched vs closed、核对实际 cadence、识别 verifier/persistence 串档
- `references/brief-template.md`
- `references/dossier-template.md`
  - 正式提交前的 dossier / submitter defaults 模板与 missing-input gate

### B. 运行模式
- `references/run-modes/queue-and-guarded-drain.md`
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
- promoted profile / submitter email / mailbox 资源来源（若流程可能触发邮箱验证，默认还应包含用户明确提供的 Gmail backup 邮箱）
- 执行范围（queue 或站点清单）
- 输出要求（如果本次要覆盖默认“汇总 + 可复查明细文件”）

如果 brief 没有显式覆盖，则沿用本 skill 的默认 campaign 边界。
如果 brief 与旧经验冲突，以当前 brief + repo 事实边界为准。

参考模板见：[references/brief-template.md](references/brief-template.md)

## Pitfalls

- 不要把 repo CLI 当成传统会打印帮助且零副作用的命令行。当前 bundled runtime 的 `claim-next-task -- --help` / `guarded-drain-status -- --help` 这类调用不会显示 usage，反而可能真的执行命令；尤其 `claim-next-task` 会直接抢占任务并写入 lease/task 状态。探测参数时应优先读 `src/cli/index.ts`、对应 command 源码，或在隔离数据目录里试跑，避免在生产队列上误 claim。
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
- 对 `wp_comment` / `forum_profile` / `dev_blog` 收口，若 `task-finalize` stdout/summary 声称已验证成功，但 `data/backlink-helper/tasks/<taskId>.json` 中的 `link_verification` 仍是 `link_missing`、`live_page_url` 明显不属于当前任务 URL、或与 operator 现场证据矛盾，不要只信 finalize stdout；必须把这类 finalize/task-state mismatch 当作 runtime 异常单独指出，并在最终汇报里明确区分“现场实测 evidence”与“repo 持久化状态”。
- 实战补充：这类 mismatch 不只会表现为 `task-finalize stdout` vs task JSON 不一致；也可能出现 `status=DONE`、`last_takeover_outcome` 写着成功、甚至 outcome/visual evidence 都指向 live backlink，但同一个 task JSON / finalization artifact 里的 `link_verification` 仍残留上一轮或错误页面（例如 unrelated hostname / unrelated `live_page_url`）并继续标成 `link_missing`。遇到这种“成功状态 + stale verifier payload”组合时，必须把 `status/outcome` 与 `link_verification` 分开核对，并在最终汇报中明确标注为 runtime persistence bug，而不是默认为 verifier 已可信。
- 新近实战补充：verifier/persistence mismatch 还可能发生在 **同一真实任务页面** 上，而不只是串到别的 hostname。已实测 `wp_comment` live reload 明确出现新评论、作者名就是 promoted identity，且作者链接直接命中目标 URL；`task-finalize` 也可把任务 authoritative `status` 落成 `DONE` 并复述成功 detail，但 `link_verification` 仍在同一个 `live_page_url`（即目标 thread 自身）上残留 `link_missing`。遇到这种“same-page live evidence + DONE + link_missing”组合时，要优先信 fresh DOM/public-thread evidence、截图视觉摘要、comment count 增量、author-link 命中等一手证据，并把 `link_verification` 明确标成 verifier false negative / runtime persistence bug，而不是因为 host 没漂移就放松核对。
- 盘面解读补充：`guarded-drain-status` 里的 `business_report` 与 `system_status_report.status_counts` 不是同一口径；出现 verifier/persistence mismatch 时，`status_counts.DONE` 可能高于 default card「已提交成功」/ `business_report.overview.submitted_success`。汇报进展时不要只看 DONE 总数，要同时对照 business card、`last_takeover_outcome` 与 `link_verification`，把差额明确解释成 verifier false negative / persistence bug，避免把未被业务口径确认的 DONE 误报成纯成功增量。
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
