import type { Page } from "playwright";

import type { LinkRelFlag, LinkVerificationResult } from "../shared/types.js";

interface LinkCandidate {
  href: string;
  text?: string;
  rel?: string;
  isVisible: boolean;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^www\./i, "").toLowerCase();
}

function normalizePathname(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  return normalized.toLowerCase();
}

function normalizeComparableUrl(raw: string): { hostname: string; pathname: string } | undefined {
  try {
    const url = new URL(raw);
    return {
      hostname: normalizeHostname(url.hostname),
      pathname: normalizePathname(url.pathname),
    };
  } catch {
    return undefined;
  }
}

export function classifyRel(rel?: string): LinkRelFlag[] {
  const tokens = new Set(
    (rel ?? "")
      .split(/\s+/)
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
  return ["ugc", "sponsored", "nofollow"].filter((flag): flag is LinkRelFlag => tokens.has(flag));
}

function isTargetMatch(candidateHref: string, targetUrl: string): boolean {
  const candidate = normalizeComparableUrl(candidateHref);
  const target = normalizeComparableUrl(targetUrl);
  if (!candidate || !target) {
    return false;
  }
  return candidate.hostname === target.hostname && candidate.pathname === target.pathname;
}

export function verifyLinkCandidates(args: {
  livePageUrl: string;
  targetUrl: string;
  candidates: LinkCandidate[];
}): LinkVerificationResult {
  const matched = args.candidates.filter((candidate) => isTargetMatch(candidate.href, args.targetUrl));
  const preferred = matched.find((candidate) => candidate.isVisible) ?? matched[0];
  const verified_at = new Date().toISOString();

  if (!preferred) {
    return {
      verification_status: "link_missing",
      expected_target_url: args.targetUrl,
      live_page_url: args.livePageUrl,
      rel_flags: [],
      visible_state: "missing",
      detail: "No matching public backlink to the target URL was found on the inspected live page.",
      verified_at,
    };
  }

  const rel_flags = classifyRel(preferred.rel);
  return {
    verification_status: preferred.isVisible ? "verified_link_present" : "link_hidden",
    expected_target_url: args.targetUrl,
    live_page_url: args.livePageUrl,
    target_link_url: preferred.href,
    anchor_text: preferred.text?.trim() || undefined,
    rel: preferred.rel?.trim() || undefined,
    rel_flags,
    visible_state: preferred.isVisible ? "visible" : "hidden",
    detail: preferred.isVisible
      ? "Matching backlink is publicly visible on the inspected live page."
      : "Matching backlink exists in the DOM but is not visibly rendered on the inspected live page.",
    verified_at,
  };
}

export async function verifyLinkOnPage(args: {
  page: Page;
  targetUrl: string;
}): Promise<LinkVerificationResult> {
  const livePageUrl = args.page.url();
  const candidates = await args.page.locator("a[href]").evaluateAll((elements) =>
    elements.map((element) => {
      const anchor = element as HTMLAnchorElement;
      const style = window.getComputedStyle(anchor);
      const rect = anchor.getBoundingClientRect();
      const isVisible =
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || "1") > 0.05 &&
        rect.width > 0 &&
        rect.height > 0;
      return {
        href: anchor.href,
        text: (anchor.innerText || anchor.textContent || "").replace(/\s+/g, " ").trim(),
        rel: anchor.getAttribute("rel") || "",
        isVisible,
      };
    }),
  );

  return verifyLinkCandidates({
    livePageUrl,
    targetUrl: args.targetUrl,
    candidates,
  });
}
