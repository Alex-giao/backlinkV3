import test from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "./openai-decider.js";
test("buildSystemPrompt uses forum_profile cues instead of directory defaults", () => {
    const prompt = buildSystemPrompt("forum_profile");
    assert.match(prompt, /forum profile/i);
    assert.match(prompt, /edit profile/i);
    assert.match(prompt, /profile updated/i);
    assert.doesNotMatch(prompt, /create startup/i);
    assert.doesNotMatch(prompt, /submit your tool/i);
});
test("buildSystemPrompt falls back to saas_directory cues when family is unset", () => {
    const prompt = buildSystemPrompt(undefined);
    assert.match(prompt, /saas directory/i);
    assert.match(prompt, /submit your tool|submit startup/i);
});
