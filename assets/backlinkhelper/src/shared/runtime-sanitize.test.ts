import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { chromium } from "playwright";

let harnessPromise:
  | Promise<{
      root: string;
      sanitize: typeof import("./runtime-sanitize.js");
      store: typeof import("../memory/data-store.js");
      incident: typeof import("./runtime-incident.js");
    }>
  | undefined;

async function getHarness() {
  if (!harnessPromise) {
    harnessPromise = (async () => {
      const root = await mkdtemp(path.join(tmpdir(), "bh-runtime-sanitize-"));
      process.env.BACKLINER_DATA_ROOT = root;
      const token = `case=${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const sanitizeUrl = new URL("./runtime-sanitize.js", import.meta.url);
      sanitizeUrl.search = token;
      const storeUrl = new URL("../memory/data-store.js", import.meta.url);
      storeUrl.search = token;
      const incidentUrl = new URL("./runtime-incident.js", import.meta.url);
      incidentUrl.search = token;
      const sanitize = await import(sanitizeUrl.href);
      const store = await import(storeUrl.href);
      const incident = await import(incidentUrl.href);
      return { root, sanitize, store, incident };
    })();
  }

  return harnessPromise;
}

async function resetHarness() {
  const { root, store } = await getHarness();
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await store.ensureDataDirectories();
}

test("tryAutoRecoverRuntimeIncident closes stale regular pages and clears the breaker after full recovery", async () => {
  const { sanitize, incident } = await getHarness();
  await resetHarness();

  await incident.openRuntimeIncident({
    kind: "PLAYWRIGHT_CDP_UNAVAILABLE",
    source: "task-prepare",
    detail: "polluted browser",
    cdp_url: "http://127.0.0.1:9224",
  });

  const originalFetch = globalThis.fetch;
  const originalConnect = chromium.connectOverCDP;
  const fetchCalls: string[] = [];
  let listCount = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    fetchCalls.push(url);
    if (url.endsWith("/json/list")) {
      listCount += 1;
      return {
        ok: true,
        json: async () =>
          listCount <= 2
            ? [
                { id: "stale-a", type: "page", title: "A", url: "https://example.com/a" },
                { id: "stale-b", type: "page", title: "B", url: "https://example.com/b" },
                { id: "stale-c", type: "page", title: "C", url: "https://example.com/c" },
                { id: "sw", type: "service_worker", title: "sw", url: "chrome-extension://abc/sw.js" },
              ]
            : [{ id: "blank", type: "page", title: "about:blank", url: "about:blank" }],
      } as Response;
    }
    if (url.includes("/json/close/")) {
      return { ok: true, text: async () => "Target is closing" } as Response;
    }
    if (url.endsWith("/json/version")) {
      return {
        ok: true,
        json: async () => ({ Browser: "Chrome/146", webSocketDebuggerUrl: "ws://127.0.0.1:9224/devtools/browser/abc123" }),
      } as Response;
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;
  (chromium as typeof chromium & { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP = (async () => ({
    contexts: () => [{ pages: () => [{ url: () => "about:blank" }] }],
    newContext: async () => ({ pages: () => [{ url: () => "about:blank" }], newPage: async () => ({ url: () => "about:blank" }) }),
    close: async () => undefined,
  })) as unknown as typeof chromium.connectOverCDP;

  try {
    const result = await sanitize.tryAutoRecoverRuntimeIncident("http://127.0.0.1:9224");
    const saved = await incident.loadRuntimeIncident();
    const recoveryStatus = await sanitize.loadRuntimeRecoveryStatus();

    assert.equal(result.recovered, true);
    assert.equal(result.sanitized_targets, 3);
    assert.equal(saved, undefined);
    assert.equal(fetchCalls.filter((url) => url.includes("/json/close/")).length, 3);
    assert.equal(recoveryStatus?.last_attempt?.recovered, true);
    assert.equal(recoveryStatus?.last_attempt?.sanitized_targets, 3);
    assert.equal(recoveryStatus?.recent_attempts.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    (chromium as typeof chromium & { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP = originalConnect;
  }
});

test("tryAutoRecoverRuntimeIncident skips cleanup when a worker lease is still active", async () => {
  const { sanitize, store, incident } = await getHarness();
  await resetHarness();

  await incident.openRuntimeIncident({
    kind: "PLAYWRIGHT_CDP_UNAVAILABLE",
    source: "task-prepare",
    detail: "polluted browser",
    cdp_url: "http://127.0.0.1:9224",
  });
  await store.saveWorkerLease({
    task_id: "task-1",
    owner: "active-worker",
    acquired_at: "2026-04-23T00:00:00.000Z",
    expires_at: "2099-04-23T00:10:00.000Z",
    group: "active",
    lane: "active_any",
  });

  const result = await sanitize.tryAutoRecoverRuntimeIncident("http://127.0.0.1:9224");
  const saved = await incident.loadRuntimeIncident();
  const recoveryStatus = await sanitize.loadRuntimeRecoveryStatus();

  assert.equal(result.recovered, false);
  assert.match(result.detail, /lease/i);
  assert.notEqual(saved, undefined);
  assert.equal(recoveryStatus?.last_attempt?.recovered, false);
  assert.match(recoveryStatus?.last_attempt?.detail ?? "", /lease/i);
});
