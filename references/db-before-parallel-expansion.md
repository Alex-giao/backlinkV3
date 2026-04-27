# BacklinkHelper V3: Database-First Before Parallel Expansion

Use this reference when planning storage migration or multi-task parallelism for BacklinkHelper V3.

## Core Principle

Do not make parallelism the first architecture change. Move structured state behind a storage boundary first, prove the existing single-slot operator path still works, then add multiple workers / CDP sessions on top of the same state model.

Reason: parallelism amplifies every state bug. A DB-backed task/lease/event model can be validated in the current serial path without changing operator behavior.

## Safe Rollout Order

1. Introduce a `DataStore` abstraction while preserving the current file-backed behavior.
2. Add a D1/SQLite-compatible schema and adapter behind an explicit env/config switch.
3. Import or shadow existing state from `BACKLINKHELPER_STATE_DIR`; keep file store rollback available.
4. Run DB smoke tests for task enqueue/load/update, lease write/clear, event append, account/playbook lookup, and artifact reference writeback.
5. Run one controlled single-task backlink flow in DB mode.
6. Only after serial DB mode is stable, add multi-worker claiming, host-level concurrency rules, and multi-CDP browser runtime allocation.

## What Belongs in D1

D1 should hold structured state and query indexes:

- promoted profiles / sites being promoted
- target sites / exact target host identity
- task records and current status
- task event log / phase history
- worker leases and lease groups
- account metadata and credential references, not secrets
- playbook summaries and family/config references
- artifact metadata: path, hash, kind, task/run linkage
- runtime key-value flags or circuit-breaker metadata

Keep the full current `TaskRecord` compatible by storing a `payload_json` column while also extracting common query columns such as `id`, `status`, `hostname`, `target_url`, `flow_family`, `queue_priority_score`, `created_at`, and `updated_at`.

## What Should Not Go Into D1

Do not store large or volatile blobs directly in D1:

- screenshots
- full HTML dumps
- Playwright traces
- large evidence JSON dumps
- temporary browser/session artifacts

Store these in local state or future object storage such as R2, and keep only artifact references in D1.

## First-Version Tables

A minimal first schema can be:

- `backlink_tasks`
- `task_events`
- `promoted_profiles`
- `target_sites`
- `site_playbooks`
- `account_records`
- `worker_leases`
- `artifact_refs`
- `runtime_kv`

Do not over-normalize the first version. Compatibility with current task semantics matters more than a perfect relational model.

## Parallelism Boundary

Before enabling multiple workers, define:

- atomic claim / lease semantics
- lease expiry and stale lease reaping
- exact-host duplicate policy
- promoted-site and target-host concurrency caps
- account/session isolation
- CDP endpoint/profile allocation
- global rate limits and per-host cooldowns
- finalization idempotency

The serial DB migration should not silently introduce parallel behavior. Treat multi-worker claiming as a later explicit feature.

## Browser/CDP Guidance

Multiple CDP browsers are feasible only if each worker has an isolated profile/user-data-dir and an allocated debugging port. Shared CDP is acceptable for single-slot operation but unsafe as the default for true parallel execution because tab/profile/session drift can corrupt evidence and finalization.

Recommended future model:

- worker slot owns one browser profile and one CDP endpoint
- runtime resolver returns canonical endpoint per slot
- leases record worker/slot ownership
- no two workers mutate the same task or same active host surface concurrently unless the scheduler explicitly allows it

## Verification

A DB-first migration is not done until:

- existing file-backed tests still pass
- DB adapter tests pass against SQLite/D1-compatible SQL
- import/shadow script can round-trip representative state
- one single-slot DB-mode task runs through prepare → trace → finalize
- artifacts remain referenced but not embedded in DB
- rollback to file store is still possible
