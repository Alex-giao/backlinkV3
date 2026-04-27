import test from "node:test";
import assert from "node:assert/strict";
import { __testInterpolateParams, __testParseWranglerJson, __testSqlLiteral } from "./wrangler-d1-data-store.js";
test("wrangler D1 SQL interpolation escapes quote-heavy JSON values", () => {
    const payload = JSON.stringify({ text: "Bob's \"quote\"; DROP? no", nested: { newline: "a\nb" } });
    assert.equal(__testSqlLiteral(null), "NULL");
    assert.equal(__testSqlLiteral(true), "1");
    assert.equal(__testSqlLiteral("O'Reilly"), "'O''Reilly'");
    assert.equal(__testInterpolateParams("INSERT INTO t (a, b, c) VALUES (?, ?, ?)", ["O'Reilly", payload, 3]), `INSERT INTO t (a, b, c) VALUES ('O''Reilly', '${payload.replace(/'/g, "''")}', 3)`);
    assert.throws(() => __testInterpolateParams("SELECT ?", []), /more placeholders/);
    assert.throws(() => __testInterpolateParams("SELECT 1", [1]), /more params/);
});
test("wrangler D1 JSON parser accepts direct and nested result envelopes", () => {
    assert.deepEqual(__testParseWranglerJson(JSON.stringify([{ results: [{ id: "a" }], success: true }])), [{ id: "a" }]);
    assert.deepEqual(__testParseWranglerJson(JSON.stringify({ result: [{ results: [{ id: "b" }] }] })), [{ id: "b" }]);
});
