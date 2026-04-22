import { runFollowUpTick } from "../control-plane/follow-up-tick.js";

export async function runFollowUpTickCommand(args: {
  owner: string;
  taskIdPrefix?: string;
  promotedHostname?: string;
  promotedUrl?: string;
}): Promise<void> {
  const result = await runFollowUpTick(args);
  console.log(JSON.stringify(result, null, 2));
}
