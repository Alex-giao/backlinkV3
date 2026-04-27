import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildRetryDecisionPlan,
  canRetry,
  deriveFlowFamilyAudit,
  getRetryReadyAt,
  deriveTaskLane,
  isRetryExhausted,
  matchesTaskScope,
  pickNextTaskForLane,
  parkExhaustedRetryableTask,
  resolveWorkerLeaseGroupForLane,
  shouldDeferHostReactivation,
  shouldReactivateRuntimeRetries,
} from "./task-queue.js";
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
    status: "RETRYABLE",
    created_at: "2026-04-08T00:00:00.000Z",
    updated_at: "2026-04-08T00:00:00.000Z",
    run_count: 2,
    escalation_level: "scout",
    takeover_attempts: 0,
    phase_history: [],
    latest_artifacts: ["artifact.json"],
    notes: [],
    ...overrides,
  };
}

test("deriveTaskLane routes active and waiting tasks into the expected logical lanes", () => {
  assert.equal(
    deriveTaskLane(makeTask({ status: "READY", run_count: 0, flow_family: "saas_directory" })),
    "directory_active",
  );
  assert.equal(
    deriveTaskLane(makeTask({ status: "READY", run_count: 0, flow_family: "wp_comment" })),
    "non_directory_active",
  );
  assert.equal(
    deriveTaskLane(makeTask({ status: "READY", run_count: 0, flow_family: "forum_post" })),
    "non_directory_active",
  );
  assert.equal(
    deriveTaskLane(makeTask({ status: "WAITING_SITE_RESPONSE", flow_family: "saas_directory" })),
    "follow_up",
  );
  assert.equal(
    deriveTaskLane(makeTask({ status: "WAITING_EXTERNAL_EVENT", flow_family: "dev_blog" })),
    "follow_up",
  );
  assert.equal(deriveTaskLane(makeTask({ status: "WAITING_MANUAL_AUTH", flow_family: "wp_comment" })), undefined);
});

test("deriveFlowFamilyAudit records explicit and defaulted family provenance for new tasks", () => {
  const explicit = deriveFlowFamilyAudit({
    requestedFlowFamily: "wp_comment",
    enqueuedBy: "dispatcher",
    now: "2026-04-21T00:00:00.000Z",
  });
  assert.equal(explicit.flowFamily, "wp_comment");
  assert.equal(explicit.flowFamilySource, "explicit");
  assert.equal(explicit.enqueuedBy, "dispatcher");

  const defaulted = deriveFlowFamilyAudit({
    enqueuedBy: "dispatcher",
    now: "2026-04-21T00:00:00.000Z",
  });
  assert.equal(defaulted.flowFamily, "saas_directory");
  assert.equal(defaulted.flowFamilySource, "defaulted");
  assert.match(defaulted.flowFamilyReason, /defaulted to saas_directory/i);
});

test("deriveFlowFamilyAudit corrects dispatcher wp_comment hints on forum thread targets", () => {
  const corrected = deriveFlowFamilyAudit({
    requestedFlowFamily: "wp_comment",
    targetUrl: "https://cyberlord.at/forum/?id=1&thread=6857",
    enqueuedBy: "dispatcher",
    now: "2026-04-21T00:00:00.000Z",
  });

  assert.equal(corrected.flowFamily, "forum_post");
  assert.equal(corrected.flowFamilySource, "corrected");
  assert.equal(corrected.correctedFromFamily, "wp_comment");
  assert.match(corrected.flowFamilyReason, /forum\/thread/i);
});

test("deriveFlowFamilyAudit records corrected_from_family when re-enqueue changes the task family", () => {
  const corrected = deriveFlowFamilyAudit({
    existingTask: makeTask({
      flow_family: "saas_directory",
      flow_family_source: "defaulted",
      enqueued_by: "dispatcher",
    }),
    requestedFlowFamily: "wp_comment",
    enqueuedBy: "hermes-follow-up",
    now: "2026-04-21T00:00:00.000Z",
  });

  assert.equal(corrected.flowFamily, "wp_comment");
  assert.equal(corrected.flowFamilySource, "corrected");
  assert.equal(corrected.correctedFromFamily, "saas_directory");
  assert.equal(corrected.enqueuedBy, "hermes-follow-up");
  assert.match(corrected.flowFamilyReason, /corrected from saas_directory to wp_comment/i);
});

test("pickNextTaskForLane keeps waiting tasks out of the active queue and prioritizes auto-resumable email checkpoints in the follow-up queue", () => {
  const directoryReady = makeTask({
    id: "directory-ready",
    status: "READY",
    run_count: 0,
    flow_family: "saas_directory",
    created_at: "2026-04-08T00:00:02.000Z",
  });
  const nonDirectoryReady = makeTask({
    id: "comment-ready",
    status: "READY",
    run_count: 0,
    flow_family: "wp_comment",
    created_at: "2026-04-08T00:00:03.000Z",
  });
  const followUpWaiting = makeTask({
    id: "follow-up-waiting",
    status: "WAITING_EXTERNAL_EVENT",
    flow_family: "wp_comment",
    created_at: "2026-04-08T00:00:01.000Z",
    wait: {
      wait_reason_code: "EMAIL_VERIFICATION_PENDING",
      resume_trigger: "Check your email to verify the account.",
      resolution_owner: "system",
      resolution_mode: "auto_resume",
      evidence_ref: "artifact.json",
    },
  });
  const siteResponseWaiting = makeTask({
    id: "site-response-waiting",
    status: "WAITING_SITE_RESPONSE",
    flow_family: "wp_comment",
    created_at: "2026-04-08T00:00:00.000Z",
    wait: {
      wait_reason_code: "COMMENT_MODERATION_PENDING",
      resume_trigger: "Comment is awaiting moderation.",
      resolution_owner: "system",
      resolution_mode: "auto_resume",
      evidence_ref: "artifact.json",
    },
  });

  assert.equal(
    pickNextTaskForLane([siteResponseWaiting, followUpWaiting, directoryReady, nonDirectoryReady], "active_any")?.id,
    "directory-ready",
  );
  assert.equal(
    pickNextTaskForLane([siteResponseWaiting, followUpWaiting, directoryReady, nonDirectoryReady], "non_directory_active")?.id,
    "comment-ready",
  );
  assert.equal(
    pickNextTaskForLane([siteResponseWaiting, followUpWaiting, directoryReady, nonDirectoryReady], "follow_up")?.id,
    "follow-up-waiting",
  );
});

test("pickNextTaskForLane exposes lightweight site-response checkpoints to the follow-up queue when no email follow-up is pending", () => {
  const siteResponseWaiting = makeTask({
    id: "site-response-waiting",
    status: "WAITING_SITE_RESPONSE",
    flow_family: "wp_comment",
    created_at: "2026-04-08T00:00:00.000Z",
    wait: {
      wait_reason_code: "COMMENT_MODERATION_PENDING",
      resume_trigger: "Comment is awaiting moderation.",
      resolution_owner: "system",
      resolution_mode: "auto_resume",
      evidence_ref: "artifact.json",
    },
  });
  const unsupportedWaiting = makeTask({
    id: "unsupported-waiting",
    status: "WAITING_SITE_RESPONSE",
    flow_family: "saas_directory",
    created_at: "2026-04-08T00:00:01.000Z",
    wait: {
      wait_reason_code: "UNKNOWN_PENDING_REASON",
      resume_trigger: "Wait and see.",
      resolution_owner: "system",
      resolution_mode: "auto_resume",
      evidence_ref: "artifact.json",
    },
  });

  assert.equal(pickNextTaskForLane([unsupportedWaiting, siteResponseWaiting], "follow_up")?.id, "site-response-waiting");
});

test("pickNextTaskForLane exposes forum_post moderation checkpoints to the follow-up queue", () => {
  const forumPostWaiting = makeTask({
    id: "forum-post-waiting",
    status: "WAITING_SITE_RESPONSE",
    flow_family: "forum_post",
    created_at: "2026-04-08T00:00:00.000Z",
    wait: {
      wait_reason_code: "FORUM_POST_MODERATION_PENDING",
      resume_trigger: "Forum reply is awaiting moderator approval.",
      resolution_owner: "system",
      resolution_mode: "auto_resume",
      evidence_ref: "artifact.json",
    },
  });
  const unsupportedWaiting = makeTask({
    id: "unsupported-waiting",
    status: "WAITING_SITE_RESPONSE",
    flow_family: "forum_post",
    created_at: "2026-04-08T00:00:01.000Z",
    wait: {
      wait_reason_code: "UNKNOWN_PENDING_REASON",
      resume_trigger: "Wait and see.",
      resolution_owner: "system",
      resolution_mode: "auto_resume",
      evidence_ref: "artifact.json",
    },
  });

  assert.equal(pickNextTaskForLane([unsupportedWaiting, forumPostWaiting], "follow_up")?.id, "forum-post-waiting");
});

test("pickNextTaskForLane prioritizes higher queue_priority_score before FIFO among READY active tasks", () => {
  const olderLowPriority = makeTask({
    id: "older-low-priority",
    status: "READY",
    run_count: 0,
    flow_family: "saas_directory",
    created_at: "2026-04-08T00:00:00.000Z",
    queue_priority_score: 15,
  });
  const newerHighPriority = makeTask({
    id: "newer-high-priority",
    status: "READY",
    run_count: 0,
    flow_family: "saas_directory",
    created_at: "2026-04-08T00:00:05.000Z",
    queue_priority_score: 80,
  });

  assert.equal(
    pickNextTaskForLane([olderLowPriority, newerHighPriority], "directory_active")?.id,
    "newer-high-priority",
  );
});

test("resolveWorkerLeaseGroupForLane keeps active work serialized while follow-up work gets its own slot", () => {
  assert.equal(resolveWorkerLeaseGroupForLane("directory_active"), "active");
  assert.equal(resolveWorkerLeaseGroupForLane("non_directory_active"), "active");
  assert.equal(resolveWorkerLeaseGroupForLane("active_any"), "active");
  assert.equal(resolveWorkerLeaseGroupForLane("follow_up"), "follow_up");
});

test("retryable task becomes exhausted after the automatic retry budget is used", () => {
  const task = makeTask();
  assert.equal(isRetryExhausted(task), true);
  assert.equal(canRetry(task), false);
});

test("parking an exhausted retryable task moves unknown cases out of the active retry queue", () => {
  const task = makeTask();
  const parked = parkExhaustedRetryableTask(task);

  assert.equal(parked, true);
  assert.equal(task.status, "WAITING_RETRY_DECISION");
  assert.equal(task.wait?.wait_reason_code, "AUTOMATIC_RETRY_EXHAUSTED");
  assert.match(task.last_takeover_outcome ?? "", /Automatic retry budget exhausted/);
  assert.equal(canRetry(task), false);
});

test("parking an exhausted retryable task promotes missing-input cases directly to WAITING_MISSING_INPUT", () => {
  const task = makeTask({
    wait: {
      wait_reason_code: "REQUIRED_INPUT_MISSING",
      resume_trigger: "Missing required fields: Phone Number.",
      resolution_owner: "none",
      resolution_mode: "terminal_audit",
      evidence_ref: "artifact.json",
    },
  });

  const parked = parkExhaustedRetryableTask(task);

  assert.equal(parked, true);
  assert.equal(task.status, "WAITING_MISSING_INPUT");
  assert.equal(task.wait?.wait_reason_code, "REQUIRED_INPUT_MISSING");
});

test("parking an exhausted retryable task promotes manual-auth cases directly to WAITING_MANUAL_AUTH", () => {
  const task = makeTask({
    wait: {
      wait_reason_code: "DIRECTORY_LOGIN_REQUIRED",
      resume_trigger: "Directory requires unsupported authentication.",
      resolution_owner: "none",
      resolution_mode: "terminal_audit",
      evidence_ref: "artifact.json",
    },
  });

  const parked = parkExhaustedRetryableTask(task);

  assert.equal(parked, true);
  assert.equal(task.status, "WAITING_MANUAL_AUTH");
  assert.equal(task.wait?.wait_reason_code, "DIRECTORY_LOGIN_REQUIRED");
});

test("parking an exhausted retryable task promotes email verification checkpoints to WAITING_EXTERNAL_EVENT", () => {
  const task = makeTask({
    wait: {
      wait_reason_code: "EMAIL_VERIFICATION_PENDING",
      resume_trigger: "Check your email to verify the listing.",
      resolution_owner: "gog",
      resolution_mode: "auto_resume",
      evidence_ref: "artifact.json",
    },
  });

  const parked = parkExhaustedRetryableTask(task);

  assert.equal(parked, true);
  assert.equal(task.status, "WAITING_EXTERNAL_EVENT");
  assert.equal(task.wait?.wait_reason_code, "EMAIL_VERIFICATION_PENDING");
});

test("parking an exhausted retryable task promotes clear success signals to WAITING_SITE_RESPONSE", () => {
  const task = makeTask({
    wait: {
      wait_reason_code: "SITE_RESPONSE_PENDING",
      resume_trigger: "Thank you. Your submission is pending review.",
      resolution_owner: "system",
      resolution_mode: "auto_resume",
      evidence_ref: "artifact.json",
    },
  });

  const parked = parkExhaustedRetryableTask(task);

  assert.equal(parked, true);
  assert.equal(task.status, "WAITING_SITE_RESPONSE");
  assert.equal(task.wait?.wait_reason_code, "SITE_RESPONSE_PENDING");
});

test("parking an exhausted retryable task promotes captcha skips directly to SKIPPED", () => {
  const task = makeTask({
    skip_reason_code: "captcha_or_human_verification_required",
    last_takeover_outcome: "A CAPTCHA challenge blocks submission.",
  });

  const parked = parkExhaustedRetryableTask(task);

  assert.equal(parked, true);
  assert.equal(task.status, "SKIPPED");
  assert.equal(task.skip_reason_code, "captcha_or_human_verification_required");
});

test("fresh retryable task remains eligible after backoff expires", () => {
  const task = makeTask({
    run_count: 1,
    updated_at: "2026-04-08T00:00:00.000Z",
  });

  assert.equal(isRetryExhausted(task), false);
  assert.equal(canRetry(task), true);
});

test("runtime retryables use short backoff while target-site outages keep the full cooldown", () => {
  const now = Date.now();
  const runtimeRetry = makeTask({
    run_count: 1,
    updated_at: new Date(now - 6 * 60 * 1_000).toISOString(),
    wait: {
      wait_reason_code: "SCOUT_SESSION_TIMEOUT",
      resume_trigger: "Scout page release failed; reset the shared session before retry.",
      resolution_owner: "system",
      resolution_mode: "auto_resume",
      evidence_ref: "scout.json",
    },
  });
  const runtimeStillCooling = makeTask({
    run_count: 1,
    updated_at: new Date(now - 4 * 60 * 1_000).toISOString(),
    wait: {
      wait_reason_code: "SCOUT_SESSION_TIMEOUT",
      resume_trigger: "Scout page release failed; reset the shared session before retry.",
      resolution_owner: "system",
      resolution_mode: "auto_resume",
      evidence_ref: "scout.json",
    },
  });
  const targetOutageRetry = makeTask({
    run_count: 1,
    updated_at: new Date(now - 6 * 60 * 1_000).toISOString(),
    wait: {
      wait_reason_code: "DIRECTORY_UPSTREAM_5XX",
      resume_trigger: "Retry later after the directory becomes reachable again.",
      resolution_owner: "system",
      resolution_mode: "auto_resume",
      evidence_ref: "scout.json",
    },
  });

  assert.equal(canRetry(runtimeRetry), true);
  assert.equal(canRetry(runtimeStillCooling), false);
  assert.equal(canRetry(targetOutageRetry), false);
  assert.equal(getRetryReadyAt(runtimeStillCooling), new Date(new Date(runtimeStillCooling.updated_at).getTime() + 5 * 60 * 1_000).toISOString());
  assert.equal(getRetryReadyAt(targetOutageRetry), new Date(new Date(targetOutageRetry.updated_at).getTime() + 60 * 60 * 1_000).toISOString());
});

test("parking an exhausted runtime retryable keeps it in the runtime recovery pool instead of generic retry triage", () => {
  const task = makeTask({
    run_count: 2,
    wait: {
      wait_reason_code: "SCOUT_SESSION_TIMEOUT",
      resume_trigger: "Retry later after resetting the shared CDP scout session.",
      resolution_owner: "system",
      resolution_mode: "auto_resume",
      evidence_ref: "scout.json",
    },
  });

  const parked = parkExhaustedRetryableTask(task);

  assert.equal(parked, true);
  assert.equal(task.status, "WAITING_RETRY_DECISION");
  assert.equal(task.wait?.wait_reason_code, "RUNTIME_RECOVERY_REQUIRED");
  assert.equal(task.terminal_class, "takeover_runtime_error");
  assert.match(task.last_takeover_outcome ?? "", /runtime\/browser recovery/i);
});

test("runtime recovery waits reactivate only after the runtime health gate passes", async () => {
  const task = makeTask({
    status: "WAITING_RETRY_DECISION",
    wait: {
      wait_reason_code: "RUNTIME_RECOVERY_REQUIRED",
      resume_trigger: "Runtime/browser recovery required after SCOUT_SESSION_TIMEOUT.",
      resolution_owner: "none",
      resolution_mode: "terminal_audit",
      evidence_ref: "scout.json",
    },
  });

  const unhealthyPlan = await buildRetryDecisionPlan(task, { healthy: false, summary: "playwright attach failed" });
  assert.equal(unhealthyPlan.bucket, "runtime_recovery_pool");
  assert.equal(unhealthyPlan.nextStatus, "WAITING_RETRY_DECISION");
  assert.equal(unhealthyPlan.waitReasonCode, "RUNTIME_RECOVERY_REQUIRED");

  const healthyPlan = await buildRetryDecisionPlan(task, { healthy: true, summary: "runtime ok" });
  assert.equal(healthyPlan.bucket, "runtime_reactivate_ready");
  assert.equal(healthyPlan.nextStatus, "READY");
});

test("runtime retry pool can be reactivated when the health gate passes", () => {
  assert.equal(shouldReactivateRuntimeRetries({ healthy: true, summary: "runtime ok" }), true);
  assert.equal(shouldReactivateRuntimeRetries({ healthy: false, summary: "browser-use unhealthy" }), false);
  assert.equal(shouldReactivateRuntimeRetries(undefined), false);
});

test("host-level reactivation guard defers hot hosts and duplicate host releases in the same apply tick", () => {
  assert.equal(
    shouldDeferHostReactivation({
      hostname: "example.com",
      bucket: "reactivate_ready",
      hotHosts: ["example.com"],
      alreadyReleasedHosts: [],
    }),
    true,
  );
  assert.equal(
    shouldDeferHostReactivation({
      hostname: "example.com",
      bucket: "runtime_reactivate_ready",
      hotHosts: [],
      alreadyReleasedHosts: ["example.com"],
    }),
    true,
  );
  assert.equal(
    shouldDeferHostReactivation({
      hostname: "example.com",
      bucket: "terminal_manual_auth",
      hotHosts: ["example.com"],
      alreadyReleasedHosts: [],
    }),
    false,
  );
});

test("matchesTaskScope filters by task prefix and promoted profile fields", () => {
  const task = makeTask({
    id: "exactstatement-20260411-awesomefree-row-0066-promotebusinessdirectory-com",
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
  });

  assert.equal(matchesTaskScope(task, { taskIdPrefix: "exactstatement-20260411-awesomefree-row-" }), true);
  assert.equal(matchesTaskScope(task, { taskIdPrefix: "other-campaign-" }), false);
  assert.equal(matchesTaskScope(task, { promotedHostname: "exactstatement.com" }), true);
  assert.equal(matchesTaskScope(task, { promotedHostname: "other.com" }), false);
  assert.equal(matchesTaskScope(task, { promotedUrl: "https://exactstatement.com/" }), true);
  assert.equal(matchesTaskScope(task, { promotedUrl: "https://other.com/" }), false);
});

test("buildRetryDecisionPlan uses early terminal classifier success semantics to avoid manual triage", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bh-plan-"));
  const artifactPath = path.join(dir, "finalization.json");
  await writeFile(
    artifactPath,
    JSON.stringify({
      current_url: "https://directory.example.com/thanks",
      title: "Thanks for submitting",
      body_excerpt: "Thanks for submitting. Please verify your email to complete listing.",
      early_terminal_classifier: {
        hypothesis: "email_verification_pending_but_submitted",
        recommended_state: "WAITING_EXTERNAL_EVENT",
        recommended_business_outcome: "submitted_success",
        allow_rerun: false,
      },
      final_outcome: {
        next_status: "WAITING_RETRY_DECISION",
        detail: "Legacy state before repartition.",
      },
    }),
    "utf-8",
  );

  const plan = await buildRetryDecisionPlan(
    makeTask({
      status: "WAITING_RETRY_DECISION",
      latest_artifacts: [artifactPath],
    }),
  );

  assert.equal(plan.bucket, "external_email_verification");
  assert.equal(plan.nextStatus, "WAITING_EXTERNAL_EVENT");
  assert.equal(plan.waitReasonCode, "EMAIL_VERIFICATION_PENDING");
});

test("buildRetryDecisionPlan treats strong visual confirmation without failure signal as submitted success", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bh-plan-"));
  const artifactPath = path.join(dir, "finalization.json");
  await writeFile(
    artifactPath,
    JSON.stringify({
      current_url: "https://devpages.io/submit-a-tool",
      title: "Submit a Tool | DevPages",
      body_excerpt: "",
      visual_verification: {
        classification: "success_or_confirmation",
        confidence: 0.97,
        summary: "Thank You! Your tool submission has been received. No error message is visible.",
      },
      final_outcome: {
        next_status: "RETRYABLE",
        detail: "Legacy outcome_not_confirmed before visual-success override.",
      },
    }),
    "utf-8",
  );

  const plan = await buildRetryDecisionPlan(
    makeTask({
      status: "WAITING_RETRY_DECISION",
      latest_artifacts: [artifactPath],
    }),
  );

  assert.equal(plan.bucket, "terminal_success");
  assert.equal(plan.nextStatus, "WAITING_SITE_RESPONSE");
  assert.equal(plan.waitReasonCode, "SITE_RESPONSE_PENDING");
});

test("buildRetryDecisionPlan does not apply directory success phrases to forum_profile tasks", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bh-plan-"));
  const artifactPath = path.join(dir, "finalization.json");
  await writeFile(
    artifactPath,
    JSON.stringify({
      current_url: "https://community.example.com/profile",
      title: "Community Profile",
      body_excerpt: "Thanks for submitting your startup.",
      final_outcome: {
        next_status: "WAITING_RETRY_DECISION",
        detail: "Legacy state before repartition.",
      },
    }),
    "utf-8",
  );

  const plan = await buildRetryDecisionPlan(
    makeTask({
      flow_family: "forum_profile",
      status: "WAITING_RETRY_DECISION",
      latest_artifacts: [artifactPath],
      target_url: "https://community.example.com/profile",
      hostname: "community.example.com",
    }),
  );

  assert.notEqual(plan.bucket, "terminal_success");
  assert.notEqual(plan.waitReasonCode, "SITE_RESPONSE_PENDING");
});

test("buildRetryDecisionPlan does not divert supported dev_blog families into generic community strategy parking", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bh-plan-"));
  const artifactPath = path.join(dir, "finalization.json");
  await writeFile(
    artifactPath,
    JSON.stringify({
      current_url: "https://dev.to/new",
      title: "Write Post",
      body_excerpt: "Draft saved for later editing.",
      final_outcome: {
        next_status: "RETRYABLE",
        detail: "Draft saved for later editing.",
        wait: {
          wait_reason_code: "ARTICLE_DRAFT_SAVED",
          resume_trigger: "Continue from the saved draft in a later automation pass.",
          resolution_owner: "system",
          resolution_mode: "auto_resume",
          evidence_ref: artifactPath,
        },
      },
    }),
    "utf-8",
  );

  const plan = await buildRetryDecisionPlan(
    makeTask({
      flow_family: "dev_blog",
      status: "WAITING_RETRY_DECISION",
      latest_artifacts: [artifactPath],
      target_url: "https://dev.to/new",
      hostname: "dev.to",
    }),
    { healthy: true, summary: "runtime ok" },
  );

  assert.notEqual(plan.bucket, "community_strategy");
  assert.equal(plan.nextStatus, "READY");
});

test("buildRetryDecisionPlan does not treat visual confirmation alone as terminal success for wp_comment flows", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bh-plan-"));
  const artifactPath = path.join(dir, "finalization.json");
  await writeFile(
    artifactPath,
    JSON.stringify({
      current_url: "https://blog.example.com/post-1#comments",
      title: "Comments",
      body_excerpt: "Thanks! Your comment has been received.",
      visual_verification: {
        classification: "success_or_confirmation",
        confidence: 0.97,
        summary: "A thank-you banner confirms the comment submission form was accepted.",
      },
      final_outcome: {
        next_status: "WAITING_RETRY_DECISION",
        detail: "Legacy outcome awaiting repartition.",
      },
    }),
    "utf-8",
  );

  const plan = await buildRetryDecisionPlan(
    makeTask({
      flow_family: "wp_comment",
      status: "WAITING_RETRY_DECISION",
      latest_artifacts: [artifactPath],
      target_url: "https://blog.example.com/post-1#comments",
      hostname: "blog.example.com",
    }),
  );

  assert.notEqual(plan.bucket, "terminal_success");
  assert.notEqual(plan.waitReasonCode, "SITE_RESPONSE_PENDING");
});

test("buildRetryDecisionPlan uses early terminal classifier policy blockers to avoid generic retry triage", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bh-plan-"));
  const artifactPath = path.join(dir, "finalization.json");
  await writeFile(
    artifactPath,
    JSON.stringify({
      current_url: "https://directory.example.com/add-site",
      title: "Add your site",
      body_excerpt: "Add our backlink first and share the live reciprocal backlink URL for review.",
      early_terminal_classifier: {
        hypothesis: "reciprocal_backlink_required",
        recommended_state: "WAITING_POLICY_DECISION",
        recommended_business_outcome: "blocked_policy",
        allow_rerun: false,
      },
      final_outcome: {
        next_status: "WAITING_RETRY_DECISION",
        detail: "Legacy state before repartition.",
      },
    }),
    "utf-8",
  );

  const plan = await buildRetryDecisionPlan(
    makeTask({
      status: "WAITING_RETRY_DECISION",
      latest_artifacts: [artifactPath],
    }),
  );

  assert.equal(plan.bucket, "terminal_policy");
  assert.equal(plan.nextStatus, "WAITING_POLICY_DECISION");
  assert.equal(plan.waitReasonCode, "RECIPROCAL_BACKLINK_REQUIRED");
});

test("buildRetryDecisionPlan ignores generic sponsor or pricing copy without a real paid-listing boundary", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bh-plan-"));
  const artifactPath = path.join(dir, "finalization.json");
  await writeFile(
    artifactPath,
    JSON.stringify({
      current_url: "https://directory.example.com/submit",
      title: "Submit your tool",
      body_excerpt:
        "Free submit is available. Sponsored by Stripe. Optional newsletter subscription for readers. Advertiser analytics starts at $49 per month.",
      final_outcome: {
        next_status: "WAITING_RETRY_DECISION",
        detail: "Legacy state before repartition.",
      },
    }),
    "utf-8",
  );

  const plan = await buildRetryDecisionPlan(
    makeTask({
      status: "WAITING_RETRY_DECISION",
      latest_artifacts: [artifactPath],
    }),
  );

  assert.notEqual(plan.bucket, "terminal_policy");
  assert.notEqual(plan.waitReasonCode, "PAID_OR_SPONSORED_LISTING");
});

test("buildRetryDecisionPlan does not promote terminal success from unstructured thank-you copy alone", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bh-plan-"));
  const artifactPath = path.join(dir, "finalization.json");
  await writeFile(
    artifactPath,
    JSON.stringify({
      current_url: "https://directory.example.com/submit",
      title: "Submit your tool",
      body_excerpt: "Thanks for submitting. We love helping founders launch.",
      final_outcome: {
        next_status: "WAITING_RETRY_DECISION",
        detail: "Legacy state before repartition.",
      },
    }),
    "utf-8",
  );

  const plan = await buildRetryDecisionPlan(
    makeTask({
      status: "WAITING_RETRY_DECISION",
      latest_artifacts: [artifactPath],
    }),
  );

  assert.notEqual(plan.bucket, "terminal_success");
  assert.notEqual(plan.waitReasonCode, "SITE_RESPONSE_PENDING");
});

test("parking an exhausted retryable task does not trust stale success notes without structured evidence", () => {
  const task = makeTask({
    wait: {
      wait_reason_code: "AUTOMATIC_RETRY_EXHAUSTED",
      resume_trigger: "Automatic retry budget exhausted.",
      resolution_owner: "none",
      resolution_mode: "terminal_audit",
      evidence_ref: "artifact.json",
    },
    last_takeover_outcome: "Thanks for submitting. Your listing is under review.",
    notes: ["Please check your email to verify the listing."],
  });

  const parked = parkExhaustedRetryableTask(task);

  assert.equal(parked, true);
  assert.equal(task.status, "WAITING_RETRY_DECISION");
  assert.equal(task.wait?.wait_reason_code, "AUTOMATIC_RETRY_EXHAUSTED");
});

test("buildRetryDecisionPlan reactivates exhausted tasks when execution blockers prove CDP runtime recovery", async () => {
  const plan = await buildRetryDecisionPlan(
    makeTask({
      status: "WAITING_RETRY_DECISION",
      wait: {
        wait_reason_code: "AUTOMATIC_RETRY_EXHAUSTED",
        resume_trigger: "Automatic retry budget exhausted.",
        resolution_owner: "none",
        resolution_mode: "terminal_audit",
        evidence_ref: "latest-preflight.json",
      },
      execution_state: {
        version: 1,
        blockers: [
          {
            blocker_id: "blocker-1",
            node_id: "node-1",
            context_type: "retry_surface",
            url: "https://example.com/submit",
            blocker_type: "playwright_cdp_unavailable",
            detail: ["browserType.connectOverCDP: Timeout 30000ms exceeded"],
            severity: "soft",
            unblock_requirement: "restore_runtime",
            can_auto_resume: true,
            consumes_retry_budget: false,
            evidence_refs: ["latest-preflight.json"],
            source: "prepare",
            updated_at: "2026-04-23T00:00:00.000Z",
            status: "active",
          },
        ],
        discovered_actions: [],
        evidence: [],
        reusable_fragments: [],
      },
    }),
    { healthy: true, summary: "runtime ok" },
  );

  assert.equal(plan.bucket, "runtime_reactivate_ready");
  assert.equal(plan.nextStatus, "READY");
  assert.match(plan.detail, /Runtime retry reactivated/);
});

test("buildRetryDecisionPlan cools down repeated stale-path retries instead of reactivating immediately", async () => {
  const plan = await buildRetryDecisionPlan(
    makeTask({
      status: "WAITING_RETRY_DECISION",
      run_count: 3,
      wait: {
        wait_reason_code: "AUTOMATIC_RETRY_EXHAUSTED",
        resume_trigger: "Automatic retry budget exhausted.",
        resolution_owner: "none",
        resolution_mode: "terminal_audit",
        evidence_ref: "artifact.json",
      },
      last_takeover_outcome: "Fresh probe confirmed this is still a stale submit path.",
    }),
    { healthy: true, summary: "runtime ok" },
  );

  assert.equal(plan.bucket, "reactivation_cooldown");
  assert.equal(plan.nextStatus, "WAITING_RETRY_DECISION");
  assert.equal(plan.waitReasonCode, "REACTIVATION_COOLDOWN");
  assert.match(plan.detail, /cooldown/i);
});

test("buildRetryDecisionPlan escalates repeated stale-path retries after cooldown has already been consumed", async () => {
  const plan = await buildRetryDecisionPlan(
    makeTask({
      status: "WAITING_RETRY_DECISION",
      run_count: 4,
      wait: {
        wait_reason_code: "AUTOMATIC_RETRY_EXHAUSTED",
        resume_trigger: "Automatic retry budget exhausted.",
        resolution_owner: "none",
        resolution_mode: "terminal_audit",
        evidence_ref: "artifact.json",
      },
      last_takeover_outcome: "Fresh probe confirmed this is still a stale submit path.",
      reactivation_cooldown_until: "2026-04-07T00:00:00.000Z",
      reactivation_cooldown_reason: "STALE_SUBMIT_PATH",
      reactivation_cooldown_count: 1,
    }),
    { healthy: true, summary: "runtime ok" },
  );

  assert.equal(plan.bucket, "needs_manual_triage");
  assert.equal(plan.nextStatus, "WAITING_RETRY_DECISION");
  assert.equal(plan.waitReasonCode, "REPEATED_FAILURE_REVIEW_REQUIRED");
  assert.match(plan.detail, /repeated/i);
});
