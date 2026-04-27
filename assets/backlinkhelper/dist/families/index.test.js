import test from "node:test";
import assert from "node:assert/strict";
import { getFamilyConfig, resolveFlowFamily } from "./index.js";
test("resolveFlowFamily falls back to saas_directory when unset", () => {
    assert.equal(resolveFlowFamily(undefined), "saas_directory");
});
test("forum_profile family config does not inherit directory completeness defaults", () => {
    const config = getFamilyConfig("forum_profile");
    assert.deepEqual(config.completeness.flow_ready_fields, []);
    assert.equal(config.pageAssessment.submitSignals.includes("create startup"), false);
    assert.equal(config.pageAssessment.dashboardSignals.includes("profile"), true);
});
test("forum_post family config is a distinct forum reply/thread contract", () => {
    const config = getFamilyConfig("forum_post");
    assert.equal(config.flowFamily, "forum_post");
    assert.deepEqual(config.completeness.flow_ready_fields, []);
    assert.equal(config.pageAssessment.submitSignals.includes("post reply"), true);
    assert.equal(config.pageAssessment.submitSignals.includes("create startup"), false);
    assert.deepEqual(config.semanticContract.pending_wait_reason_codes, ["FORUM_POST_MODERATION_PENDING", "FORUM_POST_PUBLICATION_PENDING"]);
    assert.deepEqual(config.semanticContract.review_wait_reason_codes, ["FORUM_POST_PUBLISHED_NO_LINK"]);
});
