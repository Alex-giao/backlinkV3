import test from "node:test";
import assert from "node:assert/strict";
import { applyLightweightFollowUpAction, evaluateLightweightFollowUp } from "./follow-up-tick.js";
function makeTask(overrides = {}) {
    return {
        id: "task-1",
        target_url: "https://example.com/original",
        hostname: "example.com",
        flow_family: "wp_comment",
        submission: {
            promoted_profile: {
                url: "https://exactstatement.com/",
                hostname: "exactstatement.com",
                name: "Exact Statement",
                description: "desc",
                category_hints: ["finance"],
                source: "fallback",
            },
            submitter_email: "support@exactstatement.com",
            confirm_submit: true,
        },
        status: "RUNNING",
        created_at: "2026-04-21T00:00:00.000Z",
        updated_at: "2026-04-21T00:00:00.000Z",
        run_count: 1,
        escalation_level: "scout",
        takeover_attempts: 0,
        phase_history: [],
        latest_artifacts: [],
        notes: [],
        ...overrides,
    };
}
function makeLease(overrides = {}) {
    return {
        task_id: "task-1",
        owner: "follow-up-worker",
        acquired_at: "2026-04-21T00:00:00.000Z",
        expires_at: "2026-04-21T00:10:00.000Z",
        group: "follow_up",
        lane: "follow_up",
        previous_status: "WAITING_EXTERNAL_EVENT",
        previous_wait: {
            wait_reason_code: "EMAIL_VERIFICATION_PENDING",
            resume_trigger: "Check your email to verify the account.",
            resolution_owner: "system",
            resolution_mode: "auto_resume",
            evidence_ref: "artifact.json",
        },
        ...overrides,
    };
}
test("evaluateLightweightFollowUp activates a task when a verification email contains a magic link", async () => {
    const evaluation = await evaluateLightweightFollowUp({
        task: makeTask(),
        lease: makeLease(),
        lookupAccount: async () => ({
            hostname: "example.com",
            email: "support@exactstatement.com",
            email_alias: "support+example-com@exactstatement.com",
            auth_mode: "password_email",
            verified: false,
            created_at: "2026-04-21T00:00:00.000Z",
            last_used_at: "2026-04-21T00:00:00.000Z",
            last_registration_result: "registered",
        }),
        triageEmails: async () => ({
            query_plans: [{ source: "mailbox_query", query: "is:unread to:support+example-com@exactstatement.com newer_than:2d" }],
            scanned_count: 1,
            filtered_window_count: 1,
            candidates: [
                {
                    id: "msg-1",
                    score: 10,
                    reasons: ["magic_link_detected"],
                    query_sources: ["mailbox_query"],
                    within_window: true,
                    magic_link: "https://example.com/verify?token=abc123",
                },
            ],
        }),
    });
    assert.equal(evaluation.action, "activate_ready");
    assert.equal(evaluation.nextTargetUrl, "https://example.com/verify?token=abc123");
    assert.match(evaluation.detail, /magic link/i);
});
test("evaluateLightweightFollowUp keeps the task waiting when mailbox triage finds no actionable email", async () => {
    const evaluation = await evaluateLightweightFollowUp({
        task: makeTask(),
        lease: makeLease(),
        triageEmails: async () => ({
            query_plans: [{ source: "recent_unread", query: "is:unread newer_than:2d" }],
            scanned_count: 0,
            filtered_window_count: 0,
            candidates: [],
        }),
    });
    assert.equal(evaluation.action, "restore_waiting");
    assert.match(evaluation.detail, /no actionable verification email/i);
});
test("evaluateLightweightFollowUp activates a task with code-only continuation when mailbox triage finds a verification code but no magic link", async () => {
    const evaluation = await evaluateLightweightFollowUp({
        task: makeTask(),
        lease: makeLease(),
        lookupAccount: async () => ({
            hostname: "example.com",
            email: "support@exactstatement.com",
            email_alias: "support+example-com@exactstatement.com",
            auth_mode: "password_email",
            verified: false,
            login_url: "https://example.com/login",
            submit_url: "https://example.com/submit",
            created_at: "2026-04-21T00:00:00.000Z",
            last_used_at: "2026-04-21T00:00:00.000Z",
            last_registration_result: "registered",
        }),
        triageEmails: async () => ({
            query_plans: [{ source: "mailbox_query", query: "is:unread to:support+example-com@exactstatement.com newer_than:2d" }],
            scanned_count: 1,
            filtered_window_count: 1,
            candidates: [
                {
                    id: "msg-2",
                    score: 9,
                    reasons: ["verification_code_detected"],
                    query_sources: ["mailbox_query"],
                    within_window: true,
                    from: "Auth <noreply@example.com>",
                    verification_code: "123456",
                    date_iso: "2026-04-21T00:03:00.000Z",
                },
            ],
        }),
    });
    assert.equal(evaluation.action, "activate_ready");
    assert.equal(evaluation.continuation?.kind, "verification_code");
    assert.equal(evaluation.continuation?.verification_code, "123456");
    assert.equal(evaluation.nextTargetUrl, "https://example.com/submit");
});
test("evaluateLightweightFollowUp leaves non-email follow-up tasks waiting because no lightweight action exists yet", async () => {
    const evaluation = await evaluateLightweightFollowUp({
        task: makeTask({ status: "RUNNING" }),
        lease: makeLease({
            previous_status: "WAITING_RETRY_DECISION",
            previous_wait: {
                wait_reason_code: "COMMENT_MODERATION_PENDING",
                resume_trigger: "Comment is awaiting moderation.",
                resolution_owner: "system",
                resolution_mode: "auto_resume",
                evidence_ref: "artifact.json",
            },
        }),
    });
    assert.equal(evaluation.action, "restore_waiting");
    assert.match(evaluation.detail, /no lightweight follow-up action/i);
});
test("evaluateLightweightFollowUp completes a waiting site-response task when the public page already shows the promoted backlink", async () => {
    const evaluation = await evaluateLightweightFollowUp({
        task: makeTask({
            target_url: "https://example.com/post/123",
            flow_family: "wp_comment",
        }),
        lease: makeLease({
            previous_status: "WAITING_SITE_RESPONSE",
            previous_wait: {
                wait_reason_code: "COMMENT_MODERATION_PENDING",
                resume_trigger: "Comment is awaiting moderation.",
                resolution_owner: "system",
                resolution_mode: "auto_resume",
                evidence_ref: "artifact.json",
            },
        }),
        fetchPageHtml: async () => ({
            finalUrl: "https://example.com/post/123#comment-1",
            httpStatus: 200,
            html: `
        <html>
          <body>
            <article>
              <a href="https://exactstatement.com/">Exact Statement</a>
            </article>
          </body>
        </html>
      `,
        }),
    });
    assert.equal(evaluation.action, "complete_done");
    assert.equal(evaluation.linkVerification?.verification_status, "verified_link_present");
    assert.equal(evaluation.linkVerification?.live_page_url, "https://example.com/post/123#comment-1");
});
test("evaluateLightweightFollowUp keeps a waiting site-response task parked when the public page still lacks the promoted backlink", async () => {
    const evaluation = await evaluateLightweightFollowUp({
        task: makeTask({
            target_url: "https://example.com/post/123",
            flow_family: "wp_comment",
        }),
        lease: makeLease({
            previous_status: "WAITING_SITE_RESPONSE",
            previous_wait: {
                wait_reason_code: "COMMENT_MODERATION_PENDING",
                resume_trigger: "Comment is awaiting moderation.",
                resolution_owner: "system",
                resolution_mode: "auto_resume",
                evidence_ref: "artifact.json",
            },
        }),
        fetchPageHtml: async () => ({
            finalUrl: "https://example.com/post/123",
            httpStatus: 200,
            html: "<html><body><p>Comment moderation queue is still pending.</p></body></html>",
        }),
    });
    assert.equal(evaluation.action, "restore_waiting");
    assert.equal(evaluation.linkVerification?.verification_status, "link_missing");
    assert.match(evaluation.detail, /still not visible|not yet visible/i);
});
test("applyLightweightFollowUpAction reactivates a task into READY and updates the target URL when a magic link is available", () => {
    const task = makeTask();
    const updated = applyLightweightFollowUpAction({
        task,
        lease: makeLease(),
        artifactRef: "follow-up.json",
        evaluation: {
            action: "activate_ready",
            detail: "Verification email yielded a magic link.",
            nextTargetUrl: "https://example.com/verify?token=abc123",
        },
    });
    assert.equal(updated.status, "READY");
    assert.equal(updated.wait, undefined);
    assert.equal(updated.email_verification_continuation, undefined);
    assert.equal(updated.target_url, "https://example.com/verify?token=abc123");
    assert.equal(updated.hostname, "example.com");
    assert.equal(updated.lease_expires_at, undefined);
    assert.match(updated.notes.at(-1) ?? "", /magic link/i);
    assert.deepEqual(updated.latest_artifacts, ["follow-up.json"]);
});
test("applyLightweightFollowUpAction stores code-only continuation context when a verification email yields a code", () => {
    const task = makeTask();
    const updated = applyLightweightFollowUpAction({
        task,
        lease: makeLease(),
        artifactRef: "follow-up.json",
        evaluation: {
            action: "activate_ready",
            detail: "Verification email yielded a usable code.",
            nextTargetUrl: "https://example.com/submit",
            continuation: {
                kind: "verification_code",
                verification_code: "123456",
                source_message_id: "msg-2",
                source_email: "Auth <noreply@example.com>",
                observed_at: "2026-04-21T00:03:00.000Z",
                suggested_target_url: "https://example.com/submit",
                detail: "Verification email exposed a code-only continuation.",
            },
        },
    });
    assert.equal(updated.status, "READY");
    assert.equal(updated.wait, undefined);
    assert.equal(updated.target_url, "https://example.com/submit");
    assert.equal(updated.email_verification_continuation?.kind, "verification_code");
    assert.equal(updated.email_verification_continuation?.verification_code, "123456");
    assert.equal(updated.email_verification_continuation?.suggested_target_url, "https://example.com/submit");
});
test("applyLightweightFollowUpAction restores the prior waiting checkpoint when no action is available", () => {
    const task = makeTask({
        email_verification_continuation: {
            kind: "verification_code",
            verification_code: "123456",
            source_message_id: "msg-stale",
            observed_at: "2026-04-21T00:00:00.000Z",
            suggested_target_url: "https://example.com/submit",
            detail: "stale code",
        },
    });
    const lease = makeLease({
        previous_status: "WAITING_SITE_RESPONSE",
        previous_wait: {
            wait_reason_code: "COMMENT_MODERATION_PENDING",
            resume_trigger: "Comment is awaiting moderation.",
            resolution_owner: "system",
            resolution_mode: "auto_resume",
            evidence_ref: "artifact.json",
        },
    });
    const updated = applyLightweightFollowUpAction({
        task,
        lease,
        artifactRef: "follow-up.json",
        evaluation: {
            action: "restore_waiting",
            detail: "No lightweight follow-up action exists yet for this waiting checkpoint.",
        },
    });
    assert.equal(updated.status, "WAITING_SITE_RESPONSE");
    assert.equal(updated.wait?.wait_reason_code, "COMMENT_MODERATION_PENDING");
    assert.equal(updated.email_verification_continuation, undefined);
    assert.equal(updated.lease_expires_at, undefined);
    assert.match(updated.notes.at(-1) ?? "", /no lightweight follow-up action/i);
    assert.deepEqual(updated.latest_artifacts, ["follow-up.json"]);
});
test("applyLightweightFollowUpAction marks a task DONE and persists link verification when the lightweight site-response recheck succeeds", () => {
    const task = makeTask({
        target_url: "https://example.com/post/123",
        flow_family: "wp_comment",
    });
    const lease = makeLease({
        previous_status: "WAITING_SITE_RESPONSE",
        previous_wait: {
            wait_reason_code: "COMMENT_MODERATION_PENDING",
            resume_trigger: "Comment is awaiting moderation.",
            resolution_owner: "system",
            resolution_mode: "auto_resume",
            evidence_ref: "artifact.json",
        },
    });
    const updated = applyLightweightFollowUpAction({
        task,
        lease,
        artifactRef: "follow-up.json",
        evaluation: {
            action: "complete_done",
            detail: "Lightweight public-page recheck verified the live backlink.",
            linkVerification: {
                verification_status: "verified_link_present",
                expected_target_url: "https://exactstatement.com/",
                live_page_url: "https://example.com/post/123#comment-1",
                target_link_url: "https://exactstatement.com/",
                rel_flags: [],
                visible_state: "visible",
                detail: "Matching backlink is publicly visible on the inspected live page.",
                verified_at: "2026-04-21T00:05:00.000Z",
            },
        },
    });
    assert.equal(updated.status, "DONE");
    assert.equal(updated.wait, undefined);
    assert.equal(updated.link_verification?.verification_status, "verified_link_present");
    assert.equal(updated.link_verification?.live_page_url, "https://example.com/post/123#comment-1");
    assert.equal(updated.lease_expires_at, undefined);
    assert.match(updated.notes.at(-1) ?? "", /verified the live backlink/i);
    assert.deepEqual(updated.latest_artifacts, ["follow-up.json"]);
});
