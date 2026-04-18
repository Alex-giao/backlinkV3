# Runtime Evolution Notes

This document archives the former development-phase sibling skills:
- `backlinkhelper-retry-classifier-phase-rollout`
- `backlinkhelper-terminal-classifier-phases`

It is not a runtime entry surface.
It is a repo-maintenance playbook for evolving the bundled `assets/backlinkhelper/` runtime.

## When to use

Use this document only when you are changing the bundled Backlink Helper runtime itself, especially around:
- early terminal classifier
- reason-aware retry / rerun
- shrinking `WAITING_RETRY_DECISION`
- finalize / takeover / task-queue responsibility boundaries
- business outcome vs system state layering
- reporter / status integration for new runtime truth

If you are only running V3, stay on the main skill and its runtime support references.

## First question: where is the real landing layer?

Do not start by editing queue logic because a queue symptom looks ugly.

Usually the real landing layer is one of:
- `src/execution/takeover.ts` — first-pass settlement, finalization, visual guard, early classifier
- `src/control-plane/task-queue.ts` — retry exhaustion collapse, repartition, reactivation

Rule of thumb:
- if the evidence is already enough to settle truth earlier, start in `takeover.ts`
- if truth already exists but queue behavior is still wrong, start in `task-queue.ts`

## Always read these first

Before changing runtime semantics, inspect:
- `src/execution/takeover.ts`
- `src/execution/takeover.test.ts`
- `src/control-plane/task-queue.ts`
- `docs/retry-rerun-terminal-classifier-design-v1.md`

Relevant design areas include:
- early terminal classifier
- success semantics
- queue / retry design corrections
- reporter / metrics implications

## Strict TDD discipline

Do not freehand runtime changes.

Preferred loop:
1. add or update failing tests first
2. run the real repo test command
3. implement the minimum code
4. rerun the same tests
5. rerun the broader suite

For this repo, the canonical commands are:

```bash
corepack pnpm build
corepack pnpm test
```

Important:
- do not rely on `node --test src/...` as the main entrypoint
- source tests import `.js` paths and expect built `dist/` output

## Recommended evolution patterns

### Early terminal classifier work

Preferred landing pattern in `src/execution/takeover.ts`:
- add a structured classifier such as `classifyEarlyTerminalOutcome(...)`
- return both machine-readable fields and a concrete `outcome`
- persist the classifier result into finalization artifacts, for example `early_terminal_classifier`
- keep older adapters thin if old call sites still expect a simpler `ProposedOutcome`

A useful classifier payload usually includes:
- hypothesis
- confidence
- supporting_signals
- contradicting_signals
- evidence_sufficiency
- recommended_state
- recommended_business_outcome
- allow_rerun
- outcome

### Business-outcome mapping

Do not duplicate business mapping across queue, reporter, and status layers.
Create or reuse a shared module such as:
- `src/shared/business-outcomes.ts`

Then let:
- status surfaces
- reporter scripts
- queue logic
consume the same mapping.

### Retry / reactivation work

When changing retry logic in `src/control-plane/task-queue.ts`:
- load structured classifier hints from artifacts first
- only fall back to generic text inference later
- preserve specific policy reasons when available

### Missing-input evolution

If the runtime already has a shared missing-input extractor, reuse it.
Do not create another field-language stack in execution code.

## Regression targets worth protecting

When adding or changing terminal families, strong RED cases usually include:
- clear missing input -> `WAITING_MISSING_INPUT`
- reciprocal backlink requirement -> `WAITING_POLICY_DECISION`
- `WAITING_SITE_RESPONSE` / email-verification waiting -> `submitted_success`
- non-directory family without live link evidence -> not final business success
- queue consumes structured classifier truth before free-text heuristics

## Verification checklist

Before closing a runtime semantics change, verify:
- new tests failed before the fix
- `corepack pnpm build` passes
- `corepack pnpm test` passes
- finalization artifacts contain the new structured fields
- runtime no longer leaves clearly-settleable cases in generic retry
- downstream status/reporter surfaces actually consume the new fields

If reporter output changed, also verify the consumer/prompt side; code-only schema updates are not enough.

## Common mistakes

- solving a reporter symptom while leaving upstream truth wrong
- implementing a queue-only fix for what was really an execution/finalize truth problem
- returning one coarse label instead of durable structured classifier output
- re-inventing missing-input extraction in execution code
- trusting old backlog artifacts to behave like new ones
- forgetting that prompt/report consumers may need updates when script payloads change
