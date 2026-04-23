import test from "node:test";
import assert from "node:assert/strict";

import { buildFollowUpOutcomeReport, buildGuardedDrainStatusPayload } from "./guarded-drain-status.js";
import type { TaskRecord } from "../shared/types.js";

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
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
    created_at: "2026-04-21T00:00:00.000Z",
    updated_at: "2026-04-21T00:00:00.000Z",
    run_count: 0,
    escalation_level: "none",
    takeover_attempts: 0,
    phase_history: [],
    latest_artifacts: [],
    notes: [],
    ...overrides,
  };
}

test("buildFollowUpOutcomeReport separates magic-link, code-only, and site-response follow-up outcomes", () => {
  const report = buildFollowUpOutcomeReport([
    {
      previous_status: "WAITING_EXTERNAL_EVENT",
      evaluation: {
        action: "activate_ready",
        continuation: {
          kind: "magic_link",
          observed_at: "2026-04-21T00:01:00.000Z",
          detail: "magic link",
        },
      },
    },
    {
      previous_status: "WAITING_EXTERNAL_EVENT",
      evaluation: {
        action: "activate_ready",
        continuation: {
          kind: "verification_code",
          verification_code: "123456",
          observed_at: "2026-04-21T00:02:00.000Z",
          detail: "code only",
        },
      },
    },
    {
      previous_status: "WAITING_SITE_RESPONSE",
      evaluation: {
        action: "complete_done",
      },
    },
    {
      previous_status: "WAITING_SITE_RESPONSE",
      evaluation: {
        action: "restore_waiting",
        linkVerification: {
          verification_status: "link_missing",
          expected_target_url: "https://exactstatement.com/",
          live_page_url: "https://example.com/post/1",
          rel_flags: [],
          visible_state: "missing",
          detail: "not live yet",
          verified_at: "2026-04-21T00:03:00.000Z",
        },
      },
    },
  ]);

  assert.deepEqual(report.totals, {
    magic_link_ready: 1,
    verification_code_ready: 1,
    site_response_verified: 1,
    site_response_still_waiting: 1,
  });
});

test("guarded drain payload defaults to business outcome view, exposes lane counts, and nests system status as supplemental data", () => {
  const payload = buildGuardedDrainStatusPayload({
    scope: { promotedUrl: "https://exactstatement.com/" },
    runtimeHealth: { healthy: true, summary: "runtime healthy" },
    repair: { repaired: 0 },
    tasks: [
      makeTask({ status: "DONE" }),
      makeTask({ id: "task-2", status: "SKIPPED" }),
      makeTask({ id: "task-3", status: "RETRYABLE" }),
      makeTask({ id: "task-4", status: "READY", flow_family: "saas_directory" }),
      makeTask({ id: "task-5", status: "READY", flow_family: "wp_comment" }),
      makeTask({
        id: "task-6",
        status: "WAITING_SITE_RESPONSE",
        flow_family: "wp_comment",
        wait: {
          wait_reason_code: "COMMENT_MODERATION_PENDING",
          resume_trigger: "Comment is awaiting moderation.",
          resolution_owner: "system",
          resolution_mode: "auto_resume",
          evidence_ref: "artifact.json",
        },
      }),
      makeTask({
        id: "task-7",
        status: "WAITING_RETRY_DECISION",
        wait: {
          wait_reason_code: "REPEATED_FAILURE_REVIEW_REQUIRED",
          resume_trigger: "Needs retry review.",
          resolution_owner: "none",
          resolution_mode: "terminal_audit",
          evidence_ref: "artifact.json",
        },
      }),
    ],
    activeLease: {
      task_id: "task-3",
      owner: "active-worker",
      acquired_at: "2026-04-21T00:00:00.000Z",
      expires_at: "2026-04-21T00:10:00.000Z",
      group: "active",
      lane: "active_any",
    },
    followUpLease: {
      task_id: "task-6",
      owner: "follow-up-worker",
      acquired_at: "2026-04-21T00:01:00.000Z",
      expires_at: "2026-04-21T00:11:00.000Z",
      group: "follow_up",
      lane: "follow_up",
    },
    followUpReport: buildFollowUpOutcomeReport([
      {
        previous_status: "WAITING_EXTERNAL_EVENT",
        evaluation: {
          action: "activate_ready",
          continuation: {
            kind: "magic_link",
            observed_at: "2026-04-21T00:01:00.000Z",
            detail: "magic link",
          },
        },
      },
    ]),
    blockers: [],
  });

  assert.equal(payload.report_default_view, "business_outcome");
  assert.deepEqual(payload.business_report.default_cards, [
    { key: "submitted_success", label: "已提交成功", count: 1 },
    { key: "confirmed_dead_end", label: "已确认死路", count: 1 },
    { key: "needs_rework_or_retry", label: "需要修逻辑/重跑", count: 3 },
    { key: "untouched_ready", label: "尚未开始", count: 2 },
  ]);
  assert.deepEqual(payload.lane_report.totals, {
    directory_active: 2,
    non_directory_active: 1,
    follow_up: 1,
    blocked_or_other: 3,
  });
  assert.equal(payload.system_status_report.totals.ready, 2);
  assert.equal(payload.system_status_report.totals.retryable, 1);
  assert.equal(payload.system_status_report.totals.repeated_failure_review, 1);
  assert.equal(payload.worker_leases.active?.lane, "active_any");
  assert.equal(payload.worker_leases.follow_up?.lane, "follow_up");
  assert.deepEqual(payload.follow_up_report.totals, {
    magic_link_ready: 1,
    verification_code_ready: 0,
    site_response_verified: 0,
    site_response_still_waiting: 0,
  });
  assert.deepEqual(payload.system_status_report.status_counts, {
    DONE: 1,
    SKIPPED: 1,
    RETRYABLE: 1,
    READY: 2,
    WAITING_SITE_RESPONSE: 1,
    WAITING_RETRY_DECISION: 1,
  });
  assert.equal(payload.runtime_observability.circuit_breaker_open, false);
});

test("guarded drain payload surfaces runtime observability for breaker, browser pollution, and last auto-recovery attempt", () => {
  const payload = buildGuardedDrainStatusPayload({
    scope: {},
    runtimeHealth: {
      healthy: false,
      summary: "runtime unhealthy",
      browser_state: {
        ok: true,
        detail: "Shared browser retains 4 regular pages; suspect retained regular pages / target pollution.",
        total_targets: 9,
        page_targets: 5,
        regular_page_targets: 4,
        suspicious: true,
      },
      runtime_incident: {
        kind: "PLAYWRIGHT_CDP_UNAVAILABLE",
        source: "task-prepare",
        detail: "polluted browser",
        opened_at: "2026-04-23T01:00:00.000Z",
        updated_at: "2026-04-23T01:05:00.000Z",
      },
      recovery_status: {
        last_attempt: {
          attempted_at: "2026-04-23T01:06:00.000Z",
          incident_kind: "PLAYWRIGHT_CDP_UNAVAILABLE",
          recovered: false,
          detail: "Skip sanitize: active worker lease still held by active-worker for task task-3.",
          sanitized_targets: 0,
        },
        recent_attempts: [
          {
            attempted_at: "2026-04-23T01:06:00.000Z",
            incident_kind: "PLAYWRIGHT_CDP_UNAVAILABLE",
            recovered: false,
            detail: "Skip sanitize: active worker lease still held by active-worker for task task-3.",
            sanitized_targets: 0,
          },
        ],
      },
    },
    repair: { repaired: 0 },
    tasks: [],
    followUpReport: buildFollowUpOutcomeReport([]),
    blockers: ["runtime unhealthy"],
  });

  assert.equal(payload.runtime_observability.circuit_breaker_open, true);
  assert.equal(payload.runtime_observability.incident?.kind, "PLAYWRIGHT_CDP_UNAVAILABLE");
  assert.equal(payload.runtime_observability.browser_target_health?.regular_page_targets, 4);
  assert.equal(payload.runtime_observability.last_recovery_attempt?.recovered, false);
  assert.equal(payload.runtime_observability.recent_recovery_attempts.length, 1);
});
