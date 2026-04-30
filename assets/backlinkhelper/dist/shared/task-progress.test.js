import test from "node:test";
import assert from "node:assert/strict";
import { updateTaskExecutionStateFromOutcome, updateTaskExecutionStateFromScout, updateTaskExecutionStateFromTrace, } from "./task-progress.js";
function makeTask(overrides = {}) {
    return {
        id: "task-progress-test",
        target_url: "https://directory.example.com/submit",
        hostname: "directory.example.com",
        submission: {
            promoted_profile: {
                url: "https://exactstatement.com/",
                hostname: "exactstatement.com",
                name: "Exact Statement",
                description: "Bank statement PDF to CSV converter",
                category_hints: ["finance"],
                source: "fallback",
            },
            confirm_submit: true,
        },
        status: "READY",
        created_at: "2026-04-12T00:00:00.000Z",
        updated_at: "2026-04-12T00:00:00.000Z",
        run_count: 0,
        escalation_level: "none",
        takeover_attempts: 0,
        phase_history: [],
        latest_artifacts: [],
        notes: [],
        ...overrides,
    };
}
function makeScout(overrides = {}) {
    return {
        ok: true,
        surface_summary: "Live submit form detected.",
        field_hints: ["Name", "Email", "Description"],
        auth_hints: [],
        anti_bot_hints: [],
        submit_candidates: ["Submit Startup"],
        evidence_sufficiency: true,
        embed_hints: [],
        link_candidates: [],
        page_snapshot: {
            url: "https://directory.example.com/submit",
            title: "Submit Startup",
            response_status: 200,
            body_text_excerpt: "Submit Startup Name Email Description",
        },
        page_assessment: {
            page_reachable: true,
            classification_confidence: "high",
            ambiguity_flags: [],
            visual_verification_required: false,
        },
        ...overrides,
    };
}
function makeTrace() {
    return {
        task_id: "task-progress-test",
        agent_backend: "codex",
        started_at: "2026-04-12T00:00:00.000Z",
        finished_at: "2026-04-12T00:03:00.000Z",
        stop_reason: "missing input blocked continuation",
        final_url: "https://directory.example.com/create",
        final_title: "Create Startup",
        final_excerpt: "Founded Date is required",
        steps: [
            {
                step_number: 1,
                observation: {
                    url: "https://directory.example.com/",
                    title: "Directory Home",
                    raw_text_excerpt: "Submit your startup to get listed",
                    elements: [
                        {
                            index: 1,
                            descriptor: "button",
                            text: "Submit",
                            allowed_actions: ["click_index"],
                        },
                    ],
                },
                decision: {
                    action: "click_index",
                    index: 1,
                    reason: "Open the real submit flow",
                    confidence: 0.91,
                    expected_signal: "Create page or login gate",
                    stop_if_observed: [],
                },
                execution: {
                    ok: true,
                    detail: "Clicked submit CTA",
                    before_url: "https://directory.example.com/",
                    after_url: "https://directory.example.com/auth",
                    duration_ms: 900,
                },
            },
            {
                step_number: 2,
                observation: {
                    url: "https://directory.example.com/auth",
                    title: "Sign in",
                    raw_text_excerpt: "Continue with Google to create your startup listing",
                    elements: [
                        {
                            index: 2,
                            descriptor: "button",
                            text: "Continue with Google",
                            allowed_actions: ["click_index"],
                        },
                    ],
                },
                decision: {
                    action: "click_index",
                    index: 2,
                    reason: "Continue through OAuth gate",
                    confidence: 0.88,
                    expected_signal: "Startup form",
                    stop_if_observed: [],
                },
                execution: {
                    ok: true,
                    detail: "Entered startup form",
                    before_url: "https://directory.example.com/auth",
                    after_url: "https://directory.example.com/create",
                    duration_ms: 1300,
                },
            },
        ],
    };
}
test("scout update seeds frontier and reusable submit-surface fragment", () => {
    const task = makeTask();
    updateTaskExecutionStateFromScout({
        task,
        scout: makeScout(),
        artifactRef: "/tmp/scout.json",
    });
    assert.equal(task.execution_state?.frontier?.context_type, "submit_surface");
    assert.ok(task.execution_state?.frontier?.next_best_actions.includes("advance_submit_flow"));
    assert.ok(task.execution_state?.evidence.some((item) => item.signal === "submit_candidates_visible"));
    assert.ok(task.execution_state?.reusable_fragments.some((item) => item.fragment_id === "frag_submit_surface_v1"));
});
test("task progress uses family-aware context cues instead of directory defaults", () => {
    const task = makeTask({
        flow_family: "forum_profile",
        target_url: "https://community.example.com/landing",
        hostname: "community.example.com",
    });
    updateTaskExecutionStateFromScout({
        task,
        scout: makeScout({
            surface_summary: "Landing page detected.",
            field_hints: [],
            auth_hints: [],
            submit_candidates: [],
            page_snapshot: {
                url: "https://community.example.com/landing",
                title: "Community Landing",
                response_status: 200,
                body_text_excerpt: "Create Startup landing page",
            },
        }),
        artifactRef: "/tmp/scout-profile.json",
    });
    assert.equal(task.execution_state?.frontier?.context_type, "page_surface");
    assert.equal(task.execution_state?.evidence.some((item) => item.signal === "submit_candidates_visible"), false);
});
test("task progress emits neutral form fragment ids for non-directory flows", () => {
    const task = makeTask({
        flow_family: "forum_profile",
        target_url: "https://community.example.com/settings/profile",
        hostname: "community.example.com",
    });
    updateTaskExecutionStateFromScout({
        task,
        scout: makeScout({
            surface_summary: "Profile form detected.",
            field_hints: ["Website", "Bio", "Signature"],
            auth_hints: [],
            submit_candidates: [],
            page_snapshot: {
                url: "https://community.example.com/settings/profile",
                title: "Edit Profile",
                response_status: 200,
                body_text_excerpt: "Edit Profile Website Bio Signature Social Links",
            },
        }),
        artifactRef: "/tmp/scout-profile-form.json",
    });
    assert.ok(task.execution_state?.reusable_fragments.some((item) => item.fragment_id === "frag_form_surface_v1"));
    assert.equal(task.execution_state?.reusable_fragments.some((item) => item.fragment_id === "frag_listing_form_v1"), false);
});
test("trace update records discovered actions, oauth fragment, and form frontier", () => {
    const task = makeTask();
    updateTaskExecutionStateFromTrace({
        task,
        trace: makeTrace(),
        handoff: {
            detail: "Reached startup form but Founded Date is required.",
            artifact_refs: ["/tmp/agent-loop.json"],
            current_url: "https://directory.example.com/create",
            recorded_steps: [],
            agent_trace_ref: "/tmp/agent-loop.json",
            agent_backend: "codex",
            agent_steps_count: 2,
        },
    });
    assert.equal(task.execution_state?.frontier?.context_type, "form_surface");
    assert.equal(task.execution_state?.discovered_actions.length, 2);
    assert.ok(task.execution_state?.discovered_actions.some((item) => item.label.includes("Continue with Google")));
    assert.ok(task.execution_state?.reusable_fragments.some((item) => item.fragment_id === "frag_google_oauth_gate_v1"));
});
test("trace update accepts legacy lightweight operator steps", () => {
    const task = makeTask({ flow_family: "wp_comment" });
    const trace = {
        ...makeTrace(),
        final_url: "https://blog.example.com/post/1",
        final_title: "Blog post",
        final_excerpt: "No Blogger comment frame found",
        steps: [
            { action: "open_target", url: "https://blog.example.com/post/1", title: "Blog post" },
            { action: "inspect_comment_frame", frame_url: "https://www.blogger.com/comment/frame", excerpt: "sign in required" },
        ],
    };
    assert.doesNotThrow(() => updateTaskExecutionStateFromTrace({
        task,
        trace,
        handoff: {
            detail: "No Blogger comment frame found on target page.",
            artifact_refs: ["/tmp/agent-loop.json"],
            current_url: "https://blog.example.com/post/1",
            recorded_steps: [],
            agent_trace_ref: "/tmp/agent-loop.json",
            agent_backend: "hermes-operator/suika-blogger-playwright",
            agent_steps_count: 2,
        },
    }));
    assert.equal(task.execution_state?.discovered_actions.length, 2);
    assert.equal(task.execution_state?.frontier?.url, "https://blog.example.com/post/1");
});
test("outcome update stores blocker metadata and preserves retry budget for visual verification", () => {
    const task = makeTask();
    const wait = {
        wait_reason_code: "VISUAL_VERIFICATION_REQUIRED",
        resume_trigger: "Capture screenshot evidence before closure.",
        resolution_owner: "system",
        resolution_mode: "auto_resume",
        evidence_ref: "/tmp/finalization.json",
    };
    updateTaskExecutionStateFromOutcome({
        task,
        nextStatus: "RETRYABLE",
        detail: "Need visual verification before closing the task.",
        wait,
        terminalClass: "outcome_not_confirmed",
        currentUrl: "https://directory.example.com/submit",
        currentTitle: "Submit Startup",
        artifactRefs: ["/tmp/finalization.json"],
        source: "finalize",
    });
    assert.equal(task.execution_state?.blockers[0]?.blocker_type, "visual_verification_required");
    assert.equal(task.execution_state?.blockers[0]?.consumes_retry_budget, false);
    assert.equal(task.execution_state?.frontier?.context_type, "retry_surface");
    assert.ok(task.execution_state?.evidence.some((item) => item.signal === "visual_verification_required"));
});
test("outcome update stores CAPTCHA solver waits as non-budget external blockers", () => {
    const task = makeTask();
    const wait = {
        wait_reason_code: "CAPTCHA_SOLVER_CONTINUATION",
        resume_trigger: "CAPTCHA solver should continue from the current challenge state.",
        resolution_owner: "system",
        resolution_mode: "auto_resume",
        evidence_ref: "/tmp/finalization.json",
    };
    updateTaskExecutionStateFromOutcome({
        task,
        nextStatus: "WAITING_EXTERNAL_EVENT",
        detail: "CAPTCHA solver should continue from the current challenge state.",
        wait,
        terminalClass: "captcha_blocked",
        currentUrl: "https://directory.example.com/submit",
        currentTitle: "Human verification",
        artifactRefs: ["/tmp/finalization.json"],
        source: "finalize",
    });
    assert.equal(task.execution_state?.blockers[0]?.blocker_type, "captcha_solver_continuation");
    assert.equal(task.execution_state?.blockers[0]?.can_auto_resume, true);
    assert.equal(task.execution_state?.blockers[0]?.consumes_retry_budget, false);
    assert.equal(task.execution_state?.frontier?.context_type, "captcha_surface");
    assert.ok(task.execution_state?.evidence.some((item) => item.signal === "captcha_solver_continuation"));
});
test("outcome update stores link verification evidence for multi-family tasks", () => {
    const task = makeTask({
        flow_family: "forum_profile",
        target_url: "https://community.example.com/member/exactstatement",
        hostname: "community.example.com",
    });
    updateTaskExecutionStateFromOutcome({
        task,
        nextStatus: "WAITING_SITE_RESPONSE",
        detail: "Profile appears live and needs backlink verification evidence.",
        currentUrl: "https://community.example.com/member/exactstatement",
        currentTitle: "Exact Statement Profile",
        artifactRefs: ["/tmp/finalization.json"],
        source: "finalize",
        linkVerification: {
            verification_status: "verified_link_present",
            live_page_url: "https://community.example.com/member/exactstatement",
            expected_target_url: "https://exactstatement.com/",
            target_link_url: "https://exactstatement.com/",
            anchor_text: "Exact Statement",
            rel: "ugc nofollow",
            rel_flags: ["ugc", "nofollow"],
            visible_state: "visible",
            detail: "Verified public profile backlink.",
            verified_at: "2026-04-16T00:00:00.000Z",
        },
    });
    assert.ok(task.execution_state?.evidence.some((item) => item.type === "link_verification"));
    assert.ok(task.execution_state?.evidence.some((item) => item.signal === "verified_link_present"));
});
test("dev_blog draft progress does not get collapsed into site-response evidence", () => {
    const task = makeTask({
        flow_family: "dev_blog",
        target_url: "https://dev.to/new",
        hostname: "dev.to",
    });
    updateTaskExecutionStateFromOutcome({
        task,
        nextStatus: "RETRYABLE",
        detail: "Draft saved in the editor. Continue editing before publishing or submitting for review.",
        wait: {
            wait_reason_code: "ARTICLE_DRAFT_SAVED",
            resume_trigger: "Continue from the saved draft in a later automation pass.",
            resolution_owner: "system",
            resolution_mode: "auto_resume",
            evidence_ref: "/tmp/finalization.json",
        },
        currentUrl: "https://dev.to/new",
        currentTitle: "Write Post",
        artifactRefs: ["/tmp/finalization.json"],
        source: "finalize",
    });
    assert.equal(task.execution_state?.frontier?.context_type, "retry_surface");
    assert.equal(task.execution_state?.evidence.some((item) => item.signal === "site_response_pending"), false);
    assert.ok(task.execution_state?.evidence.some((item) => item.signal === "article_draft_saved"));
});
test("outcome update ignores stale confirmation title on retryable states", () => {
    const task = makeTask();
    updateTaskExecutionStateFromOutcome({
        task,
        nextStatus: "RETRYABLE",
        detail: "Legacy retry state before verification.",
        currentUrl: "https://directory.example.com/submit",
        currentTitle: "Thanks for submitting",
        artifactRefs: ["/tmp/retry.json"],
        source: "finalize",
    });
    assert.equal(task.execution_state?.frontier?.context_type, "retry_surface");
    assert.equal(task.execution_state?.evidence.some((item) => item.signal === "site_response_pending"), false);
});
test("scout update ignores raw marketing copy that only mentions submit/auth/confirmation phrases", () => {
    const task = makeTask({
        target_url: "https://directory.example.com/landing",
        hostname: "directory.example.com",
    });
    updateTaskExecutionStateFromScout({
        task,
        scout: makeScout({
            surface_summary: "Marketing landing page detected.",
            field_hints: [],
            auth_hints: [],
            submit_candidates: [],
            page_snapshot: {
                url: "https://directory.example.com/landing",
                title: "Launch your startup",
                response_status: 200,
                body_text_excerpt: "Submit your tool today. Continue with Google when you are ready. Thank you for exploring our directory.",
            },
        }),
        artifactRef: "/tmp/scout-marketing-copy.json",
    });
    assert.equal(task.execution_state?.frontier?.context_type, "page_surface");
    assert.equal(task.execution_state?.evidence.some((item) => item.signal === "submit_candidates_visible"), false);
    assert.equal(task.execution_state?.evidence.some((item) => item.signal === "auth_gate_visible"), false);
    assert.equal(task.execution_state?.evidence.some((item) => item.signal === "site_response_pending"), false);
});
