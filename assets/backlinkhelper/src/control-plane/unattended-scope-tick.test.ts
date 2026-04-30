import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import type { PromotedProfile, TaskRecord } from "../shared/types.js";

function makePromotedProfile(): PromotedProfile {
  return {
    url: "https://promo.example/",
    hostname: "promo.example",
    name: "Promo Example",
    description: "A product being promoted",
    category_hints: ["productivity"],
    source: "fallback",
    probe_version: "deep-probe/v1",
    probed_at: "2026-04-22T00:00:00.000Z",
  };
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "scope-001-existing",
    target_url: "https://ready.example/submit",
    hostname: "ready.example",
    flow_family: "saas_directory",
    submission: {
      promoted_profile: makePromotedProfile(),
      submitter_email: "operator@example.com",
      confirm_submit: false,
    },
    status: "READY",
    created_at: "2026-04-22T00:00:00.000Z",
    updated_at: "2026-04-22T00:00:00.000Z",
    run_count: 0,
    escalation_level: "none",
    takeover_attempts: 0,
    phase_history: [],
    latest_artifacts: [],
    notes: [],
    ...overrides,
  };
}

let harnessPromise:
  | Promise<{
      root: string;
      tick: typeof import("./unattended-scope-tick.js");
      store: typeof import("../memory/data-store.js");
    }>
  | undefined;

async function getHarness() {
  if (!harnessPromise) {
    harnessPromise = (async () => {
      const root = await mkdtemp(path.join(tmpdir(), "bh-unattended-tick-"));
      process.env.BACKLINKHELPER_STORE = "file";
      process.env.BACKLINER_DATA_ROOT = root;
      const token = `case=${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const tickUrl = new URL("./unattended-scope-tick.js", import.meta.url);
      tickUrl.search = token;
      const storeUrl = new URL("../memory/data-store.js", import.meta.url);
      storeUrl.search = token;
      const tick = await import(tickUrl.href);
      const store = await import(storeUrl.href);
      return { root, tick, store };
    })();
  }
  return harnessPromise;
}

async function resetHarness() {
  const { root, store } = await getHarness();
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await store.ensureDataDirectories();
  const profile = makePromotedProfile();
  await store.writeJsonFile(store.getProfileFilePath(profile.hostname), profile);
}

test("runUnattendedScopeTick claims an existing scoped active task before using target-site intake", async () => {
  const { tick, store } = await getHarness();
  await resetHarness();

  await store.saveTask(makeTask());
  await store.upsertTargetSite({
    target_url: "https://candidate.example/submit",
    hostname: "candidate.example",
    source: "test",
    flow_family_hint: "saas_directory",
    submit_status: "candidate",
    imported_at: "2026-04-22T00:00:00.000Z",
  });

  const result = await tick.runUnattendedScopeTick({
    owner: "test-owner",
    taskIdPrefix: "scope-001",
    promotedHostname: "promo.example",
    promotedUrl: "https://promo.example/",
  });

  assert.equal(result.action, "claimed");
  assert.equal(result.task?.id, "scope-001-existing");
  assert.equal(result.lease?.owner, "test-owner");

  const savedTask = await store.loadTask("scope-001-existing");
  assert.equal(savedTask?.status, "RUNNING");
  const targetSites = await store.listTargetSites(10);
  assert.equal(targetSites[0]?.submit_status, "candidate");
});

test("runUnattendedScopeTick enqueues one safe global target-site candidate when scoped active queue is idle", async () => {
  const { tick, store } = await getHarness();
  await resetHarness();

  await store.upsertTargetSite({
    target_url: "https://candidate.example/submit",
    hostname: "candidate.example",
    source: "test",
    flow_family_hint: "saas_directory",
    submit_status: "candidate",
    imported_at: "2026-04-22T00:00:00.000Z",
  });

  const result = await tick.runUnattendedScopeTick({
    owner: "test-owner",
    taskIdPrefix: "scope-002",
    promotedHostname: "promo.example",
    promotedUrl: "https://promo.example/",
    submitterEmailBase: "operator@example.com",
  });

  assert.equal(result.action, "enqueued");
  assert.equal(result.task?.target_url, "https://candidate.example/submit");
  assert.match(result.task?.id ?? "", /^scope-002-\d{4}-candidate-example$/);

  const savedTask = await store.loadTask(result.task?.id ?? "missing");
  assert.equal(savedTask?.status, "READY");
  assert.equal(savedTask?.submission.promoted_profile.hostname, "promo.example");
  assert.equal(savedTask?.submission.submitter_email, "operator@example.com");

  const targetSites = await store.listTargetSites(10);
  assert.equal(targetSites[0]?.submit_status, "enqueued");
  assert.equal(targetSites[0]?.last_task_id, result.task?.id);
});

test("runUnattendedScopeTick marks ambiguous unhinted candidates as needs_classification instead of defaulting to directory", async () => {
  const { tick, store } = await getHarness();
  await resetHarness();

  await store.upsertTargetSite({
    target_url: "https://ambiguous.example/resources",
    hostname: "ambiguous.example",
    source: "test",
    submit_status: "candidate",
    imported_at: "2026-04-22T00:00:00.000Z",
  });

  const result = await tick.runUnattendedScopeTick({
    owner: "test-owner",
    taskIdPrefix: "scope-unknown",
    promotedHostname: "promo.example",
    promotedUrl: "https://promo.example/",
    submitterEmailBase: "operator@example.com",
  });

  assert.equal(result.action, "needs_classification");
  assert.equal(result.task, undefined);
  assert.equal(result.counts?.candidate_pool, 1);
  assert.equal(result.counts?.safe_candidates, 0);

  const tasks = await store.listTasks();
  assert.equal(tasks.length, 0);

  const targetSites = await store.listTargetSites(10);
  assert.equal(targetSites[0]?.submit_status, "needs_classification");
  assert.equal(targetSites[0]?.flow_family_hint, undefined);
  assert.equal(targetSites[0]?.payload?.surface_diagnosis && typeof targetSites[0].payload.surface_diagnosis, "object");
});

test("runUnattendedScopeTick can enqueue unhinted candidates when URL evidence gives a strong family", async () => {
  const { tick, store } = await getHarness();
  await resetHarness();

  await store.upsertTargetSite({
    target_url: "https://faithfulprovisions.com/8-ways-to-drink-more-water-every-day/",
    hostname: "faithfulprovisions.com",
    source: "test",
    submit_status: "candidate",
    imported_at: "2026-04-22T00:00:00.000Z",
  });

  const result = await tick.runUnattendedScopeTick({
    owner: "test-owner",
    taskIdPrefix: "scope-inferred",
    promotedHostname: "promo.example",
    promotedUrl: "https://promo.example/",
    submitterEmailBase: "operator@example.com",
  });

  assert.equal(result.action, "enqueued");
  assert.equal(result.task?.flow_family, "wp_comment");
  assert.equal(result.task?.flow_family_source, "inferred");

  const targetSites = await store.listTargetSites(10);
  assert.equal(targetSites[0]?.submit_status, "enqueued");
  assert.equal(targetSites[0]?.flow_family_hint, "wp_comment");
});

test("runUnattendedScopeTick preserves inferred provenance from older imported target-site rows", async () => {
  const { tick, store } = await getHarness();
  await resetHarness();

  await store.upsertTargetSite({
    target_url: "https://faithfulprovisions.com/8-ways-to-drink-more-water-every-day/",
    hostname: "faithfulprovisions.com",
    source: "test",
    flow_family_hint: "wp_comment",
    submit_status: "candidate",
    imported_at: "2026-04-22T00:00:00.000Z",
    payload: { flow_family_source: "inferred" },
  });

  const result = await tick.runUnattendedScopeTick({
    owner: "test-owner",
    taskIdPrefix: "scope-legacy-inferred",
    promotedHostname: "promo.example",
    promotedUrl: "https://promo.example/",
    submitterEmailBase: "operator@example.com",
  });

  assert.equal(result.action, "enqueued");
  assert.equal(result.task?.flow_family, "wp_comment");
  assert.equal(result.task?.flow_family_source, "inferred");
});

test("runUnattendedScopeTick ignores db-smoke target-site rows even if they are candidate", async () => {
  const { tick, store } = await getHarness();
  await resetHarness();

  await store.upsertTargetSite({
    target_url: "https://example.com/backlink-submit",
    hostname: "example.com",
    source: "db-smoke",
    flow_family_hint: "saas_directory",
    submit_status: "candidate",
    imported_at: "2026-04-22T00:00:00.000Z",
    payload: { smoke: true },
  });

  const result = await tick.runUnattendedScopeTick({
    owner: "test-owner",
    taskIdPrefix: "scope-smoke",
    promotedHostname: "promo.example",
    promotedUrl: "https://promo.example/",
    submitterEmailBase: "operator@example.com",
  });

  assert.equal(result.action, "no_candidate");
  assert.equal(result.counts?.candidate_pool, 1);
  assert.equal(result.counts?.safe_candidates, 0);
  assert.equal(await store.loadWorkerLease("active"), undefined);
});

test("runUnattendedScopeTick keeps target-site intake moving while an existing retryable task is cooling down", async () => {
  const { tick, store } = await getHarness();
  await resetHarness();

  await store.saveTask(makeTask({
    id: "scope-cooldown-existing",
    status: "RETRYABLE",
    updated_at: new Date().toISOString(),
    run_count: 1,
    wait: {
      wait_reason_code: "TASK_TIMEOUT",
      resume_trigger: "retry later",
      resolution_owner: "system",
      resolution_mode: "auto_resume",
      evidence_ref: "unit-test",
    },
  }));
  await store.upsertTargetSite({
    target_url: "https://fresh-candidate.example/submit",
    hostname: "fresh-candidate.example",
    source: "test",
    flow_family_hint: "saas_directory",
    submit_status: "candidate",
    imported_at: "2026-04-22T00:00:00.000Z",
  });

  const result = await tick.runUnattendedScopeTick({
    owner: "test-owner",
    taskIdPrefix: "scope-cooldown",
    promotedHostname: "promo.example",
    promotedUrl: "https://promo.example/",
    submitterEmailBase: "operator@example.com",
  });

  assert.equal(result.action, "enqueued");
  assert.equal(result.task?.target_url, "https://fresh-candidate.example/submit");
  assert.equal(result.counts?.scoped_tasks, 1);
  assert.equal(result.counts?.candidate_pool, 1);
  assert.equal(result.counts?.safe_candidates, 1);
});

test("runUnattendedScopeTick dry-run previews an existing scoped task without claiming it", async () => {
  const { tick, store } = await getHarness();
  await resetHarness();

  await store.saveTask(makeTask({ id: "scope-003-existing" }));

  const result = await tick.runUnattendedScopeTick({
    owner: "test-owner",
    taskIdPrefix: "scope-003",
    promotedHostname: "promo.example",
    promotedUrl: "https://promo.example/",
    dryRun: true,
  });

  assert.equal(result.action, "claimed");
  assert.equal(result.dry_run, true);
  assert.equal(result.task?.id, "scope-003-existing");

  const savedTask = await store.loadTask("scope-003-existing");
  assert.equal(savedTask?.status, "READY");
  assert.equal(savedTask?.run_count, 0);
  assert.equal(await store.loadWorkerLease("active"), undefined);
});
