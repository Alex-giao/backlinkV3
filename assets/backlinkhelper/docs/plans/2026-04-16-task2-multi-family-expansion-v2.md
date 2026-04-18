# Task 2 Revised: V3 多 Family 扩展 Implementation Plan

> Superseded for execution by `2026-04-16-task2-multi-family-expansion-v3-thin-execution.md`. Keep this file as the fuller reasoning draft; use v3 as the actual execution order.

> For Hermes: this plan supersedes `docs/plans/2026-04-16-task2-multi-family-expansion.md`. Execute with TDD. 每个代码任务都先补 failing test，再做最小实现，再跑 targeted regression，最后跑全量测试。

Goal: 把 `web-backlinker-v3-operator` 从“目录站默认心智 + 部分 family 骨架”推进到“forum profile / wp comment / dev blog 三类 flow 都能在同一 kernel 下稳定推进、稳定验证、稳定收口”的状态。

Architecture: 第一件事已经完成：skill 外层与 decider / visual prompt 已 family-aware。第二件事不再从 prompt 层起步，而是转向真正缺口：统一 verification substrate、统一多 family dossier / missing-input schema、统一终态 taxonomy、以及三类 family 各自最小可交付 flow。这里的执行顺序只是技术依赖顺序，不代表业务优先级；按你的要求，forum profile / wp comment / dev blog 三类都必须进入本轮范围。

Tech Stack: TypeScript, Node test runner (`node --test` via `corepack pnpm test`), repo-native CLI, existing family config under `src/families/`, existing references under `../references/`.

---

## User-Confirmed Constraints

These are now fixed requirements, not open questions:
- `dev_blog` 仅覆盖 self-serve community article / self-serve publishing，不做 guest post / editorial outreach。
- `dev_blog` 内容必须以事实为基础；不能为了发文而发文。
- `wp_comment` 的成功定义不是“提交成功/待审核”，而是“公开 live comment 可见 + 能验证到目标链接与 rel”。
- `wp_comment` 允许尝试纯文本、BBCode、HTML `<a href>` 等格式，并把站点经验回写到 family markdown references。
- `forum_profile` 首版范围必须覆盖 `signature / about me / website / social links`，不是只做 website/bio。
- 三类 family 都做，不按产品优先级砍范围；只能按技术依赖顺序安排实现。

---

## Non-Goals

- 不新增更多 family。
- 不重做已经完成的 decider / visual family-aware prompt 收口。
- 不扩展到 outreach / guest post / editorial pipeline。
- 不把单站经验硬编码回 kernel；单站经验应进入 `references/` 或 repo docs。

---

## Task 1: Build a shared post-submit verification substrate

**Objective:** 先补共享的 verification kernel；如果没有这一层，forum profile / wp comment / dev blog 三类的成功定义都不成立。

**Files:**
- Create: `src/execution/link-verifier.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/execution/takeover.ts`
- Modify: `src/control-plane/task-finalize.ts`
- Modify: `src/shared/task-progress.ts`
- Test: `src/execution/link-verifier.test.ts`
- Test: `src/execution/takeover.test.ts`
- Test: `src/shared/task-progress.test.ts`

**Step 1: Write failing tests**

Add tests for a shared verifier result that works for all families.

Target behaviors:
- `link verifier extracts live_page_url, target_link_url, anchor_text, rel, visible_state`
- `forum profile success requires verifier-backed public profile evidence`
- `wp comment is not marked successful when only moderation/pending exists without live comment evidence`
- `dev blog published state can distinguish with-link vs no-link`

**Step 2: Run tests to verify failure**

Run:
`corepack pnpm test -- --test-name-pattern "link verifier|forum profile success|wp comment live|published with link"`

Expected: FAIL — verifier module and verifier-backed outcomes do not exist yet.

**Step 3: Implement minimal substrate**

Implementation notes:
- Add a shared verifier output shape in `src/shared/types.ts`, e.g. fields equivalent to:
  - `live_page_url`
  - `target_link_url`
  - `anchor_text`
  - `rel`
  - `visible_state`
  - optional `link_text_context`
- In `src/execution/link-verifier.ts`, implement a minimal verifier that can:
  - fetch/inspect the live public page
  - locate target links
  - normalize rel into `ugc / sponsored / nofollow / follow / unknown`
  - distinguish `visible` vs `hidden` vs `missing`
- Wire verifier output into finalize/handoff artifacts instead of leaving it as an external note.
- In `src/execution/takeover.ts` and `src/control-plane/task-finalize.ts`, do not mark the three non-directory families as business-complete without verifier evidence when the family contract requires it.

**Step 4: Run tests to verify pass**

Run:
`corepack pnpm test -- --test-name-pattern "link verifier|forum profile success|wp comment live|published with link"`

Expected: PASS.

**Step 5: Run broader regression**

Run:
`corepack pnpm test -- --test-name-pattern "finalization|task progress|business outcome|link verifier"`

Expected: PASS with existing `saas_directory` flow still intact.

---

## Task 2: Expand promoted dossier and missing-input schema for all three families

**Objective:** 把 forum profile / wp comment / dev blog 的必要字段正式接进 dossier 和 missing-input pipeline；否则 operator 只能“看起来支持”，不能稳定填表和稳定回补。

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/promoted-profile.ts`
- Modify: `src/shared/missing-inputs.ts`
- Modify: `src/cli/update-promoted-dossier.ts`
- Test: `src/shared/missing-inputs.test.ts`
- Test: add/update promoted-profile tests if needed under `src/shared/`

**Step 1: Write failing tests**

Target behaviors:
- `forum_profile dossier fields are recognized and reusable`
- `wp_comment formatting and author fields are surfaced as missing-input candidates`
- `dev_blog article fields are surfaced without being confused with directory defaults`

Required field families for this round:
- forum_profile:
  - `profile_display_name`
  - `profile_headline`
  - `profile_bio`
  - `profile_signature`
  - `profile_website_url`
  - `profile_social_links`
- wp_comment:
  - `comment_author_name`
  - `comment_author_email`
  - `comment_author_url`
  - `comment_body`
  - `comment_format_strategy`
- dev_blog:
  - `article_title`
  - `article_summary`
  - `article_body_or_markdown`
  - `author_bio_short`
  - `canonical_url`
  - `tags_or_categories`

**Step 2: Run tests to verify failure**

Run:
`corepack pnpm test -- --test-name-pattern "missing input|forum_profile dossier|wp_comment|dev_blog"`

Expected: FAIL — these fields are absent or not wired into completeness/missing-input logic.

**Step 3: Implement minimal schema extension**

Implementation notes:
- Extend `PromotedProfile` / dossier field handling in `src/shared/types.ts` and `src/shared/promoted-profile.ts`.
- Update `src/shared/missing-inputs.ts` to recognize these keys and return reusable, family-aware prompts.
- Do not overload existing directory-specific keys when a family-specific field is semantically different.
- Keep backward compatibility for existing `saas_directory` dossier users.

**Step 4: Run tests to verify pass**

Run:
`corepack pnpm test -- --test-name-pattern "missing input|forum_profile dossier|wp_comment|dev_blog"`

Expected: PASS.

---

## Task 3: Complete forum_profile as a first-class verified family

**Objective:** 让 `forum_profile` 从“能识别 profile surface”升级到“能完整推进 + 能验证 profile live link + 能正确收口”。

**Files:**
- Modify: `src/families/non-directory.ts`
- Modify: `src/execution/scout.ts`
- Modify: `src/shared/page-assessment.ts`
- Modify: `src/shared/task-progress.ts`
- Modify: `src/execution/takeover.ts`
- Modify: `src/control-plane/task-queue.ts`
- Update Reference: `../references/families/forum-profile.md`
- Test: `src/shared/page-assessment.test.ts`
- Test: `src/shared/task-progress.test.ts`
- Test: `src/execution/takeover.test.ts`
- Test: `src/control-plane/task-queue.test.ts`

**Step 1: Write failing tests**

Target behaviors:
- `forum_profile recognizes signature/about me/website/social links as family-appropriate progress cues`
- `forum_profile does not collapse into directory success semantics`
- `forum_profile live profile with verified link is a terminal success state`
- `forum_profile saved-but-not-public stays non-terminal until verifier evidence exists`

**Step 2: Run tests to verify failure**

Run:
`corepack pnpm test -- --test-name-pattern "forum_profile|signature|about me|social links|profile updated"`

Expected: FAIL for the new verifier-backed and field-complete behaviors.

**Step 3: Implement minimal forum_profile completion**

Implementation notes:
- Keep forum-specific cues in `src/families/non-directory.ts`.
- Ensure scout/page-assessment/task-progress recognize:
  - `signature`
  - `about me`
  - `website`
  - `social links`
  - `member profile`
  - `account settings`
- Add or refine forum-profile-specific outcome reasons in takeover/task-queue as needed.
- Update `../references/families/forum-profile.md` with reusable, non-site-specific verification notes.

**Step 4: Run tests to verify pass**

Run:
`corepack pnpm test -- --test-name-pattern "forum_profile|signature|about me|social links|profile updated"`

Expected: PASS.

---

## Task 4: Complete wp_comment as a verifier-first family

**Objective:** 让 `wp_comment` 从“能识别 comment form”升级到“支持格式策略 + 反垃圾路径 + live comment verification”。

**Files:**
- Modify: `src/families/non-directory.ts`
- Modify: `src/execution/scout.ts`
- Modify: `src/shared/page-assessment.ts`
- Modify: `src/shared/task-progress.ts`
- Modify: `src/execution/takeover.ts`
- Modify: `src/control-plane/task-queue.ts`
- Update Reference: `../references/families/wp-comments.md`
- Update Reference: `../references/patterns/anti-spam.md`
- Test: `src/shared/page-assessment.test.ts`
- Test: `src/shared/task-progress.test.ts`
- Test: `src/execution/takeover.test.ts`
- Test: `src/control-plane/task-queue.test.ts`

**Step 1: Write failing tests**

Target behaviors:
- `wp_comment supports comment_format_strategy plain_text | bbcode | html_link`
- `wp_comment pending moderation is not final business success`
- `wp_comment live comment with verified link is terminal success`
- `wp_comment anti-spam block is distinct from ordinary retryable failure`

**Step 2: Run tests to verify failure**

Run:
`corepack pnpm test -- --test-name-pattern "wp_comment|comment format|moderation|anti-spam|live comment"`

Expected: FAIL — formatting strategy and live verification requirements are not fully represented yet.

**Step 3: Implement minimal wp_comment completion**

Implementation notes:
- Add a formatting strategy field to dossier/missing-input handling if not already done in Task 2.
- In takeover flow, support trying the allowed formatting variants in bounded fashion; do not grow a site-specific heuristic monster.
- Route reusable site-level syntax discoveries into `../references/families/wp-comments.md`, not kernel if/else trees.
- Ensure success requires verifier-backed live comment evidence.

**Step 4: Run tests to verify pass**

Run:
`corepack pnpm test -- --test-name-pattern "wp_comment|comment format|moderation|anti-spam|live comment"`

Expected: PASS.

---

## Task 5: Complete dev_blog as a self-serve article family

**Objective:** 让 `dev_blog` 覆盖 self-serve community article flow，并把“事实质量边界”写进 references 与 runtime contract，而不是把它误做成 guest-post pipeline。

**Files:**
- Modify: `src/families/non-directory.ts`
- Modify: `src/execution/scout.ts`
- Modify: `src/shared/page-assessment.ts`
- Modify: `src/shared/task-progress.ts`
- Modify: `src/execution/takeover.ts`
- Modify: `src/control-plane/task-queue.ts`
- Update Reference: `../references/families/dev-blog.md`
- Test: `src/shared/page-assessment.test.ts`
- Test: `src/shared/task-progress.test.ts`
- Test: `src/execution/takeover.test.ts`
- Test: `src/control-plane/task-queue.test.ts`

**Step 1: Write failing tests**

Target behaviors:
- `dev_blog recognizes write post / draft / submit for review / publish surfaces`
- `dev_blog distinguishes draft saved vs submitted for review vs published`
- `dev_blog published-with-link vs published-without-link is verifier-backed`

**Step 2: Run tests to verify failure**

Run:
`corepack pnpm test -- --test-name-pattern "dev_blog|draft saved|submitted for review|published with link"`

Expected: FAIL for the new article-specific states.

**Step 3: Implement minimal dev_blog completion**

Implementation notes:
- Keep scope narrow: only self-serve article/community publishing.
- Do not let the operator invent facts; article content must come from provided brief/dossier/references and remain fact-grounded.
- Add explicit state handling for:
  - `ARTICLE_DRAFT_SAVED`
  - `ARTICLE_SUBMITTED_PENDING_EDITORIAL`
  - `ARTICLE_PUBLISHED_WITH_LINK`
  - `ARTICLE_PUBLISHED_NO_LINK`
- Update `../references/families/dev-blog.md` with fact-quality constraints and verification notes.

**Step 4: Run tests to verify pass**

Run:
`corepack pnpm test -- --test-name-pattern "dev_blog|draft saved|submitted for review|published with link"`

Expected: PASS.

---

## Task 6: Remove remaining directory-biased naming from shared substrate and docs

**Objective:** 在三类 family 都真正接上之后，再回头清理共享层命名，避免过早抽象导致返工。

**Files:**
- Modify: `src/families/types.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/shared/missing-inputs.ts`
- Modify: `src/control-plane/init-gate.ts`
- Modify: `src/shared/task-progress.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/cli/enqueue-site.ts`
- Modify: `README.md`
- Test: `src/shared/missing-inputs.test.ts`
- Test: `src/control-plane/init-gate.test.ts`
- Test: `src/shared/task-progress.test.ts`

**Step 1: Write failing tests**

Target behaviors:
- `non-directory families no longer surface directory-only readiness wording`
- `task progress fragment ids are neutral rather than listing-specific`
- `README examples cover multiple families and show --flow-family`
- `CLI keeps --directory-url as legacy alias but exposes a neutral canonical parameter`

**Step 2: Run tests to verify failure**

Run:
`corepack pnpm test -- --test-name-pattern "missing input|init-gate|task progress|enqueue-site|forum_profile|wp_comment|dev_blog"`

Expected: FAIL for whichever neutralized naming/tests you add first.

**Step 3: Implement minimal cleanup**

Implementation notes:
- This is the place to neutralize `directory_ready*`, `frag_listing_form_v1`, and legacy directory-only wording.
- Keep compatibility wrappers where external consumers may still rely on older fields.
- In README, do not overclaim unsupported behaviors; document only what the tests/runtime now truly support.

**Step 4: Run targeted tests to verify pass**

Run:
`corepack pnpm test -- --test-name-pattern "missing input|init-gate|task progress|enqueue-site|forum_profile|wp_comment|dev_blog"`

Expected: PASS.

---

## Task 7: Full regression and acceptance gate

**Objective:** 确认 task2 完成后，这不再是“目录站内核 + 三个装饰 family”，而是一个真实的 multi-family kernel。

**Files:**
- No primary code file; this is the final verification pass.

**Step 1: Run full suite**

Run:
`corepack pnpm test`

Expected: all tests pass.

**Step 2: Bias scan**

Search remaining non-test code for problematic residue:
- `directory_ready`
- `missing_directory_fields`
- `frag_listing_form_v1`
- `pending review` being treated as universal success
- README examples missing `--flow-family`

**Step 3: Acceptance checklist**

Task 2 is complete only if all are true:
- forum_profile supports `signature / about me / website / social links` and verifies public live link/rel
- wp_comment success requires public live comment + verified link/rel
- wp_comment formatting strategies are bounded and reusable
- wp_comment site-level format learnings are written back to family markdown references
- dev_blog is limited to self-serve article/community publishing and keeps fact-grounded content constraints
- dev_blog can distinguish draft / submitted / published-with-link / published-without-link
- verifier output is persisted into artifacts / finalize / execution_state rather than oral summary only
- remaining directory-biased shared naming has been cleaned or compatibility-wrapped
- full test suite passes

---

## Suggested execution order

This is dependency order, not business priority:
1. Task 1 — shared verification substrate
2. Task 2 — dossier / missing-input schema expansion
3. Task 3 — forum_profile completion
4. Task 4 — wp_comment completion
5. Task 5 — dev_blog completion
6. Task 6 — shared naming / CLI / docs cleanup
7. Task 7 — full regression and acceptance

Why this order:
- without verifier, none of the three family success contracts are real
- without dossier/missing-input schema, operator cannot fill the flows consistently
- shared naming should be cleaned after the real multi-family substrate exists, not before

---

## Commands cheat sheet

Targeted runs during implementation:
- `corepack pnpm test -- --test-name-pattern "link verifier|forum profile success|wp comment live|published with link"`
- `corepack pnpm test -- --test-name-pattern "missing input|forum_profile dossier|wp_comment|dev_blog"`
- `corepack pnpm test -- --test-name-pattern "forum_profile|signature|about me|social links|profile updated"`
- `corepack pnpm test -- --test-name-pattern "wp_comment|comment format|moderation|anti-spam|live comment"`
- `corepack pnpm test -- --test-name-pattern "dev_blog|draft saved|submitted for review|published with link"`
- `corepack pnpm test -- --test-name-pattern "missing input|init-gate|task progress|enqueue-site|forum_profile|wp_comment|dev_blog"`

Final verification:
- `corepack pnpm test`

---

## Risk notes

- Do not let verifier logic become another site-specific heuristic dump; keep site quirks in `references/`.
- Do not declare WP comment success at moderation time; success must remain live-comment-based per your requirement.
- Do not let dev_blog scope silently expand to outreach/editorial.
- Do not make README more ambitious than the tested runtime.
- Do not re-thicken SKILL.md; runtime + references should carry the family specifics.
