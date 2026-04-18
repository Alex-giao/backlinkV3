import { repartitionRetryDecisionTasks } from "../control-plane/task-queue.js";
import { probeRuntimeHealth } from "../shared/runtime-health.js";
export async function runRepartitionRetryDecisionsCommand(args) {
    const runtimeHealth = await probeRuntimeHealth(args.cdpUrl);
    const result = await repartitionRetryDecisionTasks({
        apply: args.apply,
        limit: args.limit,
        runtimeHealth,
        scope: {
            taskIdPrefix: args.taskIdPrefix,
            promotedHostname: args.promotedHostname,
            promotedUrl: args.promotedUrl,
        },
        applyBuckets: args.applyBuckets,
        maxApply: args.maxApply,
    });
    console.log(JSON.stringify({
        ok: true,
        mode: args.apply ? "apply" : "dry-run",
        inspected: result.inspected,
        changed: result.changed,
        runtime_health: runtimeHealth,
        by_bucket: result.byBucket,
        preview: result.plans.slice(0, 30),
    }, null, 2));
}
