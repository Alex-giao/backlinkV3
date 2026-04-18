import { runPreflight } from "./preflight.js";
import { resolveBrowserRuntime } from "./browser-runtime.js";

export interface RuntimeHealthSummary {
  healthy: boolean;
  summary: string;
  source?: string;
  checks?: {
    cdp_runtime: boolean;
    playwright: boolean;
    browser_use_cli: boolean;
    agent_backend: boolean;
    gog: boolean;
  };
}

export async function probeRuntimeHealth(cdpUrl?: string): Promise<RuntimeHealthSummary> {
  try {
    const runtime = await resolveBrowserRuntime(cdpUrl);
    const preflight = await runPreflight(runtime);
    const checks = {
      cdp_runtime: preflight.preflight_checks.cdp_runtime.ok,
      playwright: preflight.preflight_checks.playwright.ok,
      browser_use_cli: preflight.preflight_checks.browser_use_cli.ok,
      agent_backend: preflight.preflight_checks.agent_backend.ok,
      gog: preflight.preflight_checks.gog.ok,
    };
    const healthy = preflight.ok && checks.browser_use_cli && checks.agent_backend;
    const summary = healthy
      ? `runtime ok via ${preflight.source}`
      : `runtime unhealthy: cdp=${checks.cdp_runtime}, playwright=${checks.playwright}, browser_use=${checks.browser_use_cli}, agent=${checks.agent_backend}, gog=${checks.gog}`;
    return {
      healthy,
      summary,
      source: preflight.source,
      checks,
    };
  } catch (error) {
    return {
      healthy: false,
      summary: error instanceof Error ? error.message : "runtime health probe failed",
    };
  }
}
