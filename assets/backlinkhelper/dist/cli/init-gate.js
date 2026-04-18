import { runInitGate } from "../control-plane/init-gate.js";
export async function runInitGateCommand(args) {
    const result = await runInitGate({
        promotedUrl: args.promotedUrl,
        promotedHostname: args.promotedHostname,
        mode: args.mode,
    });
    console.log(JSON.stringify(result, null, 2));
}
