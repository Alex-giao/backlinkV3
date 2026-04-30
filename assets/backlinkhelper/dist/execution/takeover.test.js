import test from "node:test";
import assert from "node:assert/strict";
import { UNATTENDED_POLICY, applyFamilySpecificOutcomeGuard, applySignupContinuationGuard, applyVisualVerificationGuard, buildBrowserUseSessionName, chooseFinalOutcome, choosePreferredFinalizationPageStateSample, resolveFinalizationPreferredUrl, shouldRebindFinalizationPageContext, classifyEarlyTerminalOutcome, hasCredibleSignupContinuation, mustRunVisualGateBeforeClosure, runAgentDrivenBrowserUseLoop, shouldAttemptVisionRecovery, shouldRunVisualFallback, validateFinalizationPageContext, } from "./takeover.js";
function baseRetryableOutcome() {
    return {
        next_status: "RETRYABLE",
        detail: "Takeover could not confirm a successful submission state.",
        terminal_class: "outcome_not_confirmed",
    };
}
test("unattended policy allows configured CAPTCHA solving", () => {
    assert.equal(UNATTENDED_POLICY.allow_captcha_bypass, true);
});
test("repo-native agent loop is disabled in operator-only mode", async () => {
    await assert.rejects(() => runAgentDrivenBrowserUseLoop({
        runtime: {},
        task: {},
        scout: {},
    }), /operator-only mode/i);
});
test("final outcome selection accepts legacy proposed_outcome.status alias without producing a null next_status", () => {
    const outcome = chooseFinalOutcome({
        inferred: baseRetryableOutcome(),
        proposed: {
            status: "SKIPPED",
            detail: "Target is not a SaaS directory submission surface.",
            terminal_class: "outcome_not_confirmed",
            skip_reason_code: "not_saas_directory_surface",
        },
    });
    assert.equal(outcome.next_status, "SKIPPED");
    assert.equal(outcome.detail, "Target is not a SaaS directory submission surface.");
    assert.equal(outcome.skip_reason_code, "not_saas_directory_surface");
});
test("final outcome selection falls back to inferred outcome when proposed_outcome has no usable status", () => {
    const inferred = baseRetryableOutcome();
    const outcome = chooseFinalOutcome({
        inferred,
        proposed: {
            detail: "Malformed operator outcome.",
        },
    });
    assert.equal(outcome, inferred);
    assert.equal(outcome.next_status, "RETRYABLE");
});
test("final outcome selection ignores forum/comment policy blockers based only on content relevance", () => {
    const inferred = baseRetryableOutcome();
    const outcome = chooseFinalOutcome({
        inferred,
        flowFamily: "forum_post",
        proposed: {
            next_status: "WAITING_POLICY_DECISION",
            detail: "The target thread is topically different and low content relevance, so this would be off-topic.",
            wait: {
                wait_reason_code: "FORUM_POST_ANTI_SPAM_BLOCKED",
                resolution_owner: "system",
                resolution_mode: "terminal_audit",
                resume_trigger: "Review off-topic content relevance before posting.",
                evidence_ref: "artifact.json",
            },
        },
    });
    assert.equal(outcome, inferred);
    assert.equal(outcome.next_status, "RETRYABLE");
});
test("visual guard blocks manual-auth when screenshot looks like register gate", () => {
    const guarded = applyVisualVerificationGuard({
        outcome: {
            next_status: "WAITING_MANUAL_AUTH",
            detail: "Directory requires unsupported authentication for unattended mode.",
            terminal_class: "login_required",
        },
        visualVerification: {
            classification: "register_gate",
            confidence: 0.91,
            summary: "Page shows sign-up CTA and onboarding copy instead of an existing-account login wall.",
            model: "gpt-4.1-mini",
        },
        evidenceRef: "artifact.json",
    });
    assert.equal(guarded.next_status, "RETRYABLE");
    assert.equal(guarded.wait?.wait_reason_code, "VISUAL_VERIFICATION_REQUIRED");
});
test("visual guard upgrades retryable outcome to waiting-site-response on confirmation screen", () => {
    const guarded = applyVisualVerificationGuard({
        outcome: baseRetryableOutcome(),
        visualVerification: {
            classification: "success_or_confirmation",
            confidence: 0.97,
            summary: "Page shows thank-you confirmation after submit.",
            model: "gpt-4o-mini",
        },
        evidenceRef: "artifact.json",
    });
    assert.equal(guarded.next_status, "WAITING_SITE_RESPONSE");
    assert.equal(guarded.wait?.wait_reason_code, "SITE_RESPONSE_PENDING");
});
test("final outcome selection ignores forum/comment policy blockers based on promotional-post rules", () => {
    const inferred = baseRetryableOutcome();
    const outcome = chooseFinalOutcome({
        inferred,
        flowFamily: "forum_post",
        proposed: {
            next_status: "WAITING_POLICY_DECISION",
            detail: "Forum rules prohibit advertising, promotional links, and commercial backlinks.",
            wait: {
                wait_reason_code: "FORUM_POLICY_PROMOTIONAL_LINKS",
                resolution_owner: "system",
                resolution_mode: "terminal_audit",
                resume_trigger: "Review forum advertising policy before posting.",
                evidence_ref: "artifact.json",
            },
        },
    });
    assert.equal(outcome, inferred);
    assert.equal(outcome.next_status, "RETRYABLE");
});
test("visual guard parks CAPTCHA/human verification in solver wait lane instead of retrying or skipping", () => {
    const guarded = applyVisualVerificationGuard({
        outcome: baseRetryableOutcome(),
        visualVerification: {
            classification: "captcha_or_human_verification",
            confidence: 0.96,
            summary: "Cloudflare human verification challenge blocks the flow.",
            model: "gpt-4o-mini",
        },
        evidenceRef: "artifact.json",
    });
    assert.equal(guarded.next_status, "WAITING_EXTERNAL_EVENT");
    assert.equal(guarded.terminal_class, "captcha_blocked");
    assert.equal(guarded.wait?.wait_reason_code, "CAPTCHA_SOLVER_CONTINUATION");
    assert.equal(guarded.wait?.resolution_mode, "auto_resume");
    assert.equal(guarded.skip_reason_code, undefined);
});
test("visual guard upgrades retryable outcome to manual auth on clear login wall", () => {
    const guarded = applyVisualVerificationGuard({
        outcome: baseRetryableOutcome(),
        visualVerification: {
            classification: "login_gate",
            confidence: 0.88,
            summary: "Page is an existing-account login wall with password and sign-in only.",
            model: "gpt-4.1-mini",
        },
        evidenceRef: "artifact.json",
    });
    assert.equal(guarded.next_status, "WAITING_MANUAL_AUTH");
    assert.equal(guarded.wait?.wait_reason_code, "DIRECTORY_LOGIN_REQUIRED");
});
test("visual guard upgrades manual auth outcome to waiting-site-response on confirmation screen", () => {
    const guarded = applyVisualVerificationGuard({
        outcome: {
            next_status: "WAITING_MANUAL_AUTH",
            detail: "Directory requires unsupported authentication for unattended mode.",
            terminal_class: "login_required",
        },
        visualVerification: {
            classification: "success_or_confirmation",
            confidence: 0.96,
            summary: "Screenshot shows submission accepted and pending review.",
            model: "gpt-4o-mini",
        },
        evidenceRef: "artifact.json",
    });
    assert.equal(guarded.next_status, "WAITING_SITE_RESPONSE");
    assert.equal(guarded.wait?.wait_reason_code, "SITE_RESPONSE_PENDING");
});
test("low-confidence visual signal does not override current outcome", () => {
    const guarded = applyVisualVerificationGuard({
        outcome: baseRetryableOutcome(),
        visualVerification: {
            classification: "success_or_confirmation",
            confidence: 0.31,
            summary: "Weak signal only.",
            model: "gpt-4o-mini",
        },
        evidenceRef: "artifact.json",
    });
    assert.equal(guarded.next_status, "RETRYABLE");
});
test("malformed visual signal without numeric confidence does not crash finalization", () => {
    assert.doesNotThrow(() => {
        const guarded = applyVisualVerificationGuard({
            outcome: baseRetryableOutcome(),
            visualVerification: {
                classification: "success_or_confirmation",
                summary: "Agent supplied an incomplete visual payload.",
            },
            evidenceRef: "artifact.json",
        });
        assert.equal(guarded.next_status, "RETRYABLE");
    });
});
test("reachable non-success page defaults to visual fallback even when visual flag is false", () => {
    assert.equal(shouldRunVisualFallback({
        outcome: baseRetryableOutcome(),
        pageAssessment: {
            page_reachable: true,
            classification_confidence: "high",
            ambiguity_flags: [],
            visual_verification_required: false,
        },
        screenshotAvailable: true,
        currentUrl: "https://directory.example.com/submit",
        title: "Submit your tool",
        bodyText: "Form is still reachable but no clear success state is visible.",
    }), true);
});
test("infra/runtime failures skip visual fallback", () => {
    assert.equal(shouldRunVisualFallback({
        outcome: {
            next_status: "RETRYABLE",
            detail: "Agent loop crashed before finalization: shared browser runtime disconnected.",
            wait: {
                wait_reason_code: "TAKEOVER_RUNTIME_ERROR",
                resume_trigger: "Runtime must recover before retry.",
                resolution_owner: "system",
                resolution_mode: "auto_resume",
                evidence_ref: "artifact.json",
            },
            terminal_class: "takeover_runtime_error",
        },
        pageAssessment: {
            page_reachable: true,
            classification_confidence: "low",
            ambiguity_flags: ["post_click_state_unclear"],
            visual_verification_required: true,
        },
        screenshotAvailable: true,
    }), false);
});
test("clear success skips visual fallback", () => {
    assert.equal(shouldRunVisualFallback({
        outcome: {
            next_status: "WAITING_SITE_RESPONSE",
            detail: "Submission appears to be accepted and waiting for directory review.",
        },
        pageAssessment: {
            page_reachable: true,
            classification_confidence: "high",
            ambiguity_flags: [],
            visual_verification_required: false,
        },
        screenshotAvailable: true,
    }), false);
});
test("clear external wait skips visual fallback", () => {
    assert.equal(shouldRunVisualFallback({
        outcome: {
            next_status: "WAITING_EXTERNAL_EVENT",
            detail: "Directory is waiting for email verification.",
            wait: {
                wait_reason_code: "EMAIL_VERIFICATION_PENDING",
                resume_trigger: "Wait for gog to fetch the verification email automatically.",
                resolution_owner: "gog",
                resolution_mode: "auto_resume",
                evidence_ref: "artifact.json",
            },
        },
        pageAssessment: {
            page_reachable: true,
            classification_confidence: "high",
            ambiguity_flags: [],
            visual_verification_required: false,
        },
        screenshotAvailable: true,
    }), false);
});
test("reachable login-ish page can still enter visual fallback without special-case url logic", () => {
    assert.equal(shouldRunVisualFallback({
        outcome: {
            next_status: "WAITING_MANUAL_AUTH",
            detail: "Directory requires unsupported authentication for unattended mode.",
            terminal_class: "login_required",
        },
        pageAssessment: {
            page_reachable: true,
            classification_confidence: "high",
            ambiguity_flags: [],
            visual_verification_required: false,
        },
        screenshotAvailable: true,
        currentUrl: "https://directory.example.com/account/sign-in",
        title: "Sign in",
        bodyText: "Welcome back. Sign in to continue, or sign up for a new account.",
    }), true);
});
test("visual gate is mandatory before retry-like closure on reachable pages", () => {
    assert.equal(mustRunVisualGateBeforeClosure({
        outcome: baseRetryableOutcome(),
        pageAssessment: {
            page_reachable: true,
            classification_confidence: "high",
            ambiguity_flags: [],
            visual_verification_required: false,
        },
        screenshotAvailable: true,
        currentUrl: "https://directory.example.com/submit",
        title: "Submit your tool",
        bodyText: "The page is reachable but still ambiguous.",
        visualVerificationProvided: false,
    }), true);
});
test("visual gate is skipped for infra failures or when visual evidence already exists", () => {
    assert.equal(mustRunVisualGateBeforeClosure({
        outcome: {
            next_status: "RETRYABLE",
            detail: "Agent loop crashed before finalization: shared browser runtime disconnected.",
            wait: {
                wait_reason_code: "TAKEOVER_RUNTIME_ERROR",
                resume_trigger: "Runtime must recover before retry.",
                resolution_owner: "system",
                resolution_mode: "auto_resume",
                evidence_ref: "artifact.json",
            },
            terminal_class: "takeover_runtime_error",
        },
        pageAssessment: {
            page_reachable: true,
            classification_confidence: "low",
            ambiguity_flags: ["post_click_state_unclear"],
            visual_verification_required: true,
        },
        screenshotAvailable: true,
        visualVerificationProvided: false,
    }), false);
    assert.equal(mustRunVisualGateBeforeClosure({
        outcome: {
            next_status: "WAITING_MANUAL_AUTH",
            detail: "Directory requires unsupported authentication for unattended mode.",
            terminal_class: "login_required",
        },
        pageAssessment: {
            page_reachable: true,
            classification_confidence: "high",
            ambiguity_flags: [],
            visual_verification_required: false,
        },
        screenshotAvailable: true,
        visualVerificationProvided: true,
    }), false);
});
test("finalization sampling prefers visible overlay surfaces over generic body text", () => {
    const initialSample = {
        currentUrl: "https://directory.example.com/submit",
        title: "Submit your tool",
        bodyText: "Submit your tool Name Description Submit",
        visibleSurfaceText: "",
        hasVisibleOverlaySurface: false,
        surfaceFingerprint: "",
    };
    const modalSample = {
        currentUrl: "https://directory.example.com/submit",
        title: "Submit your tool",
        bodyText: "Sign in to continue Password Continue with Google Submit your tool Name Description Submit",
        visibleSurfaceText: "Sign in to continue Password Continue with Google",
        hasVisibleOverlaySurface: true,
        surfaceFingerprint: "dialog|sign in to continue",
    };
    const selected = choosePreferredFinalizationPageStateSample({
        current: initialSample,
        candidate: modalSample,
    });
    assert.deepEqual(selected, modalSample);
});
test("finalization page context rejects cross-host pages before verifier evidence is persisted", () => {
    const validation = validateFinalizationPageContext({
        currentUrl: "https://flickr.com/photos/example/live-comment",
        handoffUrl: "https://vitamagazine.com/2026/feature-story/#comment-form",
        taskHostname: "vitamagazine.com",
    });
    assert.equal(validation.ok, false);
    assert.equal(validation.expected_hostname, "vitamagazine.com");
    assert.equal(validation.actual_hostname, "flickr.com");
    assert.match(validation.detail ?? "", /refusing to persist cross-host verification evidence/i);
});
test("finalization page context accepts canonical same-host pages after www normalization", () => {
    const validation = validateFinalizationPageContext({
        currentUrl: "https://www.designnominees.com/sites/exact-statement",
        handoffUrl: "https://designnominees.com/sites/exact-statement",
        taskHostname: "designnominees.com",
    });
    assert.equal(validation.ok, true);
    assert.equal(validation.expected_hostname, "designnominees.com");
    assert.equal(validation.actual_hostname, "designnominees.com");
});
test("finalization reconnect prefers the handoff page over unrelated shared-CDP tabs", () => {
    assert.equal(resolveFinalizationPreferredUrl({
        taskTargetUrl: "https://directory.example.com/submit",
        handoffCurrentUrl: "https://directory.example.com/submit/thank-you",
    }), "https://directory.example.com/submit/thank-you");
    assert.equal(resolveFinalizationPreferredUrl({
        taskTargetUrl: "https://directory.example.com/submit",
        handoffCurrentUrl: "",
    }), "https://directory.example.com/submit");
});
test("finalization reconnect falls back to task URL when handoff is a Chrome internal error page", () => {
    assert.equal(resolveFinalizationPreferredUrl({
        taskTargetUrl: "https://webkit.dti.ne.jp/bbs/thread.do?id=1676856",
        handoffCurrentUrl: "chrome-error://chromewebdata/",
    }), "https://webkit.dti.ne.jp/bbs/thread.do?id=1676856");
});
test("finalization reconnect rebinds stale shared-CDP Chrome error tabs to the task-bound URL", () => {
    assert.equal(shouldRebindFinalizationPageContext({
        currentUrl: "chrome-error://chromewebdata/",
        preferredUrl: "https://webkit.dti.ne.jp/bbs/thread.do?id=1676856",
        taskHostname: "webkit.dti.ne.jp",
    }), true);
    assert.equal(shouldRebindFinalizationPageContext({
        currentUrl: "https://webkit.dti.ne.jp/bbs/thread.do?id=1676856",
        preferredUrl: "https://webkit.dti.ne.jp/bbs/thread.do?id=1676856",
        taskHostname: "webkit.dti.ne.jp",
    }), false);
});
test("signup continuation guard keeps mixed login/signup surface retryable", () => {
    const guarded = applySignupContinuationGuard({
        outcome: {
            next_status: "WAITING_MANUAL_AUTH",
            detail: "Directory requires unsupported authentication for unattended mode.",
            terminal_class: "login_required",
        },
        visualVerification: {
            classification: "login_gate",
            confidence: 0.98,
            summary: "Login screen dominates the visible surface.",
            model: "gpt-5.3-codex",
        },
        evidenceRef: "artifact.json",
        currentUrl: "https://betalist.com/sign_in",
        title: "Discover and get early access to tomorrow's startups | BetaList",
        bodyText: "Welcome back Sign in to get started Sign in with magic link Don't have an account yet? Sign up Username Email Password Password confirmation Create my account",
    });
    assert.equal(guarded.next_status, "RETRYABLE");
    assert.equal(guarded.wait?.wait_reason_code, "SIGNUP_FLOW_AVAILABLE");
});
test("credible signup continuation requires both CTA and registration fields", () => {
    assert.equal(hasCredibleSignupContinuation({
        currentUrl: "https://directory.example.com/sign-in",
        title: "Sign in",
        bodyText: "Welcome back. Don't have an account yet? Sign up Username Email Password Create my account",
    }), true);
    assert.equal(hasCredibleSignupContinuation({
        currentUrl: "https://directory.example.com/sign-in",
        title: "Sign in",
        bodyText: "Welcome back. Sign in with Google or magic link.",
    }), false);
    assert.equal(hasCredibleSignupContinuation({
        currentUrl: "https://betalist.com/sign_in",
        title: "BetaList",
        bodyText: "Join BetaList Create an account to continue Already have an account? Sign in Sign up",
    }), true);
    assert.equal(hasCredibleSignupContinuation({
        currentUrl: "https://www.startupranking.com/",
        title: "Startup Ranking",
        bodyText: "Startup Ranking Create Startup Log In Discover, rank and prospect startups worldwide",
    }), true);
});
test("vision recovery attempts are limited by novelty and page reachability", () => {
    assert.equal(shouldAttemptVisionRecovery({
        observation: {
            url: "https://directory.example.com/submit",
            title: "Submit",
            raw_text_excerpt: "No visible form yet.",
            elements: [],
            page_assessment: {
                page_reachable: true,
                classification_confidence: "low",
                ambiguity_flags: ["no_visible_form_but_possible_entry"],
                visual_verification_required: true,
            },
        },
        boundary: {
            goal: "continue_toward_submission",
            failureReason: "no_progress_limit_reached",
            detail: "No new evidence.",
        },
        attempts: [],
    }), true);
    assert.equal(shouldAttemptVisionRecovery({
        observation: {
            url: "https://directory.example.com/submit",
            title: "Submit",
            raw_text_excerpt: "No visible form yet.",
            elements: [],
            page_assessment: {
                page_reachable: true,
                classification_confidence: "low",
                ambiguity_flags: ["no_visible_form_but_possible_entry"],
                visual_verification_required: true,
            },
        },
        boundary: {
            goal: "continue_toward_submission",
            failureReason: "no_progress_limit_reached",
            detail: "No new evidence.",
        },
        attempts: [
            {
                goal: "continue_toward_submission",
                failure_reason: "no_progress_limit_reached",
                surface_signature: "continue_toward_submission https://directory.example.com/submit submit no visible form yet.",
                url: "https://directory.example.com/submit",
                screenshot_path: "shot.png",
                summary: "Already tried.",
                target_text_candidates: ["Submit your tool"],
                recovery_possible: true,
                applied: false,
            },
        ],
    }), false);
});
test("browser-use session names are unique per run and stay bounded", () => {
    const left = buildBrowserUseSessionName("exactstatement-20260406-row-0092-betalist.com", 1712638800000);
    const right = buildBrowserUseSessionName("exactstatement-20260406-row-0092-betalist.com", 1712638801234);
    assert.notEqual(left, right);
    assert.ok(left.length <= 64);
    assert.match(left, /^task-/);
});
test("early terminal classifier does not treat visible Google OAuth as manual auth", () => {
    const classified = classifyEarlyTerminalOutcome({
        currentUrl: "https://directory.example.com/sign-in",
        title: "Sign in",
        bodyText: "Welcome back. Log in with Google to continue submitting your tool.",
        evidenceRef: "artifact.json",
    });
    assert.notEqual(classified.outcome.next_status, "WAITING_MANUAL_AUTH");
    assert.notEqual(classified.outcome.wait?.wait_reason_code, "DIRECTORY_LOGIN_REQUIRED");
    assert.equal(classified.allow_rerun, true);
});
test("early terminal classifier keeps CAPTCHA in auto-resume solver lane when bypass is allowed", () => {
    const classified = classifyEarlyTerminalOutcome({
        currentUrl: "https://directory.example.com/submit",
        title: "Human verification",
        bodyText: "Please verify you are human. I'm not a robot CAPTCHA challenge.",
        evidenceRef: "artifact.json",
    });
    assert.equal(classified.hypothesis, "captcha_blocked");
    assert.equal(classified.allow_rerun, true);
    assert.equal(classified.outcome.next_status, "WAITING_EXTERNAL_EVENT");
    assert.equal(classified.outcome.terminal_class, "captcha_blocked");
    assert.equal(classified.outcome.wait?.wait_reason_code, "CAPTCHA_SOLVER_CONTINUATION");
    assert.equal(classified.outcome.wait?.resolution_mode, "auto_resume");
});
test("early terminal classifier promotes clear required-field blockers to WAITING_MISSING_INPUT", () => {
    const classified = classifyEarlyTerminalOutcome({
        currentUrl: "https://directory.example.com/submit",
        title: "Submit your product",
        bodyText: "Please complete all required fields before submitting. Missing required fields: Phone Number, City, Postal Code.",
        evidenceRef: "artifact.json",
    });
    assert.equal(classified.hypothesis, "missing_input");
    assert.equal(classified.allow_rerun, false);
    assert.equal(classified.recommended_state, "WAITING_MISSING_INPUT");
    assert.equal(classified.outcome.next_status, "WAITING_MISSING_INPUT");
    assert.equal(classified.outcome.wait?.wait_reason_code, "REQUIRED_INPUT_MISSING");
    assert.deepEqual(classified.outcome.wait?.missing_fields?.map((field) => field.key), ["postal_code", "city", "phone_number"]);
});
test("early terminal classifier promotes reciprocal-backlink requirements to policy wait instead of retry", () => {
    const classified = classifyEarlyTerminalOutcome({
        currentUrl: "https://directory.example.com/add-site",
        title: "Add your site",
        bodyText: "To get listed, first add our backlink to your website and share the live reciprocal backlink URL for review.",
        evidenceRef: "artifact.json",
    });
    assert.equal(classified.hypothesis, "reciprocal_backlink_required");
    assert.equal(classified.allow_rerun, false);
    assert.equal(classified.recommended_state, "WAITING_POLICY_DECISION");
    assert.equal(classified.outcome.next_status, "WAITING_POLICY_DECISION");
    assert.equal(classified.outcome.wait?.wait_reason_code, "RECIPROCAL_BACKLINK_REQUIRED");
});
test("early terminal classifier does not apply directory success phrases to forum_profile flows", () => {
    const classified = classifyEarlyTerminalOutcome({
        currentUrl: "https://community.example.com/profile",
        title: "Community Profile",
        bodyText: "Thanks for submitting your startup.",
        evidenceRef: "artifact.json",
        flowFamily: "forum_profile",
    });
    assert.notEqual(classified.hypothesis, "success_submitted");
    assert.notEqual(classified.outcome.wait?.wait_reason_code, "SITE_RESPONSE_PENDING");
});
test("early terminal classifier keeps forum_profile save states pending live verification", () => {
    const classified = classifyEarlyTerminalOutcome({
        currentUrl: "https://community.example.com/settings/profile",
        title: "Profile Settings",
        bodyText: "Profile updated successfully. Your website, about me, and social links were saved.",
        evidenceRef: "artifact.json",
        flowFamily: "forum_profile",
    });
    assert.equal(classified.recommended_business_outcome, "unknown_needs_review");
    assert.equal(classified.outcome.next_status, "WAITING_SITE_RESPONSE");
    assert.equal(classified.outcome.wait?.wait_reason_code, "PROFILE_PUBLICATION_PENDING");
});
test("early terminal classifier keeps wp_comment moderation out of submitted success semantics", () => {
    const classified = classifyEarlyTerminalOutcome({
        currentUrl: "https://blog.example.com/post-1#comment-form",
        title: "Leave a Reply",
        bodyText: "Thank you. Your comment is awaiting moderation.",
        evidenceRef: "artifact.json",
        flowFamily: "wp_comment",
    });
    assert.equal(classified.recommended_business_outcome, "unknown_needs_review");
    assert.equal(classified.outcome.next_status, "WAITING_SITE_RESPONSE");
    assert.equal(classified.outcome.wait?.wait_reason_code, "COMMENT_MODERATION_PENDING");
});
test("early terminal classifier treats dev_blog draft saves as resumable progress instead of submission success", () => {
    const classified = classifyEarlyTerminalOutcome({
        currentUrl: "https://dev.to/new",
        title: "Write Post",
        bodyText: "Draft saved. Continue editing before you publish or submit for review.",
        evidenceRef: "artifact.json",
        flowFamily: "dev_blog",
    });
    assert.equal(classified.recommended_business_outcome, "unknown_needs_review");
    assert.equal(classified.outcome.next_status, "RETRYABLE");
    assert.equal(classified.outcome.wait?.wait_reason_code, "ARTICLE_DRAFT_SAVED");
});
test("early terminal classifier does not convert generic save copy into forum_profile pending without profile surface evidence", () => {
    const classified = classifyEarlyTerminalOutcome({
        currentUrl: "https://community.example.com/welcome",
        title: "Welcome",
        bodyText: "Changes saved successfully.",
        evidenceRef: "artifact.json",
        flowFamily: "forum_profile",
    });
    assert.notEqual(classified.outcome.wait?.wait_reason_code, "PROFILE_PUBLICATION_PENDING");
});
test("early terminal classifier does not convert generic moderation copy into wp_comment pending without comment surface evidence", () => {
    const classified = classifyEarlyTerminalOutcome({
        currentUrl: "https://blog.example.com/thanks",
        title: "Thanks",
        bodyText: "Your comment is awaiting moderation.",
        evidenceRef: "artifact.json",
        flowFamily: "wp_comment",
    });
    assert.notEqual(classified.outcome.wait?.wait_reason_code, "COMMENT_MODERATION_PENDING");
});
test("early terminal classifier does not convert generic draft copy into dev_blog progress without editor surface evidence", () => {
    const classified = classifyEarlyTerminalOutcome({
        currentUrl: "https://dev.to/",
        title: "DEV Community",
        bodyText: "Draft saved. Come back later.",
        evidenceRef: "artifact.json",
        flowFamily: "dev_blog",
    });
    assert.notEqual(classified.outcome.wait?.wait_reason_code, "ARTICLE_DRAFT_SAVED");
});
test("family outcome guard upgrades verified non-directory backlinks to DONE", () => {
    const guarded = applyFamilySpecificOutcomeGuard({
        outcome: {
            next_status: "WAITING_SITE_RESPONSE",
            detail: "Profile changes were saved and are waiting to appear publicly.",
            wait: {
                wait_reason_code: "PROFILE_PUBLICATION_PENDING",
                resume_trigger: "Re-check the public profile page until the backlink is visible.",
                resolution_owner: "system",
                resolution_mode: "auto_resume",
                evidence_ref: "artifact.json",
            },
        },
        flowFamily: "forum_profile",
        bodyText: "Profile updated successfully.",
        evidenceRef: "artifact.json",
        linkVerification: {
            verification_status: "verified_link_present",
            expected_target_url: "https://exactstatement.com/",
            live_page_url: "https://community.example.com/member/exactstatement",
            target_link_url: "https://exactstatement.com/",
            anchor_text: "Exact Statement",
            rel: "ugc nofollow",
            rel_flags: ["ugc", "nofollow"],
            visible_state: "visible",
            detail: "Verified public profile backlink.",
            verified_at: "2026-04-16T00:00:00.000Z",
        },
    });
    assert.equal(guarded.next_status, "DONE");
    assert.equal(guarded.wait, undefined);
});
test("family outcome guard distinguishes published dev_blog pages without the target link", () => {
    const guarded = applyFamilySpecificOutcomeGuard({
        outcome: {
            next_status: "WAITING_SITE_RESPONSE",
            detail: "Article publication was reported by the site.",
            wait: {
                wait_reason_code: "ARTICLE_PUBLICATION_PENDING",
                resume_trigger: "Re-check the published article.",
                resolution_owner: "system",
                resolution_mode: "auto_resume",
                evidence_ref: "artifact.json",
            },
        },
        flowFamily: "dev_blog",
        bodyText: "Your article has been published and is now live.",
        evidenceRef: "artifact.json",
        linkVerification: {
            verification_status: "link_missing",
            expected_target_url: "https://exactstatement.com/",
            live_page_url: "https://dev.to/exactstatement/live-post",
            rel_flags: [],
            visible_state: "missing",
            detail: "Published article is live, but the promoted target link is missing.",
            verified_at: "2026-04-16T00:00:00.000Z",
        },
    });
    assert.equal(guarded.next_status, "WAITING_RETRY_DECISION");
    assert.equal(guarded.wait?.wait_reason_code, "ARTICLE_PUBLISHED_NO_LINK");
});
test("family outcome guard does not invent forum_profile pending from generic saved copy alone", () => {
    const guarded = applyFamilySpecificOutcomeGuard({
        outcome: {
            next_status: "RETRYABLE",
            detail: "Takeover could not confirm a successful submission state.",
            terminal_class: "outcome_not_confirmed",
        },
        flowFamily: "forum_profile",
        bodyText: "Changes saved successfully.",
        evidenceRef: "artifact.json",
    });
    assert.equal(guarded.next_status, "RETRYABLE");
    assert.equal(guarded.wait, undefined);
});
test("family outcome guard does not invent dev_blog draft progress from generic saved copy alone", () => {
    const guarded = applyFamilySpecificOutcomeGuard({
        outcome: {
            next_status: "RETRYABLE",
            detail: "Takeover could not confirm a successful submission state.",
            terminal_class: "outcome_not_confirmed",
        },
        flowFamily: "dev_blog",
        bodyText: "Draft saved. Come back later.",
        evidenceRef: "artifact.json",
    });
    assert.equal(guarded.next_status, "RETRYABLE");
    assert.equal(guarded.wait, undefined);
});
test("early terminal classifier ignores generic sponsor or pricing copy without an explicit paid-listing boundary", () => {
    const classified = classifyEarlyTerminalOutcome({
        currentUrl: "https://directory.example.com/submit",
        title: "Submit your tool",
        bodyText: "Free submit is available for everyone. Sponsored by Stripe. Optional newsletter subscription for readers. Advertiser analytics starts at $49 per month.",
        evidenceRef: "artifact.json",
    });
    assert.notEqual(classified.hypothesis, "paid_or_sponsored");
    assert.equal(classified.outcome.next_status, "RETRYABLE");
});
