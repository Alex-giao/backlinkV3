import test from "node:test";
import assert from "node:assert/strict";

import { extractShadowElementsFromText, resolveBrowserUseCdpUrl } from "./browser-use-cli.js";

test("resolveBrowserUseCdpUrl upgrades http CDP endpoint to websocket debugger url", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9224/devtools/browser/abc123" }),
    }) as Response) as typeof fetch;

  try {
    const resolved = await resolveBrowserUseCdpUrl("http://127.0.0.1:9224");
    assert.equal(resolved, "ws://127.0.0.1:9224/devtools/browser/abc123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveBrowserUseCdpUrl keeps ws endpoints unchanged", async () => {
  const resolved = await resolveBrowserUseCdpUrl("ws://127.0.0.1:9224/devtools/browser/existing");
  assert.equal(resolved, "ws://127.0.0.1:9224/devtools/browser/existing");
});

test("resolveBrowserUseCdpUrl normalizes localhost debugger urls to 127.0.0.1", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({ webSocketDebuggerUrl: "ws://localhost:9224/devtools/browser/abc123" }),
    }) as Response) as typeof fetch;

  try {
    const resolved = await resolveBrowserUseCdpUrl("http://localhost:9224");
    assert.equal(resolved, "ws://127.0.0.1:9224/devtools/browser/abc123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("extractShadowElementsFromText exposes shadow DOM inputs as actionable elements", () => {
  const raw = `\n[19933]<svg /> <!-- SVG content collapsed --> |SHADOW(open)|[19954]<input value='Username' type=text name=username placeholder=Username /> [19957]<input value='Email' type=email name=email placeholder=Email /> [19960]<input type=password name=password placeholder=Password />`;
  const elements = extractShadowElementsFromText(raw);

  assert.deepEqual(
    elements.map((element) => element.index),
    [19954, 19957, 19960],
  );
  assert.equal(elements[0]?.text, "Username username text");
  assert.equal(elements[2]?.descriptor.includes("type=password"), true);
});
