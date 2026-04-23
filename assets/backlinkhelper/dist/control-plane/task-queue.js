import { loadOrCreatePromotedProfile } from "../shared/promoted-profile.js";
import { getFamilyConfig, resolveFlowFamily } from "../families/index.js";
import { buildTargetPreflightAssessment, findExactHostDuplicateTasks } from "./target-preflight.js";
import { clearPendingFinalize, clearWorkerLease, ensureDataDirectories, listTasks, loadTask, loadWorkerLease, readJsonFile, saveTask, saveWorkerLease, } from "../memory/data-store.js";
import { loadBrowserOwnership, reapExpiredBrowserOwnership } from "../execution/ownership-lock.js";
import { loadRuntimeIncident } from "../shared/runtime-incident.js";
import { tryAutoRecoverRuntimeIncident } from "../shared/runtime-sanitize.js";
import { BOUNDED_WORKER_LEASE_TTL_MS } from "../shared/runtime-budgets.js";
import { markTaskStageTimestamp } from "../shared/task-timing.js";
const RETRY_BACKOFF_MS = 60 * 60 * 1_000;
const MAX_AUTOMATIC_RETRIES = 1;
const RETRY_EXHAUSTED_WAIT_REASON_CODE = "AUTOMATIC_RETRY_EXHAUSTED";
const RUNTIME_RECOVERY_WAIT_REASON_CODE = "RUNTIME_RECOVERY_REQUIRED";
const COMMUNITY_STRATEGY_WAIT_REASON_CODE = "COMMUNITY_STRATEGY_REVIEW";
const RETRY_CLASSIFICATION_PENDING_WAIT_REASON_CODE = "RETRY_CLASSIFICATION_PENDING";
const REACTIVATION_COOLDOWN_WAIT_REASON_CODE = "REACTIVATION_COOLDOWN";
const REPEATED_FAILURE_REVIEW_REQUIRED_WAIT_REASON_CODE = "REPEATED_FAILURE_REVIEW_REQUIRED";
const HOT_LOOP_MIN_RUN_COUNT = 3;
const HOT_LOOP_ESCALATE_AFTER_COOLDOWN_RUN_COUNT = 4;
const REACTIVATION_COOLDOWN_MS = 6 * 60 * 60 * 1_000;
const GENERIC_WAIT_REASON_CODES = new Set([
    "VISUAL_VERIFICATION_REQUIRED",
    RETRY_EXHAUSTED_WAIT_REASON_CODE,
    RETRY_CLASSIFICATION_PENDING_WAIT_REASON_CODE,
]);
export let __testTryAutoRecoverRuntimeIncident = tryAutoRecoverRuntimeIncident;
export function __setRuntimeRecoveryHookForTest(hook) {
    __testTryAutoRecoverRuntimeIncident = hook;
}
export function __resetRuntimeRecoveryHookForTest() {
    __testTryAutoRecoverRuntimeIncident = tryAutoRecoverRuntimeIncident;
}
const COMMUNITY_HOST_PATTERNS = [
    "reddit.com",
    "github.com",
    "dev.to",
    "juejin.cn",
    "okjike.com",
    "v2ex.com",
    "hackernoon.com",
    "hashnode.com",
    "medium.com",
];
const MANUAL_AUTH_REASON_CODES = new Set(["DIRECTORY_LOGIN_REQUIRED"]);
const POLICY_REASON_CODES = new Set(["PAID_OR_SPONSORED_LISTING"]);
const MISSING_INPUT_REASON_CODES = new Set(["REQUIRED_INPUT_MISSING"]);
const EXTERNAL_EVENT_REASON_CODES = new Set(["EMAIL_VERIFICATION_PENDING"]);
const TERMINAL_SUCCESS_REASON_CODES = new Set(["SITE_RESPONSE_PENDING"]);
function semanticContractIncludes(flowFamily, key, reason) {
    const semanticContract = getFamilyConfig(flowFamily).semanticContract;
    const values = semanticContract[key] ?? [];
    return values.includes(reason);
}
const REACTIVATE_REASON_CODES = new Set([
    "STALE_SUBMIT_PATH",
    "DIRECTORY_NAVIGATION_FAILED",
    "DIRECTORY_UPSTREAM_5XX",
]);
const RUNTIME_REASON_CODES = new Set([
    "TASK_TIMEOUT",
    "TAKEOVER_RUNTIME_ERROR",
    "RUNTIME_PREFLIGHT_FAILED",
]);
const DEFAULT_GUARDED_REACTIVATION_BUCKETS = [
    "reactivate_ready",
    "runtime_reactivate_ready",
];
export function deriveFlowFamilyAudit(args) {
    const now = args.now ?? new Date().toISOString();
    const enqueuedBy = args.enqueuedBy ?? args.existingTask?.enqueued_by ?? "enqueue-site";
    const requested = resolveFlowFamily(args.requestedFlowFamily);
    if (!args.existingTask) {
        const flowFamilySource = args.requestedFlowFamily ? "explicit" : "defaulted";
        return {
            flowFamily: requested,
            flowFamilySource,
            flowFamilyReason: flowFamilySource === "explicit"
                ? `Flow family ${requested} was supplied explicitly at enqueue time.`
                : `No flow family was supplied at enqueue time; defaulted to ${requested}.`,
            flowFamilyUpdatedAt: now,
            enqueuedBy,
        };
    }
    const existingFamily = resolveFlowFamily(args.existingTask.flow_family);
    if (!args.requestedFlowFamily) {
        return {
            flowFamily: existingFamily,
            flowFamilySource: "carried_forward",
            flowFamilyReason: `Re-enqueue preserved existing flow family ${existingFamily}.`,
            flowFamilyUpdatedAt: now,
            correctedFromFamily: args.existingTask.corrected_from_family,
            enqueuedBy,
        };
    }
    if (requested !== existingFamily) {
        return {
            flowFamily: requested,
            flowFamilySource: "corrected",
            flowFamilyReason: `Flow family corrected from ${existingFamily} to ${requested} during re-enqueue.`,
            flowFamilyUpdatedAt: now,
            correctedFromFamily: existingFamily,
            enqueuedBy,
        };
    }
    return {
        flowFamily: requested,
        flowFamilySource: "explicit",
        flowFamilyReason: `Flow family ${requested} was explicitly reaffirmed during re-enqueue.`,
        flowFamilyUpdatedAt: now,
        correctedFromFamily: args.existingTask.corrected_from_family,
        enqueuedBy,
    };
}
function buildIncomingSubmissionContext(args) {
    return {
        promoted_profile: args.promotedProfile,
        submitter_email: args.submitterEmailBase,
        confirm_submit: args.confirmSubmit,
    };
}
function buildTask(args) {
    const now = new Date().toISOString();
    const familyAudit = deriveFlowFamilyAudit({
        requestedFlowFamily: args.flowFamily,
        enqueuedBy: args.enqueuedBy,
        now,
    });
    return {
        id: args.taskId,
        target_url: args.targetUrl,
        hostname: new URL(args.targetUrl).hostname,
        flow_family: familyAudit.flowFamily,
        flow_family_source: familyAudit.flowFamilySource,
        flow_family_reason: familyAudit.flowFamilyReason,
        flow_family_updated_at: familyAudit.flowFamilyUpdatedAt,
        corrected_from_family: familyAudit.correctedFromFamily,
        enqueued_by: familyAudit.enqueuedBy,
        submission: buildIncomingSubmissionContext({
            promotedProfile: args.promotedProfile,
            submitterEmailBase: args.submitterEmailBase,
            confirmSubmit: args.confirmSubmit,
        }),
        status: "READY",
        created_at: now,
        updated_at: now,
        run_count: 0,
        escalation_level: "none",
        takeover_attempts: 0,
        stage_timestamps: {
            enqueued_at: now,
        },
        phase_history: [],
        latest_artifacts: [],
        notes: [],
    };
}
export function shouldReuseExactHostDuplicateTask(args) {
    const targetHostname = new URL(args.targetUrl).hostname;
    if (args.task.target_url !== args.targetUrl || args.task.hostname !== targetHostname) {
        return false;
    }
    if (resolveFlowFamily(args.task.flow_family) !== resolveFlowFamily(args.flowFamily)) {
        return false;
    }
    const incomingSubmission = buildIncomingSubmissionContext({
        promotedProfile: args.promotedProfile,
        submitterEmailBase: args.submitterEmailBase,
        confirmSubmit: args.confirmSubmit,
    });
    return JSON.stringify(args.task.submission) === JSON.stringify(incomingSubmission);
}
function buildReenqueuedTaskFromExisting(args) {
    const targetHostname = new URL(args.targetUrl).hostname;
    let familyAudit;
    if (args.preserveExistingFlowFamilyWhenOmitted === false && !args.flowFamily) {
        const defaultedFamily = resolveFlowFamily(args.flowFamily);
        const existingFamily = resolveFlowFamily(args.existingTask.flow_family);
        const enqueuedBy = args.enqueuedBy ?? args.existingTask.enqueued_by ?? "enqueue-site";
        familyAudit =
            defaultedFamily === existingFamily
                ? {
                    flowFamily: existingFamily,
                    flowFamilySource: "carried_forward",
                    flowFamilyReason: `Re-enqueue preserved existing flow family ${existingFamily}.`,
                    flowFamilyUpdatedAt: args.now,
                    correctedFromFamily: args.existingTask.corrected_from_family,
                    enqueuedBy,
                }
                : {
                    flowFamily: defaultedFamily,
                    flowFamilySource: "corrected",
                    flowFamilyReason: `Flow family corrected from ${existingFamily} to ${defaultedFamily} because the new enqueue omitted flow family and default semantics apply.`,
                    flowFamilyUpdatedAt: args.now,
                    correctedFromFamily: existingFamily,
                    enqueuedBy,
                };
    }
    else {
        familyAudit = deriveFlowFamilyAudit({
            existingTask: args.existingTask,
            requestedFlowFamily: args.flowFamily,
            enqueuedBy: args.enqueuedBy,
            now: args.now,
        });
    }
    const task = {
        ...args.existingTask,
        target_url: args.targetUrl,
        hostname: targetHostname,
        flow_family: familyAudit.flowFamily,
        flow_family_source: familyAudit.flowFamilySource,
        flow_family_reason: familyAudit.flowFamilyReason,
        flow_family_updated_at: familyAudit.flowFamilyUpdatedAt,
        corrected_from_family: familyAudit.correctedFromFamily,
        enqueued_by: familyAudit.enqueuedBy,
        submission: buildIncomingSubmissionContext({
            promotedProfile: args.promotedProfile,
            submitterEmailBase: args.submitterEmailBase,
            confirmSubmit: args.confirmSubmit,
        }),
    };
    prepareTaskForReenqueue(task);
    markTaskStageTimestamp(task, "enqueued_at", args.now);
    applyTargetPreflightToTask({ task, historicalTasks: args.historicalTasks, now: args.now });
    updateTaskStatus(task, "READY");
    return task;
}
function applyTargetPreflightToTask(args) {
    const assessment = buildTargetPreflightAssessment({
        targetUrl: args.task.target_url,
        promotedHostname: args.task.submission.promoted_profile.hostname,
        flowFamily: args.task.flow_family,
        historicalTasks: args.historicalTasks,
        excludeTaskId: args.task.id,
        now: args.now,
    });
    args.task.target_preflight = assessment;
    args.task.queue_priority_score = assessment.queue_priority_score;
}
function updateTaskStatus(task, status) {
    task.status = status;
    task.updated_at = new Date().toISOString();
}
function compareByCreatedAt(left, right) {
    return new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
}
function getTaskQueuePriorityScore(task) {
    return task.queue_priority_score ?? task.target_preflight?.queue_priority_score ?? 0;
}
function compareByQueuePriorityThenCreated(left, right) {
    return getTaskQueuePriorityScore(right) - getTaskQueuePriorityScore(left) || compareByCreatedAt(left, right);
}
function prepareTaskForReenqueue(task) {
    task.wait = undefined;
    task.skip_reason_code = undefined;
    task.terminal_class = undefined;
    task.lease_expires_at = undefined;
    task.email_verification_continuation = undefined;
}
export function matchesTaskScope(task, scope = {}) {
    if (scope.taskIdPrefix && !task.id.startsWith(scope.taskIdPrefix)) {
        return false;
    }
    if (scope.promotedHostname && task.submission.promoted_profile.hostname !== scope.promotedHostname) {
        return false;
    }
    if (scope.promotedUrl && task.submission.promoted_profile.url !== scope.promotedUrl) {
        return false;
    }
    return true;
}
function parseBucketList(values) {
    if (!values || values.length === 0) {
        return undefined;
    }
    const unique = [...new Set(values)];
    return unique.length > 0 ? unique : undefined;
}
function buildScopedTaskList(tasks, scope = {}) {
    return tasks.filter((task) => matchesTaskScope(task, scope));
}
const FOLLOW_UP_STATUSES = new Set(["WAITING_SITE_RESPONSE", "WAITING_EXTERNAL_EVENT"]);
const AUTO_RESUMABLE_FOLLOW_UP_REASON_CODES = new Set(["EMAIL_VERIFICATION_PENDING"]);
const LIGHTWEIGHT_SITE_RESPONSE_FOLLOW_UP_REASON_CODES = new Set([
    "SITE_RESPONSE_PENDING",
    "PROFILE_PUBLICATION_PENDING",
    "COMMENT_MODERATION_PENDING",
    "ARTICLE_SUBMITTED_PENDING_EDITORIAL",
    "ARTICLE_PUBLICATION_PENDING",
]);
export function deriveTaskLane(task) {
    if (FOLLOW_UP_STATUSES.has(task.status)) {
        return "follow_up";
    }
    if (task.status === "READY" || task.status === "RETRYABLE") {
        return resolveFlowFamily(task.flow_family) === "saas_directory"
            ? "directory_active"
            : "non_directory_active";
    }
    return undefined;
}
export function resolveWorkerLeaseGroupForLane(lane = "active_any") {
    return lane === "follow_up" ? "follow_up" : "active";
}
export function matchesClaimLane(task, lane = "active_any") {
    const derived = deriveTaskLane(task);
    if (!derived) {
        return false;
    }
    if (lane === "active_any") {
        return derived === "directory_active" || derived === "non_directory_active";
    }
    return derived === lane;
}
export function pickNextTaskForLane(tasks, lane = "active_any") {
    if (lane === "follow_up") {
        const emailFollowUpTasks = tasks
            .filter((task) => matchesClaimLane(task, lane) &&
            task.status === "WAITING_EXTERNAL_EVENT" &&
            AUTO_RESUMABLE_FOLLOW_UP_REASON_CODES.has(task.wait?.wait_reason_code ?? ""))
            .sort(compareByCreatedAt);
        if (emailFollowUpTasks[0]) {
            return emailFollowUpTasks[0];
        }
        return tasks
            .filter((task) => matchesClaimLane(task, lane) &&
            task.status === "WAITING_SITE_RESPONSE" &&
            LIGHTWEIGHT_SITE_RESPONSE_FOLLOW_UP_REASON_CODES.has(task.wait?.wait_reason_code ?? ""))
            .sort(compareByCreatedAt)[0];
    }
    const readyTasks = tasks
        .filter((task) => task.status === "READY" && matchesClaimLane(task, lane))
        .sort(compareByQueuePriorityThenCreated);
    const retryableTasks = tasks
        .filter((task) => canRetry(task) && matchesClaimLane(task, lane))
        .sort(compareByQueuePriorityThenCreated);
    return readyTasks[0] ?? retryableTasks[0];
}
export function buildTaskLaneReport(tasks) {
    const totals = {
        directory_active: 0,
        non_directory_active: 0,
        follow_up: 0,
        blocked_or_other: 0,
    };
    for (const task of tasks) {
        const lane = deriveTaskLane(task);
        if (!lane) {
            totals.blocked_or_other += 1;
            continue;
        }
        totals[lane] += 1;
    }
    return { totals };
}
export function isRetryExhausted(task) {
    return task.status === "RETRYABLE" && task.run_count >= MAX_AUTOMATIC_RETRIES + 1;
}
export function canRetry(task) {
    if (task.status !== "RETRYABLE") {
        return false;
    }
    if (isRetryExhausted(task)) {
        return false;
    }
    return Date.now() - new Date(task.updated_at).getTime() >= RETRY_BACKOFF_MS;
}
function inferExhaustedRetryReason(task) {
    const prioritizedWaitReason = task.wait?.wait_reason_code && !GENERIC_WAIT_REASON_CODES.has(task.wait.wait_reason_code)
        ? task.wait.wait_reason_code
        : undefined;
    if (prioritizedWaitReason) {
        return prioritizedWaitReason;
    }
    if (task.skip_reason_code === "captcha_or_human_verification_required") {
        return "CAPTCHA_BLOCKED";
    }
    if (task.skip_reason_code === "paid_or_sponsored_listing") {
        return "PAID_OR_SPONSORED_LISTING";
    }
    return inferReasonFromText([task.last_takeover_outcome, task.wait?.resume_trigger, ...task.notes.slice(-5)]
        .filter(Boolean)
        .join("\n"), task.flow_family);
}
export function parkExhaustedRetryableTask(task) {
    if (!isRetryExhausted(task)) {
        return false;
    }
    const inferredReason = inferExhaustedRetryReason(task);
    const exhaustedDetail = `Automatic retry budget exhausted after ${task.run_count} run(s). ` +
        "This task will not be auto-claimed again until a human or policy explicitly re-queues it.";
    const evidenceRef = task.wait?.evidence_ref ?? task.latest_artifacts.at(-1) ?? "";
    if (inferredReason && TERMINAL_SUCCESS_REASON_CODES.has(inferredReason)) {
        updateTaskStatus(task, "WAITING_SITE_RESPONSE");
        task.wait = {
            wait_reason_code: "SITE_RESPONSE_PENDING",
            resume_trigger: task.wait?.resume_trigger ?? task.last_takeover_outcome ?? exhaustedDetail,
            resolution_owner: "system",
            resolution_mode: "auto_resume",
            evidence_ref: evidenceRef,
        };
        task.last_takeover_outcome = task.wait.resume_trigger;
        task.notes.push("Automatic retry exhaustion collapsed directly into WAITING_SITE_RESPONSE due to clear submission-success evidence.");
        return true;
    }
    if (inferredReason && EXTERNAL_EVENT_REASON_CODES.has(inferredReason)) {
        updateTaskStatus(task, "WAITING_EXTERNAL_EVENT");
        task.wait = {
            wait_reason_code: "EMAIL_VERIFICATION_PENDING",
            resume_trigger: task.wait?.resume_trigger ?? exhaustedDetail,
            resolution_owner: "gog",
            resolution_mode: "auto_resume",
            evidence_ref: evidenceRef,
        };
        task.terminal_class = "email_verification_pending";
        task.last_takeover_outcome = task.wait.resume_trigger;
        task.notes.push("Automatic retry exhaustion collapsed directly into WAITING_EXTERNAL_EVENT due to a real email verification checkpoint.");
        return true;
    }
    if (inferredReason && MANUAL_AUTH_REASON_CODES.has(inferredReason)) {
        updateTaskStatus(task, "WAITING_MANUAL_AUTH");
        task.wait = {
            wait_reason_code: "DIRECTORY_LOGIN_REQUIRED",
            resume_trigger: task.wait?.resume_trigger ?? exhaustedDetail,
            resolution_owner: "none",
            resolution_mode: "terminal_audit",
            evidence_ref: evidenceRef,
        };
        task.terminal_class = "login_required";
        task.last_takeover_outcome = task.wait.resume_trigger;
        task.notes.push("Automatic retry exhaustion collapsed directly into WAITING_MANUAL_AUTH.");
        return true;
    }
    if (inferredReason === "CAPTCHA_BLOCKED") {
        updateTaskStatus(task, "SKIPPED");
        task.wait = undefined;
        task.skip_reason_code = "captcha_or_human_verification_required";
        task.terminal_class = "captcha_blocked";
        task.last_takeover_outcome = task.last_takeover_outcome ?? exhaustedDetail;
        task.notes.push("Automatic retry exhaustion collapsed directly into SKIPPED for CAPTCHA / human verification.");
        return true;
    }
    if (inferredReason && POLICY_REASON_CODES.has(inferredReason)) {
        updateTaskStatus(task, "WAITING_POLICY_DECISION");
        task.wait = {
            wait_reason_code: "PAID_OR_SPONSORED_LISTING",
            resume_trigger: task.wait?.resume_trigger ?? exhaustedDetail,
            resolution_owner: "none",
            resolution_mode: "terminal_audit",
            evidence_ref: evidenceRef,
        };
        task.terminal_class = "paid_listing";
        task.last_takeover_outcome = task.wait.resume_trigger;
        task.notes.push("Automatic retry exhaustion collapsed directly into WAITING_POLICY_DECISION for a policy/paid boundary.");
        return true;
    }
    if (inferredReason && MISSING_INPUT_REASON_CODES.has(inferredReason)) {
        updateTaskStatus(task, "WAITING_MISSING_INPUT");
        task.wait = {
            wait_reason_code: "REQUIRED_INPUT_MISSING",
            resume_trigger: task.wait?.resume_trigger ?? exhaustedDetail,
            resolution_owner: "none",
            resolution_mode: "terminal_audit",
            evidence_ref: evidenceRef,
            missing_fields: task.wait?.missing_fields,
        };
        task.last_takeover_outcome = task.wait.resume_trigger;
        task.notes.push("Automatic retry exhaustion collapsed directly into WAITING_MISSING_INPUT.");
        return true;
    }
    updateTaskStatus(task, "WAITING_RETRY_DECISION");
    task.wait = {
        wait_reason_code: RETRY_EXHAUSTED_WAIT_REASON_CODE,
        resume_trigger: exhaustedDetail,
        resolution_owner: "none",
        resolution_mode: "terminal_audit",
        evidence_ref: evidenceRef,
    };
    task.last_takeover_outcome = exhaustedDetail;
    task.notes.push("Automatic retry budget exhausted; parked out of the active RETRYABLE queue.");
    return true;
}
function matchesCommunityHost(hostname) {
    return COMMUNITY_HOST_PATTERNS.some((pattern) => hostname === pattern || hostname.endsWith(`.${pattern}`));
}
export function shouldReactivateRuntimeRetries(runtimeHealth) {
    return Boolean(runtimeHealth?.healthy);
}
function isHostReactivationBucket(bucket) {
    return bucket === "reactivate_ready" || bucket === "runtime_reactivate_ready";
}
export function shouldDeferHostReactivation(args) {
    if (!isHostReactivationBucket(args.bucket)) {
        return false;
    }
    return args.hotHosts.includes(args.hostname) || args.alreadyReleasedHosts.includes(args.hostname);
}
function isHotLoopReason(reason) {
    return Boolean(reason && (REACTIVATE_REASON_CODES.has(reason) || RUNTIME_REASON_CODES.has(reason) || reason === "OUTCOME_NOT_CONFIRMED"));
}
function getActiveReactivationCooldown(task, reason) {
    if (!task.reactivation_cooldown_until) {
        return undefined;
    }
    if (new Date(task.reactivation_cooldown_until).getTime() <= Date.now()) {
        return undefined;
    }
    if (reason && task.reactivation_cooldown_reason && task.reactivation_cooldown_reason !== reason) {
        return undefined;
    }
    return task.reactivation_cooldown_until;
}
function shouldStartReactivationCooldown(task, reason) {
    return isHotLoopReason(reason) && task.run_count >= HOT_LOOP_MIN_RUN_COUNT;
}
function shouldEscalateRepeatedFailureReview(task, reason) {
    return Boolean(isHotLoopReason(reason) &&
        (task.reactivation_cooldown_count ?? 0) >= 1 &&
        task.run_count >= HOT_LOOP_ESCALATE_AFTER_COOLDOWN_RUN_COUNT);
}
function hasStrongVisualSuccessSignal(hints) {
    if (hints.visualClassification !== "success_or_confirmation") {
        return false;
    }
    if ((hints.visualConfidence ?? 0) < 0.9) {
        return false;
    }
    const summary = (hints.visualSummary ?? "").toLowerCase();
    if (!summary) {
        return false;
    }
    const negativePatterns = [
        /\berror\b/,
        /\bfailed\b/,
        /\bfailure\b/,
        /not confirmed/,
        /client-side only/,
        /no authoritative/,
        /\bcaptcha\b/,
        /\blogin\b/,
        /\bsign in\b/,
        /\bpaid\b/,
        /\bsponsor\w*\b/,
    ];
    const positiveNegationPatterns = [/no error/, /without error/, /no failure/, /without failure/];
    return !negativePatterns.some((pattern) => pattern.test(summary) && !positiveNegationPatterns.some((safe) => safe.test(summary)));
}
function looksLikePaidReasonBoundary(text) {
    return [
        /\bpaid (?:listing|submission|review|placement|plan)\b/i,
        /\b(?:featured|sponsored) (?:listing|placement|submission|review)\b/i,
        /\bone-time payment\b/i,
        /\bsubmit pay\b/i,
        /\bupgrade listing\b/i,
        /\b(?:checkout|payment|pay now|stripe)\b[\s\S]{0,60}\b(?:listing|submission|review|featured|sponsored)\b/i,
        /\bpricing\b[\s\S]{0,80}\b(?:listing|submission|review|featured|sponsored|directory)\b/i,
        /\$\s?\d[\s\S]{0,40}\b(?:listing|submission|review|featured|sponsored|plan)\b/i,
    ].some((pattern) => pattern.test(text));
}
function inferReasonFromText(text, flowFamily) {
    const normalized = text.toLowerCase();
    const reasonInference = getFamilyConfig(flowFamily).reasonInference;
    const containsAny = (needles) => needles.some((needle) => normalized.includes(needle));
    // Text fallback is intentionally limited to operational/runtime hints.
    // Business-terminal states (success, email verification, manual auth, policy, missing input)
    // must come from structured outcome artifacts, explicit wait/skip codes, visual evidence,
    // or other typed checkpoints instead of free-text summaries.
    if (containsAny(reasonInference.staleSubmitSignals)) {
        return "STALE_SUBMIT_PATH";
    }
    if (normalized.includes("navigation failed")) {
        return "DIRECTORY_NAVIGATION_FAILED";
    }
    if (normalized.includes("outcome not confirmed")) {
        return "OUTCOME_NOT_CONFIRMED";
    }
    if (containsAny(reasonInference.runtimeSignals)) {
        return "TAKEOVER_RUNTIME_ERROR";
    }
    return undefined;
}
function scoreRetryDecisionArtifactPath(candidatePath) {
    const normalized = candidatePath.toLowerCase();
    if (normalized.includes("finalization.json")) {
        return 30;
    }
    if (normalized.includes("agent-loop.json")) {
        return 20;
    }
    if (normalized.includes("scout.json")) {
        return 10;
    }
    return 0;
}
async function loadRetryDecisionArtifactHints(task) {
    const candidatePaths = [...new Set([
            ...(task.latest_artifacts ?? []).slice().reverse(),
            task.wait?.evidence_ref,
        ].filter((value) => typeof value === "string" && value.endsWith(".json")))]
        .sort((left, right) => scoreRetryDecisionArtifactPath(right) - scoreRetryDecisionArtifactPath(left));
    for (const candidatePath of candidatePaths) {
        const payload = await readJsonFile(candidatePath);
        if (!payload) {
            continue;
        }
        const finalOutcome = payload.final_outcome;
        const proposedOutcome = payload.proposed_outcome;
        const earlyTerminalClassifier = payload.early_terminal_classifier;
        const visualVerification = payload.visual_verification;
        const finalWait = finalOutcome?.wait;
        const proposedWait = proposedOutcome?.wait;
        const bodyExcerpt = typeof payload.body_excerpt === "string" ? payload.body_excerpt : undefined;
        const title = typeof payload.title === "string" ? payload.title : undefined;
        const currentUrl = typeof payload.current_url === "string" ? payload.current_url : undefined;
        const detailCandidates = [
            typeof finalOutcome?.detail === "string" ? finalOutcome.detail : undefined,
            typeof proposedOutcome?.detail === "string" ? proposedOutcome.detail : undefined,
        ].filter((value, index, array) => typeof value === "string" && value.trim().length > 0 && array.indexOf(value) === index);
        const detail = detailCandidates.length > 0 ? detailCandidates.join("\n") : undefined;
        const waitReasonCode = (typeof finalWait?.wait_reason_code === "string" ? finalWait.wait_reason_code : undefined) ??
            (typeof proposedWait?.wait_reason_code === "string" ? proposedWait.wait_reason_code : undefined);
        const skipReasonCode = (typeof finalOutcome?.skip_reason_code === "string" ? finalOutcome.skip_reason_code : undefined) ??
            (typeof proposedOutcome?.skip_reason_code === "string" ? proposedOutcome.skip_reason_code : undefined);
        const classifierHypothesis = typeof earlyTerminalClassifier?.hypothesis === "string" ? earlyTerminalClassifier.hypothesis : undefined;
        const classifierRecommendedState = typeof earlyTerminalClassifier?.recommended_state === "string"
            ? earlyTerminalClassifier.recommended_state
            : undefined;
        const classifierBusinessOutcome = typeof earlyTerminalClassifier?.recommended_business_outcome === "string"
            ? earlyTerminalClassifier.recommended_business_outcome
            : undefined;
        const classifierAllowRerun = typeof earlyTerminalClassifier?.allow_rerun === "boolean" ? earlyTerminalClassifier.allow_rerun : undefined;
        const visualClassification = typeof visualVerification?.classification === "string" ? visualVerification.classification : undefined;
        const visualConfidence = typeof visualVerification?.confidence === "number" ? visualVerification.confidence : undefined;
        const visualSummary = typeof visualVerification?.summary === "string" ? visualVerification.summary : undefined;
        if (waitReasonCode ||
            skipReasonCode ||
            detail ||
            bodyExcerpt ||
            title ||
            currentUrl ||
            classifierHypothesis ||
            classifierRecommendedState ||
            classifierBusinessOutcome ||
            typeof classifierAllowRerun === "boolean" ||
            visualClassification ||
            typeof visualConfidence === "number" ||
            visualSummary) {
            return {
                waitReasonCode,
                skipReasonCode,
                detail,
                bodyExcerpt,
                title,
                currentUrl,
                classifierHypothesis,
                classifierRecommendedState,
                classifierBusinessOutcome,
                classifierAllowRerun,
                visualClassification,
                visualConfidence,
                visualSummary,
            };
        }
    }
    return {};
}
export async function buildRetryDecisionPlan(task, runtimeHealth) {
    const hints = await loadRetryDecisionArtifactHints(task);
    const flowFamily = resolveFlowFamily(task.flow_family);
    const classifierState = hints.classifierRecommendedState;
    const classifierBusinessOutcome = hints.classifierBusinessOutcome;
    const prioritizedWaitReason = hints.waitReasonCode && !GENERIC_WAIT_REASON_CODES.has(hints.waitReasonCode)
        ? hints.waitReasonCode
        : undefined;
    const inferredReason = prioritizedWaitReason ??
        hints.skipReasonCode ??
        inferReasonFromText([
            task.last_takeover_outcome,
            hints.detail,
            hints.title,
            hints.bodyExcerpt,
            hints.currentUrl,
            hints.classifierHypothesis,
            hints.classifierBusinessOutcome,
            hints.classifierRecommendedState,
        ]
            .filter(Boolean)
            .join("\n"), task.flow_family);
    if (flowFamily === "saas_directory" && matchesCommunityHost(task.hostname)) {
        return {
            taskId: task.id,
            hostname: task.hostname,
            bucket: "community_strategy",
            nextStatus: "WAITING_POLICY_DECISION",
            waitReasonCode: COMMUNITY_STRATEGY_WAIT_REASON_CODE,
            detail: "Community/content platform requires a separate publishing strategy instead of the standard directory queue.",
        };
    }
    if (hasStrongVisualSuccessSignal(hints) && flowFamily === "saas_directory") {
        return {
            taskId: task.id,
            hostname: task.hostname,
            bucket: "terminal_success",
            nextStatus: "WAITING_SITE_RESPONSE",
            waitReasonCode: "SITE_RESPONSE_PENDING",
            resolutionOwner: "system",
            resolutionMode: "auto_resume",
            detail: "Strong visual confirmation without visible error is sufficient to treat the submission as accepted, even if the page implementation is client-side heavy.",
        };
    }
    if (inferredReason && semanticContractIncludes(flowFamily, "pending_wait_reason_codes", inferredReason)) {
        return {
            taskId: task.id,
            hostname: task.hostname,
            bucket: "terminal_success",
            nextStatus: "WAITING_SITE_RESPONSE",
            waitReasonCode: inferredReason,
            resolutionOwner: "system",
            resolutionMode: "auto_resume",
            detail: "Task is in a real site-owned pending state for a non-directory family; keep it waiting for public visibility instead of generic retry triage.",
        };
    }
    if (inferredReason && semanticContractIncludes(flowFamily, "progress_wait_reason_codes", inferredReason)) {
        return {
            taskId: task.id,
            hostname: task.hostname,
            bucket: "reactivate_ready",
            nextStatus: "READY",
            detail: "Task ended in resumable draft/progress state and should be eligible for another automated continuation pass.",
        };
    }
    if (inferredReason && semanticContractIncludes(flowFamily, "review_wait_reason_codes", inferredReason)) {
        return {
            taskId: task.id,
            hostname: task.hostname,
            bucket: "needs_manual_triage",
            nextStatus: "WAITING_RETRY_DECISION",
            waitReasonCode: inferredReason,
            resolutionOwner: "none",
            resolutionMode: "terminal_audit",
            detail: "Task reached a live public surface without the required backlink and now needs review instead of being counted as success.",
        };
    }
    if (inferredReason && semanticContractIncludes(flowFamily, "policy_wait_reason_codes", inferredReason)) {
        return {
            taskId: task.id,
            hostname: task.hostname,
            bucket: "terminal_policy",
            nextStatus: "WAITING_POLICY_DECISION",
            waitReasonCode: inferredReason,
            resolutionOwner: "none",
            resolutionMode: "terminal_audit",
            detail: "Task hit a non-directory anti-spam or moderation policy boundary and should not return to generic retry triage.",
        };
    }
    if (classifierBusinessOutcome === "submitted_success" &&
        (classifierState === "WAITING_EXTERNAL_EVENT" || inferredReason === "EMAIL_VERIFICATION_PENDING")) {
        return {
            taskId: task.id,
            hostname: task.hostname,
            bucket: "external_email_verification",
            nextStatus: "WAITING_EXTERNAL_EVENT",
            waitReasonCode: "EMAIL_VERIFICATION_PENDING",
            resolutionOwner: "gog",
            resolutionMode: "auto_resume",
            terminalClass: "email_verification_pending",
            detail: "Early terminal classifier confirmed this task already reached a real email-verification submission checkpoint and should wait for mailbox automation instead of retry triage.",
        };
    }
    if (classifierBusinessOutcome === "submitted_success" && classifierState === "WAITING_SITE_RESPONSE") {
        return {
            taskId: task.id,
            hostname: task.hostname,
            bucket: "terminal_success",
            nextStatus: "WAITING_SITE_RESPONSE",
            waitReasonCode: "SITE_RESPONSE_PENDING",
            resolutionOwner: "system",
            resolutionMode: "auto_resume",
            detail: "Early terminal classifier confirmed this task was already submitted successfully and should stay in the site-response queue instead of retry triage.",
        };
    }
    if (classifierBusinessOutcome === "blocked_missing_input" || classifierState === "WAITING_MISSING_INPUT") {
        return {
            taskId: task.id,
            hostname: task.hostname,
            bucket: "terminal_missing_input",
            nextStatus: "WAITING_MISSING_INPUT",
            waitReasonCode: "REQUIRED_INPUT_MISSING",
            resolutionOwner: "none",
            resolutionMode: "terminal_audit",
            detail: "Early terminal classifier confirmed the task is blocked by missing real submission inputs and should not return to generic retry triage.",
        };
    }
    if (classifierBusinessOutcome === "blocked_manual_auth" || classifierState === "WAITING_MANUAL_AUTH") {
        return {
            taskId: task.id,
            hostname: task.hostname,
            bucket: "terminal_manual_auth",
            nextStatus: "WAITING_MANUAL_AUTH",
            waitReasonCode: "DIRECTORY_LOGIN_REQUIRED",
            resolutionOwner: "none",
            resolutionMode: "terminal_audit",
            terminalClass: "login_required",
            detail: "Early terminal classifier confirmed the task is blocked by unsupported manual authentication and should not return to generic retry triage.",
        };
    }
    if (classifierBusinessOutcome === "blocked_policy" || classifierState === "WAITING_POLICY_DECISION") {
        const policyReasonCode = hints.classifierHypothesis === "reciprocal_backlink_required"
            ? "RECIPROCAL_BACKLINK_REQUIRED"
            : hints.classifierHypothesis === "captcha_blocked"
                ? "CAPTCHA_BLOCKED"
                : inferredReason === "RECIPROCAL_BACKLINK_REQUIRED"
                    ? "RECIPROCAL_BACKLINK_REQUIRED"
                    : inferredReason === "CAPTCHA_BLOCKED"
                        ? "CAPTCHA_BLOCKED"
                        : "PAID_OR_SPONSORED_LISTING";
        return {
            taskId: task.id,
            hostname: task.hostname,
            bucket: "terminal_policy",
            nextStatus: "WAITING_POLICY_DECISION",
            waitReasonCode: policyReasonCode,
            resolutionOwner: "none",
            resolutionMode: "terminal_audit",
            terminalClass: policyReasonCode === "CAPTCHA_BLOCKED" ? "captcha_blocked" : policyReasonCode === "PAID_OR_SPONSORED_LISTING" ? "paid_listing" : undefined,
            detail: "Early terminal classifier confirmed this task is blocked by a real policy boundary and should not stay in generic retry triage.",
        };
    }
    if (inferredReason && TERMINAL_SUCCESS_REASON_CODES.has(inferredReason)) {
        return {
            taskId: task.id,
            hostname: task.hostname,
            bucket: "terminal_success",
            nextStatus: "WAITING_SITE_RESPONSE",
            waitReasonCode: "SITE_RESPONSE_PENDING",
            resolutionOwner: "system",
            resolutionMode: "auto_resume",
            detail: "Task already has clear submission-success evidence and should be treated as waiting for the directory response, not generic retry triage.",
        };
    }
    if (inferredReason && EXTERNAL_EVENT_REASON_CODES.has(inferredReason)) {
        return {
            taskId: task.id,
            hostname: task.hostname,
            bucket: "external_email_verification",
            nextStatus: "WAITING_EXTERNAL_EVENT",
            waitReasonCode: "EMAIL_VERIFICATION_PENDING",
            resolutionOwner: "gog",
            resolutionMode: "auto_resume",
            terminalClass: "email_verification_pending",
            detail: "Task reached a real email-verification checkpoint and should wait for the mailbox watcher instead of going back to generic retry triage.",
        };
    }
    if (inferredReason && MANUAL_AUTH_REASON_CODES.has(inferredReason)) {
        return {
            taskId: task.id,
            hostname: task.hostname,
            bucket: "terminal_manual_auth",
            nextStatus: "WAITING_MANUAL_AUTH",
            waitReasonCode: "DIRECTORY_LOGIN_REQUIRED",
            resolutionOwner: "none",
            resolutionMode: "terminal_audit",
            terminalClass: "login_required",
            detail: "Task exhausted retries and should be parked as a real manual-auth blocker.",
        };
    }
    if (inferredReason === "CAPTCHA_BLOCKED" || hints.skipReasonCode === "captcha_or_human_verification_required") {
        return {
            taskId: task.id,
            hostname: task.hostname,
            bucket: "terminal_policy",
            nextStatus: "SKIPPED",
            skipReasonCode: "captcha_or_human_verification_required",
            terminalClass: "captcha_blocked",
            detail: "Task exhausted retries on a CAPTCHA / human-verification wall and should be closed as skipped.",
        };
    }
    if (inferredReason === "PAID_OR_SPONSORED_LISTING" ||
        hints.skipReasonCode === "paid_or_sponsored_listing" ||
        (inferredReason && POLICY_REASON_CODES.has(inferredReason))) {
        return {
            taskId: task.id,
            hostname: task.hostname,
            bucket: "terminal_policy",
            nextStatus: "WAITING_POLICY_DECISION",
            waitReasonCode: "PAID_OR_SPONSORED_LISTING",
            resolutionOwner: "none",
            resolutionMode: "terminal_audit",
            terminalClass: "paid_listing",
            detail: "Task exhausted retries on a paid/policy boundary and should be parked for policy review.",
        };
    }
    if (inferredReason && MISSING_INPUT_REASON_CODES.has(inferredReason)) {
        return {
            taskId: task.id,
            hostname: task.hostname,
            bucket: "terminal_missing_input",
            nextStatus: "WAITING_MISSING_INPUT",
            waitReasonCode: "REQUIRED_INPUT_MISSING",
            resolutionOwner: "none",
            resolutionMode: "terminal_audit",
            detail: "Task exhausted retries because the input set is incomplete and should be parked for input review.",
        };
    }
    const activeReactivationCooldownUntil = getActiveReactivationCooldown(task, inferredReason);
    if (activeReactivationCooldownUntil) {
        return {
            taskId: task.id,
            hostname: task.hostname,
            bucket: "reactivation_cooldown",
            nextStatus: "WAITING_RETRY_DECISION",
            waitReasonCode: REACTIVATION_COOLDOWN_WAIT_REASON_CODE,
            resolutionOwner: "none",
            resolutionMode: "terminal_audit",
            cooldownUntil: activeReactivationCooldownUntil,
            cooldownReason: inferredReason,
            detail: `Repeated automated failures for ${task.hostname} are in cooldown until ${activeReactivationCooldownUntil}; do not immediately re-feed this task into READY.`,
        };
    }
    if (shouldEscalateRepeatedFailureReview(task, inferredReason)) {
        return {
            taskId: task.id,
            hostname: task.hostname,
            bucket: "needs_manual_triage",
            nextStatus: "WAITING_RETRY_DECISION",
            waitReasonCode: REPEATED_FAILURE_REVIEW_REQUIRED_WAIT_REASON_CODE,
            resolutionOwner: "none",
            resolutionMode: "terminal_audit",
            detail: "Repeated failure: task hit the same automation-worthy failure pattern again after a cooldown window and now requires manual retry review instead of another automatic reactivation.",
        };
    }
    if (shouldStartReactivationCooldown(task, inferredReason)) {
        const cooldownUntil = new Date(Date.now() + REACTIVATION_COOLDOWN_MS).toISOString();
        return {
            taskId: task.id,
            hostname: task.hostname,
            bucket: "reactivation_cooldown",
            nextStatus: "WAITING_RETRY_DECISION",
            waitReasonCode: REACTIVATION_COOLDOWN_WAIT_REASON_CODE,
            resolutionOwner: "none",
            resolutionMode: "terminal_audit",
            cooldownUntil,
            cooldownReason: inferredReason,
            detail: `Task has already consumed ${task.run_count} bounded runs on the same automation-worthy failure pattern (${inferredReason}). Enter reactivation cooldown before considering another reactivation.`,
        };
    }
    if (inferredReason && REACTIVATE_REASON_CODES.has(inferredReason)) {
        return {
            taskId: task.id,
            hostname: task.hostname,
            bucket: "reactivate_ready",
            nextStatus: "READY",
            detail: `Task was parked after retry exhaustion but the root issue (${inferredReason}) is still worth another automated pass.`,
        };
    }
    if (inferredReason && RUNTIME_REASON_CODES.has(inferredReason)) {
        if (shouldReactivateRuntimeRetries(runtimeHealth)) {
            return {
                taskId: task.id,
                hostname: task.hostname,
                bucket: "runtime_reactivate_ready",
                nextStatus: "READY",
                detail: `Runtime retry reactivated because runtime health gate passed: ${runtimeHealth?.summary ?? "healthy"}.`,
            };
        }
        return {
            taskId: task.id,
            hostname: task.hostname,
            bucket: "runtime_recovery_pool",
            nextStatus: "WAITING_RETRY_DECISION",
            waitReasonCode: RUNTIME_RECOVERY_WAIT_REASON_CODE,
            resolutionOwner: "none",
            resolutionMode: "terminal_audit",
            terminalClass: "takeover_runtime_error",
            detail: `Task is blocked by runtime/browser issues and should wait in a runtime-recovery pool until health recovers${runtimeHealth?.summary ? ` (${runtimeHealth.summary})` : ""}.`,
        };
    }
    return {
        taskId: task.id,
        hostname: task.hostname,
        bucket: "needs_manual_triage",
        nextStatus: "WAITING_RETRY_DECISION",
        waitReasonCode: RETRY_CLASSIFICATION_PENDING_WAIT_REASON_CODE,
        detail: "Task needs manual retry triage because no strong reclassification signal was found.",
    };
}
function applyRetryDecisionPlan(task, plan) {
    let changed = false;
    if (task.status !== plan.nextStatus) {
        updateTaskStatus(task, plan.nextStatus);
        changed = true;
    }
    const expectedWait = plan.nextStatus === "READY" || plan.nextStatus === "SKIPPED"
        ? undefined
        : {
            wait_reason_code: plan.waitReasonCode ?? task.wait?.wait_reason_code ?? RETRY_CLASSIFICATION_PENDING_WAIT_REASON_CODE,
            resume_trigger: plan.detail,
            resolution_owner: plan.resolutionOwner ?? "none",
            resolution_mode: plan.resolutionMode ?? "terminal_audit",
            evidence_ref: task.wait?.evidence_ref ?? task.latest_artifacts.at(-1) ?? "",
        };
    const expectedSkipReason = plan.nextStatus === "SKIPPED" ? plan.skipReasonCode : undefined;
    const expectedTerminalClass = plan.nextStatus === "READY" ? undefined : plan.terminalClass;
    const expectedCooldownUntil = plan.waitReasonCode === REACTIVATION_COOLDOWN_WAIT_REASON_CODE ? plan.cooldownUntil : undefined;
    const expectedCooldownReason = plan.waitReasonCode === REACTIVATION_COOLDOWN_WAIT_REASON_CODE ? plan.cooldownReason : undefined;
    const startedNewCooldownWindow = plan.waitReasonCode === REACTIVATION_COOLDOWN_WAIT_REASON_CODE &&
        (task.reactivation_cooldown_until ?? undefined) !== expectedCooldownUntil;
    const expectedCooldownCount = plan.waitReasonCode === REACTIVATION_COOLDOWN_WAIT_REASON_CODE
        ? (task.reactivation_cooldown_count ?? 0) + (startedNewCooldownWindow ? 1 : 0)
        : task.reactivation_cooldown_count;
    if (JSON.stringify(task.wait ?? null) !== JSON.stringify(expectedWait ?? null)) {
        task.wait = expectedWait;
        changed = true;
    }
    if ((task.skip_reason_code ?? undefined) !== expectedSkipReason) {
        task.skip_reason_code = expectedSkipReason;
        changed = true;
    }
    if ((task.terminal_class ?? undefined) !== expectedTerminalClass) {
        task.terminal_class = expectedTerminalClass;
        changed = true;
    }
    if ((task.reactivation_cooldown_until ?? undefined) !== expectedCooldownUntil) {
        task.reactivation_cooldown_until = expectedCooldownUntil;
        changed = true;
    }
    if ((task.reactivation_cooldown_reason ?? undefined) !== expectedCooldownReason) {
        task.reactivation_cooldown_reason = expectedCooldownReason;
        changed = true;
    }
    if ((task.reactivation_cooldown_count ?? undefined) !== expectedCooldownCount) {
        task.reactivation_cooldown_count = expectedCooldownCount;
        changed = true;
    }
    if (!changed) {
        return false;
    }
    task.notes.push(`Retry-decision repartition: ${plan.bucket} -> ${plan.nextStatus}. ${plan.detail}`);
    return true;
}
export async function repartitionRetryDecisionTasks(args = {}) {
    const tasks = buildScopedTaskList((await listTasks())
        .filter((task) => task.status === "WAITING_RETRY_DECISION")
        .sort(compareByCreatedAt), args.scope);
    const selectedTasks = typeof args.limit === "number" ? tasks.slice(0, args.limit) : tasks;
    const applyBuckets = parseBucketList(args.applyBuckets ?? (typeof args.maxApply === "number" ? DEFAULT_GUARDED_REACTIVATION_BUCKETS : undefined)) ??
        undefined;
    const byBucket = {};
    const plans = [];
    let changed = 0;
    let applied = 0;
    for (const task of selectedTasks) {
        const plan = await buildRetryDecisionPlan(task, args.runtimeHealth);
        plans.push(plan);
        byBucket[plan.bucket] = (byBucket[plan.bucket] ?? 0) + 1;
    }
    const hotHosts = [...new Set(plans
            .filter((plan) => plan.waitReasonCode === REACTIVATION_COOLDOWN_WAIT_REASON_CODE ||
            plan.waitReasonCode === REPEATED_FAILURE_REVIEW_REQUIRED_WAIT_REASON_CODE)
            .map((plan) => plan.hostname))];
    const alreadyReleasedHosts = [];
    for (let index = 0; index < selectedTasks.length; index += 1) {
        const task = selectedTasks[index];
        const plan = plans[index];
        const bucketAllowed = !applyBuckets || applyBuckets.includes(plan.bucket);
        const underApplyCap = typeof args.maxApply !== "number" || applied < args.maxApply;
        const hostDeferred = shouldDeferHostReactivation({
            hostname: plan.hostname,
            bucket: plan.bucket,
            hotHosts,
            alreadyReleasedHosts,
        });
        if (args.apply && bucketAllowed && underApplyCap && !hostDeferred) {
            const didChange = applyRetryDecisionPlan(task, plan);
            if (didChange) {
                await saveTask(task);
                changed += 1;
                if (isHostReactivationBucket(plan.bucket)) {
                    alreadyReleasedHosts.push(plan.hostname);
                }
            }
            applied += 1;
        }
    }
    return {
        inspected: selectedTasks.length,
        changed,
        byBucket,
        plans,
    };
}
async function reapExpiredWorkerLease(group) {
    const existingLease = await loadWorkerLease(group);
    if (!existingLease || new Date(existingLease.expires_at).getTime() > Date.now()) {
        return {};
    }
    await clearWorkerLease(group);
    await clearPendingFinalize(existingLease.task_id);
    const task = await loadTask(existingLease.task_id);
    if (!task) {
        return { reapedTaskId: existingLease.task_id };
    }
    task.lease_expires_at = undefined;
    if (existingLease.previous_status && FOLLOW_UP_STATUSES.has(existingLease.previous_status)) {
        task.wait = existingLease.previous_wait;
        task.terminal_class = existingLease.previous_terminal_class;
        task.skip_reason_code = existingLease.previous_skip_reason_code;
        task.notes.push(`${group} worker timed out; restored the waiting checkpoint.`);
        updateTaskStatus(task, existingLease.previous_status);
        await saveTask(task);
        return { reapedTaskId: task.id };
    }
    task.wait = {
        wait_reason_code: "TASK_TIMEOUT",
        resume_trigger: "A previous bounded worker exceeded the 10 minute runtime lease and will be retried automatically.",
        resolution_owner: "system",
        resolution_mode: "auto_resume",
        evidence_ref: `data/backlink-helper/runtime/${group === "active" ? "task-worker-lease.json" : `task-worker-lease-${group}.json`}`,
    };
    task.terminal_class = "outcome_not_confirmed";
    task.notes.push("bounded worker timed out");
    updateTaskStatus(task, "RETRYABLE");
    await saveTask(task);
    return { reapedTaskId: task.id };
}
export async function reapExpiredQueueState() {
    await ensureDataDirectories();
    const reapedTaskIds = (await Promise.all([
        reapExpiredWorkerLease("active"),
        reapExpiredWorkerLease("follow_up"),
    ]))
        .map((result) => result.reapedTaskId)
        .filter((taskId) => Boolean(taskId));
    const reapedBrowserOwnership = await reapExpiredBrowserOwnership();
    return {
        reapedTaskId: reapedTaskIds[0],
        reapedTaskIds,
        reapedBrowserOwnership,
    };
}
export async function enqueueSiteTask(args) {
    await ensureDataDirectories();
    const promotedProfile = await loadOrCreatePromotedProfile({
        promotedUrl: args.promotedUrl,
        promotedName: args.promotedName,
        promotedDescription: args.promotedDescription,
    });
    const now = new Date().toISOString();
    const targetHostname = new URL(args.targetUrl).hostname;
    const tasks = await listTasks();
    const existingTask = await loadTask(args.taskId);
    if (existingTask?.status === "RUNNING") {
        throw new Error(`Task ${args.taskId} is already RUNNING and cannot be re-enqueued.`);
    }
    if (existingTask) {
        const task = buildReenqueuedTaskFromExisting({
            existingTask,
            targetUrl: args.targetUrl,
            promotedProfile,
            submitterEmailBase: args.submitterEmailBase,
            confirmSubmit: args.confirmSubmit,
            flowFamily: args.flowFamily,
            enqueuedBy: args.enqueuedBy,
            historicalTasks: tasks,
            now,
        });
        task.notes.push(`Task id ${args.taskId} was re-enqueued for the bounded single-site worker (score ${getTaskQueuePriorityScore(task)}).`);
        await saveTask(task);
        return {
            outcome: "reactivated_existing_task",
            reason: `Re-enqueued existing task ${task.id} by task id.`,
            task,
            duplicate_of_task_id: task.id,
        };
    }
    const duplicates = findExactHostDuplicateTasks({
        tasks,
        promotedHostname: promotedProfile.hostname,
        targetHostname,
        excludeTaskId: args.taskId,
    });
    if (duplicates.length > 0) {
        const duplicateWithSamePayload = duplicates.find((task) => shouldReuseExactHostDuplicateTask({
            task,
            targetUrl: args.targetUrl,
            promotedProfile,
            submitterEmailBase: args.submitterEmailBase,
            confirmSubmit: args.confirmSubmit,
            flowFamily: args.flowFamily,
        }));
        if (duplicateWithSamePayload) {
            if (duplicateWithSamePayload.status === "DONE") {
                duplicateWithSamePayload.notes.push(`Blocked duplicate enqueue for exact host ${targetHostname}; task ${duplicateWithSamePayload.id} already completed this promoted profile.`);
                await saveTask(duplicateWithSamePayload);
                return {
                    outcome: "blocked_duplicate_task",
                    reason: `Blocked duplicate enqueue because ${duplicateWithSamePayload.id} already finished this exact host.`,
                    task: duplicateWithSamePayload,
                    duplicate_of_task_id: duplicateWithSamePayload.id,
                };
            }
            if (duplicateWithSamePayload.status === "RUNNING" ||
                duplicateWithSamePayload.status === "READY" ||
                duplicateWithSamePayload.status === "WAITING_EXTERNAL_EVENT" ||
                duplicateWithSamePayload.status === "WAITING_SITE_RESPONSE" ||
                duplicateWithSamePayload.status === "WAITING_MANUAL_AUTH" ||
                duplicateWithSamePayload.status === "WAITING_MISSING_INPUT" ||
                duplicateWithSamePayload.status === "WAITING_POLICY_DECISION") {
                applyTargetPreflightToTask({ task: duplicateWithSamePayload, historicalTasks: tasks, now });
                duplicateWithSamePayload.notes.push(`Reused existing exact-host task ${duplicateWithSamePayload.id} instead of opening a parallel queue entry for ${targetHostname}.`);
                await saveTask(duplicateWithSamePayload);
                return {
                    outcome: "reused_existing_task",
                    reason: `Reused existing task ${duplicateWithSamePayload.id} for the same promoted host + exact target host.`,
                    task: duplicateWithSamePayload,
                    duplicate_of_task_id: duplicateWithSamePayload.id,
                };
            }
            const reactivatedEquivalentTask = buildReenqueuedTaskFromExisting({
                existingTask: duplicateWithSamePayload,
                targetUrl: args.targetUrl,
                promotedProfile,
                submitterEmailBase: args.submitterEmailBase,
                confirmSubmit: args.confirmSubmit,
                flowFamily: args.flowFamily,
                enqueuedBy: args.enqueuedBy,
                historicalTasks: tasks,
                now,
                preserveExistingFlowFamilyWhenOmitted: false,
            });
            reactivatedEquivalentTask.notes.push(`Reactivated equivalent exact-host task ${reactivatedEquivalentTask.id} instead of opening a parallel queue entry for ${targetHostname} (score ${getTaskQueuePriorityScore(reactivatedEquivalentTask)}).`);
            await saveTask(reactivatedEquivalentTask);
            return {
                outcome: "reactivated_existing_task",
                reason: `Reactivated equivalent task ${reactivatedEquivalentTask.id} for the same promoted host + exact target host.`,
                task: reactivatedEquivalentTask,
                duplicate_of_task_id: reactivatedEquivalentTask.id,
            };
        }
        const runningPayloadConflict = duplicates.find((task) => task.status === "RUNNING" &&
            !shouldReuseExactHostDuplicateTask({
                task,
                targetUrl: args.targetUrl,
                promotedProfile,
                submitterEmailBase: args.submitterEmailBase,
                confirmSubmit: args.confirmSubmit,
                flowFamily: args.flowFamily,
            }));
        const duplicateTask = duplicates.find((task) => task.status !== "DONE") ?? duplicates[0];
        if (runningPayloadConflict) {
            runningPayloadConflict.notes.push(`Blocked duplicate enqueue for exact host ${targetHostname}; running task ${runningPayloadConflict.id} has a different authoritative payload and cannot be overwritten while running.`);
            await saveTask(runningPayloadConflict);
            return {
                outcome: "blocked_duplicate_task",
                reason: `Blocked duplicate enqueue because running task ${runningPayloadConflict.id} has a different authoritative payload.`,
                task: runningPayloadConflict,
                duplicate_of_task_id: runningPayloadConflict.id,
            };
        }
        if (duplicateTask.status === "READY" ||
            duplicateTask.status === "WAITING_EXTERNAL_EVENT" ||
            duplicateTask.status === "WAITING_SITE_RESPONSE" ||
            duplicateTask.status === "WAITING_MANUAL_AUTH" ||
            duplicateTask.status === "WAITING_MISSING_INPUT" ||
            duplicateTask.status === "WAITING_POLICY_DECISION") {
            const reactivatedTask = buildReenqueuedTaskFromExisting({
                existingTask: duplicateTask,
                targetUrl: args.targetUrl,
                promotedProfile,
                submitterEmailBase: args.submitterEmailBase,
                confirmSubmit: args.confirmSubmit,
                flowFamily: args.flowFamily,
                enqueuedBy: args.enqueuedBy,
                historicalTasks: tasks,
                now,
                preserveExistingFlowFamilyWhenOmitted: false,
            });
            reactivatedTask.notes.push(`Authoritative enqueue payload replaced existing exact-host task ${reactivatedTask.id}; target/submission/family changed and the task was reset to READY (score ${getTaskQueuePriorityScore(reactivatedTask)}).`);
            await saveTask(reactivatedTask);
            return {
                outcome: "reactivated_existing_task",
                reason: `Authoritatively updated existing task ${reactivatedTask.id} for the same promoted host + exact target host.`,
                task: reactivatedTask,
                duplicate_of_task_id: reactivatedTask.id,
            };
        }
        const reactivatedTask = buildReenqueuedTaskFromExisting({
            existingTask: duplicateTask,
            targetUrl: args.targetUrl,
            promotedProfile,
            submitterEmailBase: args.submitterEmailBase,
            confirmSubmit: args.confirmSubmit,
            flowFamily: args.flowFamily,
            enqueuedBy: args.enqueuedBy,
            historicalTasks: tasks,
            now,
            preserveExistingFlowFamilyWhenOmitted: false,
        });
        reactivatedTask.notes.push(`Reactivated exact-host duplicate ${reactivatedTask.id} instead of creating a new task (score ${getTaskQueuePriorityScore(reactivatedTask)}).`);
        await saveTask(reactivatedTask);
        return {
            outcome: "reactivated_existing_task",
            reason: `Reactivated existing task ${reactivatedTask.id} for the same promoted host + exact target host.`,
            task: reactivatedTask,
            duplicate_of_task_id: reactivatedTask.id,
        };
    }
    const task = buildTask({
        taskId: args.taskId,
        targetUrl: args.targetUrl,
        promotedProfile,
        submitterEmailBase: args.submitterEmailBase,
        confirmSubmit: args.confirmSubmit,
        flowFamily: args.flowFamily,
        enqueuedBy: args.enqueuedBy,
    });
    applyTargetPreflightToTask({ task, historicalTasks: tasks, now });
    task.notes.push(`Task was enqueued for the bounded single-site worker (score ${getTaskQueuePriorityScore(task)}).`);
    await saveTask(task);
    return {
        outcome: "accept_new_task",
        reason: `Accepted new task ${task.id}.`,
        task,
    };
}
export async function claimNextTask(args) {
    const { reapedTaskId } = await reapExpiredQueueState();
    const lane = args.lane ?? "active_any";
    const leaseGroup = resolveWorkerLeaseGroupForLane(lane);
    const activeLease = await loadWorkerLease(leaseGroup);
    if (activeLease && new Date(activeLease.expires_at).getTime() > Date.now()) {
        return {
            mode: "lease_held",
            lease: activeLease,
            reapedTaskId,
        };
    }
    if (leaseGroup === "active") {
        const browserOwnership = await loadBrowserOwnership();
        if (browserOwnership && new Date(browserOwnership.expires_at).getTime() > Date.now()) {
            return {
                mode: "lease_held",
                lease: {
                    task_id: browserOwnership.task_id,
                    owner: browserOwnership.owner,
                    acquired_at: browserOwnership.acquired_at,
                    expires_at: browserOwnership.expires_at,
                    group: leaseGroup,
                    lane,
                },
                reapedTaskId,
            };
        }
    }
    const runtimeIncident = await loadRuntimeIncident();
    if (runtimeIncident) {
        const recovery = await __testTryAutoRecoverRuntimeIncident(runtimeIncident.cdp_url);
        if (!recovery.recovered) {
            return {
                mode: "idle",
                reapedTaskId,
                runtime_incident: runtimeIncident,
            };
        }
    }
    const tasks = await listTasks();
    const scopedTasks = buildScopedTaskList(tasks, args.scope);
    const tasksToPark = args.scope ? scopedTasks : tasks;
    for (const task of tasksToPark) {
        if (parkExhaustedRetryableTask(task)) {
            await saveTask(task);
        }
    }
    const nextTask = pickNextTaskForLane(scopedTasks, lane);
    if (!nextTask) {
        return {
            mode: "idle",
            reapedTaskId,
        };
    }
    if (!nextTask.target_preflight || nextTask.queue_priority_score === undefined) {
        applyTargetPreflightToTask({ task: nextTask, historicalTasks: tasks });
    }
    const now = Date.now();
    const lease = {
        task_id: nextTask.id,
        owner: args.owner,
        acquired_at: new Date(now).toISOString(),
        expires_at: new Date(now + BOUNDED_WORKER_LEASE_TTL_MS).toISOString(),
        group: leaseGroup,
        lane,
        previous_status: nextTask.status,
        previous_wait: nextTask.wait,
        previous_terminal_class: nextTask.terminal_class,
        previous_skip_reason_code: nextTask.skip_reason_code,
    };
    nextTask.run_count += 1;
    updateTaskStatus(nextTask, "RUNNING");
    markTaskStageTimestamp(nextTask, "claimed_at", new Date(now).toISOString());
    nextTask.wait = undefined;
    nextTask.terminal_class = undefined;
    nextTask.skip_reason_code = undefined;
    nextTask.reactivation_cooldown_until = undefined;
    nextTask.reactivation_cooldown_reason = undefined;
    nextTask.lease_expires_at = lease.expires_at;
    nextTask.notes.push(`Claimed by ${args.owner} for ${lane} lane run (score ${getTaskQueuePriorityScore(nextTask)}).`);
    await saveTask(nextTask);
    await saveWorkerLease(lease, leaseGroup);
    return {
        mode: "claimed",
        task: nextTask,
        lease,
        reapedTaskId,
    };
}
