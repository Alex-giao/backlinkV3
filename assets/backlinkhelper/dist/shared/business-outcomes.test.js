import test from "node:test";
import assert from "node:assert/strict";
import { getFamilyConfig } from "../families/index.js";
import { buildBusinessOutcomeReport, deriveBusinessOutcome, summarizeBusinessOutcomes } from "./business-outcomes.js";
function makeTask(overrides = {}) {
    return {
        id: "task-1",
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
        created_at: "2026-04-08T00:00:00.000Z",
        updated_at: "2026-04-08T00:00:00.000Z",
        run_count: 0,
        escalation_level: "none",
        takeover_attempts: 0,
        phase_history: [],
        latest_artifacts: [],
        notes: [],
        ...overrides,
    };
}
test("deriveBusinessOutcome treats submitted waiting states as business success", () => {
    assert.equal(deriveBusinessOutcome(makeTask({ status: "DONE" })), "submitted_success");
    assert.equal(deriveBusinessOutcome(makeTask({ status: "WAITING_SITE_RESPONSE" })), "submitted_success");
    assert.equal(deriveBusinessOutcome(makeTask({
        status: "WAITING_EXTERNAL_EVENT",
        wait: {
            wait_reason_code: "EMAIL_VERIFICATION_PENDING",
            resume_trigger: "Check your email to finish submission.",
            resolution_owner: "gog",
            resolution_mode: "auto_resume",
            evidence_ref: "artifact.json",
        },
    })), "submitted_success");
});
test("deriveBusinessOutcome separates blocked, skipped, retryable, and unknown buckets", () => {
    assert.equal(deriveBusinessOutcome(makeTask({ status: "WAITING_MISSING_INPUT" })), "blocked_missing_input");
    assert.equal(deriveBusinessOutcome(makeTask({ status: "WAITING_MANUAL_AUTH" })), "blocked_manual_auth");
    assert.equal(deriveBusinessOutcome(makeTask({ status: "WAITING_POLICY_DECISION" })), "blocked_policy");
    assert.equal(deriveBusinessOutcome(makeTask({ status: "SKIPPED" })), "skipped_terminal");
    assert.equal(deriveBusinessOutcome(makeTask({ status: "RETRYABLE" })), "retryable_runtime_or_evidence");
    assert.equal(deriveBusinessOutcome(makeTask({ status: "READY" })), "active_queue");
    assert.equal(deriveBusinessOutcome(makeTask({ status: "RUNNING" })), "active_queue");
    assert.equal(deriveBusinessOutcome(makeTask({ status: "WAITING_RETRY_DECISION" })), "unknown_needs_review");
});
test("deriveBusinessOutcome requires verifier-backed live link evidence for non-directory success states", () => {
    assert.equal(deriveBusinessOutcome(makeTask({
        flow_family: "forum_profile",
        status: "WAITING_SITE_RESPONSE",
    })), "unknown_needs_review");
    assert.equal(deriveBusinessOutcome(makeTask({
        flow_family: "forum_profile",
        status: "WAITING_SITE_RESPONSE",
        link_verification: {
            verification_status: "verified_link_present",
            live_page_url: "https://community.example.com/member/exactstatement",
            expected_target_url: "https://exactstatement.com/",
            target_link_url: "https://exactstatement.com/",
            anchor_text: "Exact Statement",
            rel: "ugc nofollow",
            rel_flags: ["ugc", "nofollow"],
            visible_state: "visible",
            detail: "Verified public profile backlink.",
            verified_at: "2026-04-16T00:00:00.000Z",
        },
    })), "submitted_success");
});
test("family semantic contract declares live-link verification requirements", () => {
    assert.equal(getFamilyConfig("saas_directory").semanticContract.requires_live_link_verification_for_success, false);
    assert.equal(getFamilyConfig("forum_profile").semanticContract.requires_live_link_verification_for_success, true);
    assert.equal(getFamilyConfig("wp_comment").semanticContract.requires_live_link_verification_for_success, true);
    assert.equal(getFamilyConfig("dev_blog").semanticContract.requires_live_link_verification_for_success, true);
});
test("family semantic contract declares non-directory checkpoint reason codes", () => {
    assert.deepEqual(getFamilyConfig("forum_profile").semanticContract.pending_wait_reason_codes, ["PROFILE_PUBLICATION_PENDING"]);
    assert.deepEqual(getFamilyConfig("wp_comment").semanticContract.pending_wait_reason_codes, ["COMMENT_MODERATION_PENDING"]);
    assert.deepEqual(getFamilyConfig("wp_comment").semanticContract.review_wait_reason_codes, ["COMMENT_PUBLISHED_NO_LINK"]);
    assert.deepEqual(getFamilyConfig("wp_comment").semanticContract.policy_wait_reason_codes, ["COMMENT_ANTI_SPAM_BLOCKED"]);
    assert.deepEqual(getFamilyConfig("dev_blog").semanticContract.progress_wait_reason_codes, ["ARTICLE_DRAFT_SAVED"]);
    assert.deepEqual(getFamilyConfig("dev_blog").semanticContract.pending_wait_reason_codes, ["ARTICLE_SUBMITTED_PENDING_EDITORIAL", "ARTICLE_PUBLICATION_PENDING"]);
    assert.deepEqual(getFamilyConfig("dev_blog").semanticContract.review_wait_reason_codes, ["ARTICLE_PUBLISHED_NO_LINK"]);
});
test("summarizeBusinessOutcomes reports success totals and business complete rate", () => {
    const summary = summarizeBusinessOutcomes([
        makeTask({ status: "DONE" }),
        makeTask({ id: "task-2", status: "WAITING_SITE_RESPONSE" }),
        makeTask({
            id: "task-3",
            status: "WAITING_EXTERNAL_EVENT",
            wait: {
                wait_reason_code: "EMAIL_VERIFICATION_PENDING",
                resume_trigger: "Verify your email.",
                resolution_owner: "gog",
                resolution_mode: "auto_resume",
                evidence_ref: "artifact.json",
            },
        }),
        makeTask({ id: "task-4", status: "WAITING_MISSING_INPUT" }),
        makeTask({ id: "task-5", status: "RETRYABLE" }),
    ]);
    assert.equal(summary.successful_submissions, 3);
    assert.equal(summary.business_complete_rate, 0.6);
    assert.deepEqual(summary.success_breakdown, {
        done: 1,
        waiting_site_response: 1,
        waiting_external_event_email_verification: 1,
    });
    assert.equal(summary.counts.submitted_success, 3);
    assert.equal(summary.counts.blocked_missing_input, 1);
    assert.equal(summary.counts.retryable_runtime_or_evidence, 1);
});
test("buildBusinessOutcomeReport exposes the four default business buckets while keeping blockers supplemental", () => {
    const report = buildBusinessOutcomeReport([
        makeTask({ status: "DONE" }),
        makeTask({ id: "task-2", status: "SKIPPED" }),
        makeTask({ id: "task-3", status: "RETRYABLE" }),
        makeTask({ id: "task-4", status: "WAITING_SITE_RESPONSE", flow_family: "forum_profile" }),
        makeTask({ id: "task-5", status: "READY" }),
        makeTask({ id: "task-6", status: "RUNNING" }),
        makeTask({ id: "task-7", status: "WAITING_MISSING_INPUT" }),
        makeTask({ id: "task-8", status: "WAITING_POLICY_DECISION" }),
    ]);
    assert.deepEqual(report.default_view_order, [
        "submitted_success",
        "confirmed_dead_end",
        "needs_rework_or_retry",
        "untouched_ready",
    ]);
    assert.deepEqual(report.default_cards, [
        { key: "submitted_success", label: "已提交成功", count: 1 },
        { key: "confirmed_dead_end", label: "已确认死路", count: 1 },
        { key: "needs_rework_or_retry", label: "需要修逻辑/重跑", count: 2 },
        { key: "untouched_ready", label: "尚未开始", count: 1 },
    ]);
    assert.equal(report.supplemental.blocked_missing_input, 1);
    assert.equal(report.supplemental.blocked_policy, 1);
    assert.equal(report.supplemental.in_progress_running, 1);
    assert.equal(report.supplemental.unknown_needs_review, 1);
});
test("deriveBusinessOutcome does not let stale wait reasons override active queue status", () => {
    assert.equal(deriveBusinessOutcome(makeTask({
        status: "READY",
        wait: {
            wait_reason_code: "REQUIRED_INPUT_MISSING",
            resume_trigger: "Stale carry-over.",
            resolution_owner: "none",
            resolution_mode: "terminal_audit",
            evidence_ref: "artifact.json",
        },
    })), "active_queue");
    assert.equal(deriveBusinessOutcome(makeTask({
        status: "RUNNING",
        wait: {
            wait_reason_code: "DIRECTORY_LOGIN_REQUIRED",
            resume_trigger: "Stale carry-over.",
            resolution_owner: "none",
            resolution_mode: "terminal_audit",
            evidence_ref: "artifact.json",
        },
    })), "active_queue");
});
