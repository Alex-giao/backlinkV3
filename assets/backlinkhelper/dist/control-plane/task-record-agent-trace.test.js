import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
function makeTask(overrides = {}) {
    return {
        id: "trace-task-001",
        target_url: "https://target.example/submit",
        hostname: "target.example",
        flow_family: "saas_directory",
        submission: {
            promoted_profile: {
                url: "https://suikagame.fun/",
                hostname: "suikagame.fun",
                name: "Suika Game",
                description: "A fruit merge browser puzzle.",
                category_hints: ["game"],
                source: "fallback",
                probe_version: "unit-test",
                probed_at: "2026-04-28T00:00:00.000Z",
            },
            submitter_email: "operator@example.com",
            confirm_submit: false,
        },
        status: "RUNNING",
        created_at: "2026-04-28T00:00:00.000Z",
        updated_at: "2026-04-28T00:00:00.000Z",
        run_count: 1,
        escalation_level: "none",
        takeover_attempts: 0,
        phase_history: [],
        latest_artifacts: [],
        notes: [],
        ...overrides,
    };
}
function makeEnvelope(agentBackend) {
    return {
        trace: {
            task_id: "trace-task-001",
            agent_backend: agentBackend,
            started_at: "2026-04-28T00:00:01.000Z",
            finished_at: "2026-04-28T00:00:02.000Z",
            stop_reason: "unit_test",
            final_url: "https://target.example/submit",
            final_title: "Submit",
            final_excerpt: "Done",
            steps: [],
        },
        handoff: {
            detail: "unit test handoff",
            artifact_refs: [],
            current_url: "https://target.example/submit",
            recorded_steps: [],
            agent_trace_ref: "unit-test",
            agent_backend: agentBackend,
            agent_steps_count: 0,
        },
    };
}
test("recordAgentTrace records the actual agent backend instead of hardcoding Codex", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bh-record-agent-trace-"));
    try {
        process.env.BACKLINKHELPER_STORE = "file";
        process.env.BACKLINER_DATA_ROOT = root;
        const token = `case=${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const recorderUrl = new URL("./task-record-agent-trace.js", import.meta.url);
        recorderUrl.search = token;
        const storeUrl = new URL("../memory/data-store.js", import.meta.url);
        storeUrl.search = token;
        const recorder = await import(recorderUrl.href);
        const store = await import(storeUrl.href);
        await mkdir(root, { recursive: true });
        await store.ensureDataDirectories();
        await store.saveTask(makeTask());
        await recorder.recordAgentTrace({
            taskId: "trace-task-001",
            envelope: makeEnvelope("hermes_playwright_cdp"),
        });
        const saved = await store.loadTask("trace-task-001");
        assert.ok(saved);
        assert.match(saved.notes.at(-1) ?? "", /Recorded hermes_playwright_cdp agent trace with 0 step\(s\)\./);
        assert.doesNotMatch(saved.notes.at(-1) ?? "", /Codex-driven/);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
