import test from "node:test";
import assert from "node:assert/strict";
import { applyFinalizeResultToTask } from "./task-finalize.js";
function makeTask(overrides = {}) {
    return {
        id: "task-finalize-test",
        target_url: "https://community.example.com/profile/edit",
        hostname: "community.example.com",
        submission: {
            promoted_profile: {
                url: "https://exactstatement.com/",
                hostname: "exactstatement.com",
                name: "Exact Statement",
                description: "Bank statement PDF to CSV converter",
                category_hints: ["finance"],
                source: "fallback",
            },
            confirm_submit: true,
        },
        status: "RUNNING",
        created_at: "2026-04-21T00:00:00.000Z",
        updated_at: "2026-04-21T00:00:00.000Z",
        run_count: 1,
        escalation_level: "none",
        takeover_attempts: 1,
        phase_history: [],
        latest_artifacts: [],
        notes: [],
        ...overrides,
    };
}
function makeWait(overrides = {}) {
    return {
        wait_reason_code: "FINALIZATION_PAGE_CONTEXT_MISMATCH",
        resume_trigger: "Retry finalization on the bound task page.",
        resolution_owner: "system",
        resolution_mode: "auto_resume",
        evidence_ref: "/tmp/finalization.json",
        ...overrides,
    };
}
function makeHandoff(overrides = {}) {
    return {
        detail: "Need authoritative finalization.",
        artifact_refs: ["/tmp/agent-loop.json"],
        current_url: "https://community.example.com/profile/exactstatement",
        recorded_steps: [],
        agent_trace_ref: "/tmp/agent-loop.json",
        agent_backend: "codex",
        agent_steps_count: 3,
        ...overrides,
    };
}
test("applyFinalizeResultToTask clears stale link verification when the authoritative finalize pass has none", () => {
    const task = makeTask({
        link_verification: {
            verification_status: "verified_link_present",
            expected_target_url: "https://exactstatement.com/",
            live_page_url: "https://flickr.com/photos/old-stale-page",
            target_link_url: "https://exactstatement.com/",
            rel_flags: ["ugc"],
            visible_state: "visible",
            detail: "Stale verifier payload from an unrelated tab.",
            verified_at: "2026-04-20T00:00:00.000Z",
        },
    });
    const finalResult = {
        ok: false,
        next_status: "RETRYABLE",
        detail: "Finalization refused to persist cross-host verification evidence.",
        artifact_refs: ["/tmp/finalization.json"],
        wait: makeWait(),
        terminal_class: "outcome_not_confirmed",
    };
    applyFinalizeResultToTask({
        task,
        finalResult,
        handoff: makeHandoff(),
    });
    assert.equal(task.link_verification, undefined);
    assert.equal(task.status, "RETRYABLE");
    assert.deepEqual(task.latest_artifacts, ["/tmp/agent-loop.json", "/tmp/finalization.json"]);
});
test("applyFinalizeResultToTask overwrites stale verification with the current finalization evidence", () => {
    const task = makeTask({
        email_verification_continuation: {
            kind: "verification_code",
            verification_code: "123456",
            source_message_id: "msg-1",
            observed_at: "2026-04-21T00:04:00.000Z",
            suggested_target_url: "https://community.example.com/profile/exactstatement",
            detail: "Email verification code ready for continuation.",
        },
        link_verification: {
            verification_status: "link_missing",
            expected_target_url: "https://exactstatement.com/",
            live_page_url: "https://community.example.com/old-page",
            rel_flags: [],
            visible_state: "missing",
            detail: "Old missing-link payload.",
            verified_at: "2026-04-20T00:00:00.000Z",
        },
    });
    const finalResult = {
        ok: true,
        next_status: "DONE",
        detail: "Verified public profile backlink.",
        artifact_refs: ["/tmp/finalization.json"],
        link_verification: {
            verification_status: "verified_link_present",
            expected_target_url: "https://exactstatement.com/",
            live_page_url: "https://community.example.com/profile/exactstatement",
            target_link_url: "https://exactstatement.com/",
            rel_flags: ["ugc", "nofollow"],
            visible_state: "visible",
            detail: "Matching backlink is publicly visible on the inspected live page.",
            verified_at: "2026-04-21T00:05:00.000Z",
        },
    };
    applyFinalizeResultToTask({
        task,
        finalResult,
        handoff: makeHandoff(),
    });
    assert.equal(task.link_verification?.live_page_url, "https://community.example.com/profile/exactstatement");
    assert.equal(task.link_verification?.verification_status, "verified_link_present");
    assert.equal(task.email_verification_continuation, undefined);
    assert.equal(task.status, "DONE");
});
