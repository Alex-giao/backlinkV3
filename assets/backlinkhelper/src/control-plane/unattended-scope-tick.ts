import { enqueueSiteTask } from "./task-queue.js";
import {
  canRetry,
  claimNextTask,
  matchesTaskScope,
  pickNextTaskForLane,
  resolveWorkerLeaseGroupForLane,
  type TaskScopeFilter,
} from "./task-queue.js";
import { buildTargetPreflightAssessment } from "./target-preflight.js";
import { classifyTargetSurfaceForIntake, type TargetSurfaceIntakeClassification } from "../families/classifier.js";
import { loadBrowserOwnership } from "../execution/ownership-lock.js";
import {
  ensureDataDirectories,
  listTargetSites,
  listTasks,
  loadWorkerLease,
  upsertTargetSite,
  type TargetSiteRecord,
} from "../memory/data-store.js";
import { loadRuntimeIncident } from "../shared/runtime-incident.js";
import type { ClaimLane, FlowFamily, TaskRecord, WorkerLease } from "../shared/types.js";

export type UnattendedScopeTickAction =
  | "claimed"
  | "enqueued"
  | "blocked"
  | "cooldown"
  | "no_candidate"
  | "needs_classification"
  | "needs_manual_boundary";

export interface UnattendedScopeTickArgs {
  owner: string;
  taskIdPrefix?: string;
  promotedHostname?: string;
  promotedUrl?: string;
  promotedName?: string;
  promotedDescription?: string;
  submitterEmailBase?: string;
  confirmSubmit?: boolean;
  flowFamily?: FlowFamily;
  lane?: ClaimLane;
  candidateLimit?: number;
  dryRun?: boolean;
}

export interface CandidateIntakePreview {
  target_url: string;
  hostname: string;
  source: string;
  flow_family_hint?: FlowFamily;
  queue_priority_score: number;
  viability: string;
}

export interface UnattendedScopeTickResult {
  action: UnattendedScopeTickAction;
  scope: TaskScopeFilter;
  detail: string;
  reapedTaskId?: string;
  task?: TaskRecord;
  lease?: WorkerLease;
  candidate?: CandidateIntakePreview;
  enqueue_outcome?: string;
  runtime_incident?: unknown;
  dry_run?: boolean;
  counts?: {
    scoped_tasks: number;
    candidate_pool: number;
    safe_candidates: number;
  };
}

function normalizeHostname(hostname?: string): string | undefined {
  return hostname?.trim().replace(/^www\./i, "").toLowerCase() || undefined;
}

function hostnameFromUrl(rawUrl?: string): string | undefined {
  if (!rawUrl) {
    return undefined;
  }
  try {
    return normalizeHostname(new URL(rawUrl).hostname);
  } catch {
    return undefined;
  }
}

function buildScope(args: UnattendedScopeTickArgs): TaskScopeFilter {
  return {
    taskIdPrefix: args.taskIdPrefix,
    promotedHostname: normalizeHostname(args.promotedHostname) ?? hostnameFromUrl(args.promotedUrl),
    promotedUrl: args.promotedUrl,
  };
}

function isHttpTargetSite(site: TargetSiteRecord): boolean {
  try {
    const parsed = new URL(site.target_url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isSmokeTargetSite(site: TargetSiteRecord): boolean {
  return site.source === "db-smoke" || site.payload?.smoke === true;
}

function hasLiveManualBoundary(tasks: TaskRecord[]): boolean {
  return tasks.some((task) =>
    task.status === "WAITING_MANUAL_AUTH" ||
    task.status === "WAITING_POLICY_DECISION" ||
    task.status === "WAITING_MISSING_INPUT",
  );
}

function isCoolingDown(tasks: TaskRecord[]): boolean {
  const now = Date.now();
  return tasks.some((task) => {
    if (task.status !== "RETRYABLE") {
      return false;
    }
    if (canRetry(task)) {
      return false;
    }
    const cooldownUntil = task.reactivation_cooldown_until
      ? new Date(task.reactivation_cooldown_until).getTime()
      : undefined;
    return task.wait?.wait_reason_code === "REACTIVATION_COOLDOWN" ||
      (cooldownUntil !== undefined && cooldownUntil > now) ||
      new Date(task.updated_at).getTime() > now - 60 * 60 * 1_000;
  });
}

function buildTaskId(args: { prefix?: string; index: number; targetUrl: string }): string {
  const hostname = new URL(args.targetUrl).hostname.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${args.prefix ?? "unattended"}-${String(args.index).padStart(4, "0")}-${hostname}`.slice(0, 120);
}

function classifyCandidateSurface(args: {
  site: TargetSiteRecord;
  flowFamily?: FlowFamily;
}): TargetSurfaceIntakeClassification {
  return classifyTargetSurfaceForIntake({
    targetUrl: args.site.target_url,
    requestedFlowFamily: requestedFlowFamilyForCandidate(args),
  });
}

function requestedFlowFamilyForCandidate(args: { site: TargetSiteRecord; flowFamily?: FlowFamily }): FlowFamily | undefined {
  if (args.flowFamily) {
    return args.flowFamily;
  }
  // Older CSV imports may have stored an inferred family in flow_family_hint.
  // Treat the payload provenance as authoritative so later intake does not
  // convert inferred URL evidence into an explicit operator hint.
  return args.site.payload?.flow_family_source === "inferred" ? undefined : args.site.flow_family_hint;
}

function previewCandidate(args: {
  site: TargetSiteRecord;
  promotedHostname: string;
  historicalTasks: TaskRecord[];
  surface: TargetSurfaceIntakeClassification;
}): CandidateIntakePreview {
  const assessment = buildTargetPreflightAssessment({
    targetUrl: args.site.target_url,
    promotedHostname: args.promotedHostname,
    flowFamily: args.surface.flowFamily,
    historicalTasks: args.historicalTasks,
  });
  return {
    target_url: args.site.target_url,
    hostname: args.site.hostname,
    source: args.site.source,
    flow_family_hint: args.surface.flowFamily,
    queue_priority_score: assessment.queue_priority_score,
    viability: assessment.viability,
  };
}

function representedTargetHostsForScope(args: {
  historicalTasks: TaskRecord[];
  promotedHostname: string;
}): Set<string> {
  return new Set(
    args.historicalTasks
      .filter((task) => normalizeHostname(task.submission.promoted_profile.hostname) === args.promotedHostname)
      .map((task) => normalizeHostname(task.hostname))
      .filter((hostname): hostname is string => Boolean(hostname)),
  );
}

function baseCandidateRows(args: {
  candidates: TargetSiteRecord[];
  historicalTasks: TaskRecord[];
  promotedHostname: string;
}): Array<{ site: TargetSiteRecord; index: number }> {
  const representedTargetHosts = representedTargetHostsForScope({
    historicalTasks: args.historicalTasks,
    promotedHostname: args.promotedHostname,
  });

  return args.candidates
    .map((site, index) => ({ site, index }))
    .filter(({ site }) => site.submit_status === "candidate")
    .filter(({ site }) => !isSmokeTargetSite(site))
    .filter(({ site }) => isHttpTargetSite(site))
    .filter(({ site }) => normalizeHostname(site.hostname) !== args.promotedHostname)
    .filter(({ site }) => !representedTargetHosts.has(normalizeHostname(site.hostname) ?? ""));
}

function pickNeedsClassificationCandidate(args: {
  candidates: TargetSiteRecord[];
  historicalTasks: TaskRecord[];
  promotedHostname: string;
  flowFamily?: FlowFamily;
}): { site: TargetSiteRecord; surface: TargetSurfaceIntakeClassification; index: number } | undefined {
  return baseCandidateRows(args)
    .map(({ site, index }) => ({
      site,
      index,
      surface: classifyCandidateSurface({ site, flowFamily: args.flowFamily }),
    }))
    .filter(({ surface }) => surface.state === "needs_classification")
    .sort((left, right) =>
      left.site.imported_at.localeCompare(right.site.imported_at) ||
      left.site.target_url.localeCompare(right.site.target_url),
    )[0];
}

function pickSafeCandidate(args: {
  candidates: TargetSiteRecord[];
  historicalTasks: TaskRecord[];
  promotedHostname: string;
  flowFamily?: FlowFamily;
}): { site: TargetSiteRecord; preview: CandidateIntakePreview; surface: TargetSurfaceIntakeClassification; index: number } | undefined {
  return baseCandidateRows(args)
    .map(({ site, index }) => ({
      site,
      index,
      surface: classifyCandidateSurface({ site, flowFamily: args.flowFamily }),
    }))
    .filter(({ surface }) => surface.state === "ready")
    .map(({ site, index, surface }) => ({
      site,
      index,
      surface,
      preview: previewCandidate({
        site,
        promotedHostname: args.promotedHostname,
        historicalTasks: args.historicalTasks,
        surface,
      }),
    }))
    .filter(({ preview }) => preview.viability !== "deprioritized")
    .sort((left, right) =>
      right.preview.queue_priority_score - left.preview.queue_priority_score ||
      left.site.imported_at.localeCompare(right.site.imported_at) ||
      left.site.target_url.localeCompare(right.site.target_url),
    )[0];
}

async function previewDryRun(args: UnattendedScopeTickArgs, scope: TaskScopeFilter): Promise<UnattendedScopeTickResult> {
  const lane = args.lane ?? "active_any";
  const leaseGroup = resolveWorkerLeaseGroupForLane(lane);
  const activeLease = await loadWorkerLease(leaseGroup);
  if (activeLease && new Date(activeLease.expires_at).getTime() > Date.now()) {
    return {
      action: "blocked",
      scope,
      detail: `Dry run: a live ${activeLease.group ?? leaseGroup} worker lease is already held by ${activeLease.owner}.`,
      lease: activeLease,
      dry_run: true,
    };
  }

  if (leaseGroup === "active") {
    const browserOwnership = await loadBrowserOwnership();
    if (browserOwnership && new Date(browserOwnership.expires_at).getTime() > Date.now()) {
      return {
        action: "blocked",
        scope,
        detail: `Dry run: shared browser is currently owned by ${browserOwnership.owner}.`,
        lease: {
          task_id: browserOwnership.task_id,
          owner: browserOwnership.owner,
          acquired_at: browserOwnership.acquired_at,
          expires_at: browserOwnership.expires_at,
          group: leaseGroup,
          lane,
        },
        dry_run: true,
      };
    }
  }

  const runtimeIncident = await loadRuntimeIncident();
  if (runtimeIncident) {
    return {
      action: "blocked",
      scope,
      detail: "Dry run: runtime circuit breaker is open; recovery is required before active execution.",
      runtime_incident: runtimeIncident,
      dry_run: true,
    };
  }

  const tasks = await listTasks();
  const scopedTasks = tasks.filter((task) => matchesTaskScope(task, scope));
  const nextTask = pickNextTaskForLane(scopedTasks, lane);
  if (nextTask) {
    return {
      action: "claimed",
      scope,
      detail: `Dry run: would claim scoped task ${nextTask.id} for ${lane} lane execution.`,
      task: nextTask,
      dry_run: true,
      counts: { scoped_tasks: scopedTasks.length, candidate_pool: 0, safe_candidates: 0 },
    };
  }

  const coolingDown = isCoolingDown(scopedTasks);

  const promotedHostname = scope.promotedHostname ?? hostnameFromUrl(args.promotedUrl);
  if (!args.promotedUrl || !promotedHostname) {
    if (coolingDown) {
      return {
        action: "cooldown",
        scope,
        detail: "Dry run: scoped active tasks exist, but automatic retry cooldown/backoff is still in force.",
        dry_run: true,
        counts: { scoped_tasks: scopedTasks.length, candidate_pool: 0, safe_candidates: 0 },
      };
    }
    return {
      action: hasLiveManualBoundary(scopedTasks) ? "needs_manual_boundary" : "no_candidate",
      scope,
      detail: "Dry run: no scoped active task is claimable, and promotedUrl is required before target-site intake can enqueue a new task.",
      dry_run: true,
      counts: { scoped_tasks: scopedTasks.length, candidate_pool: 0, safe_candidates: 0 },
    };
  }

  const candidatePool = await listTargetSites(args.candidateLimit ?? 500);
  const safeCandidate = pickSafeCandidate({
    candidates: candidatePool,
    historicalTasks: tasks,
    promotedHostname,
    flowFamily: args.flowFamily,
  });
  const safeCandidateCount = countSafeCandidates({
    candidatePool,
    tasks,
    promotedHostname,
    flowFamily: args.flowFamily,
  });
  const needsClassificationCandidate = pickNeedsClassificationCandidate({
    candidates: candidatePool,
    historicalTasks: tasks,
    promotedHostname,
    flowFamily: args.flowFamily,
  });

  if (!safeCandidate) {
    if (needsClassificationCandidate && !coolingDown) {
      return {
        action: "needs_classification",
        scope,
        detail: `Dry run: ${buildNeedsClassificationDetail(needsClassificationCandidate)}`,
        dry_run: true,
        counts: {
          scoped_tasks: scopedTasks.length,
          candidate_pool: candidatePool.length,
          safe_candidates: safeCandidateCount,
        },
      };
    }
    return {
      action: hasLiveManualBoundary(scopedTasks) ? "needs_manual_boundary" : "no_candidate",
      scope,
      detail: "Dry run: no safe target_sites candidate is available for this promoted scope.",
      dry_run: true,
      counts: {
        scoped_tasks: scopedTasks.length,
        candidate_pool: candidatePool.length,
        safe_candidates: safeCandidateCount,
      },
    };
  }

  return {
    action: "enqueued",
    scope,
    detail: `Dry run: selected ${safeCandidate.site.target_url} for the next enqueue without mutating queue state.`,
    candidate: safeCandidate.preview,
    dry_run: true,
    counts: {
      scoped_tasks: scopedTasks.length,
      candidate_pool: candidatePool.length,
      safe_candidates: safeCandidateCount,
    },
  };
}

function countSafeCandidates(args: {
  candidatePool: TargetSiteRecord[];
  tasks: TaskRecord[];
  promotedHostname: string;
  flowFamily?: FlowFamily;
}): number {
  return baseCandidateRows({
    candidates: args.candidatePool,
    historicalTasks: args.tasks,
    promotedHostname: args.promotedHostname,
  })
    .map(({ site }) => ({
      site,
      surface: classifyCandidateSurface({ site, flowFamily: args.flowFamily }),
    }))
    .filter(({ surface }) => surface.state === "ready")
    .filter(({ site, surface }) =>
      buildTargetPreflightAssessment({
        targetUrl: site.target_url,
        promotedHostname: args.promotedHostname,
        flowFamily: surface.flowFamily,
        historicalTasks: args.tasks,
      }).viability !== "deprioritized",
    ).length;
}

function buildNeedsClassificationDetail(candidate: { site: TargetSiteRecord; surface: TargetSurfaceIntakeClassification }): string {
  return `Target-site intake paused ${candidate.site.target_url}: ${candidate.surface.reason}`;
}

export async function runUnattendedScopeTick(args: UnattendedScopeTickArgs): Promise<UnattendedScopeTickResult> {
  await ensureDataDirectories();
  const scope = buildScope(args);
  if (!scope.taskIdPrefix && !scope.promotedHostname && !scope.promotedUrl) {
    return {
      action: "needs_manual_boundary",
      scope,
      detail: "unattended-scope-tick requires a bounded scope: pass taskIdPrefix, promotedHostname, or promotedUrl.",
      dry_run: args.dryRun || undefined,
    };
  }

  if (args.dryRun) {
    return previewDryRun(args, scope);
  }

  const claim = await claimNextTask({
    owner: args.owner,
    lane: args.lane ?? "active_any",
    scope,
  });

  if (claim.mode === "claimed" && claim.task && claim.lease) {
    return {
      action: "claimed",
      scope,
      detail: `Claimed scoped task ${claim.task.id} for active operator execution.`,
      reapedTaskId: claim.reapedTaskId,
      task: claim.task,
      lease: claim.lease,
    };
  }

  if (claim.mode === "lease_held") {
    return {
      action: "blocked",
      scope,
      detail: `A live ${claim.lease?.group ?? "active"} worker lease is already held by ${claim.lease?.owner ?? "unknown"}.`,
      reapedTaskId: claim.reapedTaskId,
      lease: claim.lease,
    };
  }

  if (claim.runtime_incident) {
    return {
      action: "blocked",
      scope,
      detail: "Runtime circuit breaker is open; claim returned idle because runtime recovery is required.",
      reapedTaskId: claim.reapedTaskId,
      runtime_incident: claim.runtime_incident,
    };
  }

  const tasks = await listTasks();
  const scopedTasks = tasks.filter((task) => matchesTaskScope(task, scope));
  const coolingDown = isCoolingDown(scopedTasks);

  const promotedHostname = scope.promotedHostname ?? hostnameFromUrl(args.promotedUrl);
  if (!args.promotedUrl || !promotedHostname) {
    if (coolingDown) {
      return {
        action: "cooldown",
        scope,
        detail: "Scoped active tasks exist, but automatic retry cooldown/backoff is still in force and promotedUrl is required before target-site intake can enqueue a new task.",
        reapedTaskId: claim.reapedTaskId,
        counts: { scoped_tasks: scopedTasks.length, candidate_pool: 0, safe_candidates: 0 },
      };
    }
    return {
      action: hasLiveManualBoundary(scopedTasks) ? "needs_manual_boundary" : "no_candidate",
      scope,
      detail: "No scoped active task was claimable, and promotedUrl is required before target-site intake can enqueue a new task.",
      reapedTaskId: claim.reapedTaskId,
      counts: { scoped_tasks: scopedTasks.length, candidate_pool: 0, safe_candidates: 0 },
    };
  }

  const candidatePool = await listTargetSites(args.candidateLimit ?? 500);
  const safeCandidate = pickSafeCandidate({
    candidates: candidatePool,
    historicalTasks: tasks,
    promotedHostname,
    flowFamily: args.flowFamily,
  });

  const safeCandidateCount = countSafeCandidates({
    candidatePool,
    tasks,
    promotedHostname,
    flowFamily: args.flowFamily,
  });
  const needsClassificationCandidate = pickNeedsClassificationCandidate({
    candidates: candidatePool,
    historicalTasks: tasks,
    promotedHostname,
    flowFamily: args.flowFamily,
  });

  if (!safeCandidate) {
    if (needsClassificationCandidate && !coolingDown) {
      await upsertTargetSite({
        ...needsClassificationCandidate.site,
        submit_status: "needs_classification",
        flow_family_hint: undefined,
        payload: {
          ...(needsClassificationCandidate.site.payload ?? {}),
          surface_diagnosis: {
            at: new Date().toISOString(),
            state: needsClassificationCandidate.surface.state,
            source: needsClassificationCandidate.surface.source,
            reason: needsClassificationCandidate.surface.reason,
          },
        },
      });
      return {
        action: "needs_classification",
        scope,
        detail: buildNeedsClassificationDetail(needsClassificationCandidate),
        reapedTaskId: claim.reapedTaskId,
        counts: {
          scoped_tasks: scopedTasks.length,
          candidate_pool: candidatePool.length,
          safe_candidates: safeCandidateCount,
        },
      };
    }
    if (coolingDown) {
      return {
        action: "cooldown",
        scope,
        detail: "Scoped active tasks exist, but automatic retry cooldown/backoff is still in force and no safe target_sites candidate is available for this promoted scope.",
        reapedTaskId: claim.reapedTaskId,
        counts: {
          scoped_tasks: scopedTasks.length,
          candidate_pool: candidatePool.length,
          safe_candidates: safeCandidateCount,
        },
      };
    }
    return {
      action: hasLiveManualBoundary(scopedTasks) ? "needs_manual_boundary" : "no_candidate",
      scope,
      detail: "No safe target_sites candidate is available for this promoted scope.",
      reapedTaskId: claim.reapedTaskId,
      counts: {
        scoped_tasks: scopedTasks.length,
        candidate_pool: candidatePool.length,
        safe_candidates: safeCandidateCount,
      },
    };
  }

  const taskId = buildTaskId({
    prefix: args.taskIdPrefix,
    index: safeCandidate.index + 1,
    targetUrl: safeCandidate.site.target_url,
  });
  const enqueueResult = await enqueueSiteTask({
    taskId,
    targetUrl: safeCandidate.site.target_url,
    promotedUrl: args.promotedUrl,
    promotedName: args.promotedName,
    promotedDescription: args.promotedDescription,
    submitterEmailBase: args.submitterEmailBase,
    confirmSubmit: args.confirmSubmit ?? false,
    flowFamily: requestedFlowFamilyForCandidate({ site: safeCandidate.site, flowFamily: args.flowFamily }),
    enqueuedBy: "unattended-scope-tick",
  });

  const acceptedOutcomes = new Set(["accept_new_task", "reactivated_existing_task", "reused_existing_task"]);
  await upsertTargetSite({
    ...safeCandidate.site,
    submit_status: acceptedOutcomes.has(enqueueResult.outcome) ? "enqueued" : "skipped",
    flow_family_hint: safeCandidate.surface.flowFamily,
    last_task_id: enqueueResult.task.id,
    payload: {
      ...(safeCandidate.site.payload ?? {}),
      unattended_scope_tick: {
        at: new Date().toISOString(),
        outcome: enqueueResult.outcome,
        task_id: enqueueResult.task.id,
        promoted_url: args.promotedUrl,
      },
    },
  });

  return {
    action: acceptedOutcomes.has(enqueueResult.outcome) ? "enqueued" : "blocked",
    scope,
    detail: `Target-site intake selected ${safeCandidate.site.target_url}; enqueue outcome: ${enqueueResult.outcome}.`,
    reapedTaskId: claim.reapedTaskId,
    task: enqueueResult.task,
    candidate: safeCandidate.preview,
    enqueue_outcome: enqueueResult.outcome,
    counts: {
      scoped_tasks: scopedTasks.length,
      candidate_pool: candidatePool.length,
      safe_candidates: safeCandidateCount,
    },
  };
}
