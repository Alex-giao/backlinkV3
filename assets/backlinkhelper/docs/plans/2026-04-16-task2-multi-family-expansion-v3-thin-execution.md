# Task 2 V3: 多 Family 扩展薄执行计划

> For Hermes: 这是 task2 的执行版 v3。它取代 `2026-04-16-task2-multi-family-expansion-v2.md` 作为实际落地顺序。目标不是把计划写厚，而是用最少的新文件、最少的 shared-layer 往返，完成真正必要的扩展。

Goal: 在保持 `saas_directory` 现有行为稳定的前提下，把 V3 真正扩成一个可承载 `forum_profile`、`wp_comment`、`dev_blog` 的共用 kernel，并满足用户已经确认的成功标准。

Architecture: 第一件事已经完成了 skill 哲学层和 prompt family-aware 收口。第二件事不再按 family 分三轮重复扫同一批共享文件，而是采用三段式：先补唯一必要的共享 substrate（verifier + schema），再一次性完成三类 family 的运行面，再做兼容清理与文档收尾。原则是：shared kernel 只改一轮，family specifics 尽量留在 family config / references，不复制成三套 runtime 分支。

Tech Stack: TypeScript, Node test runner (`corepack pnpm test`), repo-native CLI, existing family config under `src/families/`, existing family references under `../references/`.

---

## User-Confirmed Hard Constraints

- `dev_blog` 只做 self-serve community article / self-serve publishing，不做 guest post / editorial outreach。
- `dev_blog` 内容必须基于事实，不允许为了发文而编造。
- `wp_comment` 成功定义：必须看到公开 live comment，且验证到链接与 rel；“提交成功/待审核”不算完成。
- `wp_comment` 允许有界尝试 `plain_text / bbcode / html <a>` 三种格式策略。
- `wp_comment` 的站点格式经验要回写到 markdown references，而不是直接长进 kernel。
- `forum_profile` 首版必须覆盖 `signature / about me / website / social links`，不是只做 website/bio。
- 三类 family 都要做；技术顺序不等于业务优先级。

---

## Minimal File Policy

默认只允许新增这 2 个代码文件：
- `src/execution/link-verifier.ts`
- `src/execution/link-verifier.test.ts`

默认不新增 family-specific runtime 文件，例如：
- 不新增 `forum-profile-verifier.ts`
- 不新增 `wp-comment-verifier.ts`
- 不新增 `dev-blog-verifier.ts`

允许修改现有共享文件，但应尽量做到“一次 shared 改造 + 一次 family 落地”，避免三轮反复改：
- `src/shared/types.ts`
- `src/shared/promoted-profile.ts`
- `src/shared/missing-inputs.ts`
- `src/execution/scout.ts`
- `src/shared/page-assessment.ts`
- `src/shared/task-progress.ts`
- `src/execution/takeover.ts`
- `src/control-plane/task-finalize.ts`
- `src/control-plane/task-queue.ts`
- `src/cli/update-promoted-dossier.ts`
- `src/cli/index.ts`
- `src/cli/enqueue-site.ts`
- `README.md`

新增文件只有在满足下面至少一条时才允许：
1. 它是跨 2 个以上 family 复用的 deterministic 抽象。
2. 不拆出来会把核心共享文件变成难维护的巨型条件分支。
3. 它属于 references / docs，而不是 runtime heuristic dump。

---

## Phase A: 一次性补齐共享 substrate

### Objective
先把三类 family 共同缺的东西补齐：
- verifier substrate
- 多 family dossier / missing-input schema
- verifier-backed finalize / execution_state persistence

如果这一步不做，forum profile / wp comment / dev blog 只是“表面支持”。

### Files
- Create: `src/execution/link-verifier.ts`
- Test: `src/execution/link-verifier.test.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/shared/promoted-profile.ts`
- Modify: `src/shared/missing-inputs.ts`
- Modify: `src/execution/takeover.ts`
- Modify: `src/control-plane/task-finalize.ts`
- Modify: `src/shared/task-progress.ts`
- Modify: `src/cli/update-promoted-dossier.ts`
- Test: `src/shared/missing-inputs.test.ts`
- Test: `src/execution/takeover.test.ts`
- Test: `src/shared/task-progress.test.ts`

### Scope
1. Shared verifier result shape
最小字段：
- `live_page_url`
- `target_link_url`
- `anchor_text`
- `rel`
- `visible_state`
- optional `link_text_context`

2. Multi-family dossier fields
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

3. Finalize / execution_state
- verifier 输出进入 artifacts / finalize / execution_state
- 非 directory family 的成功判定不得只靠 thank-you / pending review 文案直接收口

### TDD steps
Step 1: 写 failing tests
- `link verifier extracts live_page_url, target_link_url, anchor_text, rel, visible_state`
- `forum profile success requires verifier-backed public profile evidence`
- `wp comment pending moderation is not terminal success`
- `dev blog published state distinguishes with-link vs no-link`
- `missing-input schema recognizes forum/wp/dev fields`

Step 2: 跑 RED
Run:
`corepack pnpm test -- --test-name-pattern "link verifier|forum profile success|wp comment|dev blog|missing input"`

Step 3: 做最小实现
- 只新建一个 `link-verifier.ts`
- 其余都在共享文件上加最小字段和接线

Step 4: 跑 GREEN
Run:
`corepack pnpm test -- --test-name-pattern "link verifier|forum profile success|wp comment|dev blog|missing input"`

Step 5: 跑共享层回归
Run:
`corepack pnpm test -- --test-name-pattern "finalization|task progress|business outcome|missing input|link verifier"`

### Completion criteria
- verifier 存在并可被 finalize 消费
- 三类 family 的 dossier 字段已进入 schema
- execution_state / artifacts 能承载 verifier 结果
- 还没有做 family-specific 深化也没关系，但共享底座必须成立

---

## Phase B: 一轮完成三类 family 的运行面

### Objective
不要按 family 三次重复横扫同一组 shared files；在这一轮里一次性完成：
- family config 补足
- scout / page assessment / task progress 的 family cue
- takeover / task-queue 的 family-specific outcome handling
- references 回写机制

### Shared files touched once in this phase
- `src/families/non-directory.ts`
- `src/execution/scout.ts`
- `src/shared/page-assessment.ts`
- `src/shared/task-progress.ts`
- `src/execution/takeover.ts`
- `src/control-plane/task-queue.ts`

### Family references updated in this phase
- `../references/families/forum-profile.md`
- `../references/families/wp-comments.md`
- `../references/families/dev-blog.md`
- `../references/patterns/anti-spam.md`
- `../references/verification/link-verification.md`

### Tests updated in this phase
- `src/shared/page-assessment.test.ts`
- `src/shared/task-progress.test.ts`
- `src/execution/takeover.test.ts`
- `src/control-plane/task-queue.test.ts`

### Family-specific acceptance targets

#### forum_profile
Must support:
- `signature`
- `about me`
- `website`
- `social links`
- `member profile / account settings` entry recognition

Must not do:
- collapse to directory success semantics

Success means:
- public profile is reachable
- verifier confirms target link / rel on the live profile page

#### wp_comment
Must support:
- comment form recognition
- bounded format strategy: `plain_text | bbcode | html_link`
- anti-spam / moderation distinction

Success means:
- public live comment exists
- verifier confirms target link / rel

Non-success means:
- pending moderation only
- anti-spam block
- comment visible but no target link

Formatting/site quirks:
- write into `references/families/wp-comments.md`
- not into shared kernel conditionals

#### dev_blog
Must support:
- `write post`
- `draft`
- `submit for review`
- `publish`
- article field bundle from Phase A dossier

Success states must distinguish:
- `ARTICLE_DRAFT_SAVED`
- `ARTICLE_SUBMITTED_PENDING_EDITORIAL`
- `ARTICLE_PUBLISHED_WITH_LINK`
- `ARTICLE_PUBLISHED_NO_LINK`

Scope boundary:
- self-serve community article only
- no guest post / editorial outreach
- article content must remain fact-grounded

### TDD steps
Step 1: 写 failing tests
Target test groups:
- `forum_profile|signature|about me|social links|profile updated`
- `wp_comment|comment format|moderation|anti-spam|live comment`
- `dev_blog|draft saved|submitted for review|published with link`

Step 2: 跑 RED
Run three targeted groups separately.

Step 3: 做最小实现
- 共享文件这一轮只改一次
- family-specific 细节优先放 family config / references
- 不拆 family-specific runtime 文件，除非出现真实共用抽象不足的证据

Step 4: 跑 GREEN
Run the three targeted groups again.

Step 5: 跑整轮 family regression
Run:
`corepack pnpm test -- --test-name-pattern "forum_profile|wp_comment|dev_blog|page assessment|task progress|takeover|task-queue"`

### Completion criteria
- 三类 family 都有真实可验证的完成定义
- references 已经承担格式/反垃圾/验证经验沉淀
- 没有把站点个案升级成共享 kernel 真理

---

## Phase C: 最后做兼容清理与文档收尾

### Objective
等运行面真正成立后，再统一清理 remaining directory bias。避免先抽名词、后返工。

### Files
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

### Scope
1. Neutralize naming
- `directory_ready*`
- `missing_directory_fields`
- `frag_listing_form_v1`
- other shared-layer directory-default wording

2. CLI compatibility
- keep `--directory-url` as legacy alias
- expose neutral canonical wording
- do not break current callers

3. README / examples
- cover multiple families
- explicitly show `--flow-family`
- do not overclaim unsupported behaviors

### TDD steps
Step 1: 写 failing tests
- non-directory families no longer emit directory-only readiness wording
- task progress fragment ids are neutralized
- CLI keeps compatibility while exposing neutral input surface

Step 2: 跑 RED
Run:
`corepack pnpm test -- --test-name-pattern "missing input|init-gate|task progress|enqueue-site|forum_profile|wp_comment|dev_blog"`

Step 3: 最小实现
- 这里只做命名/兼容层/README 收尾
- 不再新增 runtime 文件

Step 4: 跑 GREEN
Same command as above.

---

## Final Acceptance Gate

Run:
`corepack pnpm test`

Then bias scan non-test code for:
- `directory_ready`
- `missing_directory_fields`
- `frag_listing_form_v1`
- README examples without `--flow-family`
- family-specific site quirks accidentally写进 shared kernel

Task2 completes only if:
- forum_profile: live profile + verified link/rel
- wp_comment: live public comment + verified link/rel
- wp_comment format经验已回写 reference
- dev_blog: self-serve article only + fact-grounded + correct outcome split
- verifier output persisted into artifacts/finalize/execution_state
- shared naming and docs cleaned after the runtime truly supports multi-family
- full test suite passes

---

## Why this plan is thinner than v2

Compared with v2, this version deliberately shrinks execution shape:
- one new runtime module, not a family-specific file explosion
- one shared substrate phase, not repeated shared-file edits hidden inside each family task
- one family completion phase, not three quasi-independent shared refactors
- one cleanup phase at the end, not premature naming abstraction

That is consistent with Hermes Skill Creator philosophy:
- keep the skill thin
- keep kernel logic deterministic and centralized
- keep family specifics in config/references
- keep site-specific experience out of giant shared if/else trees
