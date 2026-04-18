import { ensureOpenClawCron } from "../control-plane/openclaw-cron.js";

export async function runEnsureOpenClawCronCommand(args: {
  name: string;
  every: string;
  cdpUrl: string;
  timeoutSeconds: number;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  owner: string;
  model?: string;
  deliver: boolean;
  channel?: string;
  to?: string;
  dryRun?: boolean;
}): Promise<void> {
  const result = await ensureOpenClawCron(args);
  console.log(JSON.stringify(result, null, 2));
}
