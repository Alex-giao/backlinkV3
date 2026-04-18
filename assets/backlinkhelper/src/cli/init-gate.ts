import { runInitGate } from "../control-plane/init-gate.js";
import type { InitGateMode } from "../shared/types.js";

export async function runInitGateCommand(args: {
  promotedUrl?: string;
  promotedHostname?: string;
  mode: InitGateMode;
}): Promise<void> {
  const result = await runInitGate({
    promotedUrl: args.promotedUrl,
    promotedHostname: args.promotedHostname,
    mode: args.mode,
  });
  console.log(JSON.stringify(result, null, 2));
}
