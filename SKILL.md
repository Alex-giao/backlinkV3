---
name: web-backlinker-v3-operator
description: operate backlinkhelper v3 for bounded single-site backlink tasks and default unattended, persistent promoted-site backlink campaigns under an evidence-first philosophy. use when chatgpt needs to run the repo-native operator loop, ensure/operate a scoped recurring watchdog, inspect scoped queue plus global target_sites intake, handle mailbox/follow-up continuation, apply runtime safeguards, or consult bundled references for family-specific context, verification semantics, and non-parallel throughput optimization.
---

# Web Backlinker V3 Operator

这是一个**薄 skill**。

它只负责三件事：
- 校准 agent 在 backlink 任务里的策略哲学
- 说明最小完备工具集与能力边界
- 强调运行时里容易被遗忘、但必须记住的事实

不要把它写成站点步骤手册、运维流水账、bug 年鉴或临时经验集。

## When to Use / Default Interpretation

当用户说“给 `<promoted site>` 提交外链 / 做外链 / 跑 backlink / 宣传网站”且没有明确限定为单个 target URL 或一次性 dry-run 时，默认解释为该 promoted site 的**持续无人值守 campaign**：不仅要跑 repo-native operator 闭环，还要确认存在可持续拉起的 scoped recurring watchdog。

默认执行语义：
- 先把用户给的 promoted URL / hostname 锁成精确 scope。
- 主入口优先用 repo-native `unattended-campaign`；不再把单次 `unattended-scope-tick` 当完整 campaign。
- 主动检查 D1 scoped queue、active lease、runtime breaker、follow-up/mailbox 以及全局 `target_sites` candidate pool。
- 单槽串行地“处理一个拿一个”：每次只 claim/enqueue 一个 active task，完成 `task-prepare -> operator/browser-use -> task-record-agent-trace -> task-finalize` 后，再跑 follow-up/mailbox，再回到 intake/claim。
- 默认建立或恢复外层 recurring watchdog/cron：精确 scope、D1 store、固定 CDP endpoint、单槽串行、bounded tick、增量汇报；除非用户明确要求“只跑一次 / 不要定时 / 手动核验”。
- watchdog 的每次运行只做小步 bounded tick，禁止重入并发，禁止在 cron-run 内递归创建/更新/删除 cron job。
- 单个 target/task 遇到人工、政策、付费墙、手机号/passkey、账号锁定、solver 不支持等 blocker 时，只终止/跳过该任务并写回证据，不停止 campaign；watchdog 继续从 scoped queue 或全局 `target_sites` 拉下一个安全候选。
- 直到达到 campaign 级真实停止条件：用户给定数量/时间/预算边界、scope 与全局 candidate pool 都无安全候选、全局 runtime/store/scope 安全 breaker 阻断所有任务，或用户明确停止。

不要因为 scoped queue 暂时空、`unattended-scope-tick` 返回一次 `enqueued/claimed/no_candidate/cooldown`，就把 campaign 当成完成；也不要在没有外层调度器/runner 串起浏览器执行闭环时，把单个 intake CLI tick 伪装成完整无人值守提交能力。

对 promoted-site backlink 请求，持续自跑是默认，不要求用户显式说“持续 / 无人值守”。必须核验外层 scheduler 是否真的存在并启用（例如 `cronjob list` 可见对应 recurring job）。只完成一轮 operator 或手动脚本后，不能汇报成持续无人值守；若没有 recurring runner/watchdog，应创建/恢复一个精确 scope、单槽串行、增量汇报的调度任务，或明确说明当前只是一次性 bounded run。

## Source Repo / Installed Copy Notes

- The GitHub source for the current BacklinkHelper V3 skill is `https://github.com/Alex-giao/backlinkV3.git`, not the older `glassesmonkey/backlinkhelper.git` line used by earlier v2/backlinkhelper migrations.
- Current active/runtime copies are `/home/gc/backlinkV3` and `/home/gc/.hermes/skills/openclaw-imports/web-backlinker-v3-operator`; these may not be Git worktrees. The Git worktree used for GitHub publishing is `/home/gc/backlinkV3.repo-merged-20260424-231004` with remote `Alex-giao/backlinkV3`.
- When the user asks to push the current V3 skill/runtime to GitHub, sync the installed/current copy into the Git worktree before committing: use `rsync -a --delete` while excluding `.git/`, `assets/backlinkhelper/node_modules/`, runtime state (`data/`, `artifacts/`, `logs/`, `browser-profiles/`, reports/cache), and one-off probe/scratch files. Then run `corepack pnpm test` from `assets/backlinkhelper`, commit, push `main`, and verify local `HEAD` equals `origin/main`.
- Do not treat old v2 `~/.hermes/external/backlinkhelper` or `glassesmonkey/backlinkhelper` as the publish target for this V3 skill.

## D1 / Parallel-State Notes

- Default store for this skill is Cloudflare D1. Unless the user explicitly asks for local/file-backed state, every operator/queue/inspection command must run with `BACKLINKHELPER_STORE=d1 BACKLINKHELPER_D1_DATABASE_NAME=backlinkhelper-v3`.
- Do not ask the user for D1 database ID, database user, password, or table schema in normal use. The runtime uses `wrangler d1 execute backlinkhelper-v3 --remote` with the machine's configured Cloudflare credentials; schema is owned by `assets/backlinkhelper/src/memory/sql-schema.ts`.
- For remote D1 bulk imports via `wrangler d1 execute ... --file`, keep the SQL file statement-only. Do **not** wrap it in explicit `BEGIN TRANSACTION` / `COMMIT`; remote execution can fail on transaction statements even when the insert SQL itself is valid.
- Important split-brain caveat: some current promoted-profile commands are still file-backed, not D1-backed. In particular, `init-gate`, `missing-input-preflight`, and `update-promoted-dossier` currently read/write `~/.hermes/state/backlinkhelper-v3/profiles/<hostname>.json` via `getProfileFilePath()/writeJsonFile()` rather than the `promoted_profiles` D1 table. When D1 queue state is empty but those commands still know the promoted site, diagnose both the D1 tables and the file-backed promoted-profile state explicitly instead of assuming D1 already contains the profile row.
- Before queue work in a fresh session, use D1 smoke checks carefully from `/home/gc/backlinkV3/assets/backlinkhelper`: `BACKLINKHELPER_STORE=d1 BACKLINKHELPER_D1_DATABASE_NAME=backlinkhelper-v3 node dist/cli/index.js db-smoke` after `corepack pnpm build` if source changed. Verify smoke rows cannot enter production intake: db-smoke/example.com target rows must be skipped/ignored, never left as `candidate`, because unattended-scope-tick may otherwise enqueue the fake `https://example.com/backlink-submit` target. If smoke pollution is found in production D1, clean both layers: mark all `db-smoke` / `example.com/backlink-submit` tasks `SKIPPED`, clear retry/cooldown/wait fields and worker leases, mark the matching `target_sites` row `skipped`, then dry-run the promoted scope to confirm it moves past cooldown into a real next task.
- If the user asks to submit backlinks using D1 data and `claim-next-task` / `guarded-drain-status` returns idle or zero scoped tasks, do not stop and ask whether to inspect SQL vs queue cause. Immediately inspect D1 raw state for the promoted scope (`backlink_tasks`, `promoted_profiles`, `worker_leases`) plus the global `target_sites` candidate pool, diagnose scope/canonical URL mismatch vs missing enqueue, then enqueue/claim the next eligible `target_sites` candidate when safe.
- Exact promoted scope is an invariant, not a fuzzy hint. For unattended or cron runs, freeze the user-provided promoted site as an exact canonical URL/hostname pair before the first queue command, and abort if later prompts, stale task state, or previous session context drift from that pair (for example `.com` vs `.io`). Never silently substitute a sibling domain/TLD just because `task-id-prefix` matches.
- Before any enqueue / claim / operator submit / finalization step in unattended mode, re-check that the live scope still matches the user’s exact promoted URL and hostname. If any artifact, pending-finalize payload, expected_target_url, or verification target points at a different domain/TLD than the user specified, stop and report a scope mismatch instead of submitting or finalizing.
- When stopping an unattended cron/operator run, verify shutdown from the scheduler (`cronjob list`) instead of inferring from chat messages alone. Old deliveries and files under `~/.hermes/cron/output/<job_id>/` can still exist after removal, and a just-finished in-flight run may still deliver once; do not mistake those historical outputs for an active job.
- Do **not** run bare / unscoped `claim-next-task` when the user asked for a specific promoted site. First lock scope with `init-gate --promoted-url <exact-url>` and preferably `unattended-scope-tick --promoted-url <exact-url> --dry-run` (or scoped `claim-next-task --promoted-url/--promoted-hostname`) so the queue cannot accidentally claim another promoted site’s READY task.
- If an accidental unscoped claim still happens, treat it as an operator mistake and revert immediately before any browser work: inspect the active lease + claimed task, restore the task to `lease.previous_status` (usually `READY`), clear `lease_expires_at`, restore previous wait/terminal fields if present, append a note that the claim was reverted without execution, then clear the active worker lease and pending-finalize payload. Verify the active lease is gone before resuming the intended promoted scope.
- `target_sites` is a global target pool, not promoted-site-scoped. Do not require a target_sites row to already reference the promoted hostname. For a fixed promoted-url run, choose safe global candidates from `target_sites` and enqueue them with that promoted-url, while still respecting exact-host duplicate checks and active-lane/lease safeguards.
- A promoted scope status like `guarded-drain-status --promoted-hostname <host>` only reports tasks already bound/enqueued for that promoted site; it is **not** the full available submission URL pool. If the scoped report shows only a few tasks or `untouched_ready: 0`, still inspect/use the global `target_sites` ready pool and continue unattended intake unless a real blocker exists.
- Treat `needs_manual_boundary` / `no_candidate` from a bounded unattended tick as provisional until you verify the global `target_sites` pool with a sufficiently wide scan window. A small default `--candidate-limit` can create a false “no safe candidate” boundary when the first page of candidates is unsuitable but later candidates are safe. Re-run `unattended-scope-tick --promoted-url <exact-url> --candidate-limit 500 --dry-run --json` (or set `BACKLINKHELPER_CANDIDATE_LIMIT`) and compare `candidate_pool` / `safe_candidates` before telling the user the pool is exhausted.
- Seed/import command exists: `node dist/cli/index.js import-backlink-csv --csv <file> --limit <n> [--enqueue --promoted-url <url>]`; large D1 bulk seeds are faster via generated SQL + `wrangler d1 execute --file` than one row per CLI call.
- When bulk-importing into remote D1 via `wrangler d1 execute --file`, do **not** wrap the file with `BEGIN TRANSACTION` / `COMMIT`; Wrangler rejects SQL transaction statements in this path. Emit plain `INSERT OR IGNORE` / `INSERT ... ON CONFLICT` statements instead.
- When reporting per-task completion speed, do not assume `DONE` is the only conclusion-level state. Unless the user explicitly asks for successful submissions only, include all tasks whose `updated_at` falls in the requested local-time window and whose status is no longer active queue: exclude `READY` / `RUNNING`; include `DONE`, `SKIPPED`, `WAITING_SITE_RESPONSE`, `WAITING_EXTERNAL_EVENT`, `WAITING_MANUAL_AUTH`, `WAITING_MISSING_INPUT`, `WAITING_POLICY_DECISION`, `WAITING_RETRY_DECISION`, and `RETRYABLE`. Convert Asia/Shanghai day windows to UTC for D1 ISO timestamps. Report two timing views: lifecycle time `created_at → updated_at`, and execution time `payload_json.stage_timestamps.claimed_at → updated_at` when `claimed_at` exists. `WAITING_RETRY_DECISION` / `RETRYABLE` can heavily skew lifecycle means because `src/control-plane/task-queue.ts` currently has `RETRY_BACKOFF_MS = 60 * 60 * 1_000` and `MAX_AUTOMATIC_RETRIES = 1`; these are often queue/cooldown delays rather than real operator execution time. For slow retry conclusions, break down `queue_wait = claimed_at - created_at` vs `after_claim = updated_at - claimed_at`, and inspect `wait.wait_reason_code`, `terminal_class`, `run_count`, `phase_history`, and local scout/finalization artifacts to separate site failures from CDP/runtime failures.

## Runtime Pitfalls To Remember

- CapSolver 只能证明“验证码已解并已回填/尝试提交”，不能证明“点到了正确的提交按钮”。对有站内搜索、newsletter、multi-form 混排的页面，submit selector 必须优先收敛到当前目标表单（例如 `form#commentform`、`#commentform input#submit`、`form[action*="comment"]`），不要用过宽的全页 `input[type="submit"]` / `button[type="submit"]` 兜底顺序放前面。
- 当前 suika watchdog 已切到 `node scripts/family-aware-operator-dispatcher.mjs`：`wp_comment` 保留专用 `suika-blogger-operator.mjs` 能力，`forum_profile` / `saas_directory` / `forum_post` / `dev_blog` 默认走 Hermes-native generic family agent（`family-agent-operator.mjs` 会调用 `hermes chat` 并注入 family contract）；Codex 只作为显式 fallback（`BACKLINKHELPER_FAMILY_AGENT_BACKEND=codex`）。明显的 forum/thread URL 必须按通用模式族识别、不要按单个域名单点枚举：包括 `viewtopic` / `showthread`、`thread|topic|tid|t=<numeric-id>`（含 SMF `topic=123.0`）、`/threads/<id-or-slug>`、`/topic/<id>-slug`、Discourse `/t/<slug>/<id>`、Flarum `/d/<id>-slug`、Zendesk `/hc/.../community/posts/<id>` 等；这些不要再当 `wp_comment` 或 `saas_directory` 硬跑，应由 classifier/dispatcher 进入 `forum_post`。但纯 `/forum/`、`/topics/marketing`、`/community/topics/<category>` 这类索引/分类页不要无证据泛化为帖子。若 generic agent 返回 pending/moderation/missing-input/policy 边界，按 family semantic contract 写回，不要伪装成 Blogger comment 失败。
- 如果验证码 solve 成功后页面却跳到明显无关页面（如站内搜索 `?s=`、首页订阅确认、其他非目标表单落点），先怀疑“submit 命中错表单”，不要误判成 CapSolver 失败或站点拒绝。
- 对 comment family，验收要拆成两层：`captcha/submit path passed` 与 `comment/backlink live`。出现 `#comment-...` 只能说明提交流程大概率接受，仍要 fresh reload 做 live/backlink 验证，避免把 moderation pending 误报为成功。
- 锚文本/评论正文不能固定模板化。对同一 promoted URL，执行器必须在运行时选择自然锚文本并记录实际使用值，避免连续重复 exact anchor（例如每条都用 `Suika Game`）。优先由本轮 agent 基于页面标题/正文摘录/评论语境临时生成自然评论与 anchor，再用确定性 guardrails 校验；不要只做固定模板池随机轮换。curated pool 只能作为 fallback/anchor 候选约束，不是正文模板。锚文本应混合品牌/部分匹配/泛化描述/naked URL，例如品牌词、`fruit-merging puzzle`、`simple browser puzzle`、`this casual game`、裸链等，并避免同一 anchor 在最近若干成功链接中连续复用。cron 是独立会话，所以跨轮去重/相似度/配额不能依赖聊天上下文，必须读写 repo/D1 中的 task/link history、generated-copy history 或 promoted-profile 配置。当前 Suika Blogger operator 已实现 runtime copy planner：`scripts/suika-blogger-operator.mjs` 会从 D1 `DONE` 历史提取最近 anchors/comment previews，默认用 `hermes chat -Q` 临时生成 JSON；可用 `BACKLINKHELPER_COPY_AI_BACKEND=codex` 切 Codex、`BACKLINKHELPER_COPY_MODE=fallback` 强制 fallback。guardrails 要求恰好 1 个 promoted link、anchor 与链接文本一致、不能复用最近 anchor、英文 campaign 不接受非 Latin anchor、正文长度和垃圾短语检查通过。
- 登录/注册墙不是天然 manual-auth。先区分可自动恢复的邮箱验证码 / magic link / confirmation mail / 受支持 CAPTCHA，与不可自动处理的手机号、passkey、账号锁定、明确 user-only approval 或当前 solver 不支持/配置缺失的验证。只要 runtime 邮箱能力可用（`gog` 或 Google Workspace `gws` fallback），邮箱验证边界应进入 mailbox/follow-up continuation；只要 CapSolver/solver API 可用且类型受支持，CAPTCHA 边界应先走 solver continuation，而不是直接终态 `WAITING_MANUAL_AUTH`。Blogger/Google-login 场景可使用共享 Chrome 中用户授权的专用 Google 登录态；Google 登录按钮本身不是 manual-auth blocker，operator 应优先点 iframe 内 `[role="button"][aria-label="Sign in with Google"]` / `div[role="button"]:has-text("Sign in with Google")` 等真实按钮；点击后若主页面跳到 `www.blogger.com/comment/login/...`，等待登录态生效后回到原 target 重新探测 comment iframe。只有额外 password/2FA/verify-it's-you/手机号/账号锁定才算人工边界。
- scout/prepare 阶段发现可提取 sitekey 的 reCAPTCHA/Turnstile 时，不要前置终停为 `WAITING_POLICY_DECISION/CAPTCHA_BLOCKED`；应让 operator/finalize 有机会调用 solver。只有 solver 未配置、类型不支持、sitekey 缺失或 solve/回填失败后，才作为该 task 的 blocker 写回证据。

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

### 7. 无人值守 campaign 的停止条件必须覆盖全池

当用户要求“持续自主提交 / 无人值守 / 帮我提交外链”时，不能把一个 scoped bounded tick 的结束误当成 campaign 结束。

正确的 campaign 判断顺序是：
- 先锁定 promoted URL / hostname 的精确 scope
- 再区分 scoped bound tasks 与全局 `target_sites` candidate pool：scoped report 只代表已绑定任务，不代表可提交 URL 总池
- 若 scoped 队列为空或仅剩冷却中的 `RETRYABLE`，仍要尝试从全局 `target_sites` 选择安全 candidate 并绑定到该 promoted scope
- 每轮执行后继续跑 follow-up / mailbox continuation，再回到 intake/claim，直到出现真实停止条件

真实 campaign 停止条件只包括：
- 已达到用户给定数量/时间/预算边界
- 无 active lease，scope 内无可执行任务，且全局 candidate pool 也无安全候选
- 全局 runtime/store/scope 安全 blocker 会影响所有任务，例如 D1/Wrangler 不可用、共享 Chrome/Playwright/CDP 整体不可用、active lease/pending-finalize 状态污染且无法安全恢复、promoted scope/verification scope 不一致、promoted profile 缺少全局必需输入导致任何提交都不安全
- 用户明确要求停

单个 task 的 blocker 不是 campaign 停止条件。普通登录/注册墙本身也不是 blocker：只要可用邮箱注册、magic link、confirmation mail、受支持 CAPTCHA 或已有账号路径存在，应先走 account/mailbox/solver continuation。只有手机号/passkey、账号锁定、邀请制、明确人工审批、当前账号/邮箱/solver 能力无法覆盖的 auth，才算该 task 的人工边界。政策/付费墙、不可恢复 auth、单站点反爬/表单异常等，应把该 task 标成 `SKIPPED` / `WAITING_MANUAL_AUTH` / `WAITING_POLICY_DECISION` / `RETRYABLE` 等合适状态并写足证据，然后继续 claim/enqueue 下一个候选；只有当这些问题上升为“全池都无法安全继续”的全局 blocker 时，才暂停 campaign。

最终汇报前必须同时说明：已提交成功数、scoped tasks 状态、全局 ready/candidate pool 是否仍可继续、以及邮箱/follow-up 是否有可自动恢复项。

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

### 2.5. Deterministic D1 intake / queue tick

D1 scope inspection and candidate-to-task intake are deterministic runtime operations, not places for LLM improvisation.

用途：
- inspect promoted scope: `backlink_tasks`, `worker_leases`, `promoted_profiles`
- inspect global `target_sites` candidate pool
- decide whether an existing READY / retryable task can be claimed
- when the scoped queue is idle and no live lease exists, select one safe global candidate and enqueue it with the fixed promoted-url
- return a compact machine-readable action summary: `claimed`, `enqueued`, `blocked`, `cooldown`, `no_candidate`, or `needs_manual_boundary`
- support `--dry-run` as a non-mutating preview: it must not claim leases, change task status/run_count, enqueue tasks, or mark `target_sites`

This capability should live as a repo-native CLI/helper under `assets/backlinkhelper`, not as a long prose checklist in this skill. The LLM may choose strategy and interpret site evidence, but the D1 intake state machine must be script/CLI-backed.

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

If a site stops at email verification / code / magic-link, do **not** classify it as `WAITING_MANUAL_AUTH` just because a mailbox step is needed. First use the repo mailbox continuation path (`mailbox-triage`, then `follow-up-tick` or equivalent task resume) and set wait ownership to mail automation (`gog` or the Google Workspace `gws` fallback) when available. Only mark manual auth for boundaries mail cannot solve, such as phone verification, human CAPTCHA that cannot be solved by configured services, locked account, or explicit user-only approval.

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

`unattended-scope-tick` 是 scope/intake 控制面：负责 scoped claim、从全局 `target_sites` enqueue 新任务、返回 `claimed/enqueued/blocked/cooldown/no_candidate` 等动作；它本身不等于 browser worker runner。默认 campaign 主入口是 `unattended-campaign`：它要求用户提供精确 `--promoted-url`，规范化并锁定 URL/hostname，拒绝 hostname mismatch 与 `--lane follow_up`，然后串起 `unattended-scope-tick`（必要时二次 claim 刚 enqueue 的任务）→ `task-prepare` → operator/browser-use（通过依赖注入或 `--operator-command` 返回 AgentTraceEnvelope）→ `task-record-agent-trace` → `task-finalize` → `follow-up-tick/mailbox` → 下一轮 intake。live 模式必须有可用 operator/browser-use 产出 `AgentTraceEnvelope`；如果没有 operator，只允许 `--dry-run` 或无副作用 smoke，runner 应返回 `operator_unavailable` 并保持 `scope_ticks=0`，不能 claim、提交或改 D1 队列。旧 `drain-worker` 脚本仍明确 disabled，`run-next` 仍只是 fail-fast 占位。

### 2. 当前 active work 仍然是单槽串行

现在不考虑并行扩容。

因此优化重点是：
- 降低热路径固定开销
- 提前拦住坏目标 / 重复目标
- 提高单槽 active 的利用率
- 避免把 cron 调度间隔变成吞吐瓶颈：持续 campaign 应采用“单槽热循环/长跑 drain”（一个任务完成后立即 claim 下一个，直到队列/候选池真实 idle、达到时间/数量上限或遇到 campaign 级 blocker），cron 只做保活/重启 watchdog；不要在高供给候选池下长期固定 `BACKLINKHELPER_LOOP_ITERS=1`，否则会退化成每个 cron 周期只处理一个任务。热循环必须带 runtime lock + heartbeat + stale recovery + idle/runtime/iteration budget，防止 cron overlap 变成隐性并发。

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

### 9. 底层 task scope 仍存在精确字符串匹配边界

底层 `matchesTaskScope()` 仍直接比较 `task.submission.promoted_profile.url === scope.promotedUrl`；旧 bounded CLI 若传入的尾斜杠形式与任务里保存的不一致，可能排除本来同站点的任务。

当前默认 campaign 入口 `unattended-campaign` 会把用户给的 `--promoted-url` 规范化并锁成 URL/hostname pair，再用这对 scope 贯穿 intake、follow-up、operator context，并在 claim 后重新校验 task 的 promoted profile。若手动跑更底层的 bounded status / claim / follow-up 命令，仍要先确认 repo 里保存的 canonical promoted URL 字符串；不确定时用 dry-run 或 D1 inspection 验证，避免把尾斜杠/协议差异误判成无任务。

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

### 10. `update-promoted-dossier` 不等于 init-gate 一定放行

有一个容易踩坑的 split：

- `update-promoted-dossier --set ...` 会稳定写入 `profile.dossier_fields`
- 但 `missing-input-preflight` / `init-gate` 的 core completeness 还会直接看 profile 顶层字段，例如 `profile.company_name`、`profile.contact_email`、`profile.primary_category`

因此实战里可能出现这种现象：

- `update-promoted-dossier` 已经把 `company_name` / `contact_email` / `primary_category` 写进 dossier fields
- 但 `init-gate --mode unattended` 仍继续报这些 core 字段缺失（尤其 `primary_category`）

遇到这种情况不要误判成 CLI 没生效，也不要直接开始 claim-next-task。正确做法是：

- 先读 `~/.hermes/state/backlinkhelper-v3/profiles/<hostname>.json`
- 同时核对顶层字段与 `dossier_fields`
- 若 core 值只存在于 `dossier_fields`、缺在顶层，则先把 profile 顶层补齐，再重跑 `init-gate`

判断标准：只有 `init-gate` 返回 core ready / flow ready 满足 unattended 条件后，才能把它当成真正可无人值守开跑；`update-promoted-dossier` 成功本身不构成这个保证。

## Safety Boundaries

- 不付费，不购买 sponsored listing，不替用户做 payment step。
- 不代做 2FA / passkey / 需要用户设备或人工身份参与的验证；但受支持的 CAPTCHA 应优先走已配置 solver（例如 CapSolver API），不要误报为人工边界。
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
- `references/db-before-parallel-expansion.md`
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
