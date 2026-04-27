import fs from "node:fs";
import path from "node:path";
const LOCK_FILE = "lock.json";
function lockFilePath(lockDir) {
    return path.join(lockDir, LOCK_FILE);
}
function iso(nowMs) {
    return new Date(nowMs).toISOString();
}
function readLock(lockDir) {
    const filePath = lockFilePath(lockDir);
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (!parsed.owner_id || !parsed.acquired_at || !parsed.heartbeat_at) {
            return undefined;
        }
        return {
            ...parsed,
            owner_id: parsed.owner_id,
            acquired_at: parsed.acquired_at,
            heartbeat_at: parsed.heartbeat_at,
        };
    }
    catch {
        return undefined;
    }
}
function writeLock(lockDir, lock) {
    fs.writeFileSync(lockFilePath(lockDir), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}
export function lockAgeMs(lock, nowMs) {
    const heartbeatMs = Date.parse(lock.heartbeat_at);
    if (!Number.isFinite(heartbeatMs)) {
        return undefined;
    }
    return Math.max(0, nowMs - heartbeatMs);
}
export function isWorkerLockAlive(lock, nowMs, staleMs) {
    const ageMs = lockAgeMs(lock, nowMs);
    if (ageMs === undefined) {
        return false;
    }
    return ageMs < staleMs;
}
function buildLock(args) {
    return {
        owner_id: args.ownerId,
        acquired_at: iso(args.nowMs),
        heartbeat_at: iso(args.nowMs),
        ...args.metadata,
    };
}
function createLockDirectory(lockDir, lock) {
    fs.mkdirSync(lockDir, { recursive: false });
    writeLock(lockDir, lock);
    return true;
}
export function acquireWorkerLock(args) {
    const nowMs = args.nowMs ?? Date.now();
    const staleMs = args.staleMs ?? 15 * 60 * 1_000;
    const lock = buildLock({ ownerId: args.ownerId, nowMs, metadata: args.metadata });
    try {
        fs.mkdirSync(path.dirname(args.lockDir), { recursive: true });
        createLockDirectory(args.lockDir, lock);
        return { acquired: true, recovered_stale: false, lock };
    }
    catch (error) {
        if (error.code !== "EEXIST") {
            return { acquired: false, reason: "error", detail: error.message };
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
    }
    catch (error) {
        return { acquired: false, reason: "error", detail: error.message };
    }
}
export function refreshWorkerLock(args) {
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
    }
    catch (error) {
        return { ok: false, reason: "error", detail: error.message, lock: existing };
    }
}
export function releaseWorkerLock(args) {
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
    }
    catch (error) {
        return { released: false, reason: "error", detail: error.message, lock: existing };
    }
}
export function classifyCampaignRun(result) {
    const reason = result.stop_reason ?? "unknown";
    const activeTasksStarted = result.active_tasks_started ?? 0;
    const activeTasksFinalized = result.active_tasks_finalized ?? 0;
    const followUpTicks = result.follow_up_ticks ?? 0;
    const hasEnqueueOrClaimEvent = result.events?.some((event) => event.action === "enqueued" || event.action === "claimed") ?? false;
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
export function shouldStopWorkerLoop(args) {
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
