import test from "node:test";
import assert from "node:assert/strict";

import { classifyImportedTargetFlowFamily } from "./import-backlink-csv.js";

test("classifyImportedTargetFlowFamily corrects imported forum threads away from wp_comment hints", () => {
  const classified = classifyImportedTargetFlowFamily({
    targetUrl: "https://cyberlord.at/forum/?id=1&thread=6857",
    requestedFlowFamily: "wp_comment",
  });

  assert.equal(classified.flowFamily, "forum_post");
  assert.equal(classified.source, "corrected");
  assert.equal(classified.correctedFromFamily, "wp_comment");
  assert.match(classified.reason, /forum\/thread/i);
});
