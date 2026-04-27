import { ensureDataDirectories, listTargetSites, loadTask, saveTask, saveWorkerLease, loadWorkerLease, clearWorkerLeaseForTask, upsertTargetSite } from "../memory/data-store.js";
function buildSmokeTask() {
    const now = new Date().toISOString();
    return {
        id: `db-smoke-${Date.now()}`,
        target_url: "https://example.com/backlink-submit",
        hostname: "example.com",
        flow_family: "saas_directory",
        flow_family_source: "explicit",
        flow_family_reason: "DB smoke test task.",
        flow_family_updated_at: now,
        enqueued_by: "db-smoke",
        submission: {
            promoted_profile: {
                url: "https://exactstatement.com/",
                hostname: "exactstatement.com",
                name: "Exact Statement",
                description: "Bank statement PDF converter smoke profile.",
                category_hints: ["finance"],
                source: "cli",
            },
            confirm_submit: false,
        },
        status: "SKIPPED",
        created_at: now,
        updated_at: now,
        run_count: 0,
        escalation_level: "none",
        takeover_attempts: 0,
        queue_priority_score: 1,
        phase_history: [],
        latest_artifacts: [],
        notes: ["Created by db-smoke; intentionally non-claimable and safe to delete."],
    };
}
export async function runDbSmokeCommand() {
    await ensureDataDirectories();
    const task = buildSmokeTask();
    await saveTask(task);
    const loadedTask = await loadTask(task.id);
    const lease = {
        task_id: task.id,
        owner: "db-smoke",
        acquired_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        group: "active",
        lane: "active_any",
    };
    await saveWorkerLease(lease);
    const loadedLease = await loadWorkerLease("active");
    const leaseCleared = await clearWorkerLeaseForTask(task.id);
    await upsertTargetSite({
        target_url: "https://example.com/backlink-submit",
        hostname: "example.com",
        source: "db-smoke",
        flow_family_hint: "saas_directory",
        submit_status: "skipped",
        imported_at: new Date().toISOString(),
        last_task_id: task.id,
        payload: { smoke: true },
    });
    const targetSites = await listTargetSites(5);
    console.log(JSON.stringify({
        ok: Boolean(loadedTask && loadedTask.id === task.id && loadedLease?.task_id === task.id && leaseCleared),
        task_id: task.id,
        loaded_task: loadedTask?.id,
        loaded_lease_task: loadedLease?.task_id,
        lease_cleared: leaseCleared,
        target_sites_sample: targetSites.length,
    }, null, 2));
}
