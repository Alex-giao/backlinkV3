import fs from "node:fs";
import path from "node:path";

export interface WorkerLockRecord {
  owner_id: string;
  acquired_at: string;
  heartbeat_at: string;
  pid?: number;
  promoted_hostname?: string;
  mode?: string;
}

export type AcquireWorkerLockResult =
  | { acquired: true; recovered_stale: boolean; lock: WorkerLockRecord }
  | { acquired: false; reason: "active"; lock?: WorkerLockRecord; age_ms?: number }
  | { acquired: false; reason: "error"; detail: string };

export interface AcquireWorkerLockArgs {
  lockDir: string;
  ownerId: string;
  nowMs?: number;
  staleMs?: number;
  metadata?: Partial<Omit<WorkerLockRecord, "owner_id" | "acquired_at" | "heartbeat_at">>;
}

export interface MutateWorkerLockArgs {
  lockDir: string;
  ownerId: string;
  nowMs?: number;
}

export type MutateWorkerLockResult =
  | { ok: true; lock: WorkerLockRecord }
  | { ok: false; reason: "missing" | "owner_mismatch" | "invalid" | "error"; detail?: string; lock?: WorkerLockRecord };

export type ReleaseWorkerLockResult =
  | { released: true }
  | { released: false; reason: "missing" | "owner_mismatch" | "invalid" | "error"; detail?: string; lock?: WorkerLockRecord };

export interface CampaignRunSummary {
  stop_reason?: string;
  active_tasks_started?: number;
  active_tasks_finalized?: number;
  follow_up_ticks?: number;
  scope_ticks?: number;
  events?: Array<{ phase?: string; action?: string; task_id?: string }>;
}

export interface CampaignRunClassification {
  productive: boolean;
  idle: boolean;
  hard_stop: boolean;
  reason: string;
}

export type WorkerLoopStopReason =
  | "max_iterations"
  | "idle_limit"
  | "max_runtime"
  | "insufficient_runtime_budget"
  | "success_target";

export interface ShouldStopWorkerLoopArgs {
  iteration: number;
  maxIterations: number;
  idleCount: number;
  idleLimit: number;
  startedAtMs: number;
  nowMs: number;
  maxRuntimeMs: number;
  minRemainingMs: number;
  submittedSuccess?: number;
  successTarget?: number;
}

const LOCK_FILE = "lock.json";

function lockFilePath(lockDir: string): string {
  return path.join(lockDir, LOCK_FILE);
}

function iso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function readLock(lockDir: string): WorkerLockRecord | undefined {
  const filePath = lockFilePath(lockDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<WorkerLockRecord>;
    if (!parsed.owner_id || !parsed.acquired_at || !parsed.heartbeat_at) {
      return undefined;
    }
    return {
      ...parsed,
      owner_id: parsed.owner_id,
      acquired_at: parsed.acquired_at,
      heartbeat_at: parsed.heartbeat_at,
    };
  } catch {
    return undefined;
  }
}

function writeLock(lockDir: string, lock: WorkerLockRecord): void {
  fs.writeFileSync(lockFilePath(lockDir), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

export function lockAgeMs(lock: WorkerLockRecord, nowMs: number): number | undefined {
  const heartbeatMs = Date.parse(lock.heartbeat_at);
  if (!Number.isFinite(heartbeatMs)) {
    return undefined;
  }
  return Math.max(0, nowMs - heartbeatMs);
}

export function isWorkerLockAlive(lock: WorkerLockRecord, nowMs: number, staleMs: number): boolean {
  const ageMs = lockAgeMs(lock, nowMs);
  if (ageMs === undefined) {
    return false;
  }
  return ageMs < staleMs;
}

function buildLock(args: Required<Pick<AcquireWorkerLockArgs, "ownerId">> & {
  nowMs: number;
  metadata?: AcquireWorkerLockArgs["metadata"];
}): WorkerLockRecord {
  return {
    owner_id: args.ownerId,
    acquired_at: iso(args.nowMs),
    heartbeat_at: iso(args.nowMs),
    ...args.metadata,
  };
}

function createLockDirectory(lockDir: string, lock: WorkerLockRecord): boolean {
  fs.mkdirSync(lockDir, { recursive: false });
  writeLock(lockDir, lock);
  return true;
}

export function acquireWorkerLock(args: AcquireWorkerLockArgs): AcquireWorkerLockResult {
  const nowMs = args.nowMs ?? Date.now();
  const staleMs = args.staleMs ?? 15 * 60 * 1_000;
  const lock = buildLock({ ownerId: args.ownerId, nowMs, metadata: args.metadata });

  try {
    fs.mkdirSync(path.dirname(args.lockDir), { recursive: true });
    createLockDirectory(args.lockDir, lock);
    return { acquired: true, recovered_stale: false, lock };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      return { acquired: false, reason: "error", detail: (error as Error).message };
    }
  }

  const existing = readLock(args.lockDir);
  if (existing && isWorkerLockAlive(existing, nowMs, staleMs)) {
    return { acquired: false, reason: "active", lock: existing, age_ms: lockAgeMs(existing, nowMs) };
  }

  try {
    fs.rmSync(args.lockDir, { recursive: true, force: true });
    createLockDirectory(args.lockDir, lock);
    return { acquired: true, recovered_stale: true, lock };
  } catch (error) {
    return { acquired: false, reason: "error", detail: (error as Error).message };
  }
}

export function refreshWorkerLock(args: MutateWorkerLockArgs): MutateWorkerLockResult {
  const nowMs = args.nowMs ?? Date.now();
  const existing = readLock(args.lockDir);
  if (!existing) {
    return { ok: false, reason: "missing" };
  }
  if (existing.owner_id !== args.ownerId) {
    return { ok: false, reason: "owner_mismatch", lock: existing };
  }
  const next = { ...existing, heartbeat_at: iso(nowMs) };
  try {
    writeLock(args.lockDir, next);
    return { ok: true, lock: next };
  } catch (error) {
    return { ok: false, reason: "error", detail: (error as Error).message, lock: existing };
  }
}

export function releaseWorkerLock(args: { lockDir: string; ownerId: string }): ReleaseWorkerLockResult {
  const existing = readLock(args.lockDir);
  if (!existing) {
    return { released: false, reason: "missing" };
  }
  if (existing.owner_id !== args.ownerId) {
    return { released: false, reason: "owner_mismatch", lock: existing };
  }
  try {
    fs.rmSync(args.lockDir, { recursive: true, force: true });
    return { released: true };
  } catch (error) {
    return { released: false, reason: "error", detail: (error as Error).message, lock: existing };
  }
}

export function classifyCampaignRun(result: CampaignRunSummary): CampaignRunClassification {
  const reason = result.stop_reason ?? "unknown";
  const activeTasksStarted = result.active_tasks_started ?? 0;
  const activeTasksFinalized = result.active_tasks_finalized ?? 0;
  const followUpTicks = result.follow_up_ticks ?? 0;
  const hasEnqueueOrClaimEvent =
    result.events?.some((event) => event.action === "enqueued" || event.action === "claimed") ?? false;
  const productive = activeTasksStarted > 0 || activeTasksFinalized > 0 || followUpTicks > 0 || hasEnqueueOrClaimEvent;
  const idleReasons = new Set(["no_candidate", "cooldown", "scope_idle"]);
  const hardStopReasons = new Set(["scope_mismatch", "operator_unavailable", "blocked", "needs_manual_boundary"]);
  return {
    productive,
    idle: !productive && idleReasons.has(reason),
    hard_stop: !productive && hardStopReasons.has(reason),
    reason,
  };
}

export function shouldStopWorkerLoop(args: ShouldStopWorkerLoopArgs): WorkerLoopStopReason | undefined {
  if (args.successTarget !== undefined && (args.submittedSuccess ?? 0) >= args.successTarget) {
    return "success_target";
  }
  if (args.iteration >= args.maxIterations) {
    return "max_iterations";
  }
  if (args.iteration > 0 && args.idleCount >= args.idleLimit) {
    return "idle_limit";
  }
  const elapsedMs = Math.max(0, args.nowMs - args.startedAtMs);
  if (elapsedMs >= args.maxRuntimeMs) {
    return "max_runtime";
  }
  if (args.iteration > 0 && args.maxRuntimeMs - elapsedMs < args.minRemainingMs) {
    return "insufficient_runtime_budget";
  }
  return undefined;
}
