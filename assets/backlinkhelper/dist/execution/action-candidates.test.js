import test from "node:test";
import assert from "node:assert/strict";
import { buildScoutActionCandidates } from "./action-candidates.js";
function makeCandidate(overrides = {}) {
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
test("sibling-domain header register link is retained as a registration continuation", () => {
    const result = buildScoutActionCandidates([
        makeCandidate({
            text: "Register",
            href: "https://www.pioneerdj.com/en/account/register/",
            area: "header",
            same_origin: false,
            same_site: true,
            path: "/en/account/register/",
            top: 24,
        }),
        makeCandidate({
            text: "Register",
            href: "https://accounts.unrelated.example/register",
            area: "header",
            same_origin: false,
            same_site: false,
            path: "/register",
            top: 24,
        }),
    ]);
    assert.deepEqual(result.linkCandidates.map((item) => ({ text: item.text, href: item.href, kind: item.kind })), [
        {
            text: "Register",
            href: "https://www.pioneerdj.com/en/account/register/",
            kind: "register",
        },
    ]);
});
test("sibling-domain ordinary navigation is not promoted as a submit continuation", () => {
    const result = buildScoutActionCandidates([
        makeCandidate({
            text: "Products",
            href: "https://www.example.com/products/",
            area: "header",
            same_origin: false,
            same_site: true,
            path: "/products/",
            top: 24,
        }),
        makeCandidate({
            text: "Register",
            href: "https://www.example.com/account/register/",
            area: "header",
            same_origin: false,
            same_site: true,
            path: "/account/register/",
            top: 28,
        }),
    ]);
    assert.deepEqual(result.submitCandidates, []);
    assert.deepEqual(result.linkCandidates.map((item) => ({ text: item.text, kind: item.kind })), [
        { text: "Register", kind: "register" },
    ]);
    assert.deepEqual(result.ctaCandidates, ["Register"]);
});
test("sibling-domain register continuation rejects cleartext http links", () => {
    const result = buildScoutActionCandidates([
        makeCandidate({
            text: "Register",
            href: "http://www.example.com/account/register/",
            area: "header",
            same_origin: false,
            same_site: true,
            path: "/account/register/",
            top: 24,
        }),
    ]);
    assert.deepEqual(result.linkCandidates, []);
    assert.deepEqual(result.ctaCandidates, []);
});
test("register and auth links are prioritized above same-origin generic navigation", () => {
    const result = buildScoutActionCandidates([
        makeCandidate({ text: "Products", href: "https://forums.example.com/products/", area: "header", path: "/products/", top: 20 }),
        makeCandidate({ text: "Downloads", href: "https://forums.example.com/downloads/", area: "header", path: "/downloads/", top: 22 }),
        makeCandidate({ text: "Register", href: "https://www.example.com/account/register/", area: "header", same_origin: false, same_site: true, path: "/account/register/", top: 24 }),
        makeCandidate({ text: "Sign in", href: "https://www.example.com/login/", area: "header", same_origin: false, same_site: true, path: "/login/", top: 26 }),
    ]);
    assert.deepEqual(result.ctaCandidates.slice(0, 2), ["Register", "Sign in"]);
    assert.deepEqual(result.linkCandidates.slice(0, 2).map((item) => item.kind), ["register", "auth"]);
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
test("registration variants win over auth and real trailing-hash register links are kept", () => {
    const result = buildScoutActionCandidates([
        makeCandidate({ text: "Continue", href: "https://example.com/auth/register", area: "header", path: "/auth/register", top: 20 }),
        makeCandidate({ text: "Join", href: "https://example.com/users/sign_up", area: "header", path: "/users/sign_up", top: 22 }),
        makeCandidate({ text: "Register", href: "https://example.com/register#", area: "header", path: "/register", same_page: false, top: 24 }),
    ]);
    assert.deepEqual(result.linkCandidates.map((item) => item.kind), ["register", "register", "register"]);
    assert.equal(result.linkCandidates.some((item) => item.href === "https://example.com/register#"), true);
});
test("same-origin cleartext auth and register links are not credential continuations", () => {
    const result = buildScoutActionCandidates([
        makeCandidate({ text: "Register", href: "http://example.com/register", same_origin: true, path: "/register" }),
        makeCandidate({ text: "Sign in", href: "http://example.com/login", same_origin: true, path: "/login" }),
    ]);
    assert.deepEqual(result.linkCandidates, []);
    assert.deepEqual(result.ctaCandidates, []);
});
