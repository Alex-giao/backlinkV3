import test from "node:test";
import assert from "node:assert/strict";

import { inferPageAssessment } from "./page-assessment.js";

test("create-startup plus login surfaces stay ambiguous instead of looking like pure manual auth", () => {
  const assessment = inferPageAssessment({
    url: "https://www.startupranking.com/",
    title: "Startup Ranking",
    bodyText: "Create Startup Log In Discover, rank and prospect startups worldwide",
    responseStatus: 200,
    submitCandidates: ["Create Startup"],
    fieldHints: [],
    authHints: ["Log In"],
  });

  assert.equal(assessment.page_reachable, true);
  assert.equal(assessment.classification_confidence, "low");
  assert.equal(assessment.ambiguity_flags.includes("mixed_submit_and_auth_signals"), true);
  assert.equal(assessment.ambiguity_flags.includes("login_vs_register_ambiguous"), true);
  assert.equal(assessment.visual_verification_required, true);
});

test("non-directory families stop treating directory-only CTA language as submit signal", () => {
  const assessment = inferPageAssessment({
    url: "https://community.example.com/profile",
    title: "Community Profile",
    bodyText: "Create Startup Log In Discover, rank and prospect startups worldwide",
    responseStatus: 200,
    submitCandidates: [],
    fieldHints: [],
    authHints: ["Log In"],
    flowFamily: "forum_profile",
  });

  assert.equal(assessment.page_reachable, true);
  assert.equal(assessment.ambiguity_flags.includes("mixed_submit_and_auth_signals"), false);
  assert.equal(assessment.ambiguity_flags.includes("login_vs_register_ambiguous"), false);
});

test("navigation failures are not treated as reachable pages just because error text exists", () => {
  const assessment = inferPageAssessment({
    url: "https://portal.example.com/submit",
    title: "Navigation failed",
    bodyText: "net::ERR_CERT_COMMON_NAME_INVALID",
    navigationFailed: true,
    flowFamily: "saas_directory",
  });

  assert.equal(assessment.page_reachable, false);
  assert.equal(assessment.classification_confidence, "high");
});
