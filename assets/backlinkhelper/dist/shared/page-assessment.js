import { getFamilyConfig } from "../families/index.js";
function includesAny(text, needles) {
    return needles.some((needle) => text.includes(needle));
}
export function inferPageAssessment(args) {
    const normalized = `${args.title ?? ""}\n${args.bodyText ?? ""}`.toLowerCase();
    const submitCandidateCount = args.submitCandidates?.length ?? 0;
    const fieldHintCount = args.fieldHints?.length ?? 0;
    const authHintCount = args.authHints?.length ?? 0;
    const antiBotHintCount = args.antiBotHints?.length ?? 0;
    const embedHintsCount = args.embedHintsCount ?? 0;
    const familyConfig = getFamilyConfig(args.flowFamily);
    const pageReachable = !args.navigationFailed &&
        Boolean(args.url) &&
        !args.url.startsWith("chrome-error://") &&
        ((args.responseStatus ?? 0) < 500 || (args.responseStatus ?? 0) === 0 || normalized.length > 0);
    const hasSubmitSignal = submitCandidateCount > 0 ||
        includesAny(normalized, familyConfig.pageAssessment.submitSignals);
    const hasLoginSignal = authHintCount > 0 ||
        includesAny(normalized, familyConfig.pageAssessment.loginSignals);
    const hasRegisterSignal = includesAny(normalized, familyConfig.pageAssessment.registerSignals);
    const hasNotFoundSignal = (args.responseStatus ?? 0) === 404 ||
        includesAny(normalized, ["404", "page not found", "not found", "doesn't exist", "does not exist"]);
    const hasDashboardSignal = includesAny(normalized, familyConfig.pageAssessment.dashboardSignals);
    const hasOverlaySignal = antiBotHintCount > 0 || includesAny(normalized, familyConfig.pageAssessment.overlaySignals);
    const ambiguityFlags = [];
    if (pageReachable && hasNotFoundSignal) {
        ambiguityFlags.push("not_found_but_reachable");
    }
    if (hasSubmitSignal && (hasLoginSignal || hasRegisterSignal)) {
        ambiguityFlags.push("mixed_submit_and_auth_signals");
    }
    if (hasLoginSignal && hasRegisterSignal) {
        ambiguityFlags.push("login_vs_register_ambiguous");
    }
    if (hasDashboardSignal && fieldHintCount === 0) {
        ambiguityFlags.push("dashboard_like");
    }
    if (hasOverlaySignal) {
        ambiguityFlags.push("overlay_or_interstitial_present");
    }
    if (fieldHintCount === 0 && (hasSubmitSignal || embedHintsCount > 0)) {
        ambiguityFlags.push("no_visible_form_but_possible_entry");
    }
    if (args.postClickStateUnclear) {
        ambiguityFlags.push("post_click_state_unclear");
    }
    const uniqueFlags = [...new Set(ambiguityFlags)];
    const visualVerificationRequired = pageReachable &&
        (uniqueFlags.length > 0 || Boolean(args.visualProbeRecommended) || embedHintsCount > 0);
    const classificationConfidence = !pageReachable
        ? "high"
        : uniqueFlags.length > 0
            ? "low"
            : visualVerificationRequired
                ? "medium"
                : "high";
    return {
        page_reachable: pageReachable,
        classification_confidence: classificationConfidence,
        ambiguity_flags: uniqueFlags,
        visual_verification_required: visualVerificationRequired,
    };
}
