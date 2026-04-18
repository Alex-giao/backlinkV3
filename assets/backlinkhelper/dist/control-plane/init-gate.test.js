import test from "node:test";
import assert from "node:assert/strict";
import { evaluateInitGate } from "./init-gate.js";
function makeReport(overrides = {}) {
    return {
        promoted_hostname: "exactstatement.com",
        tasks_inspected: 10,
        tasks_missing_input: 3,
        resolved_fields: [],
        auto_resolvable_fields: [],
        unresolved_fields: [],
        completeness: {
            core_ready: true,
            flow_ready: true,
            conditional_ready: false,
            missing_core_fields: [],
            missing_flow_fields: [],
            missing_conditional_fields: ["backlink_url"],
        },
        user_prompt: undefined,
        ...overrides,
    };
}
test("evaluateInitGate returns ready_to_execute when core and flow readiness pass", () => {
    const result = evaluateInitGate({
        mode: "interactive",
        report: makeReport(),
    });
    assert.equal(result.status, "ready_to_execute");
    assert.equal(result.blocking, false);
    assert.doesNotMatch(result.summary, /directory/i);
    assert.match(result.summary, /flow readiness/i);
});
test("evaluateInitGate returns needs_user_input in interactive mode when flow readiness fails", () => {
    const result = evaluateInitGate({
        mode: "interactive",
        report: makeReport({
            completeness: {
                core_ready: true,
                flow_ready: false,
                conditional_ready: false,
                missing_core_fields: [],
                missing_flow_fields: ["phone_number", "city"],
                missing_conditional_fields: [],
            },
            user_prompt: "Please provide Phone Number and City.",
        }),
    });
    assert.equal(result.status, "needs_user_input");
    assert.equal(result.blocking, true);
    assert.match(result.summary, /Phone Number/);
    assert.doesNotMatch(result.summary, /directory/i);
});
test("evaluateInitGate returns blocked_unattended in unattended mode when flow readiness fails", () => {
    const result = evaluateInitGate({
        mode: "unattended",
        report: makeReport({
            completeness: {
                core_ready: false,
                flow_ready: false,
                conditional_ready: false,
                missing_core_fields: ["contact_email"],
                missing_flow_fields: ["phone_number"],
                missing_conditional_fields: [],
            },
            user_prompt: "Please provide Contact Email and Phone Number.",
        }),
    });
    assert.equal(result.status, "blocked_unattended");
    assert.equal(result.blocking, true);
    assert.match(result.summary, /Contact Email/);
    assert.doesNotMatch(result.summary, /directory/i);
});
