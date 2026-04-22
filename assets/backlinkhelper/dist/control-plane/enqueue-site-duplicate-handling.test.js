import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
function makePromotedProfile() {
    return {
        url: "https://exactstatement.com/",
        hostname: "exactstatement.com",
        name: "Exact Statement",
        description: "Statement conversion tool",
        category_hints: ["finance"],
        source: "fallback",
        probe_version: "deep-probe/v1",
        probed_at: "2026-04-22T00:00:00.000Z",
    };
}
function makeTask(overrides = {}) {
    return {
        id: "existing-task",
        target_url: "https://example.com/submit-a",
        hostname: "example.com",
        flow_family: "saas_directory",
        submission: {
            promoted_profile: makePromotedProfile(),
            submitter_email: "old@example.com",
            confirm_submit: true,
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
let harnessPromise;
async function getHarness() {
    if (!harnessPromise) {
        harnessPromise = (async () => {
            const root = await mkdtemp(path.join(tmpdir(), "bh-enqueue-dup-"));
            process.env.BACKLINER_DATA_ROOT = root;
            const token = `case=${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const queueUrl = new URL("./task-queue.js", import.meta.url);
            queueUrl.search = token;
            const storeUrl = new URL("../memory/data-store.js", import.meta.url);
            storeUrl.search = token;
            const queue = await import(queueUrl.href);
            const store = await import(storeUrl.href);
            return { root, queue, store };
        })();
    }
    return harnessPromise;
}
async function resetHarness() {
    const { root, store } = await getHarness();
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    await store.ensureDataDirectories();
}
async function seedPromotedProfile() {
    const { store } = await getHarness();
    const profile = makePromotedProfile();
    await store.writeJsonFile(store.getProfileFilePath(profile.hostname), profile);
}
test("enqueueSiteTask reuses only fully equivalent exact-host duplicates", async () => {
    const { queue, store } = await getHarness();
    await resetHarness();
    await seedPromotedProfile();
    const existing = makeTask({
        id: "existing-equivalent",
        target_url: "https://example.com/submit-a",
        hostname: "example.com",
        status: "WAITING_MANUAL_AUTH",
        wait: {
            wait_reason_code: "DIRECTORY_LOGIN_REQUIRED",
            resume_trigger: "login required",
            resolution_owner: "none",
            resolution_mode: "terminal_audit",
            evidence_ref: "artifact.json",
        },
    });
    await store.saveTask(existing);
    const result = await queue.enqueueSiteTask({
        taskId: "new-task-id",
        targetUrl: "https://example.com/submit-a",
        promotedUrl: "https://exactstatement.com/",
        submitterEmailBase: "old@example.com",
        confirmSubmit: true,
        flowFamily: "saas_directory",
    });
    const saved = await store.loadTask("existing-equivalent");
    assert.equal(result.outcome, "reused_existing_task");
    assert.equal(result.duplicate_of_task_id, "existing-equivalent");
    assert.equal(saved?.status, "WAITING_MANUAL_AUTH");
    assert.equal(saved?.target_url, "https://example.com/submit-a");
    assert.equal(saved?.submission.submitter_email, "old@example.com");
});
test("enqueueSiteTask authoritative-updates exact-host duplicates when payload differs and task is not running", async () => {
    const { queue, store } = await getHarness();
    await resetHarness();
    await seedPromotedProfile();
    const existing = makeTask({
        id: "existing-mismatch",
        target_url: "https://example.com/submit-a",
        hostname: "example.com",
        status: "READY",
        submission: {
            promoted_profile: makePromotedProfile(),
            submitter_email: "old@example.com",
            confirm_submit: true,
        },
        flow_family: "saas_directory",
    });
    await store.saveTask(existing);
    const result = await queue.enqueueSiteTask({
        taskId: "new-task-id",
        targetUrl: "https://example.com/submit-b",
        promotedUrl: "https://exactstatement.com/",
        submitterEmailBase: "new@example.com",
        confirmSubmit: false,
        flowFamily: "wp_comment",
    });
    const saved = await store.loadTask("existing-mismatch");
    assert.equal(result.outcome, "reactivated_existing_task");
    assert.equal(result.duplicate_of_task_id, "existing-mismatch");
    assert.equal(saved?.status, "READY");
    assert.equal(saved?.target_url, "https://example.com/submit-b");
    assert.equal(saved?.flow_family, "wp_comment");
    assert.equal(saved?.submission.submitter_email, "new@example.com");
    assert.equal(saved?.submission.confirm_submit, false);
    assert.ok(saved?.notes.some((note) => /authoritative enqueue payload/i.test(note)));
});
test("enqueueSiteTask blocks non-equivalent duplicates when the existing exact-host task is already running", async () => {
    const { queue, store } = await getHarness();
    await resetHarness();
    await seedPromotedProfile();
    const existing = makeTask({
        id: "existing-running",
        target_url: "https://example.com/submit-a",
        hostname: "example.com",
        status: "RUNNING",
        run_count: 1,
    });
    await store.saveTask(existing);
    const result = await queue.enqueueSiteTask({
        taskId: "new-task-id",
        targetUrl: "https://example.com/submit-b",
        promotedUrl: "https://exactstatement.com/",
        submitterEmailBase: "new@example.com",
        confirmSubmit: false,
        flowFamily: "wp_comment",
    });
    const saved = await store.loadTask("existing-running");
    assert.equal(result.outcome, "blocked_duplicate_task");
    assert.equal(saved?.status, "RUNNING");
    assert.equal(saved?.target_url, "https://example.com/submit-a");
    assert.equal(saved?.submission.submitter_email, "old@example.com");
    assert.ok(saved?.notes.some((note) => /cannot be overwritten while running/i.test(note)));
});
test("enqueueSiteTask authoritative-updates duplicate family using fresh enqueue defaults when flowFamily is omitted", async () => {
    const { queue, store } = await getHarness();
    await resetHarness();
    await seedPromotedProfile();
    const existing = makeTask({
        id: "existing-omitted-family",
        target_url: "https://example.com/submit-a",
        hostname: "example.com",
        status: "READY",
        flow_family: "wp_comment",
    });
    await store.saveTask(existing);
    const result = await queue.enqueueSiteTask({
        taskId: "new-task-id",
        targetUrl: "https://example.com/submit-b",
        promotedUrl: "https://exactstatement.com/",
        submitterEmailBase: "old@example.com",
        confirmSubmit: true,
    });
    const saved = await store.loadTask("existing-omitted-family");
    assert.equal(result.outcome, "reactivated_existing_task");
    assert.equal(saved?.flow_family, "saas_directory");
    assert.equal(saved?.flow_family_source, "corrected");
    assert.equal(saved?.target_url, "https://example.com/submit-b");
});
test("enqueueSiteTask blocks a payload-mismatch enqueue when any exact-host sibling is already running", async () => {
    const { queue, store } = await getHarness();
    await resetHarness();
    await seedPromotedProfile();
    const running = makeTask({
        id: "existing-running-sibling",
        target_url: "https://example.com/submit-a",
        hostname: "example.com",
        status: "RUNNING",
        run_count: 1,
    });
    const readySibling = makeTask({
        id: "existing-ready-sibling",
        target_url: "https://example.com/submit-c",
        hostname: "example.com",
        status: "READY",
        updated_at: "2026-04-22T01:00:00.000Z",
    });
    await store.saveTask(running);
    await store.saveTask(readySibling);
    const result = await queue.enqueueSiteTask({
        taskId: "new-task-id",
        targetUrl: "https://example.com/submit-b",
        promotedUrl: "https://exactstatement.com/",
        submitterEmailBase: "new@example.com",
        confirmSubmit: false,
        flowFamily: "wp_comment",
    });
    const savedRunning = await store.loadTask("existing-running-sibling");
    const savedReady = await store.loadTask("existing-ready-sibling");
    assert.equal(result.outcome, "blocked_duplicate_task");
    assert.equal(result.duplicate_of_task_id, "existing-running-sibling");
    assert.equal(savedRunning?.status, "RUNNING");
    assert.equal(savedRunning?.target_url, "https://example.com/submit-a");
    assert.equal(savedReady?.status, "READY");
    assert.equal(savedReady?.target_url, "https://example.com/submit-c");
});
test("enqueueSiteTask still reuses an equivalent duplicate even if another exact-host sibling has a conflicting running payload", async () => {
    const { queue, store } = await getHarness();
    await resetHarness();
    await seedPromotedProfile();
    const equivalentWaiting = makeTask({
        id: "existing-equivalent-waiting",
        target_url: "https://example.com/submit-a",
        hostname: "example.com",
        status: "WAITING_MANUAL_AUTH",
        wait: {
            wait_reason_code: "DIRECTORY_LOGIN_REQUIRED",
            resume_trigger: "login required",
            resolution_owner: "none",
            resolution_mode: "terminal_audit",
            evidence_ref: "artifact.json",
        },
    });
    const runningMismatch = makeTask({
        id: "existing-running-mismatch",
        target_url: "https://example.com/submit-b",
        hostname: "example.com",
        status: "RUNNING",
        run_count: 1,
        submission: {
            promoted_profile: makePromotedProfile(),
            submitter_email: "other@example.com",
            confirm_submit: false,
        },
    });
    await store.saveTask(equivalentWaiting);
    await store.saveTask(runningMismatch);
    const result = await queue.enqueueSiteTask({
        taskId: "new-task-id",
        targetUrl: "https://example.com/submit-a",
        promotedUrl: "https://exactstatement.com/",
        submitterEmailBase: "old@example.com",
        confirmSubmit: true,
        flowFamily: "saas_directory",
    });
    assert.equal(result.outcome, "reused_existing_task");
    assert.equal(result.duplicate_of_task_id, "existing-equivalent-waiting");
});
test("enqueueSiteTask reactivates an equivalent retryable duplicate before considering a conflicting running sibling", async () => {
    const { queue, store } = await getHarness();
    await resetHarness();
    await seedPromotedProfile();
    const equivalentRetryable = makeTask({
        id: "existing-equivalent-retryable",
        target_url: "https://example.com/submit-a",
        hostname: "example.com",
        status: "RETRYABLE",
        run_count: 1,
        updated_at: "2026-04-22T01:00:00.000Z",
    });
    const runningMismatch = makeTask({
        id: "existing-running-mismatch-2",
        target_url: "https://example.com/submit-b",
        hostname: "example.com",
        status: "RUNNING",
        run_count: 1,
        submission: {
            promoted_profile: makePromotedProfile(),
            submitter_email: "other@example.com",
            confirm_submit: false,
        },
    });
    await store.saveTask(equivalentRetryable);
    await store.saveTask(runningMismatch);
    const result = await queue.enqueueSiteTask({
        taskId: "new-task-id",
        targetUrl: "https://example.com/submit-a",
        promotedUrl: "https://exactstatement.com/",
        submitterEmailBase: "old@example.com",
        confirmSubmit: true,
        flowFamily: "saas_directory",
    });
    const savedRetryable = await store.loadTask("existing-equivalent-retryable");
    assert.equal(result.outcome, "reactivated_existing_task");
    assert.equal(result.duplicate_of_task_id, "existing-equivalent-retryable");
    assert.equal(savedRetryable?.status, "READY");
});
test("enqueueSiteTask authoritatively reactivates a DONE duplicate when payload differs", async () => {
    const { queue, store } = await getHarness();
    await resetHarness();
    await seedPromotedProfile();
    const existing = makeTask({
        id: "existing-done",
        target_url: "https://example.com/submit-a",
        hostname: "example.com",
        status: "DONE",
        run_count: 1,
    });
    await store.saveTask(existing);
    const result = await queue.enqueueSiteTask({
        taskId: "new-task-id",
        targetUrl: "https://example.com/submit-b",
        promotedUrl: "https://exactstatement.com/",
        submitterEmailBase: "new@example.com",
        confirmSubmit: false,
        flowFamily: "wp_comment",
    });
    const saved = await store.loadTask("existing-done");
    assert.equal(result.outcome, "reactivated_existing_task");
    assert.equal(saved?.status, "READY");
    assert.equal(saved?.target_url, "https://example.com/submit-b");
    assert.equal(saved?.flow_family, "wp_comment");
});
