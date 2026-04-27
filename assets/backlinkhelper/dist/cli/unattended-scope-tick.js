import { runUnattendedScopeTick } from "../control-plane/unattended-scope-tick.js";
export async function runUnattendedScopeTickCommand(args) {
    const result = await runUnattendedScopeTick(args);
    console.log(JSON.stringify(result, null, 2));
}
