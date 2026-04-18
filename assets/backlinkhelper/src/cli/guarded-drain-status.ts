import { loadBrowserOwnership } from "../execution/ownership-lock.js";
import { listTasks, loadWorkerLease } from "../memory/data-store.js";
import { canRetry, matchesTaskScope, reapExpiredQueueState } from "../control-plane/task-queue.js";
import { probeRuntimeHealth } from "../shared/runtime-health.js";
import { summarizeBusinessOutcomes } from "../shared/business-outcomes.js";

interface RunGuardedDrainStatusCommandArgs {
  cdpUrl?: string;
  taskIdPrefix?: string;
  promotedHostname?: string;
  promotedUrl?: string;
}

export async function runGuardedDrainStatusCommand(
  args: RunGuardedDrainStatusCommandArgs,
): Promise<void> {
  const scope = {
    taskIdPrefix: args.taskIdPrefix,
    promotedHostname: args.promotedHostname,
    promotedUrl: args.promotedUrl,
  };
  const repair = await reapExpiredQueueState();
  const runtimeHealth = await probeRuntimeHealth(args.cdpUrl);
  const tasks = (await listTasks()).filter((task) => matchesTaskScope(task, scope));

  const statusCounts: Record<string, number> = {};
  const waitReasonCounts: Record<string, number> = {};
  for (const task of tasks) {
    statusCounts[task.status] = (statusCounts[task.status] ?? 0) + 1;
    const waitReason = task.wait?.wait_reason_code;
    if (waitReason) {
      waitReasonCounts[waitReason] = (waitReasonCounts[waitReason] ?? 0) + 1;
    }
  }
  const businessOutcomes = summarizeBusinessOutcomes(tasks);

  const waitReasonTop = Object.entries(waitReasonCounts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count }));
  const repeatFailureHostTop = Object.entries(
    tasks.reduce<Record<string, number>>((acc, task) => {
      if (
        task.wait?.wait_reason_code === "REACTIVATION_COOLDOWN" ||
        task.wait?.wait_reason_code === "REPEATED_FAILURE_REVIEW_REQUIRED"
      ) {
        acc[task.hostname] = (acc[task.hostname] ?? 0) + 1;
      }
      return acc;
    }, {}),
  )
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 10)
    .map(([hostname, count]) => ({ hostname, count }));

  const activeLease = await loadWorkerLease();
  const browserOwnership = await loadBrowserOwnership();
  const blockers: string[] = [];
  if (!runtimeHealth.healthy) {
    blockers.push(runtimeHealth.summary);
  }

  console.log(
    JSON.stringify(
      {
        ok: blockers.length === 0,
        scope,
        runtime_health: runtimeHealth,
        repair,
        active_lease:
          activeLease && new Date(activeLease.expires_at).getTime() > Date.now() ? activeLease : undefined,
        browser_ownership:
          browserOwnership && new Date(browserOwnership.expires_at).getTime() > Date.now()
            ? browserOwnership
            : undefined,
        totals: {
          tasks: tasks.length,
          ready: tasks.filter((task) => task.status === "READY").length,
          retryable: tasks.filter((task) => task.status === "RETRYABLE").length,
          retryable_eligible_now: tasks.filter(canRetry).length,
          waiting_retry_decision: tasks.filter((task) => task.status === "WAITING_RETRY_DECISION").length,
          waiting_site_response: tasks.filter((task) => task.status === "WAITING_SITE_RESPONSE").length,
          reactivation_cooldown: tasks.filter((task) => task.wait?.wait_reason_code === "REACTIVATION_COOLDOWN").length,
          repeated_failure_review: tasks.filter((task) => task.wait?.wait_reason_code === "REPEATED_FAILURE_REVIEW_REQUIRED").length,
          successful_submissions: businessOutcomes.successful_submissions,
          business_complete_rate: businessOutcomes.business_complete_rate,
        },
        status_counts: statusCounts,
        business_outcome_counts: businessOutcomes.counts,
        success_breakdown: businessOutcomes.success_breakdown,
        wait_reason_top: waitReasonTop,
        repeat_failure_host_top: repeatFailureHostTop,
        blockers,
      },
      null,
      2,
    ),
  );
}
