import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
function makeTask(overrides = {}) {
    return {
        id: "runtime-incident-task",
        target_url: "https://example.com/submit",
        hostname: "example.com",
        submission: {
            promoted_profile: {
                url: "https://exactstatement.com/",
                hostname: "exactstatement.com",
                name: "Exact Statement",
                description: "desc",
                category_hints: ["finance"],
                source: "fallback",
            },
            confirm_submit: true,
        },
        status: "READY",
        created_at: "2026-04-23T00:00:00.000Z",
        updated_at: "2026-04-23T00:00:00.000Z",
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
            const root = await mkdtemp(path.join(tmpdir(), "bh-runtime-incident-"));
            process.env.BACKLINER_DATA_ROOT = root;
            const token = `case=${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const queueUrl = new URL("./task-queue.js", import.meta.url);
            queueUrl.search = token;
            const storeUrl = new URL("../memory/data-store.js", import.meta.url);
            storeUrl.search = token;
            const incidentUrl = new URL("../shared/runtime-incident.js", import.meta.url);
            incidentUrl.search = token;
            const queue = await import(queueUrl.href);
            const store = await import(storeUrl.href);
            const incident = await import(incidentUrl.href);
            return { root, queue, store, incident };
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
test("claimNextTask idles when a runtime incident circuit breaker is open", async () => {
    const { queue, store, incident } = await getHarness();
    await resetHarness();
    await store.saveTask(makeTask());
    await incident.openRuntimeIncident({
        kind: "PLAYWRIGHT_CDP_UNAVAILABLE",
        source: "task-prepare",
        detail: "Playwright could not attach to the shared browser.",
        cdp_url: "http://127.0.0.1:1",
    });
    const result = await queue.claimNextTask({ owner: "active-worker" });
    const saved = await store.loadTask("runtime-incident-task");
    const lease = await store.loadWorkerLease();
    assert.equal(result.mode, "idle");
    assert.equal(saved?.status, "READY");
    assert.equal(lease, undefined);
    assert.equal(result.runtime_incident?.kind, "PLAYWRIGHT_CDP_UNAVAILABLE");
});
test("claimNextTask resumes claiming after runtime auto-recovery clears the breaker", async () => {
    const { queue, store, incident } = await getHarness();
    await resetHarness();
    await store.saveTask(makeTask());
    await incident.openRuntimeIncident({
        kind: "PLAYWRIGHT_CDP_UNAVAILABLE",
        source: "task-prepare",
        detail: "Playwright could not attach to the shared browser.",
        cdp_url: "http://127.0.0.1:9224",
    });
    const originalRecover = queue.__testTryAutoRecoverRuntimeIncident;
    queue.__setRuntimeRecoveryHookForTest(async () => {
        await incident.clearRuntimeIncident();
        return { recovered: true, detail: "recovered", sanitized_targets: 0 };
    });
    try {
        const result = await queue.claimNextTask({ owner: "active-worker" });
        const saved = await store.loadTask("runtime-incident-task");
        assert.equal(result.mode, "claimed");
        assert.equal(result.runtime_incident, undefined);
        assert.equal(saved?.status, "RUNNING");
    }
    finally {
        if (originalRecover) {
            queue.__setRuntimeRecoveryHookForTest(originalRecover);
        }
        else {
            queue.__resetRuntimeRecoveryHookForTest();
        }
    }
});
