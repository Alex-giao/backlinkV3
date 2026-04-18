import test from "node:test";
import assert from "node:assert/strict";

import { resolveTargetUrlFlag } from "./index.js";

test("resolveTargetUrlFlag prefers canonical --target-url while keeping --directory-url as legacy alias", () => {
  assert.equal(resolveTargetUrlFlag(["--directory-url", "https://legacy.example/"]), "https://legacy.example/");
  assert.equal(resolveTargetUrlFlag(["--target-url", "https://target.example/"]), "https://target.example/");
  assert.equal(
    resolveTargetUrlFlag([
      "--directory-url",
      "https://legacy.example/",
      "--target-url",
      "https://target.example/",
    ]),
    "https://target.example/",
  );
  assert.equal(resolveTargetUrlFlag([]), undefined);
});
