import { enqueueSiteTask } from "./task-queue.js";
import { canRetry, claimNextTask, matchesTaskScope, pickNextTaskForLane, resolveWorkerLeaseGroupForLane, } from "./task-queue.js";
import { buildTargetPreflightAssessment } from "./target-preflight.js";
import { loadBrowserOwnership } from "../execution/ownership-lock.js";
import { ensureDataDirectories, listTargetSites, listTasks, loadWorkerLease, upsertTargetSite, } from "../memory/data-store.js";
import { loadRuntimeIncident } from "../shared/runtime-incident.js";
function normalizeHostname(hostname) {
    return hostname?.trim().replace(/^www\./i, "").toLowerCase() || undefined;
}
function hostnameFromUrl(rawUrl) {
    if (!rawUrl) {
        return undefined;
    }
    try {
        return normalizeHostname(new URL(rawUrl).hostname);
    }
    catch {
        return undefined;
    }
}
function buildScope(args) {
    return {
        taskIdPrefix: args.taskIdPrefix,
        promotedHostname: normalizeHostname(args.promotedHostname) ?? hostnameFromUrl(args.promotedUrl),
        promotedUrl: args.promotedUrl,
    };
}
function isHttpTargetSite(site) {
    try {
        const parsed = new URL(site.target_url);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    }
    catch {
        return false;
    }
}
function isSmokeTargetSite(site) {
    return site.source === "db-smoke" || site.payload?.smoke === true;
}
function hasLiveManualBoundary(tasks) {
    return tasks.some((task) => task.status === "WAITING_MANUAL_AUTH" ||
        task.status === "WAITING_POLICY_DECISION" ||
        task.status === "WAITING_MISSING_INPUT");
}
function isCoolingDown(tasks) {
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
function buildTaskId(args) {
    const hostname = new URL(args.targetUrl).hostname.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return `${args.prefix ?? "unattended"}-${String(args.index).padStart(4, "0")}-${hostname}`.slice(0, 120);
}
function previewCandidate(args) {
    const flowFamily = args.flowFamily ?? args.site.flow_family_hint;
    const assessment = buildTargetPreflightAssessment({
        targetUrl: args.site.target_url,
        promotedHostname: args.promotedHostname,
        flowFamily,
        historicalTasks: args.historicalTasks,
    });
    return {
        target_url: args.site.target_url,
        hostname: args.site.hostname,
        source: args.site.source,
        flow_family_hint: flowFamily,
        queue_priority_score: assessment.queue_priority_score,
        viability: assessment.viability,
    };
}
function pickSafeCandidate(args) {
    const representedTargetHosts = new Set(args.historicalTasks
        .filter((task) => normalizeHostname(task.submission.promoted_profile.hostname) === args.promotedHostname)
        .map((task) => normalizeHostname(task.hostname))
        .filter((hostname) => Boolean(hostname)));
    return args.candidates
        .map((site, index) => ({ site, index }))
        .filter(({ site }) => site.submit_status === "candidate")
        .filter(({ site }) => !isSmokeTargetSite(site))
        .filter(({ site }) => isHttpTargetSite(site))
        .filter(({ site }) => normalizeHostname(site.hostname) !== args.promotedHostname)
        .filter(({ site }) => !representedTargetHosts.has(normalizeHostname(site.hostname) ?? ""))
        .map(({ site, index }) => ({
        site,
        index,
        preview: previewCandidate({
            site,
            promotedHostname: args.promotedHostname,
            historicalTasks: args.historicalTasks,
            flowFamily: args.flowFamily,
        }),
    }))
        .filter(({ preview }) => preview.viability !== "deprioritized")
        .sort((left, right) => right.preview.queue_priority_score - left.preview.queue_priority_score ||
        left.site.imported_at.localeCompare(right.site.imported_at) ||
        left.site.target_url.localeCompare(right.site.target_url))[0];
}
async function previewDryRun(args, scope) {
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
    const safeCandidateCount = countSafeCandidates(candidatePool, tasks, promotedHostname);
    if (!safeCandidate) {
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
function countSafeCandidates(candidatePool, tasks, promotedHostname) {
    return candidatePool.filter((site) => {
        if (site.submit_status !== "candidate" || isSmokeTargetSite(site) || !isHttpTargetSite(site)) {
            return false;
        }
        if (normalizeHostname(site.hostname) === promotedHostname) {
            return false;
        }
        return !tasks.some((task) => normalizeHostname(task.submission.promoted_profile.hostname) === promotedHostname &&
            normalizeHostname(task.hostname) === normalizeHostname(site.hostname));
    }).length;
}
export async function runUnattendedScopeTick(args) {
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
    const safeCandidateCount = countSafeCandidates(candidatePool, tasks, promotedHostname);
    if (!safeCandidate) {
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
        flowFamily: args.flowFamily ?? safeCandidate.site.flow_family_hint,
        enqueuedBy: "unattended-scope-tick",
    });
    const acceptedOutcomes = new Set(["accept_new_task", "reactivated_existing_task", "reused_existing_task"]);
    await upsertTargetSite({
        ...safeCandidate.site,
        submit_status: acceptedOutcomes.has(enqueueResult.outcome) ? "enqueued" : "skipped",
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
