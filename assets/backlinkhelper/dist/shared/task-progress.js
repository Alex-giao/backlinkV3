import { createHash } from "node:crypto";
import { getFamilyConfig } from "../families/index.js";
const MAX_BLOCKERS = 12;
const MAX_ACTIONS = 80;
const MAX_EVIDENCE = 120;
const MAX_FRAGMENTS = 40;
function stableId(prefix, ...parts) {
    const hash = createHash("sha1");
    hash.update(prefix);
    for (const part of parts) {
        hash.update("|");
        hash.update(String(part ?? ""));
    }
    return `${prefix}_${hash.digest("hex").slice(0, 12)}`;
}
function dedupeStrings(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        const normalized = value?.trim();
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}
function ensureExecutionState(task) {
    if (!task.execution_state) {
        task.execution_state = {
            version: 1,
            blockers: [],
            discovered_actions: [],
            evidence: [],
            reusable_fragments: [],
        };
    }
    return task.execution_state;
}
function upsertById(items, key, value, maxItems) {
    const existingIndex = items.findIndex((item) => item[key] === value[key]);
    if (existingIndex >= 0) {
        items[existingIndex] = value;
    }
    else {
        items.push(value);
    }
    while (items.length > maxItems) {
        items.shift();
    }
}
function inferConfidence(value, fallback = "medium") {
    if (typeof value !== "number") {
        return fallback;
    }
    if (value >= 0.85) {
        return "high";
    }
    if (value >= 0.55) {
        return "medium";
    }
    return "low";
}
function signalMatches(text, patterns) {
    return patterns.some((pattern) => pattern.test(text));
}
function toSignalPatterns(values) {
    return values.map((value) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
}
function normalizeSignalName(value) {
    return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
function inferContextType(args) {
    const corpus = [args.title, args.text, ...(args.submitCandidates ?? []), ...(args.fieldHints ?? []), ...(args.authHints ?? [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    const boundaryCorpus = [args.url, args.title].filter(Boolean).join(" ").toLowerCase();
    const familyConfig = getFamilyConfig(args.flowFamily);
    const taskProgress = familyConfig.taskProgress;
    const hasCorroboratedBoundarySignal = (signals) => boundaryCorpus.length > 0 && signalMatches(corpus, toSignalPatterns(signals)) && signalMatches(boundaryCorpus, toSignalPatterns(signals));
    if (args.visual?.classification === "success_or_confirmation") {
        return "confirmation_surface";
    }
    if (args.taskStatus === "WAITING_SITE_RESPONSE" ||
        args.taskStatus === "WAITING_EXTERNAL_EVENT" ||
        args.taskStatus === "DONE") {
        return "confirmation_surface";
    }
    if (args.taskStatus === "WAITING_MANUAL_AUTH" ||
        args.terminalClass === "login_required" ||
        args.visual?.classification === "login_gate") {
        return "auth_surface";
    }
    if (args.taskStatus === "WAITING_MISSING_INPUT") {
        return "form_surface";
    }
    if (args.taskStatus === "RETRYABLE") {
        return "retry_surface";
    }
    if (args.taskStatus === "SKIPPED") {
        return "terminal_surface";
    }
    if (args.terminalClass === "captcha_blocked" || args.visual?.classification === "captcha_or_human_verification") {
        return "captcha_surface";
    }
    if (args.status === 404 ||
        signalMatches(corpus, [/404/, /not found/, /page does not exist/, /stale submit path/])) {
        return "stale_submit_surface";
    }
    if (hasCorroboratedBoundarySignal(taskProgress.confirmationSignals)) {
        return "confirmation_surface";
    }
    if ((args.authHints?.length ?? 0) > 0 || hasCorroboratedBoundarySignal(taskProgress.authSignals)) {
        return "auth_surface";
    }
    if ((args.submitCandidates?.length ?? 0) > 0 || hasCorroboratedBoundarySignal(taskProgress.submitSignals)) {
        return "submit_surface";
    }
    if ((args.fieldHints?.length ?? 0) > 0 || hasCorroboratedBoundarySignal(taskProgress.formSignals)) {
        return "form_surface";
    }
    if (args.wait?.wait_reason_code === "CDP_RUNTIME_UNAVAILABLE" || args.wait?.wait_reason_code === "PLAYWRIGHT_CDP_UNAVAILABLE") {
        return "runtime_surface";
    }
    return "page_surface";
}
function inferNextBestActions(args) {
    const actions = [];
    if ((args.submitCandidates?.length ?? 0) > 0 || args.contextType === "submit_surface") {
        actions.push("advance_submit_flow");
    }
    if ((args.authHints?.length ?? 0) > 0 || args.contextType === "auth_surface") {
        actions.push("continue_auth_flow");
    }
    if ((args.fieldHints?.length ?? 0) > 0 || args.contextType === "form_surface") {
        actions.push("fill_visible_fields");
    }
    if (args.wait?.wait_reason_code === "VISUAL_VERIFICATION_REQUIRED") {
        actions.push("capture_terminal_evidence");
    }
    if (args.wait?.wait_reason_code === "REQUIRED_INPUT_MISSING") {
        actions.push("resume_after_missing_input");
    }
    if (args.taskStatus === "WAITING_SITE_RESPONSE") {
        actions.push("await_site_response");
    }
    return dedupeStrings(actions);
}
function inferSignals(args) {
    const corpus = [args.title, args.text, ...(args.submitCandidates ?? []), ...(args.fieldHints ?? []), ...(args.authHints ?? [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    const boundaryCorpus = [args.url, args.title].filter(Boolean).join(" ").toLowerCase();
    const taskProgress = getFamilyConfig(args.flowFamily).taskProgress;
    const confirmationSignals = taskProgress.confirmationSignals ?? [];
    const progressSignals = taskProgress.progressSignals ?? [];
    const matchedProgressSignals = progressSignals.filter((signal) => corpus.includes(signal.toLowerCase()));
    const hasCorroboratedBoundarySignal = (signals) => boundaryCorpus.length > 0 && signalMatches(corpus, toSignalPatterns(signals)) && signalMatches(boundaryCorpus, toSignalPatterns(signals));
    const signals = [];
    if ((args.submitCandidates?.length ?? 0) > 0 || hasCorroboratedBoundarySignal(taskProgress.submitSignals)) {
        signals.push("submit_candidates_visible");
    }
    if ((args.fieldHints?.length ?? 0) > 0 ||
        args.taskStatus === "WAITING_MISSING_INPUT" ||
        args.wait?.wait_reason_code === "REQUIRED_INPUT_MISSING" ||
        hasCorroboratedBoundarySignal(taskProgress.formSignals)) {
        signals.push("form_fields_visible");
    }
    if ((args.authHints?.length ?? 0) > 0 ||
        args.taskStatus === "WAITING_MANUAL_AUTH" ||
        args.terminalClass === "login_required" ||
        args.visual?.classification === "login_gate" ||
        hasCorroboratedBoundarySignal(taskProgress.authSignals)) {
        signals.push("auth_gate_visible");
    }
    if (args.visual?.classification === "success_or_confirmation" ||
        args.taskStatus === "WAITING_SITE_RESPONSE" ||
        (args.taskStatus === "WAITING_EXTERNAL_EVENT" && args.wait?.wait_reason_code === "EMAIL_VERIFICATION_PENDING") ||
        hasCorroboratedBoundarySignal(confirmationSignals)) {
        signals.push("site_response_pending");
    }
    for (const progressSignal of matchedProgressSignals) {
        signals.push(normalizeSignalName(progressSignal));
    }
    if (signalMatches(corpus, toSignalPatterns(taskProgress.captchaSignals))) {
        signals.push("captcha_gate_visible");
    }
    if (args.wait?.wait_reason_code) {
        signals.push(args.wait.wait_reason_code.toLowerCase());
    }
    if (args.taskStatus === "WAITING_MANUAL_AUTH") {
        signals.push("manual_auth_required");
    }
    if (args.taskStatus === "WAITING_MISSING_INPUT") {
        signals.push("required_input_missing");
    }
    if (args.taskStatus === "DONE") {
        signals.push("live_submission_complete");
    }
    if (args.terminalClass === "captcha_blocked") {
        signals.push("captcha_gate_visible");
    }
    if (args.visual?.classification) {
        signals.push(args.visual.classification);
    }
    return dedupeStrings(signals);
}
function maybeUpsertEvidence(state, evidence) {
    upsertById(state.evidence, "evidence_id", evidence, MAX_EVIDENCE);
}
function maybeUpsertAction(state, action) {
    upsertById(state.discovered_actions, "action_id", action, MAX_ACTIONS);
}
function maybeUpsertFragment(state, fragment) {
    upsertById(state.reusable_fragments, "fragment_id", fragment, MAX_FRAGMENTS);
}
function replaceActiveBlockers(state, blockers) {
    const resolvedAt = new Date().toISOString();
    state.blockers = state.blockers.map((blocker) => blocker.status === "active"
        ? {
            ...blocker,
            status: "resolved",
            updated_at: resolvedAt,
        }
        : blocker);
    for (const blocker of blockers) {
        upsertById(state.blockers, "blocker_id", blocker, MAX_BLOCKERS);
    }
}
function buildFrontier(args) {
    return {
        node_id: args.nodeId,
        context_type: args.contextType,
        url: args.url,
        title: args.title,
        depth: args.depth ?? 1,
        confidence: args.confidence,
        reached_via_action_id: args.reachedViaActionId,
        next_best_actions: dedupeStrings(args.nextBestActions ?? []),
        updated_at: new Date().toISOString(),
    };
}
function inferBlockersFromOutcome(args) {
    const reason = args.wait?.wait_reason_code;
    const detail = dedupeStrings([args.detail, ...(args.wait?.missing_fields?.map((field) => `${field.key}:${field.label}`) ?? [])]);
    const blockerSource = args.source;
    const buildBlocker = (blockerType, options) => ({
        blocker_id: stableId("blocker", args.nodeId, blockerType, detail.join("|")),
        node_id: args.nodeId,
        context_type: args.contextType,
        url: args.url,
        title: args.title,
        blocker_type: blockerType,
        detail,
        severity: options.severity,
        unblock_requirement: options.unblockRequirement,
        can_auto_resume: options.canAutoResume,
        consumes_retry_budget: options.consumesRetryBudget,
        evidence_refs: args.artifactRefs,
        source: blockerSource,
        updated_at: new Date().toISOString(),
        status: "active",
    });
    if (args.nextStatus === "WAITING_MANUAL_AUTH") {
        return [
            buildBlocker("manual_auth_required", {
                severity: "hard",
                unblockRequirement: "manual_auth",
                canAutoResume: false,
                consumesRetryBudget: false,
            }),
        ];
    }
    if (args.nextStatus === "WAITING_MISSING_INPUT" || reason === "REQUIRED_INPUT_MISSING") {
        return [
            buildBlocker("required_input_missing", {
                severity: "hard",
                unblockRequirement: "provide_missing_inputs",
                canAutoResume: true,
                consumesRetryBudget: false,
            }),
        ];
    }
    if (args.nextStatus === "WAITING_SITE_RESPONSE") {
        return [
            buildBlocker("site_response_pending", {
                severity: "soft",
                unblockRequirement: "wait_for_directory_response",
                canAutoResume: false,
                consumesRetryBudget: false,
            }),
        ];
    }
    if (reason === "VISUAL_VERIFICATION_REQUIRED") {
        return [
            buildBlocker("visual_verification_required", {
                severity: "soft",
                unblockRequirement: "capture_terminal_evidence",
                canAutoResume: true,
                consumesRetryBudget: false,
            }),
        ];
    }
    if (reason === "CDP_RUNTIME_UNAVAILABLE" || reason === "PLAYWRIGHT_CDP_UNAVAILABLE" || reason === "RUNTIME_PREFLIGHT_FAILED") {
        return [
            buildBlocker(reason.toLowerCase(), {
                severity: "soft",
                unblockRequirement: "restore_runtime",
                canAutoResume: true,
                consumesRetryBudget: false,
            }),
        ];
    }
    if (args.nextStatus === "RETRYABLE" && reason) {
        return [
            buildBlocker(reason.toLowerCase(), {
                severity: "soft",
                unblockRequirement: "retry_when_new_evidence_exists",
                canAutoResume: true,
                consumesRetryBudget: !["VISUAL_VERIFICATION_REQUIRED"].includes(reason),
            }),
        ];
    }
    return [];
}
function inferFragments(args) {
    const corpus = [args.title, args.text, ...(args.fieldHints ?? []), ...(args.authHints ?? []), ...(args.submitCandidates ?? [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    const fragments = [];
    const now = new Date().toISOString();
    const taskProgress = getFamilyConfig(args.flowFamily).taskProgress;
    if (signalMatches(corpus, [/continue with google/, /google oauth/, /sign in with google/])) {
        fragments.push({
            fragment_id: "frag_google_oauth_gate_v1",
            matched_at_node_id: args.nodeId,
            confidence: "medium",
            preconditions: ["button:Continue with Google"],
            recommended_next_actions: ["continue_auth_flow", "check_existing_google_session"],
            local_proof: args.proofRefs,
            source: args.source,
            updated_at: now,
        });
    }
    if ((args.submitCandidates?.length ?? 0) > 0) {
        fragments.push({
            fragment_id: "frag_submit_surface_v1",
            matched_at_node_id: args.nodeId,
            confidence: "high",
            preconditions: dedupeStrings(args.submitCandidates ?? []),
            recommended_next_actions: ["advance_submit_flow"],
            local_proof: args.proofRefs,
            source: args.source,
            updated_at: now,
        });
    }
    if (signalMatches(corpus, toSignalPatterns(taskProgress.formSignals)) ||
        (args.fieldHints?.length ?? 0) >= 2) {
        fragments.push({
            fragment_id: "frag_form_surface_v1",
            matched_at_node_id: args.nodeId,
            confidence: "medium",
            preconditions: dedupeStrings(args.fieldHints ?? []),
            recommended_next_actions: ["fill_visible_fields", "submit_form_when_ready"],
            local_proof: args.proofRefs,
            source: args.source,
            updated_at: now,
        });
    }
    if (args.visual?.classification === "success_or_confirmation" || signalMatches(corpus, toSignalPatterns(taskProgress.confirmationSignals))) {
        fragments.push({
            fragment_id: "frag_confirmation_surface_v1",
            matched_at_node_id: args.nodeId,
            confidence: inferConfidence(args.visual?.confidence, "high"),
            preconditions: ["confirmation_copy_visible"],
            recommended_next_actions: ["mark_waiting_site_response"],
            local_proof: args.proofRefs,
            source: args.source,
            updated_at: now,
        });
    }
    return fragments;
}
export function updateTaskExecutionStateFromScout(args) {
    const state = ensureExecutionState(args.task);
    const contextType = inferContextType({
        url: args.scout.page_snapshot.url,
        title: args.scout.page_snapshot.title,
        text: args.scout.page_snapshot.body_text_excerpt,
        submitCandidates: args.scout.submit_candidates,
        fieldHints: args.scout.field_hints,
        authHints: args.scout.auth_hints,
        status: args.scout.page_snapshot.response_status,
        flowFamily: args.task.flow_family,
    });
    const nodeId = stableId("node", args.scout.page_snapshot.url, args.scout.page_snapshot.title, contextType);
    state.frontier = buildFrontier({
        nodeId,
        contextType,
        url: args.scout.page_snapshot.url,
        title: args.scout.page_snapshot.title,
        confidence: args.scout.page_assessment?.classification_confidence ?? "medium",
        nextBestActions: inferNextBestActions({
            contextType,
            submitCandidates: args.scout.submit_candidates,
            fieldHints: args.scout.field_hints,
            authHints: args.scout.auth_hints,
        }),
    });
    const signals = inferSignals({
        title: args.scout.page_snapshot.title,
        url: args.scout.page_snapshot.url,
        text: `${args.scout.surface_summary} ${args.scout.page_snapshot.body_text_excerpt}`,
        submitCandidates: args.scout.submit_candidates,
        fieldHints: args.scout.field_hints,
        authHints: args.scout.auth_hints,
        flowFamily: args.task.flow_family,
    });
    for (const signal of signals) {
        maybeUpsertEvidence(state, {
            evidence_id: stableId("evidence", args.artifactRef, signal, nodeId),
            node_id: nodeId,
            context_type: contextType,
            url: args.scout.page_snapshot.url,
            title: args.scout.page_snapshot.title,
            type: signal === "submit_candidates_visible" ? "scout_submit_surface" : "scout_snapshot",
            signal,
            confidence: args.scout.page_assessment?.classification_confidence ?? "medium",
            path: args.artifactRef,
            content: args.scout.surface_summary,
            source: "scout",
            created_at: new Date().toISOString(),
        });
    }
    const fragments = inferFragments({
        nodeId,
        title: args.scout.page_snapshot.title,
        text: `${args.scout.surface_summary} ${args.scout.page_snapshot.body_text_excerpt}`,
        fieldHints: args.scout.field_hints,
        authHints: args.scout.auth_hints,
        submitCandidates: args.scout.submit_candidates,
        source: "scout",
        proofRefs: [args.artifactRef],
        flowFamily: args.task.flow_family,
    });
    for (const fragment of fragments) {
        maybeUpsertFragment(state, fragment);
    }
    return state;
}
function actionLabelFromObservation(args) {
    if (typeof args.index === "number") {
        const element = args.observation.elements.find((item) => item.index === args.index);
        if (element?.text) {
            return element.text;
        }
    }
    return (args.text ??
        args.value ??
        args.keys ??
        args.waitTarget ??
        args.url ??
        args.action.replace(/_/g, " "));
}
export function updateTaskExecutionStateFromTrace(args) {
    const state = ensureExecutionState(args.task);
    args.trace.steps.forEach((step, index) => {
        const fromContextType = inferContextType({
            url: step.observation.url,
            title: step.observation.title,
            text: step.observation.raw_text_excerpt,
            flowFamily: args.task.flow_family,
        });
        const fromNodeId = stableId("node", step.observation.url, step.observation.title, fromContextType);
        const nextObservation = args.trace.steps[index + 1]?.observation;
        const toContextType = nextObservation
            ? inferContextType({
                url: nextObservation.url,
                title: nextObservation.title,
                text: nextObservation.raw_text_excerpt,
                flowFamily: args.task.flow_family,
            })
            : inferContextType({
                url: args.handoff.current_url || args.trace.final_url,
                title: args.trace.final_title,
                text: args.trace.final_excerpt,
                flowFamily: args.task.flow_family,
            });
        const toNodeId = stableId("node", nextObservation?.url ?? args.handoff.current_url ?? args.trace.final_url, nextObservation?.title ?? args.trace.final_title, toContextType);
        const label = actionLabelFromObservation({
            observation: step.observation,
            action: step.decision.action,
            index: step.decision.index,
            text: step.decision.text,
            value: step.decision.value,
            keys: step.decision.keys,
            waitTarget: step.decision.wait_target,
            url: step.decision.url,
        });
        const actionId = stableId("action", fromNodeId, step.decision.action, label, toNodeId);
        maybeUpsertAction(state, {
            action_id: actionId,
            from_node_id: fromNodeId,
            from_context_type: fromContextType,
            from_url: step.observation.url,
            action_type: step.decision.action,
            label,
            selector_hint: typeof step.decision.index === "number"
                ? `index:${step.decision.index}`
                : step.decision.wait_target,
            outcome: step.execution.ok
                ? step.decision.action === "finish_submission_attempt"
                    ? "submission_attempted"
                    : step.execution.after_url !== step.execution.before_url
                        ? "new_node_discovered"
                        : "executed"
                : "failed",
            to_node_id: toNodeId,
            to_context_type: toContextType,
            to_url: nextObservation?.url ?? args.handoff.current_url ?? args.trace.final_url,
            evidence_refs: [args.handoff.agent_trace_ref],
            repeatable: step.decision.action !== "finish_submission_attempt",
            updated_at: new Date().toISOString(),
        });
        const signals = inferSignals({
            title: step.observation.title,
            url: step.observation.url,
            text: `${step.observation.title} ${step.observation.raw_text_excerpt}`,
            flowFamily: args.task.flow_family,
        });
        if (step.execution.ok && step.decision.action === "finish_submission_attempt") {
            signals.push("submission_attempted");
        }
        if (!step.execution.ok) {
            signals.push("action_failed");
        }
        for (const signal of dedupeStrings(signals)) {
            maybeUpsertEvidence(state, {
                evidence_id: stableId("evidence", args.handoff.agent_trace_ref, step.step_number, signal),
                node_id: fromNodeId,
                context_type: fromContextType,
                url: step.observation.url,
                title: step.observation.title,
                type: "agent_trace",
                signal,
                confidence: step.execution.ok ? "medium" : "low",
                path: args.handoff.agent_trace_ref,
                content: step.execution.detail,
                source: "agent_trace",
                created_at: new Date().toISOString(),
            });
        }
        const fragments = inferFragments({
            nodeId: fromNodeId,
            title: step.observation.title,
            text: step.observation.raw_text_excerpt,
            source: "agent_trace",
            proofRefs: [args.handoff.agent_trace_ref],
            flowFamily: args.task.flow_family,
        });
        for (const fragment of fragments) {
            maybeUpsertFragment(state, fragment);
        }
    });
    const finalContextType = inferContextType({
        url: args.handoff.current_url || args.trace.final_url,
        title: args.trace.final_title,
        text: args.trace.final_excerpt,
        flowFamily: args.task.flow_family,
    });
    const finalNodeId = stableId("node", args.handoff.current_url || args.trace.final_url, args.trace.final_title, finalContextType);
    const lastActionId = state.discovered_actions[state.discovered_actions.length - 1]?.action_id;
    state.frontier = buildFrontier({
        nodeId: finalNodeId,
        contextType: finalContextType,
        url: args.handoff.current_url || args.trace.final_url,
        title: args.trace.final_title,
        confidence: "medium",
        reachedViaActionId: lastActionId,
        nextBestActions: inferNextBestActions({
            contextType: finalContextType,
            fieldHints: signalMatches(args.trace.final_excerpt.toLowerCase(), [/required/, /founded date/])
                ? ["required-field"]
                : [],
            authHints: signalMatches(args.trace.final_excerpt.toLowerCase(), [/sign in/, /continue with google/])
                ? ["auth"]
                : [],
        }),
        depth: Math.max(args.trace.steps.length + 1, 1),
    });
    const finalSignals = inferSignals({
        title: args.trace.final_title,
        url: args.handoff.current_url || args.trace.final_url,
        text: `${args.trace.final_title} ${args.trace.final_excerpt}`,
        flowFamily: args.task.flow_family,
    });
    for (const signal of finalSignals) {
        maybeUpsertEvidence(state, {
            evidence_id: stableId("evidence", args.handoff.agent_trace_ref, "final", signal),
            node_id: finalNodeId,
            context_type: finalContextType,
            url: args.handoff.current_url || args.trace.final_url,
            title: args.trace.final_title,
            type: "agent_trace_final",
            signal,
            confidence: "medium",
            path: args.handoff.agent_trace_ref,
            content: args.trace.final_excerpt,
            source: "agent_trace",
            created_at: new Date().toISOString(),
        });
    }
    const finalFragments = inferFragments({
        nodeId: finalNodeId,
        title: args.trace.final_title,
        text: args.trace.final_excerpt,
        source: "agent_trace",
        proofRefs: [args.handoff.agent_trace_ref],
        flowFamily: args.task.flow_family,
    });
    for (const fragment of finalFragments) {
        maybeUpsertFragment(state, fragment);
    }
    return state;
}
export function updateTaskExecutionStateFromOutcome(args) {
    const state = ensureExecutionState(args.task);
    const contextType = inferContextType({
        url: args.currentUrl,
        title: args.currentTitle,
        text: args.detail,
        taskStatus: args.nextStatus,
        terminalClass: args.terminalClass,
        wait: args.wait,
        visual: args.visualVerification,
        flowFamily: args.task.flow_family,
    });
    const nodeId = stableId("node", args.currentUrl ?? args.task.target_url, args.currentTitle ?? args.task.hostname, contextType);
    const artifactRefs = dedupeStrings(args.artifactRefs ?? [args.wait?.evidence_ref]);
    state.frontier = buildFrontier({
        nodeId,
        contextType,
        url: args.currentUrl ?? args.task.target_url,
        title: args.currentTitle,
        confidence: inferConfidence(args.visualVerification?.confidence, args.wait ? "medium" : "high"),
        nextBestActions: inferNextBestActions({
            contextType,
            taskStatus: args.nextStatus,
            wait: args.wait,
        }),
    });
    replaceActiveBlockers(state, inferBlockersFromOutcome({
        nodeId,
        contextType,
        url: args.currentUrl ?? args.task.target_url,
        title: args.currentTitle,
        nextStatus: args.nextStatus,
        detail: args.detail,
        wait: args.wait,
        artifactRefs,
        source: args.source,
    }));
    const signals = inferSignals({
        title: args.currentTitle,
        url: args.currentUrl,
        text: args.detail,
        wait: args.wait,
        taskStatus: args.nextStatus,
        terminalClass: args.terminalClass,
        visual: args.visualVerification,
        flowFamily: args.task.flow_family,
    });
    for (const signal of signals) {
        maybeUpsertEvidence(state, {
            evidence_id: stableId("evidence", artifactRefs[0], signal, nodeId),
            node_id: nodeId,
            context_type: contextType,
            url: args.currentUrl ?? args.task.target_url,
            title: args.currentTitle,
            type: "outcome",
            signal,
            confidence: inferConfidence(args.visualVerification?.confidence, args.wait ? "medium" : "high"),
            path: artifactRefs[0],
            content: args.detail,
            source: args.source === "prepare" ? "system" : "finalize",
            created_at: new Date().toISOString(),
        });
    }
    if (args.visualVerification) {
        maybeUpsertEvidence(state, {
            evidence_id: stableId("evidence", artifactRefs[0], "visual", args.visualVerification.classification),
            node_id: nodeId,
            context_type: contextType,
            url: args.currentUrl ?? args.task.target_url,
            title: args.currentTitle,
            type: "visual_verification",
            signal: args.visualVerification.classification,
            confidence: inferConfidence(args.visualVerification.confidence),
            path: artifactRefs[0],
            content: args.visualVerification.summary,
            source: "finalize",
            created_at: new Date().toISOString(),
        });
    }
    if (args.linkVerification) {
        maybeUpsertEvidence(state, {
            evidence_id: stableId("evidence", artifactRefs[0], "link_verification", args.linkVerification.verification_status),
            node_id: nodeId,
            context_type: contextType,
            url: args.linkVerification.live_page_url ?? args.currentUrl ?? args.task.target_url,
            title: args.currentTitle,
            type: "link_verification",
            signal: args.linkVerification.verification_status,
            confidence: args.linkVerification.verification_status === "verified_link_present" ? "high" : "medium",
            path: artifactRefs[0],
            content: args.linkVerification.detail,
            source: "finalize",
            created_at: args.linkVerification.verified_at,
        });
    }
    const fragments = inferFragments({
        nodeId,
        title: args.currentTitle,
        text: args.detail,
        visual: args.visualVerification,
        source: "finalize",
        proofRefs: artifactRefs,
        flowFamily: args.task.flow_family,
    });
    for (const fragment of fragments) {
        maybeUpsertFragment(state, fragment);
    }
    return state;
}
export function updateTaskExecutionStateFromFinalize(args) {
    return updateTaskExecutionStateFromOutcome({
        task: args.task,
        nextStatus: args.result.next_status,
        detail: args.result.detail,
        wait: args.result.wait,
        terminalClass: args.result.terminal_class,
        currentUrl: args.handoff.current_url,
        currentTitle: undefined,
        artifactRefs: [...args.handoff.artifact_refs, ...args.result.artifact_refs],
        visualVerification: args.handoff.visual_verification,
        linkVerification: args.result.link_verification,
        source: "finalize",
    });
}
