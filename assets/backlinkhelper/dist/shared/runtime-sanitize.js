import { readdir } from "node:fs/promises";
import { loadBrowserOwnership } from "../execution/ownership-lock.js";
import { DATA_DIRECTORIES, ensureDataDirectories, getRuntimeRecoveryStatusPath, loadAllWorkerLeases, readJsonFile, writeJsonFile, } from "../memory/data-store.js";
import { resolveBrowserRuntime } from "./browser-runtime.js";
import { runPreflight } from "./preflight.js";
import { inspectBrowserTargetHealth } from "./runtime-health.js";
import { clearRuntimeIncident, loadRuntimeIncident } from "./runtime-incident.js";
export async function loadRuntimeRecoveryStatus() {
    return readJsonFile(getRuntimeRecoveryStatusPath());
}
async function recordRuntimeRecoveryAttempt(attempt) {
    const existing = (await loadRuntimeRecoveryStatus()) ?? { recent_attempts: [] };
    const recentAttempts = [attempt, ...existing.recent_attempts].slice(0, 10);
    await writeJsonFile(getRuntimeRecoveryStatusPath(), {
        last_attempt: attempt,
        recent_attempts: recentAttempts,
    });
}
function isRegularPageTarget(entry) {
    if (entry.type !== "page") {
        return false;
    }
    const url = entry.url ?? "";
    return url.startsWith("http://") || url.startsWith("https://") || url.startsWith("file://");
}
async function listPendingFinalizeArtifacts() {
    try {
        const entries = await readdir(DATA_DIRECTORIES.runtime);
        return entries.filter((entry) => entry.endsWith("-pending-finalize.json"));
    }
    catch {
        return [];
    }
}
async function canSanitizeSharedBrowser() {
    const now = Date.now();
    const leases = await loadAllWorkerLeases();
    for (const lease of Object.values(leases)) {
        if (lease && new Date(lease.expires_at).getTime() > now) {
            return {
                ok: false,
                detail: `Skip sanitize: active worker lease still held by ${lease.owner} for task ${lease.task_id}.`,
            };
        }
    }
    const ownership = await loadBrowserOwnership();
    if (ownership && ownership.task_id !== "released" && new Date(ownership.expires_at).getTime() > now) {
        return {
            ok: false,
            detail: `Skip sanitize: browser ownership still held by ${ownership.owner} for task ${ownership.task_id}.`,
        };
    }
    const pendingFinalizeArtifacts = await listPendingFinalizeArtifacts();
    if (pendingFinalizeArtifacts.length > 0) {
        return {
            ok: false,
            detail: `Skip sanitize: ${pendingFinalizeArtifacts.length} pending finalization payload(s) still exist.`,
        };
    }
    return {
        ok: true,
        detail: "Shared browser sanitize guard passed.",
    };
}
async function listRegularPageTargets(cdpUrl) {
    if (!cdpUrl.startsWith("http://") && !cdpUrl.startsWith("https://")) {
        return [];
    }
    try {
        const response = await fetch(new URL("/json/list", cdpUrl), {
            signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) {
            return [];
        }
        const targets = (await response.json());
        return targets.filter(isRegularPageTarget);
    }
    catch {
        return [];
    }
}
async function closeTarget(cdpUrl, targetId) {
    if (!cdpUrl.startsWith("http://") && !cdpUrl.startsWith("https://")) {
        return false;
    }
    try {
        const response = await fetch(new URL(`/json/close/${encodeURIComponent(targetId)}`, cdpUrl), {
            signal: AbortSignal.timeout(5_000),
        });
        return response.ok;
    }
    catch {
        return false;
    }
}
export async function tryAutoRecoverRuntimeIncident(cdpUrl) {
    await ensureDataDirectories();
    const runtimeIncident = await loadRuntimeIncident();
    if (!runtimeIncident) {
        return {
            recovered: true,
            detail: "No runtime incident is open.",
            sanitized_targets: 0,
        };
    }
    const runtime = await resolveBrowserRuntime(cdpUrl ?? runtimeIncident.cdp_url);
    const persistAttempt = async (result) => {
        await recordRuntimeRecoveryAttempt({
            attempted_at: new Date().toISOString(),
            incident_kind: runtimeIncident.kind,
            recovered: result.recovered,
            detail: result.detail,
            sanitized_targets: result.sanitized_targets,
            browser_state_before: result.browser_state_before,
            browser_state_after: result.browser_state_after,
        });
        return result;
    };
    const guard = await canSanitizeSharedBrowser();
    if (!guard.ok) {
        return persistAttempt({
            recovered: false,
            detail: guard.detail,
            sanitized_targets: 0,
            runtime_incident: runtimeIncident,
        });
    }
    const browserStateBefore = await inspectBrowserTargetHealth(runtime.cdp_url);
    const regularTargets = await listRegularPageTargets(runtime.cdp_url);
    let sanitizedTargets = 0;
    for (const target of regularTargets) {
        if (!target.id) {
            continue;
        }
        const closed = await closeTarget(runtime.cdp_url, target.id);
        if (closed) {
            sanitizedTargets += 1;
        }
    }
    if (sanitizedTargets > 0) {
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const browserStateAfter = await inspectBrowserTargetHealth(runtime.cdp_url);
    const recoveryProbe = await runPreflight(await resolveBrowserRuntime(runtime.cdp_url), { mode: "full" });
    const recovered = recoveryProbe.preflight_checks.cdp_runtime.ok && recoveryProbe.preflight_checks.playwright.ok;
    if (recovered) {
        await clearRuntimeIncident();
        return persistAttempt({
            recovered: true,
            detail: sanitizedTargets > 0
                ? `Recovered shared browser after closing ${sanitizedTargets} stale regular page target(s).`
                : "Recovered shared browser without needing to close additional regular page targets.",
            sanitized_targets: sanitizedTargets,
            browser_state_before: browserStateBefore,
            browser_state_after: browserStateAfter,
        });
    }
    return persistAttempt({
        recovered: false,
        detail: `Runtime recovery probe still failing after sanitize attempt: ${recoveryProbe.preflight_checks.playwright.detail}`,
        sanitized_targets: sanitizedTargets,
        browser_state_before: browserStateBefore,
        browser_state_after: browserStateAfter,
        runtime_incident: runtimeIncident,
    });
}
