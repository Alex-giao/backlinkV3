import test from "node:test";
import assert from "node:assert/strict";
import { inspectBrowserTargetHealth } from "./runtime-health.js";
test("inspectBrowserTargetHealth flags suspicious retained regular pages on the shared browser", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
        const url = String(input);
        if (url.endsWith("/json/list")) {
            return {
                ok: true,
                json: async () => ([
                    { id: "1", type: "page", title: "about:blank", url: "about:blank" },
                    { id: "2", type: "page", title: "Task A", url: "https://example.com/a" },
                    { id: "3", type: "page", title: "Task B", url: "https://example.com/b" },
                    { id: "4", type: "page", title: "Task C", url: "https://example.com/c" },
                    { id: "5", type: "service_worker", title: "sw", url: "chrome-extension://abc/sw.js" },
                ]),
            };
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
    });
    try {
        const health = await inspectBrowserTargetHealth("http://127.0.0.1:9224");
        assert.equal(health.ok, true);
        assert.equal(health.total_targets, 5);
        assert.equal(health.page_targets, 4);
        assert.equal(health.regular_page_targets, 3);
        assert.equal(health.suspicious, true);
        assert.match(health.detail, /retained regular pages/i);
    }
    finally {
        globalThis.fetch = originalFetch;
    }
});
