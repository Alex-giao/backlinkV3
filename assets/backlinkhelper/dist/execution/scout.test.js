import assert from "node:assert/strict";
import test from "node:test";
import { generateScoutNavigationCandidates } from "./scout.js";
test("generateScoutNavigationCandidates tries safe canonical URL variants before giving up", () => {
    const candidates = generateScoutNavigationCandidates("http://example.com/path/article.html?utm_source=x&utm_medium=y&ref=feed#comments");
    assert.deepEqual(candidates, [
        "http://example.com/path/article.html?utm_source=x&utm_medium=y&ref=feed#comments",
        "https://example.com/path/article.html?utm_source=x&utm_medium=y&ref=feed#comments",
        "http://example.com/path/article.html#comments",
        "https://example.com/path/article.html#comments",
        "http://example.com/path/article.html",
        "https://example.com/path/article.html",
    ]);
});
test("generateScoutNavigationCandidates preserves non-tracking query parameters", () => {
    const candidates = generateScoutNavigationCandidates("https://forum.example/viewtopic.php?t=5271&utm_campaign=x");
    assert.deepEqual(candidates, [
        "https://forum.example/viewtopic.php?t=5271&utm_campaign=x",
        "https://forum.example/viewtopic.php?t=5271",
    ]);
});
