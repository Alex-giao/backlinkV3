function normalizeWhitespace(value) {
    return (value ?? "").replace(/\s+/g, " ").trim();
}
function isSubmitControl(candidate) {
    const inputType = (candidate.input_type ?? "").toLowerCase();
    const buttonType = (candidate.button_type ?? "").toLowerCase();
    return inputType === "submit" || (candidate.inside_form === true && buttonType === "submit");
}
function hasIgnorableHref(candidate) {
    const href = normalizeWhitespace(candidate.href).toLowerCase();
    if (!href) {
        return false;
    }
    return (href.startsWith("mailto:") ||
        href.startsWith("tel:") ||
        href.startsWith("javascript:") ||
        href === "#" ||
        href.startsWith("#"));
}
function explicitContinuationKind(candidate) {
    const path = normalizeWhitespace(candidate.path).toLowerCase();
    const text = normalizeWhitespace(candidate.text).toLowerCase();
    const registerPathPattern = /(^|\/)(?:(?:account|accounts|auth|member|members|user|users)\/)?(?:register|registration|sign-up|signup|sign_up|create-account|create_account|join)(?:\/|$|[._-])/i;
    const authPathPattern = /(^|\/)(?:(?:account|accounts|auth|member|members|user|users)\/)?(?:login|log-in|signin|sign-in|sign_in)(?:\/|$|[._-])/i;
    // Register wins over auth so /auth/register and /users/sign_up do not get
    // treated as existing-account login walls.
    if (registerPathPattern.test(path) || /\b(register|sign up|signup|create account|join now)\b/i.test(text)) {
        return "register";
    }
    if (authPathPattern.test(path) || path === "/auth" || path === "/auth/" || /\b(log in|login|sign in|signin)\b/i.test(text)) {
        return "auth";
    }
    return undefined;
}
function hasHttpsHref(candidate) {
    const href = normalizeWhitespace(candidate.href);
    if (!href) {
        return false;
    }
    try {
        return new URL(href).protocol === "https:";
    }
    catch {
        return false;
    }
}
function hasCleartextCredentialHref(candidate) {
    if (explicitContinuationKind(candidate) === undefined) {
        return false;
    }
    const href = normalizeWhitespace(candidate.href);
    if (!href || href.startsWith("/") || href.startsWith("#")) {
        return false;
    }
    try {
        return new URL(href).protocol === "http:";
    }
    catch {
        return /^http:/i.test(href);
    }
}
function isAllowedCrossOriginContinuation(candidate) {
    return candidate.same_site === true && hasHttpsHref(candidate) && explicitContinuationKind(candidate) !== undefined;
}
function classifyCandidateKind(candidate) {
    const path = normalizeWhitespace(candidate.path).toLowerCase();
    const top = candidate.top ?? Number.POSITIVE_INFINITY;
    const relatedSite = candidate.same_origin || candidate.same_site;
    if (isSubmitControl(candidate) || candidate.inside_form) {
        return "submit";
    }
    if (relatedSite) {
        const continuationKind = explicitContinuationKind(candidate);
        if (continuationKind) {
            return continuationKind;
        }
        // Generic header/top CTA promotion is intentionally same-origin only.
        // Sibling-domain links can receive signup credentials later, so they must
        // carry explicit auth/register intent rather than being ordinary nav links.
        if (candidate.same_origin && !candidate.same_page && path && path !== "/" && path !== "/home" && (candidate.area === "header" || top <= 320)) {
            return "submit";
        }
    }
    return "other";
}
function candidateKindPriority(kind) {
    switch (kind) {
        case "register":
            return 3;
        case "auth":
            return 2;
        case "submit":
            return 1;
        case "other":
            return 0;
    }
}
function scoreCandidate(candidate) {
    if (!candidate.visible || candidate.disabled) {
        return Number.NEGATIVE_INFINITY;
    }
    const text = normalizeWhitespace(candidate.text);
    const submitControl = isSubmitControl(candidate);
    const top = candidate.top ?? Number.POSITIVE_INFINITY;
    if (!submitControl && hasIgnorableHref(candidate)) {
        return Number.NEGATIVE_INFINITY;
    }
    if (!submitControl && hasCleartextCredentialHref(candidate)) {
        return Number.NEGATIVE_INFINITY;
    }
    if (!submitControl && candidate.same_origin === false && !isAllowedCrossOriginContinuation(candidate)) {
        return Number.NEGATIVE_INFINITY;
    }
    if (!submitControl && candidate.same_page) {
        return Number.NEGATIVE_INFINITY;
    }
    if (!submitControl && candidate.area === "footer") {
        return Number.NEGATIVE_INFINITY;
    }
    if (!text) {
        return Number.NEGATIVE_INFINITY;
    }
    const kind = classifyCandidateKind(candidate);
    let score = 0;
    if (kind === "register")
        score += 46;
    if (kind === "auth")
        score += 36;
    if (submitControl)
        score += 60;
    if (candidate.inside_form)
        score += 30;
    if (candidate.same_origin && !candidate.same_page)
        score += 12;
    if (!candidate.same_origin && candidate.same_site && !candidate.same_page)
        score += 9;
    if (candidate.path && candidate.path !== "/" && candidate.path !== "/home")
        score += 14;
    if (candidate.area === "header")
        score += 18;
    if (candidate.area === "main")
        score += 10;
    if (top <= 320)
        score += 10;
    if (candidate.tag === "button" || candidate.tag === "input")
        score += 6;
    if (text.length >= 3)
        score += 6;
    if (text.length > 60)
        score -= 4;
    return score;
}
function uniqueTexts(candidates) {
    return [...new Set(candidates.map((candidate) => candidate.text).filter(Boolean))];
}
export function buildScoutActionCandidates(rawCandidates) {
    const seen = new Set();
    const ranked = [];
    for (const candidate of rawCandidates) {
        const text = normalizeWhitespace(candidate.text);
        const href = normalizeWhitespace(candidate.href);
        const score = scoreCandidate(candidate);
        if (!Number.isFinite(score) || score < 18) {
            continue;
        }
        const kind = classifyCandidateKind(candidate);
        const key = `${text}@@${href}@@${kind}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        ranked.push({ text, href, kind, score });
    }
    ranked.sort((a, b) => candidateKindPriority(b.kind) - candidateKindPriority(a.kind) || b.score - a.score || a.text.localeCompare(b.text));
    const ctaCandidates = uniqueTexts(ranked).slice(0, 8);
    const submitCandidates = uniqueTexts(ranked.filter((candidate) => candidate.kind === "submit")).slice(0, 8);
    const linkCandidates = ranked.filter((candidate) => candidate.kind !== "other").map(({ text, href, kind }) => ({ text, href, kind })).slice(0, 12);
    return {
        submitCandidates,
        ctaCandidates,
        linkCandidates,
    };
}
