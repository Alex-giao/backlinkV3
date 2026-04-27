import test from "node:test";
import assert from "node:assert/strict";

import { classifyTargetFlowFamily } from "./classifier.js";

test("classifyTargetFlowFamily corrects forum thread URLs out of wp_comment into forum_post", () => {
  const classified = classifyTargetFlowFamily({
    targetUrl: "https://cyberlord.at/forum/?id=1&thread=6857",
    requestedFlowFamily: "wp_comment",
  });

  assert.equal(classified.flowFamily, "forum_post");
  assert.equal(classified.source, "corrected");
  assert.equal(classified.correctedFromFamily, "wp_comment");
  assert.match(classified.reason, /forum\/thread/i);
});

test("classifyTargetFlowFamily infers forum_post for unhinted discussion thread URLs", () => {
  const classified = classifyTargetFlowFamily({
    targetUrl: "https://community.example.com/threads/bank-statement-pdf-to-csv.42/",
  });

  assert.equal(classified.flowFamily, "forum_post");
  assert.equal(classified.source, "inferred");
  assert.equal(classified.correctedFromFamily, undefined);
});

test("classifyTargetFlowFamily keeps ordinary blog article comment URLs in wp_comment", () => {
  const classified = classifyTargetFlowFamily({
    targetUrl: "https://blog.example.com/2026/04/statement-parser-review/",
    requestedFlowFamily: "wp_comment",
  });

  assert.equal(classified.flowFamily, "wp_comment");
  assert.equal(classified.source, "explicit");
  assert.equal(classified.correctedFromFamily, undefined);
});
