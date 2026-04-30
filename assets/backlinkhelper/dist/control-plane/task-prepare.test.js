import test from "node:test";
import assert from "node:assert/strict";
import { buildHomepageProbeUrl, classifyScoutTerminalBoundary, inferOpportunityClassFromScout, mustRunHomepageRecoveryBeforeRetry, reclassifyTaskFlowFamilyForPrepare, reclassifyTaskFlowFamilyFromScout, shouldProbeHomepageForSubmitRecovery, } from "./task-prepare.js";
function makeTask(overrides = {}) {
    return {
        id: "task-prepare-test",
        target_url: "https://example.com/submit/#",
        hostname: "example.com",
        submission: {
            promoted_profile: {
                url: "https://exactstatement.com/",
                hostname: "exactstatement.com",
                name: "Exact Statement",
                description: "desc",
                category_hints: ["finance"],
                source: "fallback",
            },
            confirm_submit: true,
        },
        status: "READY",
        created_at: "2026-04-08T00:00:00.000Z",
        updated_at: "2026-04-08T00:00:00.000Z",
        run_count: 0,
        escalation_level: "none",
        takeover_attempts: 0,
        phase_history: [],
        latest_artifacts: [],
        notes: [],
        ...overrides,
    };
}
function makeScout(overrides = {}) {
    return {
        ok: true,
        surface_summary: "Reachable page looked like a stale submit path (404).",
        field_hints: [],
        auth_hints: [],
        anti_bot_hints: [],
        submit_candidates: [],
        evidence_sufficiency: true,
        embed_hints: [],
        link_candidates: [],
        page_snapshot: {
            url: "https://example.com/submit/#",
            title: "Not Found",
            response_status: 404,
            body_text_excerpt: "404 page",
        },
        page_assessment: {
            page_reachable: true,
            visual_verification_required: true,
            classification_confidence: "medium",
            ambiguity_flags: ["not_found_but_reachable"],
        },
        ...overrides,
    };
}
test("task-prepare reclassifies forum thread targets out of wp_comment before scout", () => {
    const task = makeTask({
        target_url: "https://cyberlord.at/forum/?id=1&thread=6857",
        hostname: "cyberlord.at",
        flow_family: "wp_comment",
        flow_family_source: "explicit",
        flow_family_reason: "Imported as wp_comment.",
    });
    const changed = reclassifyTaskFlowFamilyForPrepare(task, "unit-test prepare");
    assert.equal(changed, true);
    assert.equal(task.flow_family, "forum_post");
    assert.equal(task.flow_family_source, "corrected");
    assert.equal(task.corrected_from_family, "wp_comment");
    assert.match(task.flow_family_reason ?? "", /unit-test prepare: Target URL has a strong forum\/thread surface signal/i);
    assert.match(task.notes.at(-1) ?? "", /corrected flow family from wp_comment to forum_post/i);
});
test("task-prepare infers forum thread targets without synthetic corrected-from audit", () => {
    const task = makeTask({
        target_url: "https://community.example.com/threads/bank-statement-pdf-to-csv.42/",
        hostname: "community.example.com",
        flow_family: undefined,
        flow_family_source: undefined,
        flow_family_reason: undefined,
    });
    const changed = reclassifyTaskFlowFamilyForPrepare(task, "unit-test prepare");
    assert.equal(changed, true);
    assert.equal(task.flow_family, "forum_post");
    assert.equal(task.flow_family_source, "inferred");
    assert.equal(task.corrected_from_family, undefined);
});
test("task-prepare corrects Blogger comment frames to wp_comment after scout", () => {
    const task = makeTask({
        target_url: "http://staffpicks.yourlibrary.ca/2020/09/sunny-days.html",
        hostname: "staffpicks.yourlibrary.ca",
        flow_family: "saas_directory",
        flow_family_source: "defaulted",
    });
    const scout = makeScout({
        surface_summary: "Scout reached a Blogger article.",
        embed_hints: [
            {
                frame_index: 1,
                provider: "unknown",
                frame_url: "https://www.blogger.com/comment/frame/8348134481638572242?po=6409126616709870746&jsh=m%3B%2F_%2Fscs%2Fabc-static",
                body_text_excerpt: "Enter comment",
                cta_candidates: [],
                submit_candidates: [],
                likely_interactive: false,
            },
        ],
        page_snapshot: {
            url: "http://staffpicks.yourlibrary.ca/2020/09/sunny-days.html",
            title: "RPL Staff Picks: Sunny Days",
            response_status: 200,
            body_text_excerpt: "Blog article",
        },
    });
    const changed = reclassifyTaskFlowFamilyFromScout(task, scout, "unit-test scout");
    assert.equal(changed, true);
    assert.equal(task.flow_family, "wp_comment");
    assert.equal(task.flow_family_source, "corrected");
    assert.equal(task.corrected_from_family, "saas_directory");
    assert.match(task.flow_family_reason ?? "", /Blogger comment frame/i);
});
test("buildHomepageProbeUrl normalizes stale submit URLs to homepage", () => {
    assert.equal(buildHomepageProbeUrl("https://example.com/submit/#"), "https://example.com/");
    assert.equal(buildHomepageProbeUrl("https://example.com/"), undefined);
});
test("stale reachable submit pages trigger homepage probing", () => {
    const task = makeTask();
    const scout = makeScout();
    assert.equal(shouldProbeHomepageForSubmitRecovery(task, scout), true);
});
test("homepage probing is skipped when already at homepage", () => {
    const task = makeTask({ target_url: "https://example.com/", hostname: "example.com" });
    const scout = makeScout({
        page_snapshot: {
            url: "https://example.com/",
            title: "Home",
            response_status: 404,
            body_text_excerpt: "404 page",
        },
    });
    assert.equal(shouldProbeHomepageForSubmitRecovery(task, scout), false);
});
test("homepage probing is skipped for non-stale scout failures", () => {
    const task = makeTask();
    const scout = makeScout({
        surface_summary: "Scout timed out waiting for the page to settle.",
        page_snapshot: {
            url: "https://example.com/submit/#",
            title: "Timeout",
            body_text_excerpt: "still loading",
        },
        page_assessment: {
            page_reachable: false,
            visual_verification_required: false,
            classification_confidence: "low",
            ambiguity_flags: [],
        },
    });
    assert.equal(shouldProbeHomepageForSubmitRecovery(task, scout), false);
});
test("reachable stale submit pages must complete homepage recovery before retry-like closure", () => {
    const task = makeTask();
    const scout = makeScout();
    assert.equal(mustRunHomepageRecoveryBeforeRetry({
        task,
        scout,
        homepageRecoveryAttempted: false,
    }), true);
    assert.equal(mustRunHomepageRecoveryBeforeRetry({
        task,
        scout,
        homepageRecoveryAttempted: true,
    }), false);
});
test("homepage recovery gate is skipped for non-reachable or non-stale pages", () => {
    const task = makeTask();
    const nonReachableScout = makeScout({
        page_assessment: {
            page_reachable: false,
            visual_verification_required: false,
            classification_confidence: "low",
            ambiguity_flags: [],
        },
    });
    const nonStaleScout = makeScout({
        surface_summary: "Submit form is live.",
        page_snapshot: {
            url: "https://example.com/submit/#",
            title: "Submit",
            response_status: 200,
            body_text_excerpt: "live submit form",
        },
        page_assessment: {
            page_reachable: true,
            visual_verification_required: false,
            classification_confidence: "high",
            ambiguity_flags: [],
        },
    });
    assert.equal(mustRunHomepageRecoveryBeforeRetry({
        task,
        scout: nonReachableScout,
        homepageRecoveryAttempted: false,
    }), false);
    assert.equal(mustRunHomepageRecoveryBeforeRetry({
        task,
        scout: nonStaleScout,
        homepageRecoveryAttempted: false,
    }), false);
});
test("explicit submit surfaces are tagged as deep-first opportunities", () => {
    const task = makeTask();
    const scout = makeScout({
        surface_summary: "Live submit surface detected.",
        submit_candidates: ["Submit Startup"],
        field_hints: ["email", "url", "description"],
        page_snapshot: {
            url: "https://example.com/submit",
            title: "Submit Startup",
            response_status: 200,
            body_text_excerpt: "Submit Startup Name URL Description",
        },
        page_assessment: {
            page_reachable: true,
            visual_verification_required: false,
            classification_confidence: "high",
            ambiguity_flags: [],
        },
    });
    assert.equal(inferOpportunityClassFromScout(task, scout), "deep_first");
});
test("reachable but mixed or stale pages stay in recovery-ambiguous class", () => {
    const task = makeTask();
    const scout = makeScout();
    assert.equal(inferOpportunityClassFromScout(task, scout), "recovery_ambiguous");
});
test("field hints alone do not promote a page into deep-first without real entry evidence", () => {
    const task = makeTask();
    const scout = makeScout({
        surface_summary: "Marketing page with one visible newsletter input.",
        submit_candidates: [],
        field_hints: ["email"],
        auth_hints: [],
        link_candidates: [],
        embed_hints: [],
        page_snapshot: {
            url: "https://example.com/",
            title: "Homepage",
            response_status: 200,
            body_text_excerpt: "Welcome to Example",
        },
        page_assessment: {
            page_reachable: true,
            visual_verification_required: true,
            classification_confidence: "low",
            ambiguity_flags: ["no_visible_form_but_possible_entry"],
        },
    });
    assert.equal(inferOpportunityClassFromScout(task, scout), "recovery_ambiguous");
});
test("scout terminal classifier front-loads paid-only submit walls", () => {
    const task = makeTask();
    const scout = makeScout({
        surface_summary: "Pricing wall before submission.",
        submit_candidates: [],
        page_snapshot: {
            url: "https://example.com/pricing",
            title: "Featured listing plans",
            response_status: 200,
            body_text_excerpt: "Featured listing plans. Pay $49 to submit your startup for review.",
        },
        page_assessment: {
            page_reachable: true,
            visual_verification_required: false,
            classification_confidence: "high",
            ambiguity_flags: [],
        },
    });
    const classification = classifyScoutTerminalBoundary({
        task,
        scout,
        evidenceRef: "artifact.json",
    });
    assert.equal(classification?.outcome.next_status, "SKIPPED");
    assert.equal(classification?.outcome.skip_reason_code, "paid_or_sponsored_listing");
});
test("scout terminal classifier front-loads existing-account login walls", () => {
    const task = makeTask();
    const scout = makeScout({
        surface_summary: "Existing account login required.",
        submit_candidates: [],
        auth_hints: ["sign in", "password"],
        page_snapshot: {
            url: "https://example.com/login",
            title: "Sign in",
            response_status: 200,
            body_text_excerpt: "Sign in to continue. Email Password 2FA code.",
        },
        page_assessment: {
            page_reachable: true,
            visual_verification_required: false,
            classification_confidence: "high",
            ambiguity_flags: [],
        },
    });
    const classification = classifyScoutTerminalBoundary({
        task,
        scout,
        evidenceRef: "artifact.json",
    });
    assert.equal(classification?.outcome.next_status, "WAITING_MANUAL_AUTH");
    assert.equal(classification?.outcome.wait?.wait_reason_code, "DIRECTORY_LOGIN_REQUIRED");
});
test("scout terminal classifier keeps forum post submit/auth ambiguity out of manual-auth", () => {
    const task = makeTask({
        flow_family: "forum_post",
        target_url: "https://forums.example.com/hc/en-us/community/posts/123-feature-request",
        hostname: "forums.example.com",
    });
    const scout = makeScout({
        surface_summary: "Forum community post is reachable and exposes a new-post path.",
        submit_candidates: ["New post", "Post your idea here!", "Follow"],
        auth_hints: ["sign in"],
        field_hints: ["topic"],
        page_snapshot: {
            url: "https://forums.example.com/hc/en-us/community/posts/123-feature-request",
            title: "Feature request",
            response_status: 200,
            body_text_excerpt: "Have a feature request? Post your idea here! New post. Please sign in to leave a comment.",
        },
        page_assessment: {
            page_reachable: true,
            visual_verification_required: true,
            classification_confidence: "low",
            ambiguity_flags: ["mixed_submit_and_auth_signals"],
        },
    });
    const classification = classifyScoutTerminalBoundary({
        task,
        scout,
        evidenceRef: "artifact.json",
    });
    assert.equal(classification, undefined);
});
test("scout terminal classifier keeps visible Google OAuth routes out of manual-auth", () => {
    const task = makeTask();
    const scout = makeScout({
        surface_summary: "OAuth login option is visible before submission.",
        submit_candidates: [],
        auth_hints: ["log in", "with Google"],
        page_snapshot: {
            url: "https://directory.example.com/sign-in",
            title: "Sign in",
            response_status: 200,
            body_text_excerpt: "Welcome back. Log in with Google to continue submitting your tool.",
        },
        page_assessment: {
            page_reachable: true,
            visual_verification_required: false,
            classification_confidence: "medium",
            ambiguity_flags: [],
        },
    });
    const classification = classifyScoutTerminalBoundary({
        task,
        scout,
        evidenceRef: "artifact.json",
    });
    assert.equal(classification, undefined);
});
test("scout terminal classifier ignores encoded Blogger iframe URL fragments when the comment frame is open", () => {
    const task = makeTask({ flow_family: "saas_directory" });
    const scout = makeScout({
        surface_summary: "Blogger article with an open comment frame.",
        submit_candidates: ["Search"],
        field_hints: ["website", "email"],
        auth_hints: [],
        embed_hints: [
            {
                frame_index: 1,
                provider: "unknown",
                frame_url: "https://www.blogger.com/comment/frame/8348134481638572242?jsh=m%3B%2F_%2Fscs%2Fabc-static",
                body_text_excerpt: "Enter comment",
                cta_candidates: [],
                submit_candidates: [],
                likely_interactive: false,
            },
        ],
        page_snapshot: {
            url: "http://staffpicks.yourlibrary.ca/2020/09/sunny-days.html",
            title: "RPL Staff Picks: Sunny Days",
            response_status: 200,
            body_text_excerpt: "Blog article",
        },
        page_assessment: {
            page_reachable: true,
            visual_verification_required: true,
            classification_confidence: "medium",
            ambiguity_flags: [],
        },
    });
    const classification = classifyScoutTerminalBoundary({
        task,
        scout,
        evidenceRef: "artifact.json",
    });
    assert.equal(classification, undefined);
});
test("scout terminal classifier lets solver-supported reCAPTCHA continue to operator", () => {
    const previousKey = process.env.CAPSOLVER_API_KEY;
    process.env.CAPSOLVER_API_KEY = "test-capsolver-key";
    try {
        const task = makeTask({ flow_family: "wp_comment" });
        const scout = makeScout({
            surface_summary: "Comment form is visible but protected by reCAPTCHA.",
            submit_candidates: ["Publicar el comentario"],
            field_hints: ["comment", "email"],
            anti_bot_hints: ["captcha", "recaptcha"],
            embed_hints: [
                {
                    frame_index: 1,
                    provider: "recaptcha",
                    frame_url: "https://www.google.com/recaptcha/api2/anchor?ar=1&k=6LeNUEEaAAAAAAmw20N_xTsaG5SKAAF18JV4IkX9&size=invisible",
                    frame_title: "reCAPTCHA",
                    body_text_excerpt: "protected by reCAPTCHA",
                    cta_candidates: [],
                    submit_candidates: [],
                    likely_interactive: false,
                },
            ],
            page_snapshot: {
                url: "https://blog.example.com/post",
                title: "Blog post",
                response_status: 200,
                body_text_excerpt: "Leave a reply. Publicar el comentario. protected by reCAPTCHA.",
            },
            page_assessment: {
                page_reachable: true,
                visual_verification_required: true,
                classification_confidence: "medium",
                ambiguity_flags: ["overlay_or_interstitial_present"],
            },
        });
        const classification = classifyScoutTerminalBoundary({
            task,
            scout,
            evidenceRef: "artifact.json",
        });
        assert.equal(classification, undefined);
    }
    finally {
        if (previousKey === undefined) {
            delete process.env.CAPSOLVER_API_KEY;
        }
        else {
            process.env.CAPSOLVER_API_KEY = previousKey;
        }
    }
});
test("scout terminal classifier does not stop wp_comment on standalone anti-bot labels", () => {
    const task = makeTask({
        flow_family: "wp_comment",
        target_url: "https://brownbagteacher.com/place-value-1st-grade-centers/",
        hostname: "brownbagteacher.com",
    });
    const scout = makeScout({
        surface_summary: "Comment form is visible on the article page.",
        submit_candidates: ["Post Comment"],
        field_hints: ["comment", "author", "email", "url"],
        anti_bot_hints: ["captcha", "spam"],
        embed_hints: [],
        page_snapshot: {
            url: "https://brownbagteacher.com/place-value-1st-grade-centers/",
            title: "Place Value Centers",
            response_status: 200,
            body_text_excerpt: "Leave a Reply. Comment. Name. Email. Website. Post Comment.",
        },
        page_assessment: {
            page_reachable: true,
            visual_verification_required: true,
            classification_confidence: "low",
            ambiguity_flags: ["overlay_or_interstitial_present"],
        },
    });
    const classification = classifyScoutTerminalBoundary({
        task,
        scout,
        evidenceRef: "artifact.json",
    });
    assert.equal(classification, undefined);
});
test("scout terminal classifier does not front-load mixed submit/auth ambiguity", () => {
    const task = makeTask();
    const scout = makeScout({
        surface_summary: "Mixed submit and auth surface.",
        submit_candidates: ["Submit Startup"],
        auth_hints: ["sign in", "create account"],
        page_snapshot: {
            url: "https://example.com/submit",
            title: "Submit your startup",
            response_status: 200,
            body_text_excerpt: "Submit your startup or create account to continue. Sign in if you already have an account.",
        },
        page_assessment: {
            page_reachable: true,
            visual_verification_required: true,
            classification_confidence: "low",
            ambiguity_flags: ["mixed_submit_and_auth_signals", "login_vs_register_ambiguous"],
        },
    });
    const classification = classifyScoutTerminalBoundary({
        task,
        scout,
        evidenceRef: "artifact.json",
    });
    assert.equal(classification, undefined);
});
