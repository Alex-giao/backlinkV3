import { spawn } from "node:child_process";

import { runFollowUpTick } from "./follow-up-tick.js";
import { recordAgentTrace } from "./task-record-agent-trace.js";
import { finalizeTask } from "./task-finalize.js";
import { prepareTaskForAgent } from "./task-prepare.js";
import {
  runUnattendedScopeTick,
  type UnattendedScopeTickArgs,
  type UnattendedScopeTickResult,
} from "./unattended-scope-tick.js";
import type {
  AgentTraceEnvelope,
  ClaimLane,
  FinalizeResult,
  FlowFamily,
  PrepareResult,
  TaskRecord,
} from "../shared/types.js";

export type CampaignStopReason =
  | "dry_run_preview"
  | "operator_unavailable"
  | "max_active_tasks"
  | "max_scope_ticks"
  | "blocked"
  | "cooldown"
  | "no_candidate"
  | "needs_manual_boundary"
  | "scope_mismatch"
  | "scope_idle"
  | "prepare_stopped";

export type CampaignEventPhase =
  | "scope_tick"
  | "task_prepare"
  | "operator"
  | "record_trace"
  | "task_finalize"
  | "follow_up"
  | "stop";

export interface CampaignEvent {
  phase: CampaignEventPhase;
  action?: string;
  mode?: string;
  task_id?: string;
  detail?: string;
  artifact_refs?: string[];
}

export interface UnattendedCampaignArgs {
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
  cdpUrl?: string;
  dryRun?: boolean;
  maxActiveTasks?: number;
  maxScopeTicks?: number;
  maxFollowUpTicks?: number;
  followUp?: boolean;
  operatorCommand?: string;
  operatorTimeoutMs?: number;
}

type FollowUpTickResult = Awaited<ReturnType<typeof runFollowUpTick>>;
type RecordAgentTraceResult = Awaited<ReturnType<typeof recordAgentTrace>>;

export interface OperatorContext {
  task: TaskRecord;
  prepare: PrepareResult;
  scope: UnattendedScopeTickResult["scope"];
  owner: string;
  cdpUrl?: string;
  promotedUrl?: string;
  promotedHostname?: string;
}

export interface UnattendedCampaignDeps {
  runScopeTick?: (args: UnattendedScopeTickArgs) => Promise<UnattendedScopeTickResult>;
  prepareTask?: (args: { taskId: string; cdpUrl?: string }) => Promise<PrepareResult>;
  runOperator?: (context: OperatorContext) => Promise<AgentTraceEnvelope>;
  recordAgentTrace?: (args: { taskId: string; envelope: AgentTraceEnvelope }) => Promise<RecordAgentTraceResult>;
  finalizeTask?: (args: { taskId: string; cdpUrl?: string }) => Promise<FinalizeResult>;
  runFollowUpTick?: (args: {
    owner: string;
    taskIdPrefix?: string;
    promotedHostname?: string;
    promotedUrl?: string;
  }) => Promise<FollowUpTickResult>;
}

export interface UnattendedCampaignResult {
  stop_reason: CampaignStopReason;
  scope_ticks: number;
  follow_up_ticks: number;
  active_tasks_started: number;
  active_tasks_finalized: number;
  events: CampaignEvent[];
}

interface LockedPromotedScope {
  promotedUrl: string;
  promotedHostname: string;
}

function normalizeHostname(hostname?: string): string | undefined {
  return hostname?.trim().replace(/^www\./i, "").toLowerCase() || undefined;
}

function normalizedPromotedUrl(rawUrl?: string): string | undefined {
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
  } catch {
    return undefined;
  }
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

function validateCampaignScope(args: UnattendedCampaignArgs):
  | { ok: true; scope: LockedPromotedScope }
  | { ok: false; stopReason: CampaignStopReason; detail: string } {
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

function taskMatchesLockedScope(task: TaskRecord, scope: LockedPromotedScope): boolean {
  const promotedProfile = task.submission?.promoted_profile;
  if (!promotedProfile) {
    return false;
  }

  const taskPromotedHostname =
    normalizeHostname(promotedProfile.hostname) ?? hostnameFromUrl(promotedProfile.url);
  if (taskPromotedHostname !== scope.promotedHostname) {
    return false;
  }

  const taskPromotedUrl = normalizedPromotedUrl(promotedProfile.url);
  return taskPromotedUrl === scope.promotedUrl;
}

function buildScopeTickArgs(args: UnattendedCampaignArgs, scope: LockedPromotedScope, dryRun: boolean): UnattendedScopeTickArgs {
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

function mapScopeActionToStopReason(action: UnattendedScopeTickResult["action"]): CampaignStopReason {
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

function assertAgentTraceEnvelope(value: unknown): asserts value is AgentTraceEnvelope {
  if (!value || typeof value !== "object") {
    throw new Error("Operator command did not return a JSON object.");
  }
  const candidate = value as Partial<AgentTraceEnvelope>;
  if (!candidate.trace || typeof candidate.trace !== "object") {
    throw new Error("Operator command output is missing trace.");
  }
  if (!candidate.handoff || typeof candidate.handoff !== "object") {
    throw new Error("Operator command output is missing handoff.");
  }
}

function parseJsonObjectFromStdout(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("Operator command produced no stdout JSON.");
  }
  return JSON.parse(trimmed) as unknown;
}

function runShellOperatorCommand(args: {
  command: string;
  context: OperatorContext;
  timeoutMs: number;
}): Promise<AgentTraceEnvelope> {
  return new Promise((resolve, reject) => {
    const child = spawn(args.command, {
      shell: true,
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
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Operator command timed out after ${args.timeoutMs}ms.`));
    }, args.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Operator command exited with code ${code ?? "unknown"}: ${stderr.trim()}`));
        return;
      }
      try {
        const parsed = parseJsonObjectFromStdout(stdout);
        assertAgentTraceEnvelope(parsed);
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.end(JSON.stringify(args.context, null, 2));
  });
}

function buildDeps(args: UnattendedCampaignArgs, deps: UnattendedCampaignDeps): Required<UnattendedCampaignDeps> {
  const operatorCommand = args.operatorCommand?.trim();
  const runOperator =
    deps.runOperator ??
    (operatorCommand
      ? (context: OperatorContext) =>
          runShellOperatorCommand({
            command: operatorCommand,
            context,
            timeoutMs: args.operatorTimeoutMs ?? 30 * 60 * 1_000,
          })
      : undefined);

  return {
    runScopeTick: deps.runScopeTick ?? runUnattendedScopeTick,
    prepareTask: deps.prepareTask ?? prepareTaskForAgent,
    runOperator: runOperator as Required<UnattendedCampaignDeps>["runOperator"],
    recordAgentTrace: deps.recordAgentTrace ?? recordAgentTrace,
    finalizeTask: deps.finalizeTask ?? finalizeTask,
    runFollowUpTick: deps.runFollowUpTick ?? runFollowUpTick,
  };
}

async function maybeRunFollowUp(args: {
  campaignArgs: UnattendedCampaignArgs;
  scope: LockedPromotedScope;
  deps: Required<UnattendedCampaignDeps>;
  events: CampaignEvent[];
  followUpTicks: number;
  maxFollowUpTicks: number;
}): Promise<{ followUpTicks: number; result?: FollowUpTickResult }> {
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

export async function runUnattendedCampaign(
  args: UnattendedCampaignArgs,
  deps: UnattendedCampaignDeps = {},
): Promise<UnattendedCampaignResult> {
  const effectiveDeps = buildDeps(args, deps);
  const events: CampaignEvent[] = [];
  let scopeTicks = 0;
  let followUpTicks = 0;
  let activeTasksStarted = 0;
  let activeTasksFinalized = 0;
  let stopReason: CampaignStopReason = "scope_idle";
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

    activeTasksStarted += 1;
    const taskId = scopeResult.task.id;
    const prepare = await effectiveDeps.prepareTask({ taskId, cdpUrl: args.cdpUrl });
    events.push({ phase: "task_prepare", mode: prepare.mode, task_id: taskId });

    if (prepare.mode !== "ready_for_agent_loop") {
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
      if (activeTasksStarted >= maxActiveTasks) {
        stopReason = "max_active_tasks";
      }
      continue;
    }

    const envelope = await effectiveDeps.runOperator({
      task: prepare.task,
      prepare,
      scope: scopeResult.scope,
      owner: args.owner,
      cdpUrl: args.cdpUrl,
      promotedUrl: lockedScope.promotedUrl,
      promotedHostname: lockedScope.promotedHostname,
    });
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
  } else if (scopeTicks >= maxScopeTicks && stopReason === "scope_idle") {
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
