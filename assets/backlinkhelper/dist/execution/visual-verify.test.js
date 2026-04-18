import test from "node:test";
import assert from "node:assert/strict";
import { buildRecoveryPrompt, buildVisualPrompt, shouldRunBoundaryRecheck } from "./visual-verify.js";
const baseArgs = {
    config: {
        backend: "openai",
        model: "gpt-4.1-mini",
        base_url: "https://example.com/v1",
        api_key_env: "OPENAI_API_KEY",
    },
    screenshotPath: "/tmp/example.png",
    pageUrl: "https://community.example.com/profile",
    pageTitle: "Community Profile",
    bodyExcerpt: "Profile updated successfully.",
    submitCandidates: ["Edit Profile"],
    authHints: ["Log In"],
    fieldHints: ["Website", "Bio"],
    antiBotHints: [],
    linkCandidates: [],
    flowFamily: "forum_profile",
};
test("buildVisualPrompt includes forum_profile cues and excludes directory-only examples", () => {
    const prompt = buildVisualPrompt(baseArgs, "primary");
    assert.match(prompt, /forum profile/i);
    assert.match(prompt, /edit profile/i);
    assert.match(prompt, /profile updated/i);
    assert.doesNotMatch(prompt, /create startup/i);
});
test("buildRecoveryPrompt includes family-aware recovery context", () => {
    const prompt = buildRecoveryPrompt({
        ...baseArgs,
        goal: "advance the profile update flow",
        failureReason: "current screen is ambiguous",
    });
    assert.match(prompt, /forum profile/i);
    assert.match(prompt, /edit profile/i);
    assert.doesNotMatch(prompt, /create startup/i);
});
test("shouldRunBoundaryRecheck uses family-specific success cues", () => {
    const shouldRecheck = shouldRunBoundaryRecheck(baseArgs, {
        classification: "unknown",
        confidence: 0.42,
        summary: "ambiguous profile page",
    });
    assert.equal(shouldRecheck, true);
});
