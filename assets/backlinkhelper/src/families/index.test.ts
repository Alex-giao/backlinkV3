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
