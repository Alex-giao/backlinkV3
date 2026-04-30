import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runOperatorCommand, runUnattendedCampaign } from "./unattended-campaign-runner.js";
function makePromotedProfile() {
    return {
        url: "https://promo.example/",
        hostname: "promo.example",
        name: "Promo Example",
        description: "A product being promoted",
        category_hints: ["productivity"],
        source: "fallback",
        probe_version: "deep-probe/v1",
        probed_at: "2026-04-22T00:00:00.000Z",
    };
}
function makeTask(overrides = {}) {
    return {
        id: "campaign-0001-target-example",
        target_url: "https://target.example/submit",
        hostname: "target.example",
        flow_family: "saas_directory",
        submission: {
            promoted_profile: makePromotedProfile(),
            submitter_email: "operator@example.com",
            confirm_submit: false,
        },
        status: "RUNNING",
        created_at: "2026-04-22T00:00:00.000Z",
        updated_at: "2026-04-22T00:00:00.000Z",
        run_count: 1,
        escalation_level: "none",
        takeover_attempts: 0,
        phase_history: [],
        latest_artifacts: [],
        notes: [],
        ...overrides,
    };
}
function makeLease(taskId) {
    return {
        task_id: taskId,
        owner: "campaign-runner-test",
        acquired_at: "2026-04-22T00:00:00.000Z",
        expires_at: "2026-04-22T00:30:00.000Z",
        group: "active",
        lane: "active_any",
        previous_status: "READY",
    };
}
function makeReadyPrepare(task) {
    return {
        mode: "ready_for_agent_loop",
        task,
        effective_target_url: task.target_url,
        replay_hit: false,
        scout_artifact_ref: `/tmp/${task.id}-scout.json`,
        scout: {
            ok: true,
            surface_summary: "Reachable submit surface.",
            page_snapshot: {
                url: task.target_url,
                title: "Submit",
                body_text_excerpt: "Submit your website",
            },
            submit_candidates: ["Submit"],
            evidence_sufficiency: true,
            auth_hints: [],
            anti_bot_hints: [],
            field_hints: [],
            link_candidates: [],
            embed_hints: [],
        },
    };
}
function makeStoppedPrepare(task) {
    return {
        mode: "task_stopped",
        task: { ...task, status: "RETRYABLE" },
        effective_target_url: task.target_url,
        replay_hit: false,
        scout_artifact_ref: `/tmp/${task.id}-scout.json`,
        scout: {
            ok: false,
            surface_summary: "Target navigation failed and was moved to retryable cooldown.",
            page_snapshot: {
                url: task.target_url,
                title: "Navigation failed",
                body_text_excerpt: "Connection closed before the page could load.",
            },
            submit_candidates: [],
            evidence_sufficiency: false,
            auth_hints: [],
            anti_bot_hints: [],
            field_hints: [],
            link_candidates: [],
            embed_hints: [],
        },
    };
}
function makeEnvelope(task) {
    return {
        trace: {
            task_id: task.id,
            agent_backend: "unit-test-operator",
            started_at: "2026-04-22T00:00:00.000Z",
            finished_at: "2026-04-22T00:01:00.000Z",
            stop_reason: "submitted",
            final_url: task.target_url,
            final_title: "Thanks",
            final_excerpt: "Thanks for submitting",
            steps: [],
        },
        handoff: {
            detail: "Unit-test operator submitted the form.",
            artifact_refs: [],
            current_url: task.target_url,
            recorded_steps: [],
            agent_trace_ref: `/tmp/${task.id}-agent-loop.json`,
            agent_backend: "unit-test-operator",
            agent_steps_count: 0,
            proposed_outcome: {
                next_status: "WAITING_SITE_RESPONSE",
                detail: "Submission accepted and waiting for publication.",
            },
        },
    };
}
function makeFinalizeResult() {
    return {
        ok: true,
        next_status: "WAITING_SITE_RESPONSE",
        detail: "Submission accepted and waiting for publication.",
        artifact_refs: ["/tmp/finalization.json"],
        terminal_class: "outcome_not_confirmed",
    };
}
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
test("operator command timeout terminates the whole child process group", async () => {
    if (process.platform === "win32") {
        return;
    }
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "backlinkhelper-operator-timeout-"));
    const childPidPath = path.join(tempDir, "child.pid");
    const scriptPath = path.join(tempDir, "operator.mjs");
    fs.writeFileSync(scriptPath, [
        "import { spawn } from 'node:child_process';",
        "import fs from 'node:fs';",
        `const child = spawn(process.execPath, ['-e', 'process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000);'], { stdio: 'ignore' });`,
        `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
        "setInterval(() => {}, 1000);",
    ].join("\n"));
    const task = makeTask();
    await assert.rejects(() => runOperatorCommand({
        command: `${process.execPath} ${scriptPath}`,
        context: {
            task,
            prepare: makeReadyPrepare(task),
            scope: { promotedHostname: "promo.example", promotedUrl: "https://promo.example/" },
            owner: "campaign-runner-test",
            promotedUrl: "https://promo.example/",
            promotedHostname: "promo.example",
        },
        timeoutMs: 100,
        killGraceMs: 50,
    }), /timed out/);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const childPid = Number(fs.readFileSync(childPidPath, "utf8"));
    assert.equal(isProcessAlive(childPid), false);
});
test("runUnattendedCampaign loops intake enqueue -> claim -> prepare -> operator -> record -> finalize -> follow-up", async () => {
    const task = makeTask();
    const lease = makeLease(task.id);
    const calls = [];
    const scopeResults = [
        {
            action: "enqueued",
            scope: { promotedHostname: "promo.example", promotedUrl: "https://promo.example/" },
            detail: "Selected a fresh target.",
            task: { ...task, status: "READY", run_count: 0 },
        },
        {
            action: "claimed",
            scope: { promotedHostname: "promo.example", promotedUrl: "https://promo.example/" },
            detail: "Claimed scoped task.",
            task,
            lease,
        },
    ];
    const result = await runUnattendedCampaign({
        owner: "campaign-runner-test",
        promotedUrl: "https://promo.example/",
        promotedName: "Promo Example",
        submitterEmailBase: "operator@example.com",
        taskIdPrefix: "campaign",
        maxActiveTasks: 1,
    }, {
        runScopeTick: async (args) => {
            calls.push(`scope:${args.dryRun ? "dry" : "live"}`);
            const next = scopeResults.shift();
            assert.ok(next, "expected one more scope tick result");
            return next;
        },
        prepareTask: async (args) => {
            calls.push(`prepare:${args.taskId}`);
            assert.equal(args.taskId, task.id);
            return makeReadyPrepare(task);
        },
        runOperator: async (context) => {
            calls.push(`operator:${context.task.id}`);
            assert.equal(context.prepare.mode, "ready_for_agent_loop");
            assert.equal(context.scope.promotedUrl, "https://promo.example/");
            return makeEnvelope(task);
        },
        recordAgentTrace: async (args) => {
            calls.push(`record:${args.taskId}`);
            assert.equal(args.envelope.trace.task_id, task.id);
            return {
                task_id: args.taskId,
                trace_ref: `/tmp/${args.taskId}-agent-loop.json`,
                pending_finalize_ref: `/tmp/${args.taskId}-pending-finalize.json`,
            };
        },
        finalizeTask: async (args) => {
            calls.push(`finalize:${args.taskId}`);
            return makeFinalizeResult();
        },
        runFollowUpTick: async (args) => {
            calls.push(`follow-up:${args.promotedUrl}`);
            return { mode: "idle" };
        },
    });
    assert.deepEqual(calls, [
        "scope:live",
        "scope:live",
        `prepare:${task.id}`,
        `operator:${task.id}`,
        `record:${task.id}`,
        `finalize:${task.id}`,
        "follow-up:https://promo.example/",
    ]);
    assert.equal(result.stop_reason, "max_active_tasks");
    assert.equal(result.active_tasks_started, 1);
    assert.equal(result.active_tasks_finalized, 1);
    assert.equal(result.follow_up_ticks, 1);
    assert.equal(result.events.at(-1)?.phase, "stop");
});
test("runUnattendedCampaign recovers the active lease when the operator fails before handoff", async () => {
    const task = makeTask();
    const lease = makeLease(task.id);
    const calls = [];
    const result = await runUnattendedCampaign({
        owner: "campaign-runner-test",
        promotedUrl: "https://promo.example/",
        maxActiveTasks: 1,
    }, {
        runScopeTick: async () => {
            calls.push("scope");
            return {
                action: "claimed",
                scope: { promotedHostname: "promo.example", promotedUrl: "https://promo.example/" },
                detail: "Claimed scoped task.",
                task,
                lease,
            };
        },
        prepareTask: async (args) => {
            calls.push(`prepare:${args.taskId}`);
            return makeReadyPrepare(task);
        },
        runOperator: async () => {
            calls.push("operator");
            throw new Error("Operator command timed out after 100ms.");
        },
        handleOperatorFailure: async (args) => {
            calls.push(`recover:${args.taskId}`);
            assert.equal(args.taskId, task.id);
            assert.equal(args.lease, lease);
            assert.match(args.error instanceof Error ? args.error.message : String(args.error), /timed out/);
            return { reapedTaskId: task.id };
        },
        recordAgentTrace: async () => {
            throw new Error("recordAgentTrace should not run after operator failure");
        },
        finalizeTask: async () => {
            throw new Error("finalizeTask should not run after operator failure");
        },
        runFollowUpTick: async () => {
            throw new Error("runFollowUpTick should not run after operator failure");
        },
    });
    assert.deepEqual(calls, ["scope", `prepare:${task.id}`, "operator", `recover:${task.id}`]);
    assert.equal(result.stop_reason, "max_active_tasks");
    assert.equal(result.active_tasks_started, 1);
    assert.equal(result.active_tasks_finalized, 0);
    assert.equal(result.events.some((event) => event.phase === "operator" && event.action === "runtime_failure"), true);
});
test("runUnattendedCampaign keeps pulling candidates after task-prepare stops a claimed task", async () => {
    const stoppedTask = makeTask({
        id: "campaign-0001-dead-target",
        target_url: "https://dead.example/submit",
        hostname: "dead.example",
    });
    const readyTask = makeTask({ id: "campaign-0002-good-target" });
    const scopeResults = [
        {
            action: "claimed",
            scope: { promotedHostname: "promo.example", promotedUrl: "https://promo.example/" },
            detail: "Claimed dead scoped task.",
            task: stoppedTask,
            lease: makeLease(stoppedTask.id),
        },
        {
            action: "claimed",
            scope: { promotedHostname: "promo.example", promotedUrl: "https://promo.example/" },
            detail: "Claimed next scoped task.",
            task: readyTask,
            lease: makeLease(readyTask.id),
        },
    ];
    const calls = [];
    const result = await runUnattendedCampaign({
        owner: "campaign-runner-test",
        promotedUrl: "https://promo.example/",
        maxActiveTasks: 1,
        maxScopeTicks: 3,
    }, {
        runScopeTick: async () => {
            calls.push("scope");
            const next = scopeResults.shift();
            assert.ok(next, "expected one more scope tick result");
            return next;
        },
        prepareTask: async (args) => {
            calls.push(`prepare:${args.taskId}`);
            return args.taskId === stoppedTask.id ? makeStoppedPrepare(stoppedTask) : makeReadyPrepare(readyTask);
        },
        runOperator: async (context) => {
            calls.push(`operator:${context.task.id}`);
            assert.equal(context.task.id, readyTask.id);
            return makeEnvelope(readyTask);
        },
        recordAgentTrace: async (args) => {
            calls.push(`record:${args.taskId}`);
            return {
                task_id: args.taskId,
                trace_ref: `/tmp/${args.taskId}-agent-loop.json`,
                pending_finalize_ref: `/tmp/${args.taskId}-pending-finalize.json`,
            };
        },
        finalizeTask: async (args) => {
            calls.push(`finalize:${args.taskId}`);
            return makeFinalizeResult();
        },
        runFollowUpTick: async () => {
            calls.push("follow-up");
            return { mode: "idle" };
        },
    });
    assert.deepEqual(calls, [
        "scope",
        `prepare:${stoppedTask.id}`,
        "follow-up",
        "scope",
        `prepare:${readyTask.id}`,
        `operator:${readyTask.id}`,
        `record:${readyTask.id}`,
        `finalize:${readyTask.id}`,
    ]);
    assert.equal(result.stop_reason, "max_active_tasks");
    assert.equal(result.scope_ticks, 2);
    assert.equal(result.active_tasks_started, 1);
    assert.equal(result.active_tasks_finalized, 1);
});
test("runUnattendedCampaign refuses live active mutation when no operator is configured", async () => {
    let scopeTickCalled = false;
    const result = await runUnattendedCampaign({
        owner: "campaign-runner-test",
        promotedUrl: "https://promo.example/",
        maxActiveTasks: 1,
    }, {
        runScopeTick: async () => {
            scopeTickCalled = true;
            throw new Error("scope tick should not be called without an operator");
        },
    });
    assert.equal(scopeTickCalled, false);
    assert.equal(result.stop_reason, "operator_unavailable");
    assert.equal(result.active_tasks_started, 0);
});
test("runUnattendedCampaign dry-run previews the next scope tick without requiring an operator", async () => {
    const task = makeTask({ status: "READY", run_count: 0 });
    const result = await runUnattendedCampaign({
        owner: "campaign-runner-test",
        promotedUrl: "https://promo.example/",
        dryRun: true,
    }, {
        runScopeTick: async (args) => {
            assert.equal(args.dryRun, true);
            return {
                action: "claimed",
                scope: { promotedHostname: "promo.example", promotedUrl: "https://promo.example/" },
                detail: "Dry run: would claim scoped task.",
                task,
                dry_run: true,
            };
        },
    });
    assert.equal(result.stop_reason, "dry_run_preview");
    assert.equal(result.active_tasks_started, 0);
    assert.equal(result.events[0]?.phase, "scope_tick");
    assert.equal(result.events[0]?.action, "claimed");
});
test("runUnattendedCampaign refuses live mutation without an exact promoted URL scope", async () => {
    let scopeTickCalled = false;
    const result = await runUnattendedCampaign({
        owner: "campaign-runner-test",
        promotedHostname: "promo.example",
        maxActiveTasks: 1,
    }, {
        runScopeTick: async () => {
            scopeTickCalled = true;
            throw new Error("scope tick should not be called without exact promoted URL");
        },
        runOperator: async () => makeEnvelope(makeTask()),
    });
    assert.equal(scopeTickCalled, false);
    assert.equal(result.stop_reason, "needs_manual_boundary");
    assert.equal(result.scope_ticks, 0);
});
test("runUnattendedCampaign refuses mismatched promoted URL and hostname scope", async () => {
    let scopeTickCalled = false;
    const result = await runUnattendedCampaign({
        owner: "campaign-runner-test",
        promotedUrl: "https://promo.example/",
        promotedHostname: "other.example",
        maxActiveTasks: 1,
    }, {
        runScopeTick: async () => {
            scopeTickCalled = true;
            throw new Error("scope tick should not be called with mismatched promoted scope");
        },
        runOperator: async () => makeEnvelope(makeTask()),
    });
    assert.equal(scopeTickCalled, false);
    assert.equal(result.stop_reason, "scope_mismatch");
    assert.equal(result.scope_ticks, 0);
});
test("runUnattendedCampaign rejects follow-up lane for the active campaign loop", async () => {
    let scopeTickCalled = false;
    const result = await runUnattendedCampaign({
        owner: "campaign-runner-test",
        promotedUrl: "https://promo.example/",
        lane: "follow_up",
        maxActiveTasks: 1,
    }, {
        runScopeTick: async () => {
            scopeTickCalled = true;
            throw new Error("scope tick should not be called for follow-up lane campaign");
        },
        runOperator: async () => makeEnvelope(makeTask()),
    });
    assert.equal(scopeTickCalled, false);
    assert.equal(result.stop_reason, "needs_manual_boundary");
    assert.equal(result.scope_ticks, 0);
});
test("runUnattendedCampaign stops before prepare when claimed task drifts from locked promoted scope", async () => {
    const mismatchedTask = makeTask({
        submission: {
            ...makeTask().submission,
            promoted_profile: {
                ...makePromotedProfile(),
                url: "https://other.example/",
                hostname: "other.example",
            },
        },
    });
    let prepareCalled = false;
    const result = await runUnattendedCampaign({
        owner: "campaign-runner-test",
        promotedUrl: "https://promo.example/",
        maxActiveTasks: 1,
    }, {
        runScopeTick: async () => ({
            action: "claimed",
            scope: { promotedHostname: "promo.example", promotedUrl: "https://promo.example/" },
            detail: "Claimed scoped task.",
            task: mismatchedTask,
            lease: makeLease(mismatchedTask.id),
        }),
        prepareTask: async () => {
            prepareCalled = true;
            throw new Error("prepare should not run for a scope-mismatched task");
        },
        runOperator: async () => makeEnvelope(mismatchedTask),
    });
    assert.equal(prepareCalled, false);
    assert.equal(result.stop_reason, "scope_mismatch");
    assert.equal(result.active_tasks_started, 0);
});
test("runUnattendedCampaign treats malformed claimed tasks as scope mismatch instead of throwing", async () => {
    const malformedTask = {
        ...makeTask(),
        submission: undefined,
    };
    let prepareCalled = false;
    const result = await runUnattendedCampaign({
        owner: "campaign-runner-test",
        promotedUrl: "https://promo.example/",
        maxActiveTasks: 1,
    }, {
        runScopeTick: async () => ({
            action: "claimed",
            scope: { promotedHostname: "promo.example", promotedUrl: "https://promo.example/" },
            detail: "Claimed malformed scoped task.",
            task: malformedTask,
            lease: makeLease(malformedTask.id),
        }),
        prepareTask: async () => {
            prepareCalled = true;
            throw new Error("prepare should not run for a malformed scoped task");
        },
        runOperator: async () => {
            throw new Error("operator should not run for a malformed scoped task");
        },
    });
    assert.equal(prepareCalled, false);
    assert.equal(result.stop_reason, "scope_mismatch");
    assert.equal(result.active_tasks_started, 0);
});
