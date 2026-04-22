import { runInitGate } from "../control-plane/init-gate.js";
import { claimNextTask } from "../control-plane/task-queue.js";
import type { ClaimLane, InitGateMode } from "../shared/types.js";

export async function runClaimNextTaskCommand(args: {
  owner: string;
  taskIdPrefix?: string;
  promotedHostname?: string;
  promotedUrl?: string;
  requireCompleteProfile?: boolean;
  initGateMode?: InitGateMode;
  lane?: ClaimLane;
}): Promise<void> {
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
    lane: args.lane,
    scope: {
      taskIdPrefix: args.taskIdPrefix,
      promotedHostname: args.promotedHostname,
      promotedUrl: args.promotedUrl,
    },
  });
  console.log(JSON.stringify(result, null, 2));
}
