import { loadOrCreatePromotedProfile } from "../shared/promoted-profile.js";
import { getFamilyConfig, resolveFlowFamily } from "../families/index.js";
import { clearPendingFinalize, clearWorkerLease, ensureDataDirectories, listTasks, loadTask, loadWorkerLease, readJsonFile, saveTask, saveWorkerLease, } from "../memory/data-store.js";
import { loadBrowserOwnership, reapExpiredBrowserOwnership } from "../execution/ownership-lock.js";
import { BOUNDED_WORKER_LEASE_TTL_MS } from "../shared/runtime-budgets.js";
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
function buildTask(args) {
    const now = new Date().toISOString();
    return {
        id: args.taskId,
        target_url: args.targetUrl,
        hostname: new URL(args.targetUrl).hostname,
        flow_family: resolveFlowFamily(args.flowFamily),
        submission: {
            promoted_profile: args.promotedProfile,
            submitter_email: args.submitterEmailBase,
            confirm_submit: args.confirmSubmit,
        },
        status: "READY",
        created_at: now,
        updated_at: now,
        run_count: 0,
        escalation_level: "none",
        takeover_attempts: 0,
        phase_history: [],
        latest_artifacts: [],
        notes: [],
    };
}
function updateTaskStatus(task, status) {
    task.status = status;
    task.updated_at = new Date().toISOString();
}
function compareByCreatedAt(left, right) {
    return new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
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
async function reapExpiredWorkerLease() {
    const existingLease = await loadWorkerLease();
    if (!existingLease || new Date(existingLease.expires_at).getTime() > Date.now()) {
        return {};
    }
    await clearWorkerLease();
    await clearPendingFinalize(existingLease.task_id);
    const task = await loadTask(existingLease.task_id);
    if (!task) {
        return { reapedTaskId: existingLease.task_id };
    }
    task.lease_expires_at = undefined;
    task.wait = {
        wait_reason_code: "TASK_TIMEOUT",
        resume_trigger: "A previous bounded worker exceeded the 10 minute runtime lease and will be retried automatically.",
        resolution_owner: "system",
        resolution_mode: "auto_resume",
        evidence_ref: "data/backlink-helper/runtime/task-worker-lease.json",
    };
    task.terminal_class = "outcome_not_confirmed";
    task.notes.push("bounded worker timed out");
    updateTaskStatus(task, "RETRYABLE");
    await saveTask(task);
    return { reapedTaskId: task.id };
}
export async function reapExpiredQueueState() {
    await ensureDataDirectories();
    const { reapedTaskId } = await reapExpiredWorkerLease();
    const reapedBrowserOwnership = await reapExpiredBrowserOwnership();
    return {
        reapedTaskId,
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
    const existingTask = await loadTask(args.taskId);
    if (existingTask?.status === "RUNNING") {
        throw new Error(`Task ${args.taskId} is already RUNNING and cannot be re-enqueued.`);
    }
    const task = existingTask
        ? {
            ...existingTask,
            target_url: args.targetUrl,
            hostname: new URL(args.targetUrl).hostname,
            flow_family: resolveFlowFamily(args.flowFamily ?? existingTask.flow_family),
            submission: {
                promoted_profile: promotedProfile,
                submitter_email: args.submitterEmailBase,
                confirm_submit: args.confirmSubmit,
            },
            wait: undefined,
            skip_reason_code: undefined,
            terminal_class: undefined,
            lease_expires_at: undefined,
        }
        : buildTask({
            taskId: args.taskId,
            targetUrl: args.targetUrl,
            promotedProfile,
            submitterEmailBase: args.submitterEmailBase,
            confirmSubmit: args.confirmSubmit,
            flowFamily: args.flowFamily,
        });
    updateTaskStatus(task, "READY");
    task.notes.push("Task was enqueued for the bounded single-site worker.");
    await saveTask(task);
    return task;
}
export async function claimNextTask(args) {
    const { reapedTaskId } = await reapExpiredQueueState();
    const activeLease = await loadWorkerLease();
    if (activeLease && new Date(activeLease.expires_at).getTime() > Date.now()) {
        return {
            mode: "lease_held",
            lease: activeLease,
            reapedTaskId,
        };
    }
    const browserOwnership = await loadBrowserOwnership();
    if (browserOwnership && new Date(browserOwnership.expires_at).getTime() > Date.now()) {
        return {
            mode: "lease_held",
            lease: {
                task_id: browserOwnership.task_id,
                owner: browserOwnership.owner,
                acquired_at: browserOwnership.acquired_at,
                expires_at: browserOwnership.expires_at,
            },
            reapedTaskId,
        };
    }
    const tasks = await listTasks();
    const scopedTasks = buildScopedTaskList(tasks, args.scope);
    const tasksToPark = args.scope ? scopedTasks : tasks;
    for (const task of tasksToPark) {
        if (parkExhaustedRetryableTask(task)) {
            await saveTask(task);
        }
    }
    const readyTasks = scopedTasks
        .filter((task) => task.status === "READY")
        .sort(compareByCreatedAt);
    const retryableTasks = scopedTasks
        .filter(canRetry)
        .sort(compareByCreatedAt);
    const nextTask = readyTasks[0] ?? retryableTasks[0];
    if (!nextTask) {
        return {
            mode: "idle",
            reapedTaskId,
        };
    }
    const now = Date.now();
    const lease = {
        task_id: nextTask.id,
        owner: args.owner,
        acquired_at: new Date(now).toISOString(),
        expires_at: new Date(now + BOUNDED_WORKER_LEASE_TTL_MS).toISOString(),
    };
    nextTask.run_count += 1;
    updateTaskStatus(nextTask, "RUNNING");
    nextTask.wait = undefined;
    nextTask.terminal_class = undefined;
    nextTask.skip_reason_code = undefined;
    nextTask.reactivation_cooldown_until = undefined;
    nextTask.reactivation_cooldown_reason = undefined;
    nextTask.lease_expires_at = lease.expires_at;
    nextTask.notes.push(`Claimed by ${args.owner} for a bounded worker run.`);
    await saveTask(nextTask);
    await saveWorkerLease(lease);
    return {
        mode: "claimed",
        task: nextTask,
        lease,
        reapedTaskId,
    };
}
