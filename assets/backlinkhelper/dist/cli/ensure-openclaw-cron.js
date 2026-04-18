import { ensureOpenClawCron } from "../control-plane/openclaw-cron.js";
export async function runEnsureOpenClawCronCommand(args) {
    const result = await ensureOpenClawCron(args);
    console.log(JSON.stringify(result, null, 2));
}
