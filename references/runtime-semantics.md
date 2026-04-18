# Runtime Semantics

This document is part of the bundled `web-backlinker-v3-operator` runtime documentation.

It absorbs the runtime-relevant stable semantics from the former development-phase sibling skills:
- `backlinkhelper-retry-classifier-phase-rollout`
- `backlinkhelper-terminal-classifier-phases`

These points are no longer separate skill entry surfaces. They are standing runtime semantics and maintenance facts for V3.

## Core semantic rules

### 1. Terminal truth should move forward, not backward

If evidence is already sufficient, prefer to settle terminal or waiting truth during execution/finalize rather than throwing the task into blind retry.

Practical rule:
- first authoritative layer is `takeover/finalize`
- queue/reactivator should consume that structured truth later
- reporter/status should consume shared business outcomes after that

Do not start from the reporter and work backward.

### 2. System state and business outcome are different layers

System state answers:
- where did the repo stop?

Business outcome answers:
- did the submission succeed in business terms?

Examples of default business mapping:
- `DONE` -> `submitted_success`
- `WAITING_SITE_RESPONSE` -> `submitted_success`
- `WAITING_EXTERNAL_EVENT` + `EMAIL_VERIFICATION_PENDING` -> `submitted_success`
- `WAITING_MISSING_INPUT` -> `blocked_missing_input`
- `WAITING_MANUAL_AUTH` -> `blocked_manual_auth`
- `WAITING_POLICY_DECISION` -> `blocked_policy`
- `SKIPPED` -> `skipped_terminal`
- `RETRYABLE` -> `retryable_runtime_or_evidence`
- `WAITING_RETRY_DECISION` -> `unknown_needs_review`

Do not answer campaign progress from `DONE` alone.

### 3. `WAITING_RETRY_DECISION` should shrink

It should remain only for genuinely unknown or conflicting cases.

Do not dump a task there when the real blocker is already clear, such as:
- missing truthful input
- manual auth
- policy wall
- clear submitted success with waiting follow-up
- clear terminal CAPTCHA or stale-path evidence

### 4. Queue logic must consume structured finalize truth before free-text heuristics

Preferred semantic flow:
1. execution/finalize decides early truth
2. finalization artifacts persist structured classifier output
3. queue/repartition/reactivator consume classifier output first
4. only then fall back to older text heuristics

If queue logic reads free text before strong structured evidence, it will override better truth with weaker guesses.

### 5. Preserve specific policy reasons

If policy evidence is more specific than a generic paid/sponsored wall, keep the specific reason.

Example:
- reciprocal-backlink requirements should remain `RECIPROCAL_BACKLINK_REQUIRED`
- do not flatten them into broad `PAID_OR_SPONSORED_LISTING`

### 6. Missing-input semantics should reuse the shared extractor

Do not build new field dictionaries ad hoc in execution paths.

Prefer the shared missing-input layer so these stay aligned:
- `wait.missing_fields`
- preflight
- init gate
- finalize
- reporting

### 7. Classifier output must be durable

If you produce early terminal/business truth, persist it into finalization artifacts so downstream layers can reuse it.

Preferred structured fields include at least:
- hypothesis
- confidence
- supporting_signals
- contradicting_signals
- evidence_sufficiency
- recommended_state
- recommended_business_outcome
- allow_rerun
- outcome

A classifier that only emits one label is too weak for downstream reuse.

## Runtime implications for V3 execution

### Structured discovery should outrank free-text keyword scans

For scout / prepare / recovery logic:
- visible forms, submit controls, same-origin entry links, and interactive embeds should be the first discovery layer
- raw body-text keyword matches are only fallback evidence, not the primary basis for declaring a submit/auth surface
- orchestration scripts may automate cadence and state transitions, but they must not hardcode site-flow click choreography as the canonical execution path

Why this matters:
- marketing pages often contain stray words like `join`, `submit`, or `profile` that do not represent the real next step
- footer links, comment permalinks, and content links can look like submit candidates under naive keyword matching
- the operator should receive cleaner, structure-first candidates so site judgment stays agent-driven rather than regex-driven

### Queue / reactivation

Reactivation should prefer structured truth such as:
- submitted success + waiting external event
- submitted success + waiting site response
- blocked missing input
- blocked manual auth
- blocked policy

Only after that should it fall back to generic text inference.

### Outcome / queue semantics must not let stale or generic text outrank current truth

Second-layer maintenance rule:
- active system state should outrank stale historical annotations
- generic marketing copy should not manufacture a terminal/policy state
- free-text fallback should only fire when it is corroborated by stronger boundary evidence or current structured state

Practical implications:
- `READY` / `RUNNING` must not be reclassified into blocked buckets just because an old `wait_reason_code` still says `REQUIRED_INPUT_MISSING` or `DIRECTORY_LOGIN_REQUIRED`
- task-progress surface inference should not upgrade a page into `submit_surface` / `auth_surface` / `confirmation_surface` from raw body copy alone when there are no real submit candidates, field hints, auth hints, title/url boundary cues, or current task-status evidence
- queue reason inference should not classify a page as `PAID_OR_SPONSORED_LISTING` just because the page mentions `sponsor`, `pricing`, `subscription`, `Stripe`, or `$49`; require an explicit paid-listing / sponsored-placement / checkout-for-listing boundary instead

Regression examples worth preserving:
- marketing landing copy like `Submit your tool today. Continue with Google. Thank you for exploring...` with no real CTA/form evidence should stay `page_surface`
- stale blocked waits attached to a `READY` / `RUNNING` task should not override active-queue business outcome
- `Sponsored by Stripe` or analytics/pricing copy on an otherwise free submit surface should not collapse into paid-policy classification without an explicit listing/payment boundary

### Reporting

If status/reporter surfaces change shape, downstream prompts or consumers must also update to use the new business fields.
Producing `successful_submissions` in code while the reporting prompt still speaks old system-state language is an integration failure, not a runtime success.

### Non-directory family semantics

For `forum_profile`, `wp_comment`, and `dev_blog`, business success should not collapse from UI copy alone.
Default rule:
- live/public backlink verification is the business-success gate
- submit/pending/review text without live-link evidence is not final success

### Flow-family truth vs runtime observations

`flow_family` is enqueue-time truth, not a fresh runtime inference.
Practical implications:
- `enqueue-site --flow-family ...` (or its upstream caller) decides the family contract that scout / decider / visual verification / finalize will use
- if `flow_family` is absent, runtime falls back to `saas_directory`
- `task-prepare` may update `target_url`, `hostname`, and `opportunity_class`, but it does not automatically reclassify the task into a different family

Why this matters:
- a wrong family biases scout regexes, page-assessment signals, prompt cues, and terminal interpretations in the same wrong direction
- captcha/interstitial recovery can make this worse: after a noisy homepage or anti-bot gate, the first reachable logged-in/settings page may look like a valid terminal surface for the stored family even when the site’s real business surface belongs to another family

Operator rule:
- if the public/home/root surface clearly contradicts the stored family contract, do not trust the current task’s family-specific terminal closure
- instead, treat it as a family-misclassification case: reopen/re-enqueue the site under the correct family (or otherwise correct the task truth) before settling business outcome
- do not let an accidental reachable page like `/settings` or `/profile` override a stronger site-level signal that the hostname is actually a directory / article-submit / comment surface

### Success semantics

Default `submitted_success` should at least include:
- `DONE`
- `WAITING_SITE_RESPONSE`
- `WAITING_EXTERNAL_EVENT` + `EMAIL_VERIFICATION_PENDING`

For non-directory families, apply the live-link verification rule above before collapsing to final business success.

## Maintenance checklist

When evolving runtime semantics, ask in this order:
1. Is this an execution/finalize truth problem?
2. Is it actually a queue/repartition consumption problem?
3. Is it a reporting/prompt integration problem?
4. Is it merely a data-backfill issue in old artifacts?

Do not jump to the reporter first.

## Pitfalls

- Do not implement business outcome mapping separately in multiple places.
- Do not keep tasks in generic retry when the root cause is already known.
- Do not trust old backlog artifacts to contain modern classifier fields.
- Do not confuse a data-backfill gap with a live logic bug.
- Do not flatten precise policy reasons into vague bucket labels.

## Verification

When runtime semantics change, verify at least:
- finalization artifacts contain the structured truth you expect
- queue/repartition consumes that truth before free-text fallback
- reporter/status output reflects business outcomes, not only system state
- test entrypoints use the repo’s real build/test path rather than ad-hoc source-only shortcuts
