import { getProfileFilePath, readJsonFile, writeJsonFile } from "../memory/data-store.js";
import { lookupMissingInputFieldDefinition } from "./missing-inputs.js";
const PROMOTED_PROFILE_PROBE_VERSION = "deep-probe/v1";
const PROMOTED_PROFILE_FETCH_TIMEOUT_MS = 15_000;
const MAX_PROBE_PAGES = 6;
const MAX_FEATURE_BULLETS = 5;
const MAX_SOURCE_PAGES = 6;
const USER_AGENT = "Mozilla/5.0 (compatible; BacklinerHelper/0.1; +https://github.com/glassesmonkey/backlinkhelper)";
function stripHtmlEntityNoise(value) {
    return value
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/&#x27;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#x2F;/g, "/")
        .replace(/\s+/g, " ")
        .trim();
}
function normalizeHost(hostname) {
    return hostname.replace(/^www\./i, "").toLowerCase();
}
function normalizeComparableText(value) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function uniq(items) {
    return [...new Set(items)];
}
function uniqStrings(items) {
    const seen = new Set();
    const result = [];
    for (const item of items) {
        const normalized = normalizeComparableText(item);
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        result.push(item.trim());
    }
    return result;
}
function truncate(value, maxLength) {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}
function extractTagContent(html, pattern) {
    const match = html.match(pattern);
    return match?.[1] ? stripHtmlEntityNoise(match[1]) : undefined;
}
function extractMetaContent(html, key) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (extractTagContent(html, new RegExp(`<meta[^>]+(?:name|property)=["']${escapedKey}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i")) ??
        extractTagContent(html, new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escapedKey}["'][^>]*>`, "i")));
}
function stripHtmlToText(html) {
    return stripHtmlEntityNoise(html
        .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/a>/gi, "\n")
        .replace(/<\/(?:p|div|section|article|header|footer|main|aside|nav|h1|h2|h3|h4|h5|li|ul|ol|table|tr|td|th)>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/\n{3,}/g, "\n\n"));
}
function extractStructuredTexts(html, tagName) {
    const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
    const values = [];
    let match;
    while ((match = pattern.exec(html)) !== null) {
        const text = stripHtmlToText(match[1]);
        if (text) {
            values.push(text);
        }
    }
    return uniqStrings(values);
}
function cleanCandidateLine(line) {
    const cleaned = stripHtmlEntityNoise(line)
        .replace(/^[-•·*]+\s*/, "")
        .replace(/\s+/g, " ")
        .trim();
    if (!cleaned) {
        return undefined;
    }
    const normalized = normalizeComparableText(cleaned);
    if (!normalized) {
        return undefined;
    }
    if (cleaned.length < 18 || cleaned.length > 220) {
        return undefined;
    }
    const boilerplateFragments = [
        "cookie",
        "privacy policy",
        "terms of service",
        "all rights reserved",
        "skip to content",
        "sign in",
        "log in",
        "login",
        "register",
        "book a demo",
        "get started",
        "request a demo",
        "contact sales",
    ];
    if (boilerplateFragments.some((fragment) => normalized.includes(fragment))) {
        return undefined;
    }
    return cleaned;
}
function extractMeaningfulLines(text) {
    return uniqStrings(text
        .split(/\n+/)
        .map((line) => cleanCandidateLine(line))
        .filter((line) => Boolean(line)));
}
function isSameSiteUrl(candidateUrl, baseUrl) {
    return normalizeHost(candidateUrl.hostname) === normalizeHost(baseUrl.hostname);
}
function extractSocialLinks(html, baseUrl) {
    const socialLinks = {};
    const pattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = pattern.exec(html)) !== null) {
        const rawHref = match[1];
        let href;
        try {
            href = new URL(rawHref, baseUrl);
        }
        catch {
            continue;
        }
        const normalized = href.toString();
        if (!socialLinks.x && /(?:^|\.)x\.com$/i.test(href.hostname)) {
            socialLinks.x = normalized;
        }
        else if (!socialLinks.x && /(?:^|\.)twitter\.com$/i.test(href.hostname)) {
            socialLinks.x = normalized;
        }
        else if (!socialLinks.linkedin && /(?:^|\.)linkedin\.com$/i.test(href.hostname)) {
            socialLinks.linkedin = normalized;
        }
        else if (!socialLinks.github && /(?:^|\.)github\.com$/i.test(href.hostname)) {
            socialLinks.github = normalized;
        }
        else if (!socialLinks.youtube && /(?:^|\.)youtube\.com$/i.test(href.hostname)) {
            socialLinks.youtube = normalized;
        }
    }
    return socialLinks;
}
function extractEmails(html, text) {
    const matches = [...`${html}\n${text}`.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)];
    return uniqStrings(matches
        .map((match) => match[0].trim())
        .filter((email) => !/\.(?:png|jpg|jpeg|gif|webp)$/i.test(email)));
}
function inferCategoryHints(text) {
    const normalized = text.toLowerCase();
    const hints = new Set();
    const keywordGroups = [
        ["finance", ["finance", "fintech", "bank", "accounting", "bookkeeping", "invoice", "statement"]],
        ["productivity", ["productivity", "workflow", "spreadsheet", "automation"]],
        ["automation", ["agent", "automation", "autonomous", "no-code", "workflow"]],
        ["business", ["business", "operations", "company", "team", "sales"]],
        ["research", ["research", "analysis", "insight"]],
        ["marketing", ["seo", "marketing", "growth", "content"]],
        ["developer-tools", ["developer", "api", "sdk", "code", "repository", "github"]],
        ["ai", ["ai", "artificial intelligence", "llm", "model", "agentic"]],
    ];
    for (const [hint, keywords] of keywordGroups) {
        if (keywords.some((keyword) => normalized.includes(keyword))) {
            hints.add(hint);
        }
    }
    if (normalized.includes("quickbooks") || normalized.includes("xero") || normalized.includes("qbo")) {
        hints.add("accounting");
        hints.add("finance");
    }
    return [...hints];
}
function pickPromotedName(args) {
    if (args.overrideName?.trim()) {
        return args.overrideName.trim();
    }
    const siteName = args.homepage.siteName;
    if (siteName) {
        return siteName;
    }
    const h1 = args.homepage.headings[0];
    if (h1 && h1.length <= 80) {
        return h1;
    }
    const title = args.homepage.title ?? args.hostname;
    const dashParts = title.split(/\s[-–]\s/).map((part) => part.trim()).filter(Boolean);
    if (dashParts.length > 1) {
        return dashParts[dashParts.length - 1];
    }
    const pipeParts = title.split("|").map((part) => part.trim()).filter(Boolean);
    if (pipeParts.length > 1) {
        return pipeParts[0];
    }
    return title;
}
function buildShortDescriptionCandidates(pages) {
    const candidates = [];
    for (const page of pages) {
        if (page.metaDescription) {
            candidates.push(page.metaDescription);
        }
        const headingAndLine = [page.headings[0], page.lines[0]]
            .filter((value) => Boolean(value))
            .join(" — ");
        if (headingAndLine) {
            candidates.push(headingAndLine);
        }
        candidates.push(...page.lines.slice(0, 3));
    }
    return uniqStrings(candidates.map((candidate) => truncate(candidate, 280)));
}
function pickPromotedDescription(args) {
    if (args.overrideDescription?.trim()) {
        return args.overrideDescription.trim();
    }
    const candidates = buildShortDescriptionCandidates(args.pages);
    const preferred = candidates.find((candidate) => candidate.length >= 60 && candidate.length <= 220);
    if (preferred) {
        return preferred;
    }
    return candidates[0] ?? args.fallbackName;
}
function pickTagline(pages, fallbackDescription) {
    const candidates = buildShortDescriptionCandidates(pages).filter((candidate) => candidate.length <= 140);
    return candidates[0] ?? truncate(fallbackDescription, 140);
}
function pickLongDescription(pages, shortDescription) {
    const candidates = uniqStrings([
        ...buildShortDescriptionCandidates(pages),
        ...pages.flatMap((page) => page.lines.slice(0, 4)),
    ]).filter((candidate) => candidate !== shortDescription);
    const selected = [];
    let totalLength = 0;
    for (const candidate of candidates) {
        if (candidate.length < 40) {
            continue;
        }
        const projected = totalLength + candidate.length + (selected.length > 0 ? 1 : 0);
        if (projected > 650) {
            continue;
        }
        selected.push(candidate);
        totalLength = projected;
        if (selected.length >= 3) {
            break;
        }
    }
    if (selected.length === 0) {
        return undefined;
    }
    return selected.join(" ");
}
function pickFeatureBullets(pages) {
    const featurePages = pages.filter((page) => ["home", "product", "features", "solutions"].includes(page.kind));
    const listItemCandidates = uniqStrings(featurePages.flatMap((page) => page.listItems));
    const candidates = listItemCandidates.length > 0
        ? listItemCandidates
        : uniqStrings([
            ...featurePages.flatMap((page) => page.headings.slice(1)),
            ...featurePages.flatMap((page) => page.lines.slice(0, 6)),
        ]);
    return candidates
        .filter((candidate) => candidate.length >= 18 && candidate.length <= 120)
        .filter((candidate) => !/^(pricing|about|contact|faq)$/i.test(candidate))
        .slice(0, MAX_FEATURE_BULLETS);
}
function pickPricingSummary(pages) {
    const pricingPages = pages.filter((page) => page.kind === "pricing");
    const pricingSignals = uniqStrings(pricingPages.flatMap((page) => page.lines.filter((line) => /(pricing|price|plan|free|trial|monthly|annual|yearly|contact sales|\$|usd)/i.test(line))));
    if (pricingSignals.length === 0) {
        return undefined;
    }
    return truncate(pricingSignals.slice(0, 2).join(" "), 280);
}
function pickCompanyName(name, pages) {
    const aboutPage = pages.find((page) => page.kind === "about");
    const siteName = pages.find((page) => page.siteName)?.siteName;
    const candidate = aboutPage?.siteName ?? siteName ?? name;
    return candidate?.trim() || undefined;
}
function pickContactEmail(pages, hostname) {
    const emails = uniqStrings(pages.flatMap((page) => page.emails));
    const sameHost = emails.find((email) => normalizeHost(email.split("@")[1] ?? "") === normalizeHost(hostname));
    return sameHost ?? emails[0];
}
function mergeSocialLinks(pages) {
    const merged = {};
    for (const page of pages) {
        merged.x = merged.x ?? page.socialLinks.x;
        merged.linkedin = merged.linkedin ?? page.socialLinks.linkedin;
        merged.github = merged.github ?? page.socialLinks.github;
        merged.youtube = merged.youtube ?? page.socialLinks.youtube;
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
}
function scoreCandidateUrl(url, anchorText) {
    const combined = `${url.pathname} ${anchorText}`.toLowerCase();
    const rejectFragments = [
        "login",
        "sign-in",
        "signin",
        "sign-up",
        "signup",
        "register",
        "account",
        "privacy",
        "terms",
        "legal",
        "cookie",
        "career",
        "job",
        "status",
        "changelog",
        "blog",
        "news",
    ];
    if (rejectFragments.some((fragment) => combined.includes(fragment))) {
        return -1;
    }
    const keywordScores = [
        [20, ["pricing", "price", "plans"]],
        [18, ["features", "feature", "product"]],
        [16, ["solutions", "solution", "use-case", "usecase"]],
        [14, ["about", "company", "team", "story"]],
        [12, ["contact", "support", "help"]],
        [10, ["faq", "questions"]],
        [8, ["integrations", "integration"]],
    ];
    let score = 0;
    for (const [weight, keywords] of keywordScores) {
        if (keywords.some((keyword) => combined.includes(keyword))) {
            score = Math.max(score, weight);
        }
    }
    return score;
}
function classifyProbePageKind(url, anchorText) {
    const combined = `${url.pathname} ${anchorText}`.toLowerCase();
    if (/(pricing|price|plans)/i.test(combined)) {
        return "pricing";
    }
    if (/(features|feature|product)/i.test(combined)) {
        return "features";
    }
    if (/(solutions|solution|use-case|usecase)/i.test(combined)) {
        return "solutions";
    }
    if (/(about|company|team|story)/i.test(combined)) {
        return "about";
    }
    if (/(contact|support|help)/i.test(combined)) {
        return "contact";
    }
    if (/(faq|questions)/i.test(combined)) {
        return "faq";
    }
    return "page";
}
function buildCandidatePages(homeUrl, html) {
    const baseUrl = new URL(homeUrl);
    const linkedCandidates = new Map();
    const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorPattern.exec(html)) !== null) {
        const rawHref = match[1];
        const anchorText = stripHtmlToText(match[2]);
        let url;
        try {
            url = new URL(rawHref, baseUrl);
        }
        catch {
            continue;
        }
        if (!["http:", "https:"].includes(url.protocol) || !isSameSiteUrl(url, baseUrl)) {
            continue;
        }
        url.hash = "";
        const score = scoreCandidateUrl(url, anchorText);
        if (score <= 0) {
            continue;
        }
        const key = url.toString();
        const existing = linkedCandidates.get(key);
        if (!existing || score > existing.score) {
            linkedCandidates.set(key, {
                score,
                kind: classifyProbePageKind(url, anchorText),
            });
        }
    }
    const defaultPaths = [
        { path: "/pricing", kind: "pricing", score: 20 },
        { path: "/features", kind: "features", score: 18 },
        { path: "/product", kind: "product", score: 18 },
        { path: "/solutions", kind: "solutions", score: 16 },
        { path: "/about", kind: "about", score: 14 },
        { path: "/contact", kind: "contact", score: 12 },
        { path: "/faq", kind: "faq", score: 10 },
    ];
    const fallbackCandidates = [];
    for (const fallback of defaultPaths) {
        const url = new URL(fallback.path, baseUrl);
        fallbackCandidates.push({ url: url.toString(), kind: fallback.kind, score: fallback.score });
    }
    const rankedLinked = [...linkedCandidates.entries()]
        .sort((left, right) => right[1].score - left[1].score)
        .map(([url, data]) => ({ url, kind: data.kind }));
    const result = [...rankedLinked];
    const seen = new Set(result.map((item) => item.url));
    for (const fallback of fallbackCandidates.sort((left, right) => right.score - left.score)) {
        if (result.length >= MAX_PROBE_PAGES - 1) {
            break;
        }
        if (seen.has(fallback.url)) {
            continue;
        }
        result.push({ url: fallback.url, kind: fallback.kind });
        seen.add(fallback.url);
    }
    return result.slice(0, MAX_PROBE_PAGES - 1);
}
async function fetchSiteHtml(url) {
    const response = await fetch(url, {
        signal: AbortSignal.timeout(PROMOTED_PROFILE_FETCH_TIMEOUT_MS),
        headers: {
            "User-Agent": USER_AGENT,
            Accept: "text/html,application/xhtml+xml",
        },
        redirect: "follow",
    });
    if (!response.ok) {
        throw new Error(`Promoted site fetch failed with status ${response.status}.`);
    }
    const html = await response.text();
    return {
        url: response.url || url,
        html,
    };
}
async function probePage(url, kind) {
    try {
        const fetched = await fetchSiteHtml(url);
        const baseUrl = new URL(fetched.url);
        const text = stripHtmlToText(fetched.html);
        return {
            url: fetched.url,
            kind,
            title: extractTagContent(fetched.html, /<title[^>]*>(.*?)<\/title>/is),
            siteName: extractMetaContent(fetched.html, "og:site_name") ??
                extractMetaContent(fetched.html, "application-name"),
            metaDescription: extractMetaContent(fetched.html, "description") ??
                extractMetaContent(fetched.html, "og:description"),
            headings: uniqStrings([
                ...extractStructuredTexts(fetched.html, "h1"),
                ...extractStructuredTexts(fetched.html, "h2"),
                ...extractStructuredTexts(fetched.html, "h3"),
            ]).slice(0, 10),
            lines: extractMeaningfulLines(text).slice(0, 20),
            listItems: extractStructuredTexts(fetched.html, "li")
                .map((item) => cleanCandidateLine(item))
                .filter((item) => Boolean(item))
                .slice(0, 20),
            socialLinks: extractSocialLinks(fetched.html, baseUrl),
            emails: extractEmails(fetched.html, text),
            html: fetched.html,
        };
    }
    catch {
        return undefined;
    }
}
function buildDossierField(args) {
    if (!args.value?.trim()) {
        return undefined;
    }
    return {
        key: args.key,
        label: args.label,
        value: args.value,
        source_type: args.sourceType ?? "scraped_public",
        confidence: args.confidence ?? "medium",
        verified_at: args.updatedAt,
        updated_at: args.updatedAt,
        reuse_scope: "promoted_site",
        allowed_for_autofill: args.allowedForAutofill ?? true,
        source_ref: args.sourceRef,
    };
}
function buildDossierFields(profile) {
    const updatedAt = profile.probed_at ?? new Date().toISOString();
    const sourceRef = profile.source_pages?.[0] ?? profile.url;
    const fields = [
        buildDossierField({ key: "company_name", label: "Company Name", value: profile.company_name ?? profile.name, updatedAt, sourceRef }),
        buildDossierField({ key: "contact_email", label: "Contact Email", value: profile.contact_email, updatedAt, sourceRef }),
        buildDossierField({ key: "country", label: "Country", value: profile.country, updatedAt, sourceRef }),
        buildDossierField({ key: "state_province", label: "State / Province", value: profile.state_province, updatedAt, sourceRef }),
        buildDossierField({ key: "founded_date", label: "Founded Date", value: profile.founded_date, updatedAt, sourceRef }),
        buildDossierField({ key: "primary_category", label: "Primary Category", value: profile.primary_category, updatedAt, sourceRef }),
        buildDossierField({ key: "logo_url", label: "Logo URL", value: profile.logo_url, updatedAt, sourceRef }),
    ].filter((field) => Boolean(field));
    if (fields.length === 0) {
        return profile.dossier_fields;
    }
    return {
        ...(profile.dossier_fields ?? {}),
        ...Object.fromEntries(fields.map((field) => [field.key, field])),
    };
}
export function applyDossierUpdates(args) {
    const now = new Date().toISOString();
    const nextFields = {
        ...(args.profile.dossier_fields ?? {}),
    };
    for (const update of args.updates) {
        const definition = lookupMissingInputFieldDefinition(update.key);
        const key = definition?.key ?? update.key.trim().toLowerCase();
        const label = definition?.label ?? update.key;
        const next = buildDossierField({
            key,
            label,
            value: update.value,
            updatedAt: now,
            sourceRef: args.profile.url,
            sourceType: args.sourceType ?? "user_confirmed",
            confidence: args.sourceType === "operator_default" ? "medium" : "high",
            allowedForAutofill: definition?.recommended_resolution !== "needs_policy_decision",
        });
        if (next) {
            nextFields[key] = next;
        }
    }
    return {
        ...args.profile,
        dossier_fields: nextFields,
    };
}
function applyProfileOverrides(profile, args) {
    const withOverrides = {
        ...profile,
        name: args.promotedName?.trim() || profile.name,
        description: args.promotedDescription?.trim() || profile.description,
    };
    if (args.promotedName || args.promotedDescription) {
        withOverrides.source = "cli";
    }
    withOverrides.dossier_fields = buildDossierFields(withOverrides);
    return withOverrides;
}
function shouldReuseExistingProfile(existing, promotedUrl) {
    return Boolean(existing &&
        existing.url === promotedUrl &&
        existing.probe_version === PROMOTED_PROFILE_PROBE_VERSION);
}
export async function probePromotedProfile(args) {
    const homepageFetch = await fetchSiteHtml(args.promotedUrl);
    const homepage = await probePage(homepageFetch.url, "home");
    if (!homepage) {
        throw new Error("Promoted site homepage probe returned no page data.");
    }
    const candidatePages = buildCandidatePages(homepage.url, homepage.html);
    const supplementalPages = [];
    for (const candidate of candidatePages) {
        const page = await probePage(candidate.url, candidate.kind);
        if (!page) {
            continue;
        }
        supplementalPages.push(page);
    }
    const allPages = [homepage, ...supplementalPages].slice(0, MAX_PROBE_PAGES);
    const hostname = new URL(homepage.url).hostname;
    const name = pickPromotedName({
        homepage,
        hostname,
        overrideName: args.promotedName,
    });
    const description = pickPromotedDescription({
        pages: allPages,
        overrideDescription: args.promotedDescription,
        fallbackName: name,
    });
    const tagline = pickTagline(allPages, description);
    const longDescription = pickLongDescription(allPages, description);
    const combinedText = uniqStrings([
        name,
        description,
        tagline ?? "",
        longDescription ?? "",
        ...allPages.flatMap((page) => [page.title ?? "", page.metaDescription ?? "", ...page.headings, ...page.lines]),
    ]).join(" ");
    const profile = {
        url: homepage.url,
        hostname,
        name,
        description,
        tagline,
        long_description: longDescription,
        category_hints: inferCategoryHints(combinedText),
        feature_bullets: pickFeatureBullets(allPages),
        pricing_summary: pickPricingSummary(allPages),
        company_name: pickCompanyName(name, allPages),
        contact_email: pickContactEmail(allPages, hostname),
        social_links: mergeSocialLinks(allPages),
        source_pages: allPages.map((page) => page.url).slice(0, MAX_SOURCE_PAGES),
        source: args.promotedName || args.promotedDescription ? "cli" : "deep_probe",
        probe_version: PROMOTED_PROFILE_PROBE_VERSION,
        probed_at: new Date().toISOString(),
    };
    profile.dossier_fields = buildDossierFields(profile);
    if (args.existingProfile) {
        return {
            ...args.existingProfile,
            ...profile,
            feature_bullets: profile.feature_bullets?.length ? profile.feature_bullets : args.existingProfile.feature_bullets,
            pricing_summary: profile.pricing_summary ?? args.existingProfile.pricing_summary,
            company_name: profile.company_name ?? args.existingProfile.company_name,
            contact_email: profile.contact_email ?? args.existingProfile.contact_email,
            social_links: profile.social_links ?? args.existingProfile.social_links,
            source_pages: profile.source_pages?.length ? profile.source_pages : args.existingProfile.source_pages,
        };
    }
    return profile;
}
export async function loadOrCreatePromotedProfile(args) {
    const hostname = new URL(args.promotedUrl).hostname;
    const existing = await readJsonFile(getProfileFilePath(hostname));
    if (shouldReuseExistingProfile(existing, args.promotedUrl) &&
        !args.promotedName &&
        !args.promotedDescription) {
        return existing;
    }
    if (existing &&
        shouldReuseExistingProfile(existing, args.promotedUrl) &&
        (args.promotedName || args.promotedDescription)) {
        const merged = applyProfileOverrides(existing, args);
        await writeJsonFile(getProfileFilePath(hostname), merged);
        return merged;
    }
    try {
        const profile = await probePromotedProfile({
            promotedUrl: args.promotedUrl,
            promotedName: args.promotedName,
            promotedDescription: args.promotedDescription,
            existingProfile: existing,
        });
        await writeJsonFile(getProfileFilePath(profile.hostname), profile);
        return profile;
    }
    catch {
        if (existing && existing.url === args.promotedUrl) {
            const mergedExisting = applyProfileOverrides(existing, args);
            await writeJsonFile(getProfileFilePath(mergedExisting.hostname), mergedExisting);
            return mergedExisting;
        }
        const fallbackProfile = {
            url: args.promotedUrl,
            hostname,
            name: args.promotedName?.trim() || hostname.replace(/^www\./, ""),
            description: args.promotedDescription?.trim() ||
                `Listing for ${args.promotedName?.trim() || hostname.replace(/^www\./, "")}`,
            category_hints: inferCategoryHints(`${args.promotedName ?? ""} ${args.promotedDescription ?? ""}`),
            source: "fallback",
            probe_version: PROMOTED_PROFILE_PROBE_VERSION,
            probed_at: new Date().toISOString(),
        };
        fallbackProfile.dossier_fields = buildDossierFields(fallbackProfile);
        await writeJsonFile(getProfileFilePath(hostname), fallbackProfile);
        return fallbackProfile;
    }
}
