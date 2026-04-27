import { loadBrowserOwnership } from "../execution/ownership-lock.js";
import { listTasks, loadAllWorkerLeases, readJsonFile } from "../memory/data-store.js";
import { buildTaskLaneReport, canRetry, matchesTaskScope, reapExpiredQueueState } from "../control-plane/task-queue.js";
import { probeRuntimeHealth, type BrowserTargetHealth, type RuntimeHealthSummary } from "../shared/runtime-health.js";
import type { RuntimeRecoveryAttempt } from "../shared/runtime-sanitize.js";
import { buildBusinessOutcomeReport } from "../shared/business-outcomes.js";
import type { TaskRecord, WorkerLease } from "../shared/types.js";

interface RunGuardedDrainStatusCommandArgs {
  cdpUrl?: string;
  taskIdPrefix?: string;
  promotedHostname?: string;
  promotedUrl?: string;
}

interface GuardedDrainStatusScope {
  taskIdPrefix?: string;
  promotedHostname?: string;
  promotedUrl?: string;
}

interface FollowUpArtifactSnapshot {
  previous_status?: TaskRecord["status"];
  evaluation?: {
    action?: string;
    continuation?: TaskRecord["email_verification_continuation"];
    linkVerification?: TaskRecord["link_verification"];
  };
}

export interface FollowUpOutcomeReport {
  totals: {
    magic_link_ready: number;
    verification_code_ready: number;
    site_response_verified: number;
    site_response_still_waiting: number;
  };
}

export interface GuardedDrainSystemStatusReport {
  totals: {
    tasks: number;
    ready: number;
    retryable: number;
    retryable_eligible_now: number;
    waiting_retry_decision: number;
    waiting_site_response: number;
    reactivation_cooldown: number;
    repeated_failure_review: number;
  };
  status_counts: Record<string, number>;
  wait_reason_top: Array<{ reason: string; count: number }>;
  repeat_failure_host_top: Array<{ hostname: string; count: number }>;
  latest_claim_timing: {
    samples: number;
    avg_total_minutes: number;
    avg_queue_or_cooldown_minutes: number;
    avg_latest_claim_execution_minutes: number;
    max_latest_claim_execution_minutes: number;
  };
}

export interface GuardedDrainRuntimeObservabilityReport {
  circuit_breaker_open: boolean;
  incident?: RuntimeHealthSummary["runtime_incident"];
  browser_target_health?: BrowserTargetHealth;
  last_recovery_attempt?: RuntimeRecoveryAttempt;
  recent_recovery_attempts: RuntimeRecoveryAttempt[];
}

export interface GuardedDrainStatusPayload {
  ok: boolean;
  scope: GuardedDrainStatusScope;
  runtime_health: RuntimeHealthSummary;
  runtime_observability: GuardedDrainRuntimeObservabilityReport;
  repair: unknown;
  report_default_view: "business_outcome";
  business_report: ReturnType<typeof buildBusinessOutcomeReport>;
  lane_report: ReturnType<typeof buildTaskLaneReport>;
  follow_up_report: FollowUpOutcomeReport;
  system_status_report: GuardedDrainSystemStatusReport;
  worker_leases: {
    active?: WorkerLease;
    follow_up?: WorkerLease;
  };
  browser_ownership?: unknown;
  blockers: string[];
}

function roundMinutes(value: number): number {
  return Number(value.toFixed(2));
}

function buildLatestClaimTimingReport(tasks: TaskRecord[]): GuardedDrainSystemStatusReport["latest_claim_timing"] {
  const samples = tasks
    .map((task) => {
      const createdAt = new Date(task.created_at).getTime();
      const updatedAt = new Date(task.updated_at).getTime();
      const claimedAt = task.stage_timestamps?.claimed_at
        ? new Date(task.stage_timestamps.claimed_at).getTime()
        : Number.NaN;
      if (![createdAt, updatedAt, claimedAt].every(Number.isFinite)) {
        return undefined;
      }
      const totalMs = Math.max(0, updatedAt - createdAt);
      const latestClaimExecutionMs = Math.max(0, updatedAt - claimedAt);
      return {
        totalMinutes: totalMs / 60_000,
        latestClaimExecutionMinutes: latestClaimExecutionMs / 60_000,
        queueOrCooldownMinutes: Math.max(0, totalMs - latestClaimExecutionMs) / 60_000,
      };
    })
    .filter((sample): sample is {
      totalMinutes: number;
      latestClaimExecutionMinutes: number;
      queueOrCooldownMinutes: number;
    } => Boolean(sample));

  if (samples.length === 0) {
    return {
      samples: 0,
      avg_total_minutes: 0,
      avg_queue_or_cooldown_minutes: 0,
      avg_latest_claim_execution_minutes: 0,
      max_latest_claim_execution_minutes: 0,
    };
  }

  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  return {
    samples: samples.length,
    avg_total_minutes: roundMinutes(sum(samples.map((sample) => sample.totalMinutes)) / samples.length),
    avg_queue_or_cooldown_minutes: roundMinutes(sum(samples.map((sample) => sample.queueOrCooldownMinutes)) / samples.length),
    avg_latest_claim_execution_minutes: roundMinutes(sum(samples.map((sample) => sample.latestClaimExecutionMinutes)) / samples.length),
    max_latest_claim_execution_minutes: roundMinutes(Math.max(...samples.map((sample) => sample.latestClaimExecutionMinutes))),
  };
}

function buildSystemStatusReport(tasks: TaskRecord[]): GuardedDrainSystemStatusReport {
  const statusCounts: Record<string, number> = {};
  const waitReasonCounts: Record<string, number> = {};
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
    latest_claim_timing: buildLatestClaimTimingReport(tasks),
  };
}

function emptyFollowUpOutcomeReport(): FollowUpOutcomeReport {
  return {
    totals: {
      magic_link_ready: 0,
      verification_code_ready: 0,
      site_response_verified: 0,
      site_response_still_waiting: 0,
    },
  };
}

export function buildFollowUpOutcomeReport(snapshots: FollowUpArtifactSnapshot[]): FollowUpOutcomeReport {
  const report = emptyFollowUpOutcomeReport();

  for (const snapshot of snapshots) {
    if (snapshot.previous_status === "WAITING_EXTERNAL_EVENT" && snapshot.evaluation?.action === "activate_ready") {
      if (snapshot.evaluation.continuation?.kind === "magic_link") {
        report.totals.magic_link_ready += 1;
      } else if (snapshot.evaluation.continuation?.kind === "verification_code") {
        report.totals.verification_code_ready += 1;
      }
      continue;
    }

    if (snapshot.previous_status === "WAITING_SITE_RESPONSE") {
      if (snapshot.evaluation?.action === "complete_done") {
        report.totals.site_response_verified += 1;
      } else if (
        snapshot.evaluation?.action === "restore_waiting" &&
        snapshot.evaluation.linkVerification?.verification_status === "link_missing"
      ) {
        report.totals.site_response_still_waiting += 1;
      }
    }
  }

  return report;
}

async function loadLatestFollowUpSnapshots(tasks: TaskRecord[]): Promise<FollowUpArtifactSnapshot[]> {
  const snapshots: FollowUpArtifactSnapshot[] = [];

  for (const task of tasks) {
    const artifactPath = [...task.latest_artifacts].reverse().find((entry) => entry.includes("follow-up"));
    if (!artifactPath) {
      continue;
    }
    const artifact = await readJsonFile<{
      stage?: string;
      previous_status?: TaskRecord["status"];
      evaluation?: FollowUpArtifactSnapshot["evaluation"];
    }>(artifactPath);
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

function buildRuntimeObservabilityReport(runtimeHealth: RuntimeHealthSummary): GuardedDrainRuntimeObservabilityReport {
  const recentRecoveryAttempts = runtimeHealth.recovery_status?.recent_attempts.slice(0, 5) ?? [];
  return {
    circuit_breaker_open: Boolean(runtimeHealth.runtime_incident),
    incident: runtimeHealth.runtime_incident,
    browser_target_health: runtimeHealth.browser_state,
    last_recovery_attempt: runtimeHealth.recovery_status?.last_attempt,
    recent_recovery_attempts: recentRecoveryAttempts,
  };
}

export function buildGuardedDrainStatusPayload(args: {
  scope: GuardedDrainStatusScope;
  runtimeHealth: RuntimeHealthSummary;
  repair: unknown;
  tasks: TaskRecord[];
  activeLease?: WorkerLease;
  followUpLease?: WorkerLease;
  followUpReport: FollowUpOutcomeReport;
  browserOwnership?: unknown;
  blockers: string[];
}): GuardedDrainStatusPayload {
  return {
    ok: args.blockers.length === 0,
    scope: args.scope,
    runtime_health: args.runtimeHealth,
    runtime_observability: buildRuntimeObservabilityReport(args.runtimeHealth),
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
  const followUpSnapshots = await loadLatestFollowUpSnapshots(tasks);

  const workerLeases = await loadAllWorkerLeases();
  const browserOwnership = await loadBrowserOwnership();
  const blockers: string[] = [];
  if (!runtimeHealth.healthy) {
    blockers.push(runtimeHealth.summary);
  }

  const isLiveLease = (lease?: WorkerLease): lease is WorkerLease =>
    Boolean(lease && new Date(lease.expires_at).getTime() > Date.now());

  const payload = buildGuardedDrainStatusPayload({
    scope,
    runtimeHealth,
    repair,
    tasks,
    activeLease: isLiveLease(workerLeases.active) ? workerLeases.active : undefined,
    followUpLease: isLiveLease(workerLeases.follow_up) ? workerLeases.follow_up : undefined,
    followUpReport: buildFollowUpOutcomeReport(followUpSnapshots),
    browserOwnership:
      browserOwnership && new Date(browserOwnership.expires_at).getTime() > Date.now()
        ? browserOwnership
        : undefined,
    blockers,
  });

  console.log(JSON.stringify(payload, null, 2));
}
