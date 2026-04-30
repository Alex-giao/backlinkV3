import path from "node:path";

import { buildScoutActionCandidates, type RawActionCandidate } from "./action-candidates.js";
import { getFamilyConfig } from "../families/index.js";
import type { FamilyConfig } from "../families/types.js";
import { DATA_DIRECTORIES } from "../memory/data-store.js";
import { inferPageAssessment } from "../shared/page-assessment.js";
import { PlaywrightSessionTimeoutError, withConnectedPage } from "../shared/playwright-session.js";
import { safeSameSiteSiblingNavigation } from "./site-scope.js";
import type {
  BrowserRuntime,
  PageSnapshot,
  ScoutEmbedHint,
  ScoutLinkCandidate,
  ScoutResult,
  TaskRecord,
} from "../shared/types.js";

function extractHints(text: string, familyConfig: FamilyConfig): {
  field_hints: string[];
  auth_hints: string[];
  anti_bot_hints: string[];
  evidence_sufficiency: boolean;
} {
  const normalized = text.toLowerCase();

  const field_hints = familyConfig.scout.fieldHints.filter((hint) => normalized.includes(hint));
  const auth_hints = familyConfig.scout.authHints.filter((hint) => normalized.includes(hint));
  const anti_bot_hints = familyConfig.scout.antiBotHints.filter((hint) => normalized.includes(hint));

  const evidence_sufficiency =
    familyConfig.scout.evidenceSignals.some((signal) => normalized.includes(signal)) || field_hints.length > 0;

  return {
    field_hints,
    auth_hints,
    anti_bot_hints,
    evidence_sufficiency,
  };
}

async function collectVisibleSurfaceText(
  root: import("playwright").Page | import("playwright").Frame,
): Promise<string> {
  return root
    .locator("form, input, textarea, select, button, [role=button], a[href]")
    .evaluateAll((elements) => {
      const values: string[] = [];
      for (const element of elements) {
        const visible = Boolean((element as HTMLElement).offsetWidth || (element as HTMLElement).offsetHeight || element.getClientRects().length);
        if (!visible) {
          continue;
        }
        if (element.closest("footer")) {
          continue;
        }
        const tag = element.tagName.toLowerCase();
        const placeholder = element.getAttribute("placeholder");
        const normalizedPlaceholder = (placeholder ?? "").trim();
        const safePlaceholder =
          normalizedPlaceholder.includes("@") || /^https?:\/\//i.test(normalizedPlaceholder)
            ? undefined
            : normalizedPlaceholder;
        const text = [
          (element as HTMLElement).innerText,
          element.getAttribute("aria-label"),
          safePlaceholder,
          element.getAttribute("name"),
          element.getAttribute("id"),
        ]
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (!text) {
          continue;
        }
        values.push(`${tag}: ${text}`);
      }
      return values.join("\n");
    })
    .catch(() => "");
}

async function collectActionCandidates(
  root: import("playwright").Page | import("playwright").Frame,
): Promise<{ submitCandidates: string[]; ctaCandidates: string[]; linkCandidates: ScoutLinkCandidate[] }> {
  const currentUrl = root.url();
  const rawCandidates = await root
    .locator('a[href], button, [role="button"], input[type="submit"], input[type="button"]')
    .evaluateAll((elements) => {
      const rows: RawActionCandidate[] = [];
      for (const element of elements) {
        const htmlElement = element as HTMLElement;
        const visible = Boolean(htmlElement.offsetWidth || htmlElement.offsetHeight || htmlElement.getClientRects().length);
        const areaTag = element.closest("header, nav, main, footer")?.tagName.toLowerCase();
        const area: RawActionCandidate["area"] = areaTag === "header" || areaTag === "nav"
          ? "header"
          : areaTag === "footer"
            ? "footer"
            : areaTag === "main"
              ? "main"
              : "unknown";
        const href = element instanceof HTMLAnchorElement ? element.href : "";
        const top = Math.round(htmlElement.getBoundingClientRect().top);
        let sameOrigin = false;
        let samePage = false;
        let path = "";
        if (href) {
          try {
            const resolved = new URL(href, location.href);
            sameOrigin = resolved.origin === location.origin;
            samePage = sameOrigin && resolved.pathname === location.pathname && resolved.search === location.search;
            path = resolved.pathname;
          } catch {
            path = "";
          }
        }
        rows.push({
          tag: element.tagName.toLowerCase(),
          text: (htmlElement.innerText || (element as HTMLInputElement).value || "").replace(/\s+/g, " ").trim(),
          href,
          input_type: element instanceof HTMLInputElement ? element.type : undefined,
          button_type: element instanceof HTMLButtonElement ? element.type : undefined,
          visible,
          disabled:
            (element instanceof HTMLInputElement || element instanceof HTMLButtonElement)
              ? element.disabled
              : element.getAttribute("aria-disabled") === "true",
          inside_form: Boolean(element.closest("form")),
          area,
          same_origin: sameOrigin,
          same_page: samePage,
          path,
          top,
        });
      }
      return rows;
    })
    .catch(() => [] as RawActionCandidate[]);

  return buildScoutActionCandidates(
    rawCandidates.map((candidate) => ({
      ...candidate,
      same_site: candidate.href
        ? safeSameSiteSiblingNavigation({ currentUrl, candidateUrl: candidate.href })
        : false,
    })),
  );
}

function inferEmbedProvider(args: {
  frameUrl: string;
  frameTitle?: string;
  bodyText: string;
}): ScoutEmbedHint["provider"] {
  const combined = `${args.frameUrl}\n${args.frameTitle ?? ""}\n${args.bodyText}`.toLowerCase();
  if (combined.includes("typeform")) {
    return "typeform";
  }
  if (combined.includes("tally")) {
    return "tally";
  }
  if (combined.includes("jotform")) {
    return "jotform";
  }
  if (combined.includes("hubspot")) {
    return "hubspot";
  }
  if (combined.includes("docs.google.com/forms") || combined.includes("google form")) {
    return "google_forms";
  }
  if (combined.includes("airtable")) {
    return "airtable_form";
  }
  if (combined.includes("fillout")) {
    return "fillout";
  }
  if (combined.includes("recaptcha") || combined.includes("verify you are human")) {
    return "recaptcha";
  }
  return "unknown";
}

const TRACKING_QUERY_PREFIXES = ["utm_"];
const TRACKING_QUERY_KEYS = new Set(["ref", "fbclid", "gclid", "mc_cid", "mc_eid"]);

function uniquePush(values: string[], candidate: string): void {
  if (!values.includes(candidate)) {
    values.push(candidate);
  }
}

function stripTrackingQuery(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
      const normalized = key.toLowerCase();
      if (TRACKING_QUERY_KEYS.has(normalized) || TRACKING_QUERY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
        url.searchParams.delete(key);
        changed = true;
      }
    }
    return changed ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function withoutHash(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    if (!url.hash) return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function withHttps(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:") return undefined;
    url.protocol = "https:";
    return url.href;
  } catch {
    return undefined;
  }
}

export function generateScoutNavigationCandidates(targetUrl: string): string[] {
  const candidates: string[] = [];
  uniquePush(candidates, targetUrl);

  const directHttps = withHttps(targetUrl);
  if (directHttps) uniquePush(candidates, directHttps);

  const strippedTracking = stripTrackingQuery(targetUrl);
  if (strippedTracking) {
    uniquePush(candidates, strippedTracking);
    const strippedHttps = withHttps(strippedTracking);
    if (strippedHttps) uniquePush(candidates, strippedHttps);
  }

  for (const candidate of [...candidates]) {
    try {
      const parsed = new URL(candidate);
      if (parsed.search) continue;
    } catch {
      continue;
    }
    const noHash = withoutHash(candidate);
    if (noHash) uniquePush(candidates, noHash);
  }

  return candidates;
}

function normalizeFrameUrl(src: string | null, pageUrl: string): string {
  if (!src) {
    return "";
  }

  try {
    return new URL(src, pageUrl).href;
  } catch {
    return src;
  }
}

function findMatchingFrame(args: {
  page: import("playwright").Page;
  frameUrl: string;
}): import("playwright").Frame | undefined {
  const normalizedTarget = args.frameUrl.replace(/#.*$/, "");
  return args.page.frames().find((frame) => {
    const candidate = frame.url().replace(/#.*$/, "");
    return candidate === normalizedTarget || candidate.startsWith(normalizedTarget) || normalizedTarget.startsWith(candidate);
  });
}

async function collectEmbedHints(args: {
  page: import("playwright").Page;
  task: TaskRecord;
  familyConfig: FamilyConfig;
}): Promise<ScoutEmbedHint[]> {
  const hints: ScoutEmbedHint[] = [];
  const iframes = args.page.locator("iframe");
  const count = await iframes.count();

  for (let index = 0; index < Math.min(count, 8); index += 1) {
    const iframe = iframes.nth(index);
    const visible = await iframe.isVisible().catch(() => false);
    const frameTitle = (await iframe.getAttribute("title").catch(() => null)) ?? undefined;
    const frameUrl = normalizeFrameUrl(await iframe.getAttribute("src").catch(() => null), args.page.url());
    const matchedFrame = frameUrl ? findMatchingFrame({ page: args.page, frameUrl }) : undefined;

    let bodyText = "";
    if (matchedFrame) {
      bodyText = await matchedFrame.locator("body").innerText().catch(() => "");
    }

    const provider = inferEmbedProvider({ frameUrl, frameTitle, bodyText });
    const candidateSignals = matchedFrame ? await collectActionCandidates(matchedFrame).catch(() => ({ submitCandidates: [], ctaCandidates: [], linkCandidates: [] })) : {
      submitCandidates: [],
      ctaCandidates: [],
      linkCandidates: [],
    };
    const likelyInteractive =
      provider !== "recaptcha" &&
      (frameUrl.includes("embed-widget") ||
        candidateSignals.submitCandidates.length > 0 ||
        candidateSignals.ctaCandidates.length > 0 ||
        /tool|listing|start/i.test(bodyText));

    if (!visible && provider === "unknown" && candidateSignals.submitCandidates.length === 0 && candidateSignals.ctaCandidates.length === 0) {
      continue;
    }

    if (!frameUrl && provider === "unknown" && bodyText.trim().length === 0) {
      continue;
    }

    let screenshotRef: string | undefined;
    if (visible && (provider !== "unknown" || likelyInteractive || bodyText.trim().length > 0)) {
      screenshotRef = path.join(DATA_DIRECTORIES.artifacts, `${args.task.id}-scout-frame-${index + 1}.png`);
      await iframe.screenshot({ path: screenshotRef }).catch(() => {
        screenshotRef = undefined;
      });
    }

    hints.push({
      frame_index: index + 1,
      provider,
      frame_url: frameUrl,
      frame_title: frameTitle,
      body_text_excerpt: bodyText.slice(0, 2_000),
      cta_candidates: candidateSignals.ctaCandidates,
      submit_candidates: candidateSignals.submitCandidates,
      screenshot_ref: screenshotRef,
      likely_interactive: likelyInteractive,
    });
  }

  return hints;
}

export async function runLightweightScout(args: {
  runtime: BrowserRuntime;
  task: TaskRecord;
}): Promise<ScoutResult> {
  const familyConfig = getFamilyConfig(args.task.flow_family);
  try {
    return await withConnectedPage(
      args.runtime.cdp_url,
      async (page) => {
        const navigationCandidates = generateScoutNavigationCandidates(args.task.target_url);
        const navigationFailures: string[] = [];

        for (const candidateUrl of navigationCandidates) {
          try {
            const response = await page.goto(candidateUrl, {
              waitUntil: "domcontentloaded",
              timeout: 20_000,
            });
            await page.waitForTimeout(1_500).catch(() => undefined);

            const bodyTextExcerpt = await page.locator("body").innerText().catch(() => "");
            const pageScreenshotRef = path.join(DATA_DIRECTORIES.artifacts, `${args.task.id}-scout-page.png`);
            await page.screenshot({ path: pageScreenshotRef, fullPage: true }).catch(() => undefined);

            const snapshot = {
              url: page.url(),
              title: await page.title(),
              response_status: response?.status(),
              body_text_excerpt: bodyTextExcerpt.slice(0, 3_000),
              screenshot_ref: pageScreenshotRef,
            } satisfies PageSnapshot;

            const actionCandidates = await collectActionCandidates(page);
            const embedHints = await collectEmbedHints({ page, task: args.task, familyConfig });
            const embedCombinedText = embedHints
              .map((hint) => `${hint.provider}\n${hint.frame_url}\n${hint.body_text_excerpt}\n${hint.cta_candidates.join("\n")}`)
              .join("\n\n");
            const visibleSurfaceText = await collectVisibleSurfaceText(page);
            const combinedStructuredText = `${visibleSurfaceText}\n${embedCombinedText}`;
            const hints = extractHints(combinedStructuredText, familyConfig);
            const visualProbeRecommended = actionCandidates.submitCandidates.length === 0 && embedHints.some((hint) => hint.likely_interactive);
            const evidenceSufficiency = hints.evidence_sufficiency || visualProbeRecommended || actionCandidates.linkCandidates.length > 0;

            const topInteractiveEmbed = embedHints.find((hint) => hint.likely_interactive);
            const recoveredPrefix = candidateUrl !== args.task.target_url
              ? `Scout recovered from ${args.task.target_url} by loading canonical candidate ${candidateUrl}. `
              : "";
            const surfaceSummary =
              snapshot.response_status && snapshot.response_status >= 500
                ? `${recoveredPrefix}Scout reached ${snapshot.url} but the directory returned upstream status ${snapshot.response_status}.`
                : visualProbeRecommended && topInteractiveEmbed
                  ? `${recoveredPrefix}Scout reached ${snapshot.url} with title "${snapshot.title}" and detected a likely interactive ${topInteractiveEmbed.provider} embed in frame ${topInteractiveEmbed.frame_index}.`
                  : `${recoveredPrefix}Scout reached ${snapshot.url} with title "${snapshot.title}".`;
            const pageAssessment = inferPageAssessment({
              url: snapshot.url,
              title: snapshot.title,
              bodyText: snapshot.body_text_excerpt,
              responseStatus: snapshot.response_status,
              submitCandidates: actionCandidates.submitCandidates,
              fieldHints: hints.field_hints,
              authHints: hints.auth_hints,
              antiBotHints: hints.anti_bot_hints,
              embedHintsCount: embedHints.length,
              visualProbeRecommended,
              flowFamily: args.task.flow_family,
            });

            return {
              ok: true,
              surface_summary: surfaceSummary,
              submit_candidates: actionCandidates.submitCandidates,
              page_snapshot: snapshot,
              embed_hints: embedHints,
              link_candidates: actionCandidates.linkCandidates,
              visual_probe_recommended: visualProbeRecommended,
              page_assessment: pageAssessment,
              ...hints,
              evidence_sufficiency: evidenceSufficiency,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown navigation failure.";
            navigationFailures.push(`${candidateUrl}: ${message}`);
          }
        }

        const message = navigationFailures.join("\n---\n") || "Unknown navigation failure.";
        return {
          ok: false,
          surface_summary: `Scout could not load ${args.task.target_url} after ${navigationCandidates.length} canonical navigation candidate(s): ${message}`,
          submit_candidates: [],
          link_candidates: [],
          page_snapshot: {
            url: args.task.target_url,
            title: "Navigation failed",
            body_text_excerpt: message,
          },
          embed_hints: [],
          visual_probe_recommended: false,
          page_assessment: inferPageAssessment({
            url: args.task.target_url,
            title: "Navigation failed",
            bodyText: message,
            navigationFailed: true,
            flowFamily: args.task.flow_family,
          }),
          field_hints: [],
          auth_hints: [],
          anti_bot_hints: [],
          evidence_sufficiency: false,
        };
      },
      {
        freshPage: true,
        operationTimeoutMs: 45_000,
        pageCloseTimeoutMs: 2_000,
        browserCloseTimeoutMs: 2_000,
      },
    );
  } catch (error) {
    const message =
      error instanceof PlaywrightSessionTimeoutError
        ? `Scout session timed out before the shared CDP page could be released: ${error.message}`
        : error instanceof Error
          ? error.message
          : "Unknown scout session failure.";
    return {
      ok: false,
      surface_summary: `Scout could not finish ${args.task.target_url}: ${message}`,
      submit_candidates: [],
      link_candidates: [],
      page_snapshot: {
        url: args.task.target_url,
        title: "Scout session failed",
        body_text_excerpt: message,
      },
      embed_hints: [],
      visual_probe_recommended: false,
      page_assessment: inferPageAssessment({
        url: args.task.target_url,
        title: "Scout session failed",
        bodyText: message,
        navigationFailed: true,
        flowFamily: args.task.flow_family,
      }),
      field_hints: [],
      auth_hints: [],
      anti_bot_hints: [],
      evidence_sufficiency: false,
    };
  }
}
