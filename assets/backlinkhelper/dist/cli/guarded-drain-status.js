import { loadBrowserOwnership } from "../execution/ownership-lock.js";
import { listTasks, loadAllWorkerLeases, readJsonFile } from "../memory/data-store.js";
import { buildTaskLaneReport, canRetry, matchesTaskScope, reapExpiredQueueState } from "../control-plane/task-queue.js";
import { probeRuntimeHealth } from "../shared/runtime-health.js";
import { buildBusinessOutcomeReport } from "../shared/business-outcomes.js";
function buildSystemStatusReport(tasks) {
    const statusCounts = {};
    const waitReasonCounts = {};
    for (const task of tasks) {
        statusCounts[task.status] = (statusCounts[task.status] ?? 0) + 1;
        const waitReason = task.wait?.wait_reason_code;
        if (waitReason) {
            waitReasonCounts[waitReason] = (waitReasonCounts[waitReason] ?? 0) + 1;
        }
    }
    const waitReasonTop = Object.entries(waitReasonCounts)
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 10)
        .map(([reason, count]) => ({ reason, count }));
    const repeatFailureHostTop = Object.entries(tasks.reduce((acc, task) => {
        if (task.wait?.wait_reason_code === "REACTIVATION_COOLDOWN" ||
            task.wait?.wait_reason_code === "REPEATED_FAILURE_REVIEW_REQUIRED") {
            acc[task.hostname] = (acc[task.hostname] ?? 0) + 1;
        }
        return acc;
    }, {}))
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 10)
        .map(([hostname, count]) => ({ hostname, count }));
    return {
        totals: {
            tasks: tasks.length,
            ready: tasks.filter((task) => task.status === "READY").length,
            retryable: tasks.filter((task) => task.status === "RETRYABLE").length,
            retryable_eligible_now: tasks.filter(canRetry).length,
            waiting_retry_decision: tasks.filter((task) => task.status === "WAITING_RETRY_DECISION").length,
            waiting_site_response: tasks.filter((task) => task.status === "WAITING_SITE_RESPONSE").length,
            reactivation_cooldown: tasks.filter((task) => task.wait?.wait_reason_code === "REACTIVATION_COOLDOWN").length,
            repeated_failure_review: tasks.filter((task) => task.wait?.wait_reason_code === "REPEATED_FAILURE_REVIEW_REQUIRED").length,
        },
        status_counts: statusCounts,
        wait_reason_top: waitReasonTop,
        repeat_failure_host_top: repeatFailureHostTop,
    };
}
function emptyFollowUpOutcomeReport() {
    return {
        totals: {
            magic_link_ready: 0,
            verification_code_ready: 0,
            site_response_verified: 0,
            site_response_still_waiting: 0,
        },
    };
}
export function buildFollowUpOutcomeReport(snapshots) {
    const report = emptyFollowUpOutcomeReport();
    for (const snapshot of snapshots) {
        if (snapshot.previous_status === "WAITING_EXTERNAL_EVENT" && snapshot.evaluation?.action === "activate_ready") {
            if (snapshot.evaluation.continuation?.kind === "magic_link") {
                report.totals.magic_link_ready += 1;
            }
            else if (snapshot.evaluation.continuation?.kind === "verification_code") {
                report.totals.verification_code_ready += 1;
            }
            continue;
        }
        if (snapshot.previous_status === "WAITING_SITE_RESPONSE") {
            if (snapshot.evaluation?.action === "complete_done") {
                report.totals.site_response_verified += 1;
            }
            else if (snapshot.evaluation?.action === "restore_waiting" &&
                snapshot.evaluation.linkVerification?.verification_status === "link_missing") {
                report.totals.site_response_still_waiting += 1;
            }
        }
    }
    return report;
}
async function loadLatestFollowUpSnapshots(tasks) {
    const snapshots = [];
    for (const task of tasks) {
        const artifactPath = [...task.latest_artifacts].reverse().find((entry) => entry.includes("follow-up"));
        if (!artifactPath) {
            continue;
        }
        const artifact = await readJsonFile(artifactPath);
        if (!artifact || artifact.stage !== "follow_up") {
            continue;
        }
        snapshots.push({
            previous_status: artifact.previous_status,
            evaluation: artifact.evaluation,
        });
    }
    return snapshots;
}
export function buildGuardedDrainStatusPayload(args) {
    return {
        ok: args.blockers.length === 0,
        scope: args.scope,
        runtime_health: args.runtimeHealth,
        repair: args.repair,
        report_default_view: "business_outcome",
        business_report: buildBusinessOutcomeReport(args.tasks),
        lane_report: buildTaskLaneReport(args.tasks),
        follow_up_report: args.followUpReport,
        system_status_report: buildSystemStatusReport(args.tasks),
        worker_leases: {
            active: args.activeLease,
            follow_up: args.followUpLease,
        },
        browser_ownership: args.browserOwnership,
        blockers: args.blockers,
    };
}
export async function runGuardedDrainStatusCommand(args) {
    const scope = {
        taskIdPrefix: args.taskIdPrefix,
        promotedHostname: args.promotedHostname,
        promotedUrl: args.promotedUrl,
    };
    const repair = await reapExpiredQueueState();
    const runtimeHealth = await probeRuntimeHealth(args.cdpUrl);
    const tasks = (await listTasks()).filter((task) => matchesTaskScope(task, scope));
    const followUpSnapshots = await loadLatestFollowUpSnapshots(tasks);
    const workerLeases = await loadAllWorkerLeases();
    const browserOwnership = await loadBrowserOwnership();
    const blockers = [];
    if (!runtimeHealth.healthy) {
        blockers.push(runtimeHealth.summary);
    }
    const isLiveLease = (lease) => Boolean(lease && new Date(lease.expires_at).getTime() > Date.now());
    const payload = buildGuardedDrainStatusPayload({
        scope,
        runtimeHealth,
        repair,
        tasks,
        activeLease: isLiveLease(workerLeases.active) ? workerLeases.active : undefined,
        followUpLease: isLiveLease(workerLeases.follow_up) ? workerLeases.follow_up : undefined,
        followUpReport: buildFollowUpOutcomeReport(followUpSnapshots),
        browserOwnership: browserOwnership && new Date(browserOwnership.expires_at).getTime() > Date.now()
            ? browserOwnership
            : undefined,
        blockers,
    });
    console.log(JSON.stringify(payload, null, 2));
}
