import test from "node:test";
import assert from "node:assert/strict";

import { classifyTargetFlowFamily, classifyTargetSurfaceForIntake } from "./classifier.js";

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

test("classifyTargetFlowFamily infers forum_post for Zendesk community posts", () => {
  const classified = classifyTargetFlowFamily({
    targetUrl: "https://forums.pioneerdj.com/hc/en-us/community/posts/28657611549337-XDJ-RX3-with-Serato-Beat-FX-msec-not-matching",
  });

  assert.equal(classified.flowFamily, "forum_post");
  assert.equal(classified.source, "inferred");
});

test("classifyTargetFlowFamily infers forum_post for common forum engine thread URL shapes", () => {
  const targetUrls = [
    // Discourse-style: /t/<slug>/<id>
    "https://discuss.example.com/t/bank-statement-pdf-to-csv/12345",
    // Flarum-style: /d/<id>-<slug>
    "https://community.example.com/d/12345-bank-statement-pdf-to-csv",
    // NodeBB / IP.Board-style: /topic/<id>-<slug> or /topic/<id>/<slug>
    "https://forums.example.com/topic/12345-bank-statement-pdf-to-csv/",
    "https://forum.example.com/forum/topic/43353/",
    // SMF-style: index.php?topic=<id>.<page>
    "https://forum.example.com/index.php?topic=12345.0",
    // Slug-only forum route used by some custom engines: /forum/posts/view/<slug>
    "https://fantasyfeeder.com/forum/posts/view/Middle%20age%20gainers",
  ];

  for (const targetUrl of targetUrls) {
    const classified = classifyTargetFlowFamily({ targetUrl, requestedFlowFamily: "saas_directory" });
    assert.equal(classified.flowFamily, "forum_post", targetUrl);
    assert.equal(classified.source, "corrected", targetUrl);
    assert.equal(classified.correctedFromFamily, "saas_directory", targetUrl);
  }
});

test("classifyTargetFlowFamily does not treat non-post Zendesk help-center pages as forum_post", () => {
  for (const targetUrl of [
    "https://support.example.com/hc/en-us/articles/123456789-How-to-export",
    "https://support.example.com/hc/en-us/community/posts/new",
    "https://support.example.com/hc/en-us/community/topics/123456-General",
  ]) {
    const classified = classifyTargetFlowFamily({ targetUrl, requestedFlowFamily: "wp_comment" });
    assert.equal(classified.flowFamily, "wp_comment");
    assert.equal(classified.source, "explicit");
  }
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

test("classifyTargetFlowFamily infers wp_comment for unhinted article-like blog URLs", () => {
  for (const targetUrl of [
    "https://faithfulprovisions.com/8-ways-to-drink-more-water-every-day/",
    "https://blog.example.com/2026/04/statement-parser-review/",
  ]) {
    const classified = classifyTargetFlowFamily({ targetUrl });
    assert.equal(classified.flowFamily, "wp_comment", targetUrl);
    assert.equal(classified.source, "inferred", targetUrl);
  }
});

test("classifyTargetFlowFamily corrects article-like URLs away from saas_directory", () => {
  const classified = classifyTargetFlowFamily({
    targetUrl: "https://faithfulprovisions.com/8-ways-to-drink-more-water-every-day/",
    requestedFlowFamily: "saas_directory",
  });

  assert.equal(classified.flowFamily, "wp_comment");
  assert.equal(classified.source, "corrected");
  assert.equal(classified.correctedFromFamily, "saas_directory");
});

test("classifyTargetFlowFamily avoids broad forum/topic false positives", () => {
  for (const targetUrl of [
    "https://blog.example.com/article?t=utm",
    "https://support.example.com/search?topic=billing",
    "https://community.example.com/topics/marketing",
    "https://community.example.com/topics/123456-General",
    "https://forum.example.com/forum/topics/123456-General",
    "https://blog.example.com/threads/marketing",
    "https://forum.example.com/forum/",
  ]) {
    const classified = classifyTargetFlowFamily({ targetUrl, requestedFlowFamily: "wp_comment" });
    assert.equal(classified.flowFamily, "wp_comment", targetUrl);
    assert.equal(classified.source, "explicit", targetUrl);
  }
});

test("classifyTargetFlowFamily infers forum_post for embedded forum discussion redirects", () => {
  const classified = classifyTargetFlowFamily({
    targetUrl:
      "https://fioridipensiero.freeforumzone.com/mobile/error.aspx?pbu=%2fmobile%2fd%2f11864546%2f-U-2018-Esistono-temporali-dentro-e-nessun-riparo-U-2019-%2fdiscussione.aspx%3fp%3d1%26pl%3d5%26idm1%3d141688650",
  });

  assert.equal(classified.flowFamily, "forum_post");
  assert.equal(classified.source, "inferred");
});

test("classifyTargetFlowFamily infers forum_post for nested forum slug routes", () => {
  const classified = classifyTargetFlowFamily({
    targetUrl: "https://fnfansite.wixstudio.com/fridaynightfansite/forum/mod-discussion/cool-schoolgrounds-thing",
  });

  assert.equal(classified.flowFamily, "forum_post");
  assert.equal(classified.source, "inferred");

  const categoryOnly = classifyTargetFlowFamily({
    targetUrl: "https://fnfansite.wixstudio.com/fridaynightfansite/forum/mod-discussion",
  });
  assert.equal(categoryOnly.flowFamily, "saas_directory");
  assert.equal(categoryOnly.source, "defaulted");
});

test("classifyTargetSurfaceForIntake does not default ambiguous unhinted targets to saas_directory", () => {
  const classified = classifyTargetSurfaceForIntake({
    targetUrl: "https://ambiguous.example/resources",
  });

  assert.equal(classified.state, "needs_classification");
  assert.equal(classified.flowFamily, undefined);
  assert.equal(classified.source, "unknown");
  assert.doesNotMatch(classified.reason, /defaulted to saas_directory/i);
});

test("classifyTargetSurfaceForIntake still accepts strong inferred article/comment targets", () => {
  const classified = classifyTargetSurfaceForIntake({
    targetUrl: "https://faithfulprovisions.com/8-ways-to-drink-more-water-every-day/",
  });

  assert.equal(classified.state, "ready");
  assert.equal(classified.flowFamily, "wp_comment");
  assert.equal(classified.source, "inferred");
});
