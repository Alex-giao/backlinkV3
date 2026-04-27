import test from "node:test";
import assert from "node:assert/strict";
import { buildTargetPreflightAssessment, findExactHostDuplicateTasks } from "./target-preflight.js";
function makeTask(overrides = {}) {
    return {
        id: "task-1",
        target_url: "https://example.com/submit",
        hostname: "example.com",
        submission: {
            promoted_profile: {
                url: "https://exactstatement.com/",
                hostname: "exactstatement.com",
                name: "Exact Statement",
                description: "desc",
                category_hints: ["finance"],
                source: "fallback",
            },
            confirm_submit: true,
        },
        status: "READY",
        created_at: "2026-04-08T00:00:00.000Z",
        updated_at: "2026-04-08T00:00:00.000Z",
        run_count: 0,
        escalation_level: "none",
        takeover_attempts: 0,
        phase_history: [],
        latest_artifacts: [],
        notes: [],
        ...overrides,
    };
}
test("buildTargetPreflightAssessment boosts strong submit-like paths and penalizes weak commercial/auth paths", () => {
    const strong = buildTargetPreflightAssessment({
        targetUrl: "https://toolhub.example.com/add-listing",
        promotedHostname: "exactstatement.com",
        flowFamily: "saas_directory",
    });
    const weak = buildTargetPreflightAssessment({
        targetUrl: "https://toolhub.example.com/pricing/login",
        promotedHostname: "exactstatement.com",
        flowFamily: "saas_directory",
    });
    assert.equal(strong.viability, "promising");
    assert.ok(strong.queue_priority_score > weak.queue_priority_score);
    assert.equal(weak.viability, "deprioritized");
});
test("buildTargetPreflightAssessment incorporates exact-host history without collapsing sibling subdomains", () => {
    const assessment = buildTargetPreflightAssessment({
        targetUrl: "https://community.saashub.com/submit",
        promotedHostname: "exactstatement.com",
        flowFamily: "saas_directory",
        historicalTasks: [
            makeTask({
                id: "done-hit",
                hostname: "community.saashub.com",
                status: "DONE",
            }),
            makeTask({
                id: "fast-fail-hit",
                hostname: "community.saashub.com",
                status: "SKIPPED",
                updated_at: "2026-04-09T00:00:00.000Z",
            }),
            makeTask({
                id: "different-subdomain",
                hostname: "saashub.com",
                status: "DONE",
            }),
        ],
    });
    assert.equal(assessment.historical_exact_host_hits, 2);
    assert.equal(assessment.historical_success_count, 1);
    assert.equal(assessment.historical_fast_fail_count, 1);
});
test("wp_comment preflight rejects obvious forum/thread URLs instead of treating them as article comments", () => {
    const assessment = buildTargetPreflightAssessment({
        targetUrl: "https://cyberlord.at/forum/?id=1&thread=6857",
        promotedHostname: "suikagame.fun",
        flowFamily: "wp_comment",
    });
    assert.equal(assessment.viability, "deprioritized");
    assert.ok(assessment.queue_priority_score < 40);
    assert.ok(assessment.signals.some((signal) => signal.detail.includes("Forum/thread URL should not be treated as a wp_comment surface")));
});
test("findExactHostDuplicateTasks only matches the same promoted hostname and exact target hostname", () => {
    const matches = findExactHostDuplicateTasks({
        tasks: [
            makeTask({ id: "same-host", hostname: "community.saashub.com" }),
            makeTask({ id: "different-subdomain", hostname: "saashub.com" }),
            makeTask({
                id: "different-promoted",
                hostname: "community.saashub.com",
                submission: {
                    promoted_profile: {
                        url: "https://other.com/",
                        hostname: "other.com",
                        name: "Other",
                        description: "desc",
                        category_hints: ["finance"],
                        source: "fallback",
                    },
                    confirm_submit: true,
                },
            }),
        ],
        promotedHostname: "exactstatement.com",
        targetHostname: "community.saashub.com",
    });
    assert.deepEqual(matches.map((task) => task.id), ["same-host"]);
});
