import type { BrowserRuntime, BrowserRuntimeSource } from "./types.js";

export const DEFAULT_CDP_URL = "http://127.0.0.1:9333";
const EXTERNAL_CDP_PORTS = [9222, 9223, 9224, 9229];
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost"];

function serializeUrlPreservingBareOrigin(parsed: URL): string {
  const serialized = parsed.toString();
  if (!parsed.search && !parsed.hash && parsed.pathname === "/") {
    return serialized.replace(/\/$/, "");
  }
  return serialized;
}

function normalizeLoopbackCdpUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return rawUrl;
    }
    if (parsed.hostname !== "localhost") {
      return rawUrl;
    }
    parsed.hostname = "127.0.0.1";
    return serializeUrlPreservingBareOrigin(parsed);
  } catch {
    return rawUrl;
  }
}

function hostPreference(cdpUrl: string): number {
  try {
    const parsed = new URL(cdpUrl);
    if (parsed.hostname === "127.0.0.1") {
      return 0;
    }
    if (parsed.hostname === "localhost") {
      return 1;
    }
  } catch {
    // Ignore parse failures and keep a neutral preference.
  }
  return 2;
}

const RUNTIME_ENV_PRIORITY: Array<{
  key: BrowserRuntimeSource;
  value: string | undefined;
}> = [
  { key: "BACKLINK_BROWSER_CDP_URL", value: process.env.BACKLINK_BROWSER_CDP_URL },
  { key: "BROWSER_USE_CDP_URL", value: process.env.BROWSER_USE_CDP_URL },
  { key: "CHROME_CDP_URL", value: process.env.CHROME_CDP_URL },
];

interface BrowserMetadata {
  browser_name: string;
  protocol_version: string;
}

interface CdpEndpointMetadata {
  browser_name?: string;
  user_agent?: string;
}

async function probeCdpEndpoint(cdpUrl: string): Promise<CdpEndpointMetadata | undefined> {
  if (!cdpUrl.startsWith("http://") && !cdpUrl.startsWith("https://")) {
    return {};
  }

  try {
    const response = await fetch(new URL("/json/version", cdpUrl), {
      signal: AbortSignal.timeout(1_500),
    });

    if (!response.ok) {
      return undefined;
    }

    const payload = (await response.json()) as {
      Browser?: string;
      "User-Agent"?: string;
    };

    if (!payload.Browser) {
      return undefined;
    }

    return {
      browser_name: payload.Browser,
      user_agent: payload["User-Agent"],
    };
  } catch {
    return undefined;
  }
}

function scoreExternalCandidate(metadata: CdpEndpointMetadata): number {
  const userAgent = metadata.user_agent ?? "";
  return userAgent.includes("HeadlessChrome") ? 0 : 10;
}

async function autodiscoverExternalCdpUrl(): Promise<string | undefined> {
  const candidates = new Map<string, number>();

  for (const port of EXTERNAL_CDP_PORTS) {
    for (const host of LOOPBACK_HOSTS) {
      const candidate = `http://${host}:${port}`;
      const metadata = await probeCdpEndpoint(candidate);
      if (metadata) {
        const normalizedCandidate = normalizeLoopbackCdpUrl(candidate);
        const score = scoreExternalCandidate(metadata);
        const existingScore = candidates.get(normalizedCandidate);
        if (existingScore === undefined || score > existingScore) {
          candidates.set(normalizedCandidate, score);
        }
      }
    }
  }

  const ranked = [...candidates.entries()]
    .map(([cdpUrl, score]) => ({ cdpUrl, score }))
    .sort((left, right) => right.score - left.score || hostPreference(left.cdpUrl) - hostPreference(right.cdpUrl));
  return ranked[0]?.cdpUrl;
}

export async function resolveCdpUrl(cliValue?: string): Promise<{
  cdpUrl: string;
  source: BrowserRuntimeSource;
}> {
  if (cliValue) {
    return {
      cdpUrl: normalizeLoopbackCdpUrl(cliValue),
      source: "cli",
    };
  }

  const match = RUNTIME_ENV_PRIORITY.find((candidate) => candidate.value);
  if (match?.value) {
    return {
      cdpUrl: normalizeLoopbackCdpUrl(match.value),
      source: match.key,
    };
  }

  const autodiscovered = await autodiscoverExternalCdpUrl();
  if (autodiscovered) {
    return {
      cdpUrl: autodiscovered,
      source: "autodiscovered_external",
    };
  }

  return {
    cdpUrl: normalizeLoopbackCdpUrl(DEFAULT_CDP_URL),
    source: "default_local",
  };
}

async function fetchBrowserMetadata(cdpUrl: string): Promise<BrowserMetadata> {
  if (!cdpUrl.startsWith("http://") && !cdpUrl.startsWith("https://")) {
    return {
      browser_name: "unknown",
      protocol_version: "unknown",
    };
  }

  try {
    const metadataUrl = new URL("/json/version", cdpUrl);
    const response = await fetch(metadataUrl, {
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      return {
        browser_name: "unknown",
        protocol_version: "unknown",
      };
    }

    const payload = (await response.json()) as {
      Browser?: string;
      "Protocol-Version"?: string;
    };

    return {
      browser_name: payload.Browser ?? "unknown",
      protocol_version: payload["Protocol-Version"] ?? "unknown",
    };
  } catch {
    return {
      browser_name: "unknown",
      protocol_version: "unknown",
    };
  }
}

export async function resolveBrowserRuntime(
  cliCdpUrl?: string,
): Promise<BrowserRuntime> {
  const { cdpUrl, source } = await resolveCdpUrl(cliCdpUrl);
  const metadata = await fetchBrowserMetadata(cdpUrl);

  return {
    cdp_url: cdpUrl,
    ok: false,
    source,
    browser_name: metadata.browser_name,
    protocol_version: metadata.protocol_version,
    preflight_checks: {
      cdp_runtime: { ok: false, detail: "Not checked yet." },
      playwright: { ok: false, detail: "Not checked yet." },
      browser_use_cli: { ok: false, detail: "Not checked yet." },
      agent_backend: { ok: false, detail: "Not checked yet." },
      gog: { ok: false, detail: "Not checked yet." },
    },
  };
}
