import test from "node:test";
import assert from "node:assert/strict";
import { classifyRel, verifyLinkCandidates } from "./link-verifier.js";
test("verifyLinkCandidates returns verified visible backlink evidence when target link exists", () => {
    const result = verifyLinkCandidates({
        livePageUrl: "https://community.example.com/profile/alex",
        targetUrl: "https://exactstatement.com/",
        candidates: [
            {
                href: "https://exactstatement.com/?ref=community-profile",
                text: "Exact Statement",
                rel: "ugc nofollow",
                isVisible: true,
            },
        ],
    });
    assert.equal(result.verification_status, "verified_link_present");
    assert.equal(result.visible_state, "visible");
    assert.equal(result.target_link_url, "https://exactstatement.com/?ref=community-profile");
    assert.equal(result.anchor_text, "Exact Statement");
    assert.deepEqual(result.rel_flags, ["ugc", "nofollow"]);
});
test("verifyLinkCandidates returns link_missing when no matching target link exists", () => {
    const result = verifyLinkCandidates({
        livePageUrl: "https://example.com/post/1",
        targetUrl: "https://exactstatement.com/",
        candidates: [
            {
                href: "https://another-site.example.com/",
                text: "Another Site",
                rel: "nofollow",
                isVisible: true,
            },
        ],
    });
    assert.equal(result.verification_status, "link_missing");
    assert.equal(result.visible_state, "missing");
    assert.equal(result.target_link_url, undefined);
});
test("classifyRel normalizes rel tokens into ordered flags", () => {
    assert.deepEqual(classifyRel("sponsored ugc nofollow"), ["ugc", "sponsored", "nofollow"]);
    assert.deepEqual(classifyRel(""), []);
});
