import { runInitGate } from "../control-plane/init-gate.js";
import { claimNextTask } from "../control-plane/task-queue.js";
export async function runClaimNextTaskCommand(args) {
    if (args.requireCompleteProfile && (args.promotedUrl || args.promotedHostname)) {
        const gate = await runInitGate({
            promotedUrl: args.promotedUrl,
            promotedHostname: args.promotedHostname,
            mode: args.initGateMode ?? "unattended",
        });
        if (gate.blocking) {
            console.log(JSON.stringify({ mode: "blocked_by_init_gate", init_gate: gate }, null, 2));
            return;
        }
    }
    const result = await claimNextTask({
        owner: args.owner,
        scope: {
            taskIdPrefix: args.taskIdPrefix,
            promotedHostname: args.promotedHostname,
            promotedUrl: args.promotedUrl,
        },
    });
    console.log(JSON.stringify(result, null, 2));
}
