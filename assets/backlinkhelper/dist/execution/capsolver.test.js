import test from "node:test";
import assert from "node:assert/strict";
import { attemptCapsolverContinuation, CapsolverClient, buildCapsolverTask, extractImageText, extractSolutionToken, resolveCapsolverConfig, } from "./capsolver.js";
test("CapSolver config enables unattended solver from env", () => {
    const config = resolveCapsolverConfig({
        CAPSOLVER_API_KEY: "key-123",
        CAPSOLVER_MAX_POLLS: "3",
        CAPSOLVER_POLL_INTERVAL_MS: "1",
    });
    assert.equal(config.enabled, true);
    assert.equal(config.apiKey, "key-123");
    assert.equal(config.maxPolls, 3);
    assert.equal(config.pollIntervalMs, 1);
});
test("CapSolver config stays disabled without API key", () => {
    const config = resolveCapsolverConfig({});
    assert.equal(config.enabled, false);
    assert.equal(config.apiKey, undefined);
});
test("buildCapsolverTask maps supported CAPTCHA descriptors to official task types", () => {
    const recaptcha = {
        kind: "recaptcha_v2",
        websiteURL: "https://example.com/form",
        websiteKey: "site-key",
        isInvisible: true,
        detail: "recaptcha",
    };
    assert.deepEqual(buildCapsolverTask(recaptcha), {
        type: "ReCaptchaV2TaskProxyLess",
        websiteURL: "https://example.com/form",
        websiteKey: "site-key",
        isInvisible: true,
    });
    const turnstile = {
        kind: "turnstile",
        websiteURL: "https://example.com/form",
        websiteKey: "turnstile-key",
        detail: "turnstile",
    };
    assert.deepEqual(buildCapsolverTask(turnstile), {
        type: "AntiTurnstileTaskProxyLess",
        websiteURL: "https://example.com/form",
        websiteKey: "turnstile-key",
    });
    const image = {
        kind: "image_to_text",
        websiteURL: "https://example.com/form",
        detail: "image",
    };
    assert.deepEqual(buildCapsolverTask(image, "base64-image"), {
        type: "ImageToTextTask",
        websiteURL: "https://example.com/form",
        module: "common",
        body: "base64-image",
    });
});
test("CapsolverClient polls token tasks until ready", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, payload: JSON.parse(String(init?.body)) });
        if (url.endsWith("/createTask")) {
            return new Response(JSON.stringify({ errorId: 0, taskId: "task-1" }), { status: 200 });
        }
        return new Response(JSON.stringify({ errorId: 0, status: "ready", solution: { gRecaptchaResponse: "token-abc" } }), { status: 200 });
    };
    const client = new CapsolverClient({
        apiKey: "secret",
        createTaskUrl: "https://api.test/createTask",
        getTaskResultUrl: "https://api.test/getTaskResult",
        pollIntervalMs: 0,
        maxPolls: 2,
        fetchImpl,
    });
    const result = await client.solve({ type: "ReCaptchaV2TaskProxyLess", websiteURL: "https://example.com", websiteKey: "k" });
    assert.equal(result.taskId, "task-1");
    assert.equal(extractSolutionToken(result.solution), "token-abc");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1]?.payload, { clientKey: "secret", taskId: "task-1" });
});
test("CapsolverClient returns ImageToText solution directly from createTask", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ errorId: 0, status: "ready", taskId: "img-1", solution: { text: "44795sds" } }), { status: 200 });
    const client = new CapsolverClient({ apiKey: "secret", pollIntervalMs: 0, fetchImpl });
    const result = await client.solve({ type: "ImageToTextTask", websiteURL: "https://example.com", body: "abc" });
    assert.equal(result.taskId, "img-1");
    assert.equal(extractImageText(result.solution), "44795sds");
});
test("attemptCapsolverContinuation records missing Turnstile sitekey as bounded failed attempt", async () => {
    const page = {
        url: () => "https://example.com/form",
        evaluate: async () => ({
            kind: "turnstile",
            websiteURL: "https://example.com/form",
            detail: "Detected Cloudflare Turnstile iframe but no sitekey was available in DOM.",
        }),
    };
    const result = await attemptCapsolverContinuation({
        page: page,
        config: {
            enabled: true,
            apiKey: "secret",
            createTaskUrl: "https://api.test/createTask",
            getTaskResultUrl: "https://api.test/getTaskResult",
            pollIntervalMs: 0,
            maxPolls: 1,
            requestTimeoutMs: 100,
        },
    });
    assert.equal(result.attempted, true);
    assert.equal(result.solved, false);
    assert.equal(result.captcha_kind, "turnstile");
    assert.equal(result.task_type, undefined);
    assert.match(result.detail, /missing websiteKey/);
});
