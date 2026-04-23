import { chromium } from "playwright";

import { describeBrowserUseLookup, resolveBrowserUseBin } from "./browser-use-bin.js";
import { runCommand } from "./command.js";
import { detectMailProvider } from "./gog.js";
import type { BrowserRuntime, PreflightCheckResult } from "./types.js";

interface CdpProbeResult {
  ok: boolean;
  browser_name?: string;
  browser_id?: string;
  status?: number;
  error?: string;
}

function extractBrowserDebuggerId(webSocketDebuggerUrl?: string): string | undefined {
  if (!webSocketDebuggerUrl) {
    return undefined;
  }

  const match = webSocketDebuggerUrl.match(/\/devtools\/browser\/([^/?#]+)/);
  return match?.[1];
}

async function probeCdpVersion(cdpUrl: string): Promise<CdpProbeResult> {
  try {
    const response = await fetch(new URL("/json/version", cdpUrl), {
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
      };
    }

    const payload = (await response.json()) as { Browser?: string; webSocketDebuggerUrl?: string };
    return {
      ok: true,
      browser_name: payload.Browser,
      browser_id: extractBrowserDebuggerId(payload.webSocketDebuggerUrl),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to connect to CDP metadata endpoint.",
    };
  }
}

function getAlternateLoopbackUrl(cdpUrl: string): string | undefined {
  if (!cdpUrl.startsWith("http://") && !cdpUrl.startsWith("https://")) {
    return undefined;
  }

  const parsed = new URL(cdpUrl);
  if (parsed.hostname === "127.0.0.1") {
    parsed.hostname = "localhost";
    return parsed.toString().replace(/\/$/, "");
  }

  if (parsed.hostname === "localhost") {
    parsed.hostname = "127.0.0.1";
    return parsed.toString().replace(/\/$/, "");
  }

  return undefined;
}

async function getLoopbackConflictHint(cdpUrl: string): Promise<string> {
  const alternateUrl = getAlternateLoopbackUrl(cdpUrl);
  if (!alternateUrl) {
    return "";
  }

  const [primaryProbe, alternateProbe] = await Promise.all([
    probeCdpVersion(cdpUrl),
    probeCdpVersion(alternateUrl),
  ]);
  if (!alternateProbe.ok) {
    return "";
  }

  if (
    primaryProbe.ok &&
    primaryProbe.browser_id &&
    alternateProbe.browser_id &&
    primaryProbe.browser_id === alternateProbe.browser_id
  ) {
    return "";
  }

  return ` The alternate loopback host ${alternateUrl} responded as ${alternateProbe.browser_name ?? "a DevTools endpoint"}. Another browser instance is likely occupying one loopback listener. Use ${alternateUrl} directly or restart on a clean port.`;
}

async function checkCdpRuntime(cdpUrl: string): Promise<PreflightCheckResult> {
  if (!cdpUrl.startsWith("http://") && !cdpUrl.startsWith("https://")) {
    return {
      ok: true,
      detail: "CDP URL uses ws:// or wss://. Metadata fetch skipped.",
    };
  }

  const probe = await probeCdpVersion(cdpUrl);
  if (probe.ok) {
    return {
      ok: true,
      detail: `Connected to ${probe.browser_name ?? "browser"} via /json/version.`,
    };
  }

  const loopbackHint = await getLoopbackConflictHint(cdpUrl);
  if (probe.status) {
    return {
      ok: false,
      detail: `CDP metadata endpoint returned ${probe.status}.${loopbackHint}`,
    };
  }

  return {
    ok: false,
    detail: `${probe.error ?? "Failed to connect to CDP metadata endpoint."}${loopbackHint}`,
  };
}

async function checkBrowserUseCli(): Promise<PreflightCheckResult> {
  const browserUseBin = resolveBrowserUseBin();
  const result = await runCommand("which", [browserUseBin]);
  if (result.exit_code !== 0) {
    return {
      ok: false,
      detail: describeBrowserUseLookup(),
    };
  }

  return {
    ok: true,
    detail: `browser-use CLI detected at ${result.stdout.trim()}.`,
  };
}

export async function checkPlaywright(
  cdpUrl: string,
  options: {
    mode?: "full" | "skip";
  } = {},
): Promise<PreflightCheckResult> {
  if (options.mode === "skip") {
    return {
      ok: true,
      detail: "Skipped full Playwright attach check in light preflight mode.",
    };
  }

  try {
    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    const currentUrl = page?.url() ?? "about:blank";
    await browser.close();

    return {
      ok: true,
      detail: `Playwright connected successfully. Current page: ${currentUrl}`,
    };
  } catch (error) {
    const loopbackHint = await getLoopbackConflictHint(cdpUrl);
    return {
      ok: false,
      detail: `${error instanceof Error ? error.message : "Playwright could not connect over CDP."}${loopbackHint}`,
    };
  }
}

async function checkGog(): Promise<PreflightCheckResult> {
  const status = await detectMailProvider();
  return {
    ok: status.ok,
    detail: status.detail,
  };
}

async function checkAgentBackend(): Promise<PreflightCheckResult> {
  return {
    ok: true,
    detail:
      "Operator-only mode: repo-native OpenAI agent backend is disabled. Use Codex/OpenClaw operator flow (claim-next-task -> task-prepare -> task-record-agent-trace -> task-finalize).",
  };
}

export async function runPreflight(
  runtime: BrowserRuntime,
  options: {
    mode?: "full" | "light";
  } = {},
): Promise<BrowserRuntime> {
  const cdp_runtime = await checkCdpRuntime(runtime.cdp_url);
  const playwright = await checkPlaywright(runtime.cdp_url, {
    mode: options.mode === "light" ? "skip" : "full",
  });
  const browser_use_cli = await checkBrowserUseCli();
  const agent_backend = await checkAgentBackend();
  const gog = await checkGog();

  return {
    ...runtime,
    ok: cdp_runtime.ok && playwright.ok,
    preflight_checks: {
      cdp_runtime,
      playwright,
      browser_use_cli,
      agent_backend,
      gog,
    },
  };
}
