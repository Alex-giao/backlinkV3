import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHomepageProbeUrl,
  inferOpportunityClassFromScout,
  mustRunHomepageRecoveryBeforeRetry,
  shouldProbeHomepageForSubmitRecovery,
} from "./task-prepare.js";
import type { PrepareResult, TaskRecord } from "../shared/types.js";

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
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

function makeScout(overrides: Partial<NonNullable<PrepareResult["scout"]>> = {}): NonNullable<PrepareResult["scout"]> {
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

  assert.equal(
    mustRunHomepageRecoveryBeforeRetry({
      task,
      scout,
      homepageRecoveryAttempted: false,
    }),
    true,
  );
  assert.equal(
    mustRunHomepageRecoveryBeforeRetry({
      task,
      scout,
      homepageRecoveryAttempted: true,
    }),
    false,
  );
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

  assert.equal(
    mustRunHomepageRecoveryBeforeRetry({
      task,
      scout: nonReachableScout,
      homepageRecoveryAttempted: false,
    }),
    false,
  );
  assert.equal(
    mustRunHomepageRecoveryBeforeRetry({
      task,
      scout: nonStaleScout,
      homepageRecoveryAttempted: false,
    }),
    false,
  );
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
