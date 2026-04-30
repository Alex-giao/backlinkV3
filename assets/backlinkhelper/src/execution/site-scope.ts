import { getDomain } from "tldts";

const KNOWN_MULTI_TENANT_SITE_DOMAINS = new Set([
  "atlassian.net",
  "blogspot.com",
  "freshdesk.com",
  "freshservice.com",
  "gitbook.io",
  "github.io",
  "helpscoutdocs.com",
  "herokuapp.com",
  "intercom.help",
  "myshopify.com",
  "netlify.app",
  "notion.site",
  "pages.dev",
  "readme.io",
  "salesforce-sites.com",
  "vercel.app",
  "webflow.io",
  "wixsite.com",
  "workers.dev",
  "wordpress.com",
  "zendesk.com",
]);

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^www\./i, "").toLowerCase();
}

export function siteDomainForHostname(hostname: string): string | undefined {
  const normalized = normalizeHostname(hostname.trim());
  if (!normalized) {
    return undefined;
  }

  const domain = getDomain(normalized, { allowPrivateDomains: true });
  return normalizeHostname(domain ?? normalized);
}

export function isKnownMultiTenantSiteDomain(siteDomain: string | undefined): boolean {
  return Boolean(siteDomain && KNOWN_MULTI_TENANT_SITE_DOMAINS.has(siteDomain));
}

export function safeSameSiteSiblingNavigation(args: {
  currentUrl: string;
  candidateUrl: string;
}): boolean {
  let current: URL;
  let candidate: URL;
  try {
    current = new URL(args.currentUrl);
    candidate = new URL(args.candidateUrl, current);
  } catch {
    return false;
  }

  if (!candidate.hostname || !current.hostname) {
    return false;
  }

  const crossOrigin = candidate.origin !== current.origin;
  if (crossOrigin) {
    // Cross-origin account/signup continuations can receive credentials. Do not
    // promote any cleartext edge, including a cleartext source page that would
    // discover and hand credentials to an HTTPS sibling account page.
    if (candidate.protocol !== "https:" || current.protocol !== "https:") {
      return false;
    }
  }

  const currentSite = siteDomainForHostname(current.hostname);
  const candidateSite = siteDomainForHostname(candidate.hostname);
  if (!currentSite || !candidateSite || currentSite !== candidateSite) {
    return false;
  }

  // PSL/private suffix data is good but not complete for every hosted SaaS
  // surface. Treat known multi-tenant bases as public-like unless exact origin
  // already matched above, otherwise company.zendesk.com -> attacker.zendesk.com
  // could be mistaken for a same-brand account continuation.
  if (crossOrigin && isKnownMultiTenantSiteDomain(currentSite)) {
    return false;
  }

  return true;
}
