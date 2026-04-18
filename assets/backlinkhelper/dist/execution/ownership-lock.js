import { getOwnershipLockPath, readJsonFile, writeJsonFile } from "../memory/data-store.js";
import { BOUNDED_WORKER_LEASE_TTL_MS } from "../shared/runtime-budgets.js";
export async function loadBrowserOwnership() {
    return readJsonFile(getOwnershipLockPath());
}
export async function reapExpiredBrowserOwnership() {
    const existing = await loadBrowserOwnership();
    if (!existing) {
        return false;
    }
    if (existing.task_id === "released" && existing.owner === "scout") {
        return false;
    }
    if (new Date(existing.expires_at).getTime() > Date.now()) {
        return false;
    }
    await releaseBrowserOwnership();
    return true;
}
export async function acquireBrowserOwnership(owner, taskId, ttlMs = BOUNDED_WORKER_LEASE_TTL_MS) {
    const lockPath = getOwnershipLockPath();
    const existing = await readJsonFile(lockPath);
    if (existing && new Date(existing.expires_at).getTime() > Date.now()) {
        throw new Error(`Browser is currently owned by ${existing.owner} for task ${existing.task_id} until ${existing.expires_at}.`);
    }
    const now = Date.now();
    await writeJsonFile(lockPath, {
        owner,
        task_id: taskId,
        acquired_at: new Date(now).toISOString(),
        expires_at: new Date(now + ttlMs).toISOString(),
    });
}
export async function releaseBrowserOwnership() {
    await writeJsonFile(getOwnershipLockPath(), {
        owner: "scout",
        task_id: "released",
        acquired_at: new Date(0).toISOString(),
        expires_at: new Date(0).toISOString(),
    });
}
