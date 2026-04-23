import { loadRuntimeIncident, type RuntimeIncident } from "./runtime-incident.js";
import { loadRuntimeRecoveryStatus, type RuntimeRecoveryStatus } from "./runtime-sanitize.js";
import { runPreflight } from "./preflight.js";
import { resolveBrowserRuntime } from "./browser-runtime.js";

export interface BrowserTargetHealth {
  ok: boolean;
  detail: string;
  total_targets: number;
  page_targets: number;
  regular_page_targets: number;
  suspicious: boolean;
}

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
  browser_state?: BrowserTargetHealth;
  runtime_incident?: RuntimeIncident;
  recovery_status?: RuntimeRecoveryStatus;
}

function isRegularPageTarget(entry: { type?: string; url?: string }): boolean {
  if (entry.type !== "page") {
    return false;
  }

  const url = entry.url ?? "";
  return url.startsWith("http://") || url.startsWith("https://") || url.startsWith("file://");
}

export async function inspectBrowserTargetHealth(cdpUrl: string): Promise<BrowserTargetHealth> {
  if (!cdpUrl.startsWith("http://") && !cdpUrl.startsWith("https://")) {
    return {
      ok: true,
      detail: "Target graph inspection skipped for websocket CDP URLs.",
      total_targets: 0,
      page_targets: 0,
      regular_page_targets: 0,
      suspicious: false,
    };
  }

  try {
    const response = await fetch(new URL("/json/list", cdpUrl), {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return {
        ok: false,
        detail: `Target graph inspection returned ${response.status}.`,
        total_targets: 0,
        page_targets: 0,
        regular_page_targets: 0,
        suspicious: false,
      };
    }

    const targets = (await response.json()) as Array<{ type?: string; url?: string }>;
    const pageTargets = targets.filter((target) => target.type === "page");
    const regularPageTargets = pageTargets.filter(isRegularPageTarget);
    const suspicious = regularPageTargets.length >= 3;

    return {
      ok: true,
      detail: suspicious
        ? `Shared browser retains ${regularPageTargets.length} regular pages; suspect retained regular pages / target pollution.`
        : `Shared browser target graph looks bounded (${pageTargets.length} page targets, ${regularPageTargets.length} regular pages).`,
      total_targets: targets.length,
      page_targets: pageTargets.length,
      regular_page_targets: regularPageTargets.length,
      suspicious,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : "Target graph inspection failed.",
      total_targets: 0,
      page_targets: 0,
      regular_page_targets: 0,
      suspicious: false,
    };
  }
}

export async function probeRuntimeHealth(
  cdpUrl?: string,
  options: {
    mode?: "full" | "light";
  } = {},
): Promise<RuntimeHealthSummary> {
  try {
    const runtime = await resolveBrowserRuntime(cdpUrl);
    const [preflight, browserState, runtimeIncident, recoveryStatus] = await Promise.all([
      runPreflight(runtime, { mode: options.mode ?? "light" }),
      inspectBrowserTargetHealth(runtime.cdp_url),
      loadRuntimeIncident(),
      loadRuntimeRecoveryStatus(),
    ]);
    const checks = {
      cdp_runtime: preflight.preflight_checks.cdp_runtime.ok,
      playwright: preflight.preflight_checks.playwright.ok,
      browser_use_cli: preflight.preflight_checks.browser_use_cli.ok,
      agent_backend: preflight.preflight_checks.agent_backend.ok,
      gog: preflight.preflight_checks.gog.ok,
    };
    const healthy = preflight.ok && checks.browser_use_cli && checks.agent_backend && !runtimeIncident;
    const summaryParts = [
      healthy
        ? `runtime ok via ${preflight.source}`
        : `runtime unhealthy: cdp=${checks.cdp_runtime}, playwright=${checks.playwright}, browser_use=${checks.browser_use_cli}, agent=${checks.agent_backend}, gog=${checks.gog}`,
    ];
    if (browserState.suspicious) {
      summaryParts.push(browserState.detail);
    }
    if (runtimeIncident) {
      summaryParts.push(`circuit breaker open: ${runtimeIncident.kind} from ${runtimeIncident.source}`);
    }
    if (recoveryStatus?.last_attempt) {
      summaryParts.push(
        `last recovery ${recoveryStatus.last_attempt.recovered ? "recovered" : "failed"}: ${recoveryStatus.last_attempt.detail}`,
      );
    }
    return {
      healthy,
      summary: summaryParts.join("; "),
      source: preflight.source,
      checks,
      browser_state: browserState,
      runtime_incident: runtimeIncident,
      recovery_status: recoveryStatus,
    };
  } catch (error) {
    return {
      healthy: false,
      summary: error instanceof Error ? error.message : "runtime health probe failed",
    };
  }
}
