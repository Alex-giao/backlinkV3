import test from "node:test";
import assert from "node:assert/strict";

import { chromium } from "playwright";

import { checkPlaywright } from "./preflight.js";

test("checkPlaywright skip mode avoids connectOverCDP and reports a light preflight skip", async () => {
  const original = chromium.connectOverCDP;
  let called = false;
  (chromium as typeof chromium & { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP = (async () => {
    called = true;
    throw new Error("connectOverCDP should not be called in skip mode");
  }) as typeof chromium.connectOverCDP;

  try {
    const result = await checkPlaywright("http://127.0.0.1:9224", { mode: "skip" });
    assert.equal(result.ok, true);
    assert.match(result.detail, /skip/i);
    assert.equal(called, false);
  } finally {
    (chromium as typeof chromium & { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP = original;
  }
});
