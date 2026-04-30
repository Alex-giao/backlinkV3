import test from "node:test";
import assert from "node:assert/strict";

import { createSqliteDataStore } from "./sqlite-data-store.js";
import { __setActiveDataStoreForTest, listTargetSites, upsertTargetSite } from "./data-store.js";
import type { SqlExecutor } from "./sql-data-store.js";
import type { AccountRecord, TaskRecord, WorkerLease } from "../shared/types.js";

function buildTask(id = "task-sql-1"): TaskRecord {
  const now = "2026-04-24T00:00:00.000Z";
  return {
    id,
    target_url: "https://example-directory.com/submit",
    hostname: "example-directory.com",
    flow_family: "saas_directory",
    flow_family_source: "explicit",
    flow_family_reason: "test",
    flow_family_updated_at: now,
    enqueued_by: "sql-data-store-test",
    submission: {
      promoted_profile: {
        url: "https://exactstatement.com/",
        hostname: "exactstatement.com",
        name: "Exact Statement",
        description: "Bank statement PDF converter",
        category_hints: ["finance"],
        source: "cli",
      },
      confirm_submit: false,
    },
    status: "READY",
    created_at: now,
    updated_at: now,
    run_count: 0,
    escalation_level: "none",
    takeover_attempts: 0,
    queue_priority_score: 7,
    phase_history: [],
    latest_artifacts: [],
    notes: [],
  };
}

test("sqlite datastore applies D1-compatible schema and round-trips task/account/lease state", async () => {
  const store = createSqliteDataStore(":memory:");
  await store.ensureDataDirectories();

  const task = buildTask();
  await store.saveTask(task);
  assert.deepEqual(await store.loadTask(task.id), task);
  assert.deepEqual(await store.listTasks(), [task]);

  const lease: WorkerLease = {
    task_id: task.id,
    owner: "worker-a",
    acquired_at: "2026-04-24T00:01:00.000Z",
    expires_at: "2026-04-24T00:11:00.000Z",
    group: "active",
    lane: "active_any",
  };
  await store.saveWorkerLease(lease);
  assert.deepEqual(await store.loadWorkerLease("active"), lease);
  assert.equal(await store.clearWorkerLeaseForTask(task.id), true);
  assert.equal(await store.loadWorkerLease("active"), undefined);

  const account: AccountRecord = {
    hostname: "example-directory.com",
    email: "submitter@example.com",
    email_alias: "submitter+example@example.com",
    auth_mode: "password_email",
    verified: true,
    created_at: "2026-04-24T00:02:00.000Z",
    last_used_at: "2026-04-24T00:03:00.000Z",
    last_registration_result: "ok",
  };
  await store.saveAccountRecord(account);
  assert.deepEqual(await store.loadAccountRecord(account.hostname), account);
});

test("active datastore facade can upsert target-site seed data", async () => {
  const store = createSqliteDataStore(":memory:");
  __setActiveDataStoreForTest(store);
  try {
    await upsertTargetSite({
      target_url: "https://example.com/post/1",
      hostname: "example.com",
      source: "unit-test-csv",
      flow_family_hint: "wp_comment",
      submit_status: "candidate",
      imported_at: "2026-04-24T00:00:00.000Z",
      payload: { row: 1 },
    });

    const sites = await listTargetSites(10);
    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.target_url, "https://example.com/post/1");
  } finally {
    __setActiveDataStoreForTest(undefined);
  }
});

test("sql target-site listing reconstructs scalar columns when payload_json is metadata only", async () => {
  const store = createSqliteDataStore(":memory:");
  await store.ensureDataDirectories();
  const executor = (store as unknown as { executor: SqlExecutor }).executor;
  await executor.run(
    `INSERT INTO target_sites (
      target_url, hostname, source, flow_family_hint, submit_status, imported_at, last_task_id, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "https://metadata.example/resources",
      "metadata.example",
      "unit-test-csv",
      null,
      "needs_classification",
      "2026-04-24T00:00:00.000Z",
      null,
      JSON.stringify({ target_url: "metadata-only", row_index: 1 }),
    ],
  );

  const sites = await store.listTargetSites(10);
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.target_url, "https://metadata.example/resources");
  assert.equal(sites[0]?.hostname, "metadata.example");
  assert.equal(sites[0]?.submit_status, "needs_classification");
  assert.equal(sites[0]?.payload?.target_url, "metadata-only");
});
