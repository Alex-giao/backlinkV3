import { runUnattendedScopeTick } from "../control-plane/unattended-scope-tick.js";
import type { ClaimLane, FlowFamily } from "../shared/types.js";

export async function runUnattendedScopeTickCommand(args: {
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
  dryRun?: boolean;
}): Promise<void> {
  const result = await runUnattendedScopeTick(args);
  console.log(JSON.stringify(result, null, 2));
}
