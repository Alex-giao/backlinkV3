import { spawn } from "node:child_process";
import { runFollowUpTick } from "./follow-up-tick.js";
import { recordAgentTrace } from "./task-record-agent-trace.js";
import { finalizeTask } from "./task-finalize.js";
import { prepareTaskForAgent } from "./task-prepare.js";
import { recoverActiveWorkerLeaseAfterOperatorFailure } from "./task-queue.js";
import { runUnattendedScopeTick, } from "./unattended-scope-tick.js";
function normalizeHostname(hostname) {
    return hostname?.trim().replace(/^www\./i, "").toLowerCase() || undefined;
}
function normalizedPromotedUrl(rawUrl) {
    if (!rawUrl) {
        return undefined;
    }
    try {
        const parsed = new URL(rawUrl);
        const protocol = parsed.protocol.toLowerCase();
        const hostname = normalizeHostname(parsed.hostname);
        if (!hostname || (protocol !== "http:" && protocol !== "https:")) {
            return undefined;
        }
        const pathname = parsed.pathname === "/" ? "/" : parsed.pathname.replace(/\/+$/, "");
        return `${protocol}//${hostname}${pathname || "/"}${parsed.search}`;
    }
    catch {
        return undefined;
    }
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
function validateCampaignScope(args) {
    if (args.lane === "follow_up") {
        return {
            ok: false,
            stopReason: "needs_manual_boundary",
            detail: "unattended-campaign active loop does not accept lane=follow_up; follow-up work is handled by follow-up-tick.",
        };
    }
    const promotedUrl = normalizedPromotedUrl(args.promotedUrl);
    const promotedHostname = hostnameFromUrl(args.promotedUrl);
    if (!promotedUrl || !promotedHostname) {
        return {
            ok: false,
            stopReason: "needs_manual_boundary",
            detail: "unattended-campaign requires an exact promotedUrl before any live or dry-run scope tick.",
        };
    }
    const explicitHostname = normalizeHostname(args.promotedHostname);
    if (explicitHostname && explicitHostname !== promotedHostname) {
        return {
            ok: false,
            stopReason: "scope_mismatch",
            detail: `promotedHostname ${explicitHostname} does not match promotedUrl hostname ${promotedHostname}.`,
        };
    }
    return { ok: true, scope: { promotedUrl, promotedHostname } };
}
function taskMatchesLockedScope(task, scope) {
    const promotedProfile = task.submission?.promoted_profile;
    if (!promotedProfile) {
        return false;
    }
    const taskPromotedHostname = normalizeHostname(promotedProfile.hostname) ?? hostnameFromUrl(promotedProfile.url);
    if (taskPromotedHostname !== scope.promotedHostname) {
        return false;
    }
    const taskPromotedUrl = normalizedPromotedUrl(promotedProfile.url);
    return taskPromotedUrl === scope.promotedUrl;
}
function buildScopeTickArgs(args, scope, dryRun) {
    return {
        owner: args.owner,
        taskIdPrefix: args.taskIdPrefix,
        promotedHostname: scope.promotedHostname,
        promotedUrl: scope.promotedUrl,
        promotedName: args.promotedName,
        promotedDescription: args.promotedDescription,
        submitterEmailBase: args.submitterEmailBase,
        confirmSubmit: args.confirmSubmit,
        flowFamily: args.flowFamily,
        lane: args.lane ?? "active_any",
        candidateLimit: args.candidateLimit,
        dryRun,
    };
}
function mapScopeActionToStopReason(action) {
    if (action === "blocked") {
        return "blocked";
    }
    if (action === "cooldown") {
        return "cooldown";
    }
    if (action === "no_candidate") {
        return "no_candidate";
    }
    if (action === "needs_manual_boundary") {
        return "needs_manual_boundary";
    }
    return "scope_idle";
}
function assertAgentTraceEnvelope(value) {
    if (!value || typeof value !== "object") {
        throw new Error("Operator command did not return a JSON object.");
    }
    const candidate = value;
    if (!candidate.trace || typeof candidate.trace !== "object") {
        throw new Error("Operator command output is missing trace.");
    }
    if (!candidate.handoff || typeof candidate.handoff !== "object") {
        throw new Error("Operator command output is missing handoff.");
    }
}
function parseJsonObjectFromStdout(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed) {
        throw new Error("Operator command produced no stdout JSON.");
    }
    return JSON.parse(trimmed);
}
function splitCommandLine(command) {
    const parts = [];
    let current = "";
    let quote;
    let escaping = false;
    for (const char of command.trim()) {
        if (escaping) {
            current += char;
            escaping = false;
            continue;
        }
        if (char === "\\" && quote !== "'") {
            escaping = true;
            continue;
        }
        if ((char === '"' || char === "'") && !quote) {
            quote = char;
            continue;
        }
        if (char === quote) {
            quote = undefined;
            continue;
        }
        if (!quote && /\s/.test(char)) {
            if (current) {
                parts.push(current);
                current = "";
            }
            continue;
        }
        current += char;
    }
    if (escaping) {
        current += "\\";
    }
    if (quote) {
        throw new Error(`Operator command has an unterminated ${quote} quote.`);
    }
    if (current) {
        parts.push(current);
    }
    if (parts.length === 0) {
        throw new Error("Operator command is empty.");
    }
    return parts;
}
function terminateProcessTree(pid, signal) {
    if (!pid) {
        return;
    }
    try {
        if (process.platform === "win32") {
            process.kill(pid, signal);
        }
        else {
            process.kill(-pid, signal);
        }
    }
    catch {
        // The process may already have exited between timeout and cleanup.
    }
}
export function runOperatorCommand(args) {
    return new Promise((resolve, reject) => {
        const [executable, ...commandArgs] = splitCommandLine(args.command);
        const child = spawn(executable, commandArgs, {
            shell: false,
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                ...process.env,
                BACKLINKHELPER_OPERATOR_TASK_ID: args.context.task.id,
                BACKLINKHELPER_OPERATOR_TARGET_URL: args.context.prepare.effective_target_url,
                BACKLINKHELPER_OPERATOR_PROMOTED_URL: args.context.promotedUrl ?? "",
                BACKLINKHELPER_OPERATOR_CDP_URL: args.context.cdpUrl ?? "",
            },
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;
        let killTimer;
        const clearTimers = () => {
            clearTimeout(timer);
            if (killTimer) {
                clearTimeout(killTimer);
            }
        };
        const timer = setTimeout(() => {
            if (settled) {
                return;
            }
            timedOut = true;
            settled = true;
            terminateProcessTree(child.pid, "SIGTERM");
            killTimer = setTimeout(() => {
                terminateProcessTree(child.pid, "SIGKILL");
                killTimer = undefined;
            }, args.killGraceMs ?? 5_000);
            reject(new Error(`Operator command timed out after ${args.timeoutMs}ms.`));
        }, args.timeoutMs);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.on("error", (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimers();
            reject(error);
        });
        child.on("close", (code) => {
            if (settled) {
                if (!timedOut) {
                    clearTimers();
                }
                return;
            }
            settled = true;
            clearTimers();
            if (code !== 0) {
                reject(new Error(`Operator command exited with code ${code ?? "unknown"}: ${stderr.trim()}`));
                return;
            }
            try {
                const parsed = parseJsonObjectFromStdout(stdout);
                assertAgentTraceEnvelope(parsed);
                resolve(parsed);
            }
            catch (error) {
                reject(error);
            }
        });
        child.stdin.end(JSON.stringify(args.context, null, 2));
    });
}
function buildDeps(args, deps) {
    const operatorCommand = args.operatorCommand?.trim();
    const runOperator = deps.runOperator ??
        (operatorCommand
            ? (context) => runOperatorCommand({
                command: operatorCommand,
                context,
                timeoutMs: args.operatorTimeoutMs ?? 30 * 60 * 1_000,
            })
            : undefined);
    return {
        runScopeTick: deps.runScopeTick ?? runUnattendedScopeTick,
        prepareTask: deps.prepareTask ?? prepareTaskForAgent,
        runOperator: runOperator,
        recordAgentTrace: deps.recordAgentTrace ?? recordAgentTrace,
        finalizeTask: deps.finalizeTask ?? finalizeTask,
        handleOperatorFailure: deps.handleOperatorFailure ??
            ((recoveryArgs) => recoverActiveWorkerLeaseAfterOperatorFailure({
                taskId: recoveryArgs.taskId,
                group: recoveryArgs.group ?? "active",
                detail: recoveryArgs.error instanceof Error ? recoveryArgs.error.message : String(recoveryArgs.error),
            })),
        runFollowUpTick: deps.runFollowUpTick ?? runFollowUpTick,
    };
}
async function maybeRunFollowUp(args) {
    if (args.campaignArgs.followUp === false || args.followUpTicks >= args.maxFollowUpTicks) {
        return { followUpTicks: args.followUpTicks };
    }
    const result = await args.deps.runFollowUpTick({
        owner: args.campaignArgs.owner,
        taskIdPrefix: args.campaignArgs.taskIdPrefix,
        promotedHostname: args.scope.promotedHostname,
        promotedUrl: args.scope.promotedUrl,
    });
    args.events.push({
        phase: "follow_up",
        mode: result.mode,
        task_id: "task" in result ? result.task.id : result.lease?.task_id,
        detail: "detail" in result ? result.detail : undefined,
    });
    return { followUpTicks: args.followUpTicks + 1, result };
}
export async function runUnattendedCampaign(args, deps = {}) {
    const effectiveDeps = buildDeps(args, deps);
    const events = [];
    let scopeTicks = 0;
    let followUpTicks = 0;
    let activeTasksStarted = 0;
    let activeTasksFinalized = 0;
    let stopReason = "scope_idle";
    const maxActiveTasks = args.maxActiveTasks ?? 1;
    const maxScopeTicks = args.maxScopeTicks ?? Math.max(4, maxActiveTasks * 4);
    const maxFollowUpTicks = args.maxFollowUpTicks ?? Math.max(1, maxActiveTasks);
    const scopeValidation = validateCampaignScope(args);
    if (scopeValidation.ok === false) {
        events.push({
            phase: "stop",
            action: scopeValidation.stopReason,
            detail: scopeValidation.detail,
        });
        return {
            stop_reason: scopeValidation.stopReason,
            scope_ticks: scopeTicks,
            follow_up_ticks: followUpTicks,
            active_tasks_started: activeTasksStarted,
            active_tasks_finalized: activeTasksFinalized,
            events,
        };
    }
    const lockedScope = scopeValidation.scope;
    if (args.dryRun) {
        const scopeResult = await effectiveDeps.runScopeTick(buildScopeTickArgs(args, lockedScope, true));
        scopeTicks += 1;
        events.push({
            phase: "scope_tick",
            action: scopeResult.action,
            task_id: scopeResult.task?.id,
            detail: scopeResult.detail,
        });
        events.push({ phase: "stop", action: "dry_run_preview" });
        return {
            stop_reason: "dry_run_preview",
            scope_ticks: scopeTicks,
            follow_up_ticks: followUpTicks,
            active_tasks_started: activeTasksStarted,
            active_tasks_finalized: activeTasksFinalized,
            events,
        };
    }
    if (!effectiveDeps.runOperator) {
        events.push({
            phase: "stop",
            action: "operator_unavailable",
            detail: "Live campaign execution requires either a dependency-injected operator or --operator-command.",
        });
        return {
            stop_reason: "operator_unavailable",
            scope_ticks: scopeTicks,
            follow_up_ticks: followUpTicks,
            active_tasks_started: activeTasksStarted,
            active_tasks_finalized: activeTasksFinalized,
            events,
        };
    }
    while (activeTasksStarted < maxActiveTasks && scopeTicks < maxScopeTicks) {
        const scopeResult = await effectiveDeps.runScopeTick(buildScopeTickArgs(args, lockedScope, false));
        scopeTicks += 1;
        events.push({
            phase: "scope_tick",
            action: scopeResult.action,
            task_id: scopeResult.task?.id,
            detail: scopeResult.detail,
        });
        if (scopeResult.action === "enqueued") {
            continue;
        }
        if (scopeResult.action !== "claimed" || !scopeResult.task) {
            const followUp = await maybeRunFollowUp({
                campaignArgs: args,
                scope: lockedScope,
                deps: effectiveDeps,
                events,
                followUpTicks,
                maxFollowUpTicks,
            });
            followUpTicks = followUp.followUpTicks;
            if (followUp.result?.mode === "activated_ready") {
                continue;
            }
            stopReason = mapScopeActionToStopReason(scopeResult.action);
            break;
        }
        if (!taskMatchesLockedScope(scopeResult.task, lockedScope)) {
            stopReason = "scope_mismatch";
            break;
        }
        const taskId = scopeResult.task.id;
        const prepare = await effectiveDeps.prepareTask({ taskId, cdpUrl: args.cdpUrl });
        events.push({ phase: "task_prepare", mode: prepare.mode, task_id: taskId });
        if (prepare.mode !== "ready_for_agent_loop") {
            // A prepare-stage stop (for example RETRYABLE cooldown or a terminal audit
            // boundary) did not start an active operator run. Do not spend the
            // maxActiveTasks budget on it; keep pulling the next scoped candidate until
            // an operator actually starts or maxScopeTicks is exhausted.
            stopReason = "prepare_stopped";
            const followUp = await maybeRunFollowUp({
                campaignArgs: args,
                scope: lockedScope,
                deps: effectiveDeps,
                events,
                followUpTicks,
                maxFollowUpTicks,
            });
            followUpTicks = followUp.followUpTicks;
            continue;
        }
        activeTasksStarted += 1;
        let envelope;
        try {
            envelope = await effectiveDeps.runOperator({
                task: prepare.task,
                prepare,
                scope: scopeResult.scope,
                owner: args.owner,
                cdpUrl: args.cdpUrl,
                promotedUrl: lockedScope.promotedUrl,
                promotedHostname: lockedScope.promotedHostname,
            });
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const recovery = await effectiveDeps.handleOperatorFailure({
                taskId,
                error,
                lease: scopeResult.lease,
                group: scopeResult.lease?.group ?? "active",
            });
            events.push({
                phase: "operator",
                action: "runtime_failure",
                task_id: taskId,
                detail: recovery.reapedTaskId
                    ? `${detail} Recovered worker lease for ${recovery.reapedTaskId}.`
                    : `${detail} No active worker lease found to recover.`,
            });
            continue;
        }
        events.push({ phase: "operator", task_id: taskId, detail: envelope.handoff.detail });
        const record = await effectiveDeps.recordAgentTrace({ taskId, envelope });
        events.push({
            phase: "record_trace",
            task_id: taskId,
            artifact_refs: [record.trace_ref, record.pending_finalize_ref],
        });
        const finalize = await effectiveDeps.finalizeTask({ taskId, cdpUrl: args.cdpUrl });
        activeTasksFinalized += 1;
        events.push({
            phase: "task_finalize",
            mode: finalize.next_status,
            task_id: taskId,
            detail: finalize.detail,
            artifact_refs: finalize.artifact_refs,
        });
        const followUp = await maybeRunFollowUp({
            campaignArgs: args,
            scope: lockedScope,
            deps: effectiveDeps,
            events,
            followUpTicks,
            maxFollowUpTicks,
        });
        followUpTicks = followUp.followUpTicks;
        if (activeTasksStarted >= maxActiveTasks) {
            stopReason = "max_active_tasks";
            break;
        }
    }
    if (activeTasksStarted >= maxActiveTasks) {
        stopReason = "max_active_tasks";
    }
    else if (scopeTicks >= maxScopeTicks && stopReason === "scope_idle") {
        stopReason = "max_scope_ticks";
    }
    events.push({ phase: "stop", action: stopReason });
    return {
        stop_reason: stopReason,
        scope_ticks: scopeTicks,
        follow_up_ticks: followUpTicks,
        active_tasks_started: activeTasksStarted,
        active_tasks_finalized: activeTasksFinalized,
        events,
    };
}
