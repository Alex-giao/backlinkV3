import test from "node:test";
import assert from "node:assert/strict";

import { buildScoutActionCandidates, type RawActionCandidate } from "./action-candidates.js";

function makeCandidate(overrides: Partial<RawActionCandidate> = {}): RawActionCandidate {
  return {
    tag: "a",
    text: "Action",
    href: "https://example.com/action",
    visible: true,
    disabled: false,
    inside_form: false,
    area: "main",
    same_origin: true,
    same_page: false,
    path: "/action",
    ...overrides,
  };
}

test("same-origin header CTA with a real path becomes a scout submit candidate without keyword matching", () => {
  const result = buildScoutActionCandidates([
    makeCandidate({ text: "Add startup", href: "https://startuptracker.io/crowdsourcing/", area: "header", path: "/crowdsourcing/" }),
    makeCandidate({ text: "Get Started — it's Free", href: "https://startuptracker.io/home", area: "main", path: "/home" }),
    makeCandidate({ text: "hello@startuptracker.io", href: "mailto:hello@startuptracker.io", area: "footer", same_origin: false, path: "" }),
  ]);

  assert.deepEqual(result.submitCandidates, ["Add startup"]);
  assert.deepEqual(result.ctaCandidates, ["Add startup", "Get Started — it's Free"]);
  assert.deepEqual(result.linkCandidates.map((item) => ({ text: item.text, kind: item.kind })), [
    { text: "Add startup", kind: "submit" },
  ]);
});

test("fragment and footer noise are filtered out of scout action candidates", () => {
  const result = buildScoutActionCandidates([
    makeCandidate({ text: "April 18, 2026", href: "https://domains.example.com/thread#comment-123", path: "/thread", same_page: true }),
    makeCandidate({ text: "Privacy Policy", href: "https://example.com/privacy", area: "footer", path: "/privacy" }),
    makeCandidate({ tag: "input", input_type: "submit", text: "Submit Now", href: "", inside_form: true, area: "main", path: "" }),
  ]);

  assert.deepEqual(result.submitCandidates, ["Submit Now"]);
  assert.deepEqual(result.linkCandidates.map((item) => item.text), ["Submit Now"]);
});
