import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCommentCopyPrompt,
  chooseFallbackCommentCopy,
  extractRecentCopyHistory,
  validateCommentCopyPlan,
} from "./comment-copy-policy.js";
import type { TaskRecord } from "./types.js";

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: overrides.id ?? "task-1",
    target_url: "https://target.example/post",
    hostname: "target.example",
    submission: {
      promoted_profile: {
        url: "https://suikagame.fun/",
        hostname: "suikagame.fun",
        name: "Suika Game",
        description: "A casual fruit-merging browser puzzle.",
        category_hints: ["browser game"],
        source: "fallback",
      },
      confirm_submit: false,
    },
    status: "DONE",
    created_at: "2026-04-26T00:00:00.000Z",
    updated_at: "2026-04-26T00:00:00.000Z",
    run_count: 1,
    escalation_level: "none",
    takeover_attempts: 0,
    phase_history: [],
    latest_artifacts: [],
    notes: [],
    ...overrides,
  };
}

test("validateCommentCopyPlan rejects repeated recent anchor and malformed link counts", () => {
  const repeated = validateCommentCopyPlan(
    {
      anchor_text: "Suika Game",
      comment_html: 'This detail reminded me of <a href="https://suikagame.fun/">Suika Game</a> during a short break.',
      reason: "contextual",
    },
    {
      promotedUrl: "https://suikagame.fun/",
      recentAnchors: ["Suika Game"],
      minChars: 40,
      maxChars: 220,
    },
  );

  assert.equal(repeated.ok, false);
  assert.ok(repeated.errors.some((error: string) => error.includes("recent anchor")));

  const tooManyLinks = validateCommentCopyPlan(
    {
      anchor_text: "quick fruit puzzle",
      comment_html:
        'Nice post. <a href="https://suikagame.fun/">quick fruit puzzle</a> and <a href="https://example.com/">another link</a>.',
      reason: "contextual",
    },
    {
      promotedUrl: "https://suikagame.fun/",
      recentAnchors: [],
      minChars: 20,
      maxChars: 220,
    },
  );

  assert.equal(tooManyLinks.ok, false);
  assert.ok(tooManyLinks.errors.some((error: string) => error.includes("exactly one link")));
});

test("validateCommentCopyPlan rejects non-Latin anchors on English-context submissions", () => {
  const result = validateCommentCopyPlan(
    {
      anchor_text: "スイカゲーム",
      comment_html: 'Good reminder about careful preparation; a quiet break with <a href="https://suikagame.fun/">スイカゲーム</a> can reset attention between tasks.',
      reason: "varied anchor",
    },
    {
      promotedUrl: "https://suikagame.fun/",
      recentAnchors: [],
      minChars: 40,
      maxChars: 240,
    },
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error: string) => error.includes("Latin")));
});

test("chooseFallbackCommentCopy avoids recently used anchors and still emits one promoted link", () => {
  const plan = chooseFallbackCommentCopy({
    promotedUrl: "https://suikagame.fun/",
    pageTitle: "Who is artist Lori Daniels?",
    pageExcerpt: "The article discusses visual details, composition, and taking time to notice small choices.",
    recentAnchors: ["Suika Game", "fruit-merging puzzle", "simple browser puzzle", "quick casual game"],
    seed: "target-host-1",
  });

  assert.notEqual(plan.anchor_text, "Suika Game");
  assert.notEqual(plan.anchor_text, "fruit-merging puzzle");
  const validation = validateCommentCopyPlan(plan, {
    promotedUrl: "https://suikagame.fun/",
    recentAnchors: ["Suika Game", "fruit-merging puzzle", "simple browser puzzle", "quick casual game"],
    minChars: 60,
    maxChars: 420,
  });
  assert.equal(validation.ok, true, validation.errors.join("; "));
});

test("extractRecentCopyHistory returns promoted DONE anchors newest first", () => {
  const tasks = [
    makeTask({
      id: "old",
      updated_at: "2026-04-20T00:00:00.000Z",
      link_verification: {
        verification_status: "verified_link_present",
        expected_target_url: "https://suikagame.fun/",
        target_link_url: "https://suikagame.fun/",
        anchor_text: "Suika Game",
        rel_flags: ["nofollow"],
        visible_state: "visible",
        detail: "ok",
        verified_at: "2026-04-20T00:00:00.000Z",
      },
    }),
    makeTask({
      id: "new",
      updated_at: "2026-04-25T00:00:00.000Z",
      link_verification: {
        verification_status: "verified_link_present",
        expected_target_url: "https://suikagame.fun/",
        target_link_url: "https://suikagame.fun/",
        anchor_text: "simple browser puzzle",
        rel_flags: ["nofollow"],
        visible_state: "visible",
        detail: "ok",
        verified_at: "2026-04-25T00:00:00.000Z",
      },
    }),
    makeTask({
      id: "other-site",
      updated_at: "2026-04-26T00:00:00.000Z",
      submission: {
        promoted_profile: {
          url: "https://other.example/",
          hostname: "other.example",
          name: "Other",
          description: "Other site",
          category_hints: [],
          source: "fallback",
        },
        confirm_submit: false,
      },
      link_verification: {
        verification_status: "verified_link_present",
        expected_target_url: "https://other.example/",
        target_link_url: "https://other.example/",
        anchor_text: "Other",
        rel_flags: [],
        visible_state: "visible",
        detail: "ok",
        verified_at: "2026-04-26T00:00:00.000Z",
      },
    }),
  ];

  const history = extractRecentCopyHistory(tasks, "https://suikagame.fun/", 5);
  assert.deepEqual(
    history.map((item) => item.anchor_text),
    ["simple browser puzzle", "Suika Game"],
  );
});

test("buildCommentCopyPrompt asks the AI for contextual non-template JSON with history constraints", () => {
  const prompt = buildCommentCopyPrompt({
    promotedUrl: "https://suikagame.fun/",
    promotedName: "Suika Game",
    promotedDescription: "A casual fruit-merging browser puzzle.",
    pageTitle: "Who is artist Lori Daniels?",
    pageExcerpt: "The post focuses on noticing small visual details in an artist's work.",
    recentHistory: [
      { task_id: "a", anchor_text: "Suika Game", comment_excerpt: "Interesting read...", verified_at: "2026-04-26T00:00:00.000Z" },
    ],
  });

  assert.match(prompt, /Return JSON only/i);
  assert.match(prompt, /exactly one/i);
  assert.match(prompt, /Do not reuse these recent anchors/i);
  assert.match(prompt, /Who is artist Lori Daniels/);
  assert.match(prompt, /Suika Game/);
});
