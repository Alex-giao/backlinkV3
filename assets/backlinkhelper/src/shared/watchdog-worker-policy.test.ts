import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireWorkerLock,
  classifyCampaignRun,
  refreshWorkerLock,
  releaseWorkerLock,
  shouldStopWorkerLoop,
} from "./watchdog-worker-policy.js";

function tmpLockDir(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "backlink-worker-lock-")), "worker.lock");
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

test("acquireWorkerLock creates a fresh single-owner lock and blocks a second active owner", () => {
  const lockDir = tmpLockDir();
  const first = acquireWorkerLock({
    lockDir,
    ownerId: "worker-a",
    nowMs: 1_000,
    staleMs: 60_000,
    metadata: { promoted_hostname: "suikagame.fun" },
  });

  assert.equal(first.acquired, true);
  assert.equal(first.recovered_stale, false);
  assert.equal(fs.existsSync(path.join(lockDir, "lock.json")), true);
  assert.equal(readJson(path.join(lockDir, "lock.json")).owner_id, "worker-a");

  const second = acquireWorkerLock({
    lockDir,
    ownerId: "worker-b",
    nowMs: 5_000,
    staleMs: 60_000,
  });

  assert.equal(second.acquired, false);
  assert.equal(second.reason, "active");
  assert.equal(second.lock?.owner_id, "worker-a");
});

test("acquireWorkerLock recovers stale locks and transfers ownership", () => {
  const lockDir = tmpLockDir();
  const first = acquireWorkerLock({ lockDir, ownerId: "old-worker", nowMs: 1_000, staleMs: 60_000 });
  assert.equal(first.acquired, true);

  const recovered = acquireWorkerLock({ lockDir, ownerId: "new-worker", nowMs: 90_000, staleMs: 60_000 });

  assert.equal(recovered.acquired, true);
  assert.equal(recovered.recovered_stale, true);
  assert.equal(readJson(path.join(lockDir, "lock.json")).owner_id, "new-worker");
});

test("refreshWorkerLock and releaseWorkerLock only mutate locks owned by the caller", () => {
  const lockDir = tmpLockDir();
  assert.equal(acquireWorkerLock({ lockDir, ownerId: "owner", nowMs: 1_000, staleMs: 60_000 }).acquired, true);

  assert.equal(refreshWorkerLock({ lockDir, ownerId: "intruder", nowMs: 2_000 }).ok, false);
  assert.equal(readJson(path.join(lockDir, "lock.json")).heartbeat_at, "1970-01-01T00:00:01.000Z");

  assert.equal(refreshWorkerLock({ lockDir, ownerId: "owner", nowMs: 2_000 }).ok, true);
  assert.equal(readJson(path.join(lockDir, "lock.json")).heartbeat_at, "1970-01-01T00:00:02.000Z");

  assert.equal(releaseWorkerLock({ lockDir, ownerId: "intruder" }).released, false);
  assert.equal(fs.existsSync(lockDir), true);

  assert.equal(releaseWorkerLock({ lockDir, ownerId: "owner" }).released, true);
  assert.equal(fs.existsSync(lockDir), false);
});

test("classifyCampaignRun separates productive task runs from idle and hard-stop outcomes", () => {
  assert.deepEqual(
    classifyCampaignRun({ stop_reason: "max_active_tasks", active_tasks_started: 1, active_tasks_finalized: 1 }),
    { productive: true, idle: false, hard_stop: false, reason: "max_active_tasks" },
  );

  assert.deepEqual(
    classifyCampaignRun({ stop_reason: "no_candidate", active_tasks_started: 0, active_tasks_finalized: 0 }),
    { productive: false, idle: true, hard_stop: false, reason: "no_candidate" },
  );

  assert.deepEqual(
    classifyCampaignRun({ stop_reason: "scope_mismatch", active_tasks_started: 0, active_tasks_finalized: 0 }),
    { productive: false, idle: false, hard_stop: true, reason: "scope_mismatch" },
  );
});

test("shouldStopWorkerLoop stops before starting unsafe extra work", () => {
  assert.equal(
    shouldStopWorkerLoop({
      iteration: 10,
      maxIterations: 10,
      idleCount: 0,
      idleLimit: 2,
      startedAtMs: 0,
      nowMs: 1_000,
      maxRuntimeMs: 600_000,
      minRemainingMs: 60_000,
    }),
    "max_iterations",
  );

  assert.equal(
    shouldStopWorkerLoop({
      iteration: 1,
      maxIterations: 10,
      idleCount: 2,
      idleLimit: 2,
      startedAtMs: 0,
      nowMs: 1_000,
      maxRuntimeMs: 600_000,
      minRemainingMs: 60_000,
    }),
    "idle_limit",
  );

  assert.equal(
    shouldStopWorkerLoop({
      iteration: 3,
      maxIterations: 10,
      idleCount: 0,
      idleLimit: 2,
      startedAtMs: 0,
      nowMs: 560_000,
      maxRuntimeMs: 600_000,
      minRemainingMs: 60_000,
    }),
    "insufficient_runtime_budget",
  );

  assert.equal(
    shouldStopWorkerLoop({
      iteration: 0,
      maxIterations: 10,
      idleCount: 0,
      idleLimit: 2,
      startedAtMs: 0,
      nowMs: 560_000,
      maxRuntimeMs: 600_000,
      minRemainingMs: 60_000,
    }),
    undefined,
  );
});
