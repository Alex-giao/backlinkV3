# Runtime Philosophy Hardening Notes

## Trigger

Use this note when maintaining or extending BacklinkHelper V3 runtime logic around:
- `task-queue` retry repartition / bucket assignment
- `takeover` final-state classification
- `task-progress` frontier/evidence/context inference
- `families/*` config design

## Core rule

Raw text is audit evidence, not a business-state decider.

Do NOT let free-text alone directly determine:
- `next_status`
- retry bucket / repartition bucket
- business outcome
- paid/manual-auth/missing-input/success terminal state
- non-directory family checkpoint states like profile pending / comment moderation / draft saved / published-no-link

## Required precedence order

When deciding state transitions, prefer this order:
1. Structured artifact outcome (`final_outcome`, `proposed_outcome`, classifier fields)
2. Explicit `wait_reason_code`, `skip_reason_code`, `terminal_class`
3. Visual verification classification/confidence
4. Link verification (`verified_link_present`, `link_missing`, etc.)
5. Family semantic contract
6. Only then low-confidence text audit hints

Text fallback may support runtime/audit hints, but should not directly create business-terminal states.

## Specific implementation lessons

### 1. `task-queue.ts`
- `inferReasonFromText()` should be limited to operational/runtime hints such as:
  - stale submit path
  - navigation failed
  - outcome not confirmed
  - runtime error
- It should NOT directly return business-terminal reasons like:
  - `SITE_RESPONSE_PENDING`
  - `EMAIL_VERIFICATION_PENDING`
  - `DIRECTORY_LOGIN_REQUIRED`
  - `PAID_OR_SPONSORED_LISTING`
  - `REQUIRED_INPUT_MISSING`
  - reciprocal backlink requirement
- If classifier output exists, prefer `classifierHypothesis` / `recommended_state` / `recommended_business_outcome` over text summary.

### 2. `takeover.ts`
- Non-directory checkpoint classification must not be driven by body text alone.
- For `forum_profile`, `wp_comment`, and `dev_blog`, require surface boundary evidence before accepting text cues in early classifier logic.
  - forum profile: profile/member/account/settings surface
  - wp comment: comment/reply/comments surface
  - dev blog: editor/new/review/publish surface
- `applyFamilySpecificOutcomeGuard()` should consume structured `wait_reason_code` + link verification, not raw `bodyText`, to invent family checkpoints.

### 3. `task-progress.ts`
- Retry/review states must not be polluted by stale titles like `Thanks for submitting`.
- `inferContextType()` / `inferSignals()` should prioritize:
  - task status
  - wait reason
  - terminal class
  - visual classification
  - explicit candidates / hints
- Marketing copy and generic confirmation phrases must not create submit/auth/confirmation surfaces without corroborating boundary evidence.

### 4. Family config design
- Keep moving family config away from string-signal bundles and toward semantic contracts.
- At minimum, each family should expose reusable semantic requirements such as:
  - `requires_live_link_verification_for_success`
  - `pending_wait_reason_codes`
  - `progress_wait_reason_codes`
  - `review_wait_reason_codes`
  - `policy_wait_reason_codes`
- Consumers like `business-outcomes.ts` and `task-queue.ts` should read these contract fields instead of hardcoding non-directory family lists or reason-code sets.

## Required regression tests

Any future runtime change touching classification must add anti-misclassification tests for:
- generic sponsor/pricing copy
- unstructured thank-you / success copy
- stale notes / stale title / stale wait pollution
- family mismatch (directory wording on forum/comment/blog surfaces)
- generic saved/draft/moderation copy without matching surface evidence

## Verification standard

After changes:
- run targeted tests for the new regression cases
- then run full suite:
  - `corepack pnpm test`

If a change improves success on one path by making raw text more powerful, assume it is architecturally suspicious until proven otherwise.
