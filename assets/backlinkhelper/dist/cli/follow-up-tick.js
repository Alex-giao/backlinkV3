import { runFollowUpTick } from "../control-plane/follow-up-tick.js";
export async function runFollowUpTickCommand(args) {
    const result = await runFollowUpTick(args);
    console.log(JSON.stringify(result, null, 2));
}
