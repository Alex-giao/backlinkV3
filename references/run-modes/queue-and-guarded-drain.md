# Queue / Guarded Drain Modes

This file is part of `web-backlinker-v3-operator`.

It is the retained queue-scale operations reference for V3.
It absorbs the former sibling skills:
- `backlinkhelper-hermes-guarded-drain`
- `backlinkhelper-ready-queue-drain`

Those names are no longer active entry points. They are now operating modes of the same V3 system.

## When to use

Use this document when the user is not asking for one bounded site tick, but for campaign-scale progress under the same V3 runtime, for example:
- batch-run the current READY queue for one promoted site
- keep a bounded campaign slice progressing unattended
- reactivate a small amount of retry-decision inventory and drain it safely
- run a guarded queue drain with health checks and scoped repair

If the user is asking to work one site only, stay on the main bounded run contract in `SKILL.md`.

## Core principle

Do not turn V3 into one infinite-loop worker.

Preferred drain architecture:
1. worker tick — exactly one bounded V3 task per run
2. retry reactivator — selectively move a few high-confidence tasks back into READY
3. watchdog — health/status only, with bounded repair

Why:
- fresh session each tick
- low context accumulation
- easier crash recovery
- clearer audit trail
- preserves the same prepare -> evidence -> trace -> finalize truth model as single-task V3

## Required repo capabilities

Campaign drain assumes the bundled runtime exposes:
- `claim-next-task` scope filters such as `--task-id-prefix`, `--promoted-hostname`, `--promoted-url`
- `repartition-retry-decisions` scope filters plus `--apply-buckets` and `--max-apply`
- `guarded-drain-status` for scoped health/status output
- repo-native `task-prepare`, `task-record-agent-trace`, and `task-finalize`

If these are missing, fix the runtime first. Do not paper over missing repo capabilities with prompt gymnastics.

## Default guarded-drain shape

### 1. Worker tick

Purpose:
- claim exactly one scoped task
- run the normal bounded V3 chain
- never claim a second task in the same run

Typical cadence:
- every 5m

Typical commands:

```bash
corepack pnpm guarded-drain-status -- \
  --task-id-prefix <prefix> \
  --cdp-url http://127.0.0.1:9224

corepack pnpm claim-next-task -- \
  --owner <worker-owner> \
  --task-id-prefix <prefix>
```

Then continue with:
- `task-prepare`
- main operator loop if needed
- `task-record-agent-trace`
- `task-finalize`

### 2. Retry reactivator

Purpose:
- inspect `WAITING_RETRY_DECISION`
- only release a few high-confidence tasks
- avoid blind full-batch requeue

Typical cadence:
- every 15m

Recommended command pattern:

```bash
corepack pnpm repartition-retry-decisions -- \
  --apply \
  --limit 40 \
  --task-id-prefix <prefix> \
  --apply-buckets reactivate_ready,runtime_reactivate_ready \
  --max-apply 3 \
  --cdp-url http://127.0.0.1:9224
```

Interpretation:
- inspect a bounded slice only
- release only safe/high-confidence buckets
- keep manual-review buckets parked
- repeated losers should cool down before re-entering READY
- apply host-level guardrails; do not keep releasing the same bad host repeatedly

### 3. Watchdog

Purpose:
- report current blockers
- surface stale lease/browser-lock repair
- stay read-mostly
- do not claim tasks and do not run browser automation

Typical cadence:
- every 5m

Command:

```bash
corepack pnpm guarded-drain-status -- \
  --task-id-prefix <prefix> \
  --cdp-url http://127.0.0.1:9224
```

Healthy watchdog output should focus on actual blockers:
- runtime unhealthy
- lease held too long
- repeated recovery failure

A stale lock being reaped is often a successful bounded repair, not a steady-state blocker.

## Idle scope cleanup

A running cron is not proof that a campaign still has runnable work.

If scoped `guarded-drain-status` shows `ready=0` and `retryable_eligible_now=0`:
- treat the scope as idle rather than as an active worker campaign
- if the remaining inventory is only `WAITING_SITE_RESPONSE`, `WAITING_EXTERNAL_EVENT`, `WAITING_MISSING_INPUT`, `WAITING_MANUAL_AUTH`, or `WAITING_POLICY_DECISION`, do not keep empty worker/watchdog schedules spinning by default
- preferred cleanup layer: the parent/bootstrap/manual maintenance session should pause/remove the related cron job; do not assume a cron-run child session should blindly mutate scheduling from inside its own tick
- only keep a pure watchdog alive when the user explicitly wants passive health watch / external-event observation

## READY queue / imported-batch variation

Use this variation when the user explicitly asks to run the current READY or reactivated queue for one promoted site.

### Recommended flow

1. Run missing-input preflight first:

```bash
corepack pnpm missing-input-preflight --promoted-url <PROMOTED_URL>
```

- if `unresolved_fields` is non-empty, stop and ask once for the whole missing-input set
- if empty, continue

2. Inspect queue shape for that promoted hostname:
- count READY / WAITING_* / RETRYABLE / RUNNING
- distinguish imported batch tasks from legacy tasks if that matters

3. Repartition retry decisions before bulk drain:

```bash
corepack pnpm repartition-retry-decisions -- --apply
```

Do not assume every `WAITING_RETRY_DECISION` task is runnable.

4. Validate the operator path with one real task first:

```bash
corepack pnpm claim-next-task -- --owner <owner>
corepack pnpm task-prepare -- --task-id <task_id> --cdp-url http://127.0.0.1:9224
```

Then actually run one site to confirm runtime health before bulk drain.

5. After one real validation, keep the worker on the operator path — do not hand site-level navigation/submit decisions to a source-only tmp helper with hardcoded keywords or scripted click choreography.

Allowed automation shell:
- scheduler / cron cadence
- claim / prepare / trace / finalize orchestration
- task-state recounts and reporting

But the actual site execution for each claimed task should still re-enter the operator skill / bounded agent judgment loop on fresh evidence, rather than a tmp script pretending to know the site flow.

Recommended Hermes pattern:
- background orchestration process is OK
- `notify_on_complete=true`
- live recount of task states while it runs
- each task still follows `claim-next-task -> task-prepare -> operator reasoning -> task-record-agent-trace -> task-finalize`

6. Monitor by truth, not by startup logs:
- task state recounts under `$BACKLINKHELPER_STATE_DIR/tasks/*.json`
- worker lease file under `$BACKLINKHELPER_STATE_DIR/runtime/task-worker-lease.json`
- process status

7. Report honestly:
- if the worker is still running, say so
- do not claim drained until READY is near zero or the worker exits idle

## Cadence and scaling guidance

### Avoid blind throughput math

A worker scheduled every 5m does not imply 12 completions/hour.
One bounded tick can spend real time on:
- claim
- prepare
- runtime recovery
- evidence capture
- trace
- finalize

Better KPIs:
- unique tasks whose state materially changed
- new `submitted_success` count
- new structured blocker count (`WAITING_MISSING_INPUT`, `WAITING_MANUAL_AUTH`, etc.)
- repeated claims on the same task/host without state improvement

### Cool down repeated losers

If the same task or host keeps consuming bounded ticks without state improvement:
- stop treating it as normal inventory
- quarantine with cooldown or stronger triage
- do not let the reactivator immediately feed it back into READY

### Do not jump to parallelism too early

Fix these first:
1. cooldown / host deprioritization
2. better retry classification
3. stale-path / runtime-heath ambiguity

Only then consider multi-worker scaling.

If you do scale, isolation matters:
- separate browser runtime / CDP endpoint
- separate browser profile / cookie jar
- ideally separate network identity if campaign policy requires it

### Long-running drain worker is sometimes better than more ticks

If startup/teardown overhead dominates, prefer one continuous worker over more frequent overlapping ticks.

Pattern:

```bash
corepack pnpm drain-worker -- \
  http://127.0.0.1:9224 \
  999 \
  <owner> \
  <prefix>
```

Use this when:
- READY keeps regenerating
- short cron ticks mostly burn overhead
- you want one continuous worker without increasing concurrency

This is still single-worker draining, not a worker farm.

## Operational pitfalls

### Never use an infinite-loop chat session as the worker

Bad pattern:
- one long-lived session that claims, runs, claims, runs forever

Why bad:
- bloated context
- dirty browser/runtime state
- harder crash recovery
- poor auditability

### Scope safety matters

If scope filtering happens after claim-side queue mutation, a supposedly scoped claim can still rewrite unrelated tasks. Scope must apply before queue mutation.

### Do not bulk-reactivate blindly

Only auto-reactivate strong buckets such as:
- `reactivate_ready`
- `runtime_reactivate_ready`

Leave the rest in triage.

### Do not probe `follow-up-tick` with `--help`

Observed CLI pitfall:
- `corepack pnpm follow-up-tick -- --help` can execute a real, effectively unscoped follow-up tick instead of printing usage

Operator rule:
- do not use `--help` as a dry-run probe for this subcommand
- if you need the accepted flags, inspect `src/cli/index.ts` / `src/cli/follow-up-tick.ts`
- in production runs, pass the explicit scope flags (`--task-id-prefix`, `--promoted-hostname`, or `--promoted-url`) and owner directly on the first invocation

### Do not probe `claim-next-task` with `--help`

Observed CLI pitfall:
- `corepack pnpm claim-next-task -- --help` can execute a real claim instead of printing usage
- at least one live run claimed a scoped task immediately and wrote a lease/notes entry rather than showing help text

Operator rule:
- do not use `--help` as a dry-run probe for this subcommand either
- inspect `src/cli/index.ts` / `src/cli/claim-next-task.ts` for accepted flags
- when running live, pass explicit `--owner`, `--lane`, and scope flags on the first invocation so an accidental default claim cannot widen the blast radius

### Follow-up ticks inherit the same runtime-incident gate as normal claims

Observed runtime behavior:
- `follow-up-tick` calls the same `claimNextTask(... lane: "follow_up")` path as other queue claims
- if a runtime incident / circuit breaker is still open, the claim step returns `mode: "idle"` before lane-specific follow-up selection happens
- this can happen even when you are only targeting `WAITING_EXTERNAL_EVENT` / `WAITING_SITE_RESPONSE` continuations and even when the scoped follow-up inventory is already zero

Operator rule:
- when a scoped `follow-up-tick` returns `idle`, do not immediately interpret that as "no continuation work exists"
- inspect the prior `guarded-drain-status` payload for `runtime_incident` / circuit-breaker state first
- in reporting, distinguish `idle because no follow-up tasks matched` from `idle because the runtime breaker is still open`
- if guarded status already shows zero scoped follow-up tasks, keep the report concise and do not overstate the breaker as a follow-up delta
### `corepack pnpm <command>` output is not guaranteed to be pure JSON

Observed CLI pitfall:
- repo commands such as `guarded-drain-status` can print the package-manager preamble before the JSON payload
- a scripted caller that assumes stdout starts with `{` can fail to parse otherwise-valid command output

Operator rule:
- for machine parsing, either call `node dist/cli/index.js ...` directly or strip the `pnpm` preamble before JSON parsing
- do not treat a top-level JSON parse failure as proof that the repo command itself failed
- when you only need human reporting, it is fine to run the normal `corepack pnpm ...` form and read the payload manually

### Manual browser-use in guarded drain may need the websocket CDP URL

Observed failure mode:
- `browser-use --cdp-url http://127.0.0.1:9224 ... open ...` works
- the next `eval/state/screenshot` fails with a config mismatch

Reliable workaround:
1. read the live websocket endpoint:

```bash
curl -s http://127.0.0.1:9224/json/version
```

2. use `webSocketDebuggerUrl`
3. pass that `ws://.../devtools/browser/...` value to all browser-use calls in the same session

### Tiny viewport is a runtime blocker, not a site conclusion

After attaching a task-scoped session, inspect viewport metrics.
If either dimension is `< 100`:
- treat it as runtime-unhealthy
- stop the bounded worker
- capture evidence with Playwright/CDP if needed
- finalize as a system-owned retryable blocker rather than blaming the site

Practical symptom pattern from live runs:
- the page may still be reachable and even show visible form fields in DOM / Playwright inspection
- but the attached shared tab can collapse to something like `innerWidth=1`, `innerHeight=1` while `outerWidth` stays non-zero
- submit controls then produce misleading click failures such as `intercepts pointer events` or `element is outside of the viewport`
- if you have already filled fields before noticing the collapsed viewport, do **not** reinterpret that as a real submission attempt; record that no trustworthy click/submit happened and stop cleanly

Recommended outcome shape:
- `next_status: RETRYABLE`
- `wait_reason_code: SHARED_BROWSER_TINY_VIEWPORT`
- `resolution_owner: system`
- `resolution_mode: auto_resume`

### CDP HTTP health can be green while Playwright-over-CDP is still broken

Observed runtime failure mode:
- `http://127.0.0.1:9224/json/version` and `/json/list` both respond normally
- `guarded-drain-status` shows `cdp=true` and sometimes `browser_use=true`
- but `Playwright connectOverCDP(...)` still times out after the websocket connects
- one concrete variant: `task-prepare --cdp-url http://127.0.0.1:9224` reports that the alternate loopback host `http://localhost:9224` responds as a Chrome instance, suggesting the two loopback listeners are not actually the same browser/runtime
- newer runtime wording may explicitly say another browser instance is likely occupying one loopback listener and recommend `Use http://localhost:9224 directly or restart on a clean port.` Treat that as the same split-listener failure class, not as a target-site blocker
- `task-prepare` may then auto-stop the task into a system-owned retryable state such as `RETRYABLE` + `PLAYWRIGHT_CDP_UNAVAILABLE`

Operator rule:
- treat this as runtime health failure, not a site-specific blocker
- if `task-prepare` already wrote the task into retryable auto-resume state, do **not** force a manual agent loop just to satisfy the normal chain
- verify the persisted task JSON (`status`, `wait`, `terminal_class`, notes/evidence) and report the runtime blocker as the actual outcome of that tick
- when the error explicitly mentions the alternate loopback host, suspect a `127.0.0.1` vs `localhost` listener split/conflict before blaming the target site; retry with the canonical host the runtime expects or restart on a clean port
- prefer `guarded-drain-status` plus a direct Playwright `connectOverCDP` probe when you need to distinguish “Chrome HTTP endpoint alive” from “authoritative Playwright layer usable”

### Login overlays can create false signup retries

If the visible surface is a login/auth overlay but background homepage copy contains words like `Join` or `register`, finalization may over-trigger signup continuation.

Operator rule:
- record the exact visible path into the overlay
- capture a focused screenshot of the actual dialog
- describe the visible overlay in the handoff, not just the background page
- if this repeats, patch the runtime heuristics instead of pretending the site exposed a real continuation

### Do not assume `browser-use` is on PATH

Repo preflight may resolve `browser-use` from a fallback path even when plain shell PATH says command not found.
For ad-hoc manual commands, prefer the resolved binary explicitly rather than misdiagnosing a site problem.

### `task-finalize` may require vault discipline

If `BACKLINER_VAULT_KEY` is unavailable, do not stuff `credential_payload` into the trace envelope just to preserve lightweight account metadata. Keep only non-secret account metadata unless credential persistence is truly required.

### Not every visible submit form is a backlink surface

A generic utility page with one URL field and a Share button is not a directory/profile/comment submission surface.
If the page does not publish a listing/profile/comment/article outcome:
- capture evidence
- record trace
- finalize to `SKIPPED`

## Verification

Before calling a campaign drain healthy, verify:
- worker job handles one task per tick
- scoped claim never touches unrelated campaigns
- reactivator releases only a few high-confidence tasks per run
- watchdog is mostly quiet when healthy
- queue reports are based on current task truth, not startup logs
- user-facing reports distinguish still-running drain from actually-drained queue
