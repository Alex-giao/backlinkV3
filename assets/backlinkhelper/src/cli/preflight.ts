import { ensureDataDirectories, writeJsonFile } from "../memory/data-store.js";
import { resolveBrowserRuntime } from "../shared/browser-runtime.js";
import { runPreflight } from "../shared/preflight.js";

export async function runPreflightCommand(args: { cdpUrl?: string }): Promise<void> {
  await ensureDataDirectories();
  const runtime = await runPreflight(await resolveBrowserRuntime(args.cdpUrl));
  const manifestPath = "data/backlink-helper/runs/latest-preflight.json";
  await writeJsonFile(manifestPath, runtime);
  console.log(JSON.stringify(runtime, null, 2));
  console.log(`\nWrote preflight manifest to ${manifestPath}`);
}
