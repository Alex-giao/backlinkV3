import { buildMissingInputPreflightReport } from "../control-plane/missing-input-preflight.js";

export async function runMissingInputPreflightCommand(args: {
  promotedUrl?: string;
}): Promise<void> {
  const result = await buildMissingInputPreflightReport(args);
  console.log(JSON.stringify(result, null, 2));
}
