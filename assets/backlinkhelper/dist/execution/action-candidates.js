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
        href.endsWith("#"));
}
function classifyCandidateKind(candidate) {
    const path = normalizeWhitespace(candidate.path).toLowerCase();
    const top = candidate.top ?? Number.POSITIVE_INFINITY;
    if (isSubmitControl(candidate) || candidate.inside_form) {
        return "submit";
    }
    if (candidate.same_origin) {
        if (/(^|\/)(login|log-in|signin|sign-in|auth)(\/|$)/i.test(path)) {
            return "auth";
        }
        if (/(^|\/)(register|registration|sign-up|signup|create-account)(\/|$)/i.test(path)) {
            return "register";
        }
        if (!candidate.same_page && path && path !== "/" && path !== "/home" && (candidate.area === "header" || top <= 320)) {
            return "submit";
        }
    }
    return "other";
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
    if (!submitControl && candidate.same_origin === false) {
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
    let score = 0;
    if (submitControl)
        score += 60;
    if (candidate.inside_form)
        score += 30;
    if (candidate.same_origin && !candidate.same_page)
        score += 12;
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
    ranked.sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));
    const ctaCandidates = [...new Set(ranked.map((candidate) => candidate.text).filter(Boolean))].slice(0, 8);
    const submitCandidates = [...new Set(ranked.filter((candidate) => candidate.kind === "submit").map((candidate) => candidate.text).filter(Boolean))].slice(0, 8);
    const linkCandidates = ranked.filter((candidate) => candidate.kind !== "other").map(({ text, href, kind }) => ({ text, href, kind })).slice(0, 12);
    return {
        submitCandidates,
        ctaCandidates,
        linkCandidates,
    };
}
