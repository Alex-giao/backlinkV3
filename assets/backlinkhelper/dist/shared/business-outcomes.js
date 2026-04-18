import { getFamilyConfig } from "../families/index.js";
const BUSINESS_OUTCOME_KEYS = [
    "submitted_success",
    "skipped_terminal",
    "blocked_missing_input",
    "blocked_manual_auth",
    "blocked_policy",
    "active_queue",
    "retryable_runtime_or_evidence",
    "unknown_needs_review",
];
function emptyCounts() {
    return Object.fromEntries(BUSINESS_OUTCOME_KEYS.map((key) => [key, 0]));
}
export function deriveBusinessOutcome(task) {
    const familyConfig = getFamilyConfig(task.flow_family);
    const requiresLiveVerification = familyConfig.semanticContract.requires_live_link_verification_for_success;
    const hasVerifiedLiveLink = task.link_verification?.verification_status === "verified_link_present";
    if (task.status === "DONE" || task.status === "WAITING_SITE_RESPONSE") {
        return !requiresLiveVerification || hasVerifiedLiveLink ? "submitted_success" : "unknown_needs_review";
    }
    if (task.status === "WAITING_EXTERNAL_EVENT" &&
        task.wait?.wait_reason_code === "EMAIL_VERIFICATION_PENDING") {
        return !requiresLiveVerification || hasVerifiedLiveLink ? "submitted_success" : "unknown_needs_review";
    }
    if (task.status === "WAITING_MISSING_INPUT") {
        return "blocked_missing_input";
    }
    if (task.status === "WAITING_MANUAL_AUTH") {
        return "blocked_manual_auth";
    }
    if (task.status === "WAITING_POLICY_DECISION") {
        return "blocked_policy";
    }
    if (task.status === "SKIPPED") {
        return "skipped_terminal";
    }
    if (task.status === "READY" || task.status === "RUNNING") {
        return "active_queue";
    }
    if (task.status === "RETRYABLE") {
        return "retryable_runtime_or_evidence";
    }
    return "unknown_needs_review";
}
export function summarizeBusinessOutcomes(tasks) {
    const counts = emptyCounts();
    const successBreakdown = {
        done: 0,
        waiting_site_response: 0,
        waiting_external_event_email_verification: 0,
    };
    for (const task of tasks) {
        const businessOutcome = deriveBusinessOutcome(task);
        counts[businessOutcome] += 1;
        if (task.status === "DONE") {
            successBreakdown.done += 1;
        }
        else if (task.status === "WAITING_SITE_RESPONSE") {
            successBreakdown.waiting_site_response += 1;
        }
        else if (task.status === "WAITING_EXTERNAL_EVENT" &&
            task.wait?.wait_reason_code === "EMAIL_VERIFICATION_PENDING") {
            successBreakdown.waiting_external_event_email_verification += 1;
        }
    }
    const successfulSubmissions = counts.submitted_success;
    const businessCompleteRate = tasks.length > 0 ? successfulSubmissions / tasks.length : 0;
    return {
        counts,
        successful_submissions: successfulSubmissions,
        business_complete_rate: Number(businessCompleteRate.toFixed(4)),
        success_breakdown: successBreakdown,
    };
}
