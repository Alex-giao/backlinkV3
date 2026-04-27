const DEFAULT_MIN_CHARS = 70;
const DEFAULT_MAX_CHARS = 460;
const FALLBACK_ANCHORS = [
    "Suika Game",
    "fruit-merging puzzle",
    "simple browser puzzle",
    "quick casual game",
    "watermelon puzzle game",
    "a small browser game",
    "this fruit puzzle",
    "suikagame.fun",
];
const BANNED_PHRASES = [
    "check out my site",
    "click here now",
    "best game ever",
    "guaranteed",
    "free money",
    "visit my website",
    "spam",
];
function stripTrailingSlash(value) {
    return value.replace(/\/+$/, "") || value;
}
export function normalizeUrlForCopyPolicy(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        parsed.hash = "";
        parsed.search = parsed.search;
        parsed.hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
        if (parsed.pathname === "") {
            parsed.pathname = "/";
        }
        return stripTrailingSlash(parsed.toString());
    }
    catch {
        return stripTrailingSlash(rawUrl.trim().toLowerCase());
    }
}
export function normalizeAnchorText(text) {
    return (text ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}
function stripHtmlToText(html) {
    return html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/\s+/g, " ")
        .trim();
}
function extractLinks(html) {
    const links = [];
    const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorPattern.exec(html)) !== null) {
        const attrs = match[1] ?? "";
        const text = stripHtmlToText(match[2] ?? "");
        const hrefMatch = attrs.match(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
        links.push({ href: hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? "", text });
    }
    return links;
}
function taskPromotedUrl(task) {
    return task.submission?.promoted_profile?.url;
}
function samePromotedUrl(a, b) {
    if (!a) {
        return false;
    }
    return normalizeUrlForCopyPolicy(a) === normalizeUrlForCopyPolicy(b);
}
export function extractRecentCopyHistory(tasks, promotedUrl, limit = 8) {
    return tasks
        .filter((task) => task.status === "DONE" && samePromotedUrl(taskPromotedUrl(task), promotedUrl))
        .filter((task) => task.link_verification?.anchor_text)
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
        .slice(0, limit)
        .map((task) => ({
        task_id: task.id,
        anchor_text: task.link_verification?.anchor_text,
        verified_at: task.link_verification?.verified_at ?? task.updated_at,
        live_page_url: task.link_verification?.live_page_url,
    }));
}
export function validateCommentCopyPlan(plan, args) {
    const errors = [];
    const commentHtml = String(plan.comment_html ?? "").trim();
    const anchorText = String(plan.anchor_text ?? "").trim();
    const links = extractLinks(commentHtml);
    const text = stripHtmlToText(commentHtml);
    const minChars = args.minChars ?? DEFAULT_MIN_CHARS;
    const maxChars = args.maxChars ?? DEFAULT_MAX_CHARS;
    if (!anchorText) {
        errors.push("anchor_text is required");
    }
    if (!commentHtml) {
        errors.push("comment_html is required");
    }
    if (links.length !== 1) {
        errors.push("comment_html must contain exactly one link");
    }
    const promotedUrl = normalizeUrlForCopyPolicy(args.promotedUrl);
    const onlyLink = links[0];
    if (onlyLink) {
        const linkUrl = normalizeUrlForCopyPolicy(onlyLink.href);
        if (linkUrl !== promotedUrl) {
            errors.push(`the only link must point to promoted URL ${args.promotedUrl}`);
        }
        if (normalizeAnchorText(onlyLink.text) !== normalizeAnchorText(anchorText)) {
            errors.push("anchor_text must match the text inside the promoted link");
        }
    }
    if (text.length < minChars) {
        errors.push(`comment text is too short; minimum is ${minChars} characters`);
    }
    if (text.length > maxChars) {
        errors.push(`comment text is too long; maximum is ${maxChars} characters`);
    }
    const normalizedAnchor = normalizeAnchorText(anchorText);
    if (/[^\x20-\x7E]/.test(anchorText)) {
        errors.push("anchor_text should use English/Latin characters for this campaign");
    }
    const recent = new Set((args.recentAnchors ?? []).map(normalizeAnchorText).filter(Boolean));
    if (normalizedAnchor && recent.has(normalizedAnchor)) {
        errors.push("anchor_text repeats a recent anchor");
    }
    const loweredText = text.toLowerCase();
    for (const phrase of BANNED_PHRASES) {
        if (loweredText.includes(phrase)) {
            errors.push(`comment contains banned spam phrase: ${phrase}`);
        }
    }
    return {
        ok: errors.length === 0,
        errors,
        anchor_text: anchorText || onlyLink?.text,
        link_count: links.length,
    };
}
function hashSeed(seed) {
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i += 1) {
        hash ^= seed.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}
function chooseAnchor(recentAnchors, seed) {
    const recent = new Set(recentAnchors.map(normalizeAnchorText).filter(Boolean));
    const eligible = FALLBACK_ANCHORS.filter((anchor) => !recent.has(normalizeAnchorText(anchor)));
    const pool = eligible.length > 0 ? eligible : FALLBACK_ANCHORS.filter((anchor) => normalizeAnchorText(anchor) !== normalizeAnchorText(recentAnchors[0]));
    const finalPool = pool.length > 0 ? pool : FALLBACK_ANCHORS;
    return finalPool[hashSeed(seed) % finalPool.length];
}
function cleanContextSnippet(value, max = 120) {
    return stripHtmlToText(value).replace(/[<>]/g, "").slice(0, max).trim();
}
export function chooseFallbackCommentCopy(args) {
    const seed = `${args.seed ?? ""}|${args.pageTitle}|${args.pageExcerpt ?? ""}`;
    const anchor = chooseAnchor(args.recentAnchors ?? [], seed);
    const title = cleanContextSnippet(args.pageTitle, 90) || "this post";
    const excerpt = cleanContextSnippet(args.pageExcerpt ?? "", 140);
    const contextClause = excerpt
        ? `The note about ${excerpt.toLowerCase()} made the post feel grounded.`
        : `The detail in ${title} made the post feel grounded.`;
    const transition = anchor === "suikagame.fun"
        ? `For a short break afterward, I keep <a href="${args.promotedUrl}">${anchor}</a> bookmarked as a simple fruit puzzle.`
        : `For a short break afterward, I like the same small-pattern focus in <a href="${args.promotedUrl}">${anchor}</a>.`;
    return {
        anchor_text: anchor,
        comment_html: `${contextClause} ${transition}`,
        reason: "Fallback copy built from page context while avoiding recent anchors.",
        source: "fallback",
    };
}
export function buildCommentCopyPrompt(args) {
    const recentAnchors = (args.recentHistory ?? [])
        .map((item) => item.anchor_text)
        .filter((value) => Boolean(value?.trim()));
    const recentComments = (args.recentHistory ?? [])
        .map((item) => item.comment_excerpt)
        .filter((value) => Boolean(value?.trim()))
        .slice(0, 5);
    return [
        "You are writing one low-key, contextual blog comment for a backlink submission.",
        "Return JSON only. Do not use Markdown fences.",
        "Required JSON shape: {\"anchor_text\": string, \"comment_html\": string, \"reason\": string}.",
        "comment_html must contain exactly one HTML link, and that link must point to the promoted URL.",
        "Write a fresh sentence for this specific page; do not use a fixed template or boilerplate phrasing.",
        "Keep it natural, modest, and non-promotional. Avoid hype, calls to action, SEO language, and spammy phrases.",
        "Length target: 1-2 sentences, 90-320 visible characters.",
        "The anchor should vary naturally: brand, partial-match description, generic description, or naked domain are all acceptable. Use English/Latin characters for the anchor unless the naked domain is used.",
        `Do not reuse these recent anchors: ${recentAnchors.length ? recentAnchors.join(" | ") : "none"}.`,
        recentComments.length ? `Avoid sounding like these recent comments: ${recentComments.join(" || ")}.` : "No recent comment excerpts are available.",
        "Promoted site facts — do not invent anything beyond these:",
        `- URL: ${args.promotedUrl}`,
        `- Name: ${args.promotedName}`,
        `- Description: ${args.promotedDescription || "A casual browser game."}`,
        "Target page context:",
        `- Title: ${cleanContextSnippet(args.pageTitle, 180)}`,
        `- Excerpt: ${cleanContextSnippet(args.pageExcerpt, 900)}`,
        "Return only the JSON object now.",
    ].join("\n");
}
