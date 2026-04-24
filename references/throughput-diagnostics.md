# Throughput Diagnostics for Queue/Cron Runs

Use this when a bounded BacklinkHelper V3 cron/worker feels too slow for production.

## What to measure first

1. Task stage timestamps
   - Read `task.stage_timestamps` first.
   - Split latency into at least:
     - `enqueued_at -> claimed_at`
     - `prepare_started_at -> prepare_finished_at`
     - `trace_recorded_at -> finalize_finished_at`
   - Prefer these fields over artifact-time inference whenever they exist.

2. Cron output cadence
   - Inspect `~/.hermes/cron/output/<job_id>/*.md` timestamps.
   - Compare actual output interval vs nominal schedule.
   - If a job scheduled every 5m is producing outputs every 20m+ on average, the bottleneck is execution duration / serialization, not queue starvation.

3. Queue progress semantics
   - Do **not** equate `total - READY` with "completed".
   - Split inventory into:
     - touched = `total - READY`
     - closed terminal = `DONE + SKIPPED`
     - nonterminal touched = `WAITING_SITE_RESPONSE + WAITING_EXTERNAL_EVENT + RETRYABLE + RUNNING`
   - Report both touched and closed; otherwise throughput will be overstated.

4. Task-file reality check
   - Read `$BACKLINKHELPER_STATE_DIR/tasks/<prefix>*.json` and aggregate:
     - `status`
     - `flow_family`
     - `wait.wait_reason_code`
     - `run_count`
     - `takeover_attempts`
     - `created_at` / `updated_at`
   - Key interpretation:
     - `run_count` mostly 0/1 means low throughput is **not** from many replays of the same task.
     - Large `updated_at - created_at` spans with low `run_count` mean queue latency / serialized worker cadence is the issue.

## Common root-cause buckets

### 1. Architecture bottleneck
- Prompt/contract claims exactly one task per run.
- Skill/runtime enforces bounded single-task work with ~10m timebox.
- Real output cadence becomes much slower than the nominal cron interval.
- Conclusion: this is an operator-style lane, not a production throughput lane.

### 2. Family mix causes slow business closure
- If queue is dominated by `wp_comment` / `forum_profile` / `dev_blog`, remember these are **not** submit-and-done.
- Business success often requires live public backlink verification.
- `COMMENT_MODERATION_PENDING`, `SITE_RESPONSE_PENDING`, and `EMAIL_VERIFICATION_PENDING` are expected wait states, not immediate failures.
- Therefore touched throughput and closed throughput will diverge sharply.

### 3. Runtime persistence / verifier bugs
Check for contradictions such as:
- `status = DONE` but `link_verification.verification_status = link_missing`
- `link_verification.live_page_url` host does not match the task hostname
- final response claims live backlink success but persisted verifier payload points at an unrelated page

If present, treat this as a production blocker:
- automated reporting is untrustworthy
- downstream retry/decision logic may be poisoned
- fix verifier/finalize persistence before scaling workers

### 4. Bad target intake
Watch for buckets like:
- `DIRECTORY_NAVIGATION_FAILED`
- `unsupported_surface_no_direct_backlink_slot`
- wrong-target redirects / clearly unrelated hosts
- paid-only or captcha-blocked surfaces

If these are discovered only after expensive browser work, the intake/preflight layer is too weak. Tighten pre-enqueue filtering before trying to improve worker count.

### 5. Platform/model slot waste
Cron slots that end in model 429/500 or summarization failure should be counted explicitly as wasted capacity.
Even a small percentage matters when worker cadence is already serialized.

## Recommended reporting format
When diagnosing production fitness, report:
- nominal schedule vs actual output cadence
- total / touched / closed terminal / still-nonterminal
- family mix
- top wait reasons
- verifier mismatch count
- wasted cron slots from platform/model errors

## Practical conclusion rule
If actual cadence is far below nominal, most touched tasks are still nonterminal, and verifier persistence is contradictory, do **not** call the workflow production-ready. Classify it as an evidence-heavy operator workflow first, then propose architectural fixes (parallel lanes, family-split queues, stronger preflight, verifier repair).