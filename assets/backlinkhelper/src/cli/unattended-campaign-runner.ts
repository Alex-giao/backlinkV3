import { runUnattendedCampaign } from "../control-plane/unattended-campaign-runner.js";
import type { ClaimLane, FlowFamily } from "../shared/types.js";

export async function runUnattendedCampaignCommand(args: {
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
}): Promise<void> {
  const result = await runUnattendedCampaign(args);
  console.log(JSON.stringify(result, null, 2));
}
