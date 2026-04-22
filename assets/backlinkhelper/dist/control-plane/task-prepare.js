import { acquireBrowserOwnership, releaseBrowserOwnership } from "../execution/ownership-lock.js";
import { runTrajectoryReplay } from "../execution/replay.js";
import { runLightweightScout } from "../execution/scout.js";
import { classifyEarlyTerminalOutcome } from "../execution/takeover.js";
import { getAccountForHostname } from "../memory/account-registry.js";
import { getCredential } from "../memory/credential-vault.js";
import { clearWorkerLeaseForTask, ensureDataDirectories, getArtifactFilePath, getLatestPreflightPath, loadTask, saveTask, writeJsonFile, } from "../memory/data-store.js";
import { loadTrajectoryPlaybook } from "../memory/trajectory-playbook.js";
import { resolveBrowserRuntime } from "../shared/browser-runtime.js";
import { buildMailboxQuery, buildPlusAlias, generateSignupUsername, generateSitePassword } from "../shared/email.js";
import { runPreflight } from "../shared/preflight.js";
import { updateTaskExecutionStateFromOutcome, updateTaskExecutionStateFromScout } from "../shared/task-progress.js";
import { markTaskStageTimestamp } from "../shared/task-timing.js";
function updateTaskStatus(task, status) {
    task.status = status;
    task.updated_at = new Date().toISOString();
}
function inferRegistrationRequired(task, scoutTextHints) {
    if (!task.submission.submitter_email) {
        return false;
    }
    const normalizedHints = new Set(scoutTextHints.map((hint) => hint.toLowerCase()));
    const visibleOauthOnly = (normalizedHints.has("with google") ||
        normalizedHints.has("sign in with google") ||
        normalizedHints.has("login with google") ||
        normalizedHints.has("continue with google")) &&
        !normalizedHints.has("password") &&
        !normalizedHints.has("create account") &&
        !normalizedHints.has("register");
    if (visibleOauthOnly) {
        return false;
    }
    return ["create account", "register", "password"].some((hint) => normalizedHints.has(hint));
}
function buildRegistrationDraft(task) {
    if (!task.submission.submitter_email) {
        return undefined;
    }
    const alias = buildPlusAlias(task.submission.submitter_email, task.hostname);
    if (!alias) {
        return undefined;
    }
    const credentials = {
        email: alias,
        username: generateSignupUsername(task.submission.promoted_profile.name, task.hostname),
        password: generateSitePassword(),
    };
    const account = {
        hostname: task.hostname,
        email: alias,
        email_alias: alias,
        auth_mode: "password_email",
        verified: false,
        created_at: new Date().toISOString(),
        last_used_at: new Date().toISOString(),
        submit_url: task.target_url,
        last_registration_result: "Generated unattended signup draft credentials for a public registration flow.",
    };
    return { account, credentials };
}
function inferScoutFailureReason(scout) {
    const summary = scout?.surface_summary?.toLowerCase() ?? "";
    if (summary.includes("timed out")) {
        return "SCOUT_SESSION_TIMEOUT";
    }
    return "DIRECTORY_NAVIGATION_FAILED";
}
function pickRecoveredTargetUrl(task, scout) {
    const assessment = scout.page_assessment;
    if (!assessment?.page_reachable || !assessment.ambiguity_flags.includes("not_found_but_reachable")) {
        return undefined;
    }
    let currentUrl;
    try {
        currentUrl = new URL(task.target_url);
    }
    catch {
        return undefined;
    }
    const scored = (scout.link_candidates ?? [])
        .map((candidate) => {
        try {
            const href = new URL(candidate.href);
            if (!["http:", "https:"].includes(href.protocol)) {
                return undefined;
            }
            if (href.href === currentUrl.href) {
                return undefined;
            }
            if (href.hostname !== currentUrl.hostname) {
                return undefined;
            }
            let score = 0;
            if (candidate.kind === "submit")
                score += 45;
            if (candidate.kind === "register")
                score += 20;
            if (candidate.kind === "auth")
                score += 5;
            const path = `${href.pathname}${href.search}`.toLowerCase();
            const text = candidate.text.toLowerCase();
            if (/(submit|add|listing|get-listed)/i.test(path))
                score += 35;
            if (/(submit|add|listing|get listed)/i.test(text))
                score += 20;
            if (/(sign-up|signup|register|join|create-account)/i.test(path))
                score += 18;
            if (/(suggest|suggested)/i.test(path))
                score -= 12;
            if (/\/categories\//i.test(path))
                score -= 10;
            if (href.pathname !== "/")
                score += 4;
            return { href: href.href, score };
        }
        catch {
            return undefined;
        }
    })
        .filter((value) => Boolean(value))
        .sort((a, b) => b.score - a.score);
    return scored[0]?.score && scored[0].score >= 20 ? scored[0].href : undefined;
}
export function buildHomepageProbeUrl(targetUrl) {
    const parsed = new URL(targetUrl);
    const homepageUrl = `${parsed.origin}/`;
    return parsed.href === homepageUrl ? undefined : homepageUrl;
}
export function shouldProbeHomepageForSubmitRecovery(task, scout) {
    if (!scout?.ok) {
        return false;
    }
    if (!buildHomepageProbeUrl(task.target_url)) {
        return false;
    }
    const summary = scout.surface_summary?.toLowerCase() ?? "";
    const ambiguityFlags = scout.page_assessment?.ambiguity_flags ?? [];
    const responseStatus = scout.page_snapshot?.response_status;
    return (scout.page_assessment?.page_reachable === true &&
        (responseStatus === 404 ||
            ambiguityFlags.includes("not_found_but_reachable") ||
            summary.includes("stale submit path") ||
            summary.includes("404")));
}
export function mustRunHomepageRecoveryBeforeRetry(args) {
    if (args.homepageRecoveryAttempted) {
        return false;
    }
    return shouldProbeHomepageForSubmitRecovery(args.task, args.scout);
}
export function inferOpportunityClassFromScout(_task, scout) {
    if (!scout?.ok || scout.page_assessment?.page_reachable !== true) {
        return "fast_terminal";
    }
    const ambiguityFlags = scout.page_assessment?.ambiguity_flags ?? [];
    const hasInteractiveEmbed = (scout.embed_hints ?? []).some((hint) => hint.likely_interactive);
    const hasStructuredEntryCandidate = (scout.link_candidates ?? []).some((candidate) => candidate.kind === "submit");
    const hasExplicitSubmitSurface = (scout.submit_candidates?.length ?? 0) > 0 ||
        hasStructuredEntryCandidate ||
        hasInteractiveEmbed;
    if (hasExplicitSubmitSurface &&
        !ambiguityFlags.includes("not_found_but_reachable") &&
        !ambiguityFlags.includes("mixed_submit_and_auth_signals") &&
        !ambiguityFlags.includes("login_vs_register_ambiguous")) {
        return "deep_first";
    }
    return "recovery_ambiguous";
}
function buildScoutTerminalBoundaryText(scout) {
    const embedText = (scout.embed_hints ?? [])
        .map((hint) => [
        hint.provider,
        hint.frame_title,
        hint.frame_url,
        hint.body_text_excerpt,
        ...(hint.cta_candidates ?? []),
        ...(hint.submit_candidates ?? []),
    ]
        .filter((value) => typeof value === "string" && value.trim().length > 0)
        .join("\n"))
        .filter(Boolean)
        .join("\n\n");
    return [
        scout.surface_summary,
        scout.page_snapshot.title,
        scout.page_snapshot.body_text_excerpt,
        ...(scout.submit_candidates ?? []),
        ...(scout.field_hints ?? []),
        ...(scout.auth_hints ?? []),
        ...(scout.anti_bot_hints ?? []),
        embedText,
    ]
        .filter((value) => typeof value === "string" && value.trim().length > 0)
        .join("\n");
}
export function classifyScoutTerminalBoundary(args) {
    if (!args.scout.ok || args.scout.page_assessment?.page_reachable !== true) {
        return undefined;
    }
    const classification = classifyEarlyTerminalOutcome({
        currentUrl: args.scout.page_snapshot.url || args.task.target_url,
        title: args.scout.page_snapshot.title,
        bodyText: buildScoutTerminalBoundaryText(args.scout),
        evidenceRef: args.evidenceRef,
        flowFamily: args.task.flow_family,
    });
    const stoppableStates = new Set([
        "SKIPPED",
        "WAITING_POLICY_DECISION",
        "WAITING_MANUAL_AUTH",
        "WAITING_MISSING_INPUT",
    ]);
    if (classification.evidence_sufficiency !== "sufficient") {
        return undefined;
    }
    if (classification.allow_rerun) {
        return undefined;
    }
    if (!stoppableStates.has(classification.outcome.next_status)) {
        return undefined;
    }
    return classification;
}
async function stopTaskForOutcome(args) {
    args.task.wait = args.wait;
    args.task.terminal_class = args.terminalClass;
    args.task.skip_reason_code = args.skipReasonCode;
    args.task.last_takeover_outcome = args.detail;
    if (args.nextStatus !== "RETRYABLE") {
        args.task.email_verification_continuation = undefined;
    }
    args.task.notes.push(args.detail);
    markTaskStageTimestamp(args.task, "prepare_finished_at");
    updateTaskStatus(args.task, args.nextStatus);
    updateTaskExecutionStateFromOutcome({
        task: args.task,
        nextStatus: args.nextStatus,
        detail: args.detail,
        wait: args.wait,
        terminalClass: args.terminalClass,
        currentUrl: args.scout?.page_snapshot.url ?? args.task.target_url,
        currentTitle: args.scout?.page_snapshot.title,
        artifactRefs: [args.evidenceRef, args.scoutArtifactRef].filter((value) => Boolean(value)),
        source: "prepare",
    });
    await saveTask(args.task);
    await clearWorkerLeaseForTask(args.task.id);
    return {
        mode: "task_stopped",
        task: args.task,
        effective_target_url: args.task.target_url,
        replay_hit: args.replayHit,
        scout_artifact_ref: args.scoutArtifactRef,
        scout: args.scout,
        account_candidate: args.accountCandidate,
        account_credentials: args.accountCredentials,
        registration_required: args.registrationRequired,
        registration_email_alias: args.registrationEmailAlias,
        mailbox_query: args.mailboxQuery,
        email_verification_continuation: args.task.email_verification_continuation,
    };
}
function inferPreflightFailure(args) {
    if (!args.runtime.preflight_checks.cdp_runtime.ok) {
        return {
            wait_reason_code: "CDP_RUNTIME_UNAVAILABLE",
            detail: `${args.stage} stopped because the shared CDP runtime is unavailable: ${args.runtime.preflight_checks.cdp_runtime.detail}`,
        };
    }
    if (!args.runtime.preflight_checks.playwright.ok) {
        return {
            wait_reason_code: "PLAYWRIGHT_CDP_UNAVAILABLE",
            detail: `${args.stage} stopped because Playwright could not connect to the shared browser: ${args.runtime.preflight_checks.playwright.detail}`,
        };
    }
    return {
        wait_reason_code: "RUNTIME_PREFLIGHT_FAILED",
        detail: `${args.stage} stopped because the runtime preflight failed unexpectedly.`,
    };
}
async function stopTaskForRetry(args) {
    args.task.wait = {
        wait_reason_code: args.waitReasonCode,
        resume_trigger: args.detail,
        resolution_owner: "system",
        resolution_mode: "auto_resume",
        evidence_ref: args.evidenceRef,
    };
    args.task.terminal_class = args.task.terminal_class ?? "outcome_not_confirmed";
    args.task.notes.push(args.detail);
    markTaskStageTimestamp(args.task, "prepare_finished_at");
    updateTaskStatus(args.task, "RETRYABLE");
    updateTaskExecutionStateFromOutcome({
        task: args.task,
        nextStatus: "RETRYABLE",
        detail: args.detail,
        wait: args.task.wait,
        terminalClass: args.task.terminal_class,
        currentUrl: args.scout?.page_snapshot.url ?? args.task.target_url,
        currentTitle: args.scout?.page_snapshot.title,
        artifactRefs: [args.evidenceRef, args.scoutArtifactRef].filter((value) => Boolean(value)),
        source: "prepare",
    });
    await saveTask(args.task);
    await clearWorkerLeaseForTask(args.task.id);
    return {
        mode: "task_stopped",
        task: args.task,
        effective_target_url: args.task.target_url,
        replay_hit: args.replayHit,
        scout_artifact_ref: args.scoutArtifactRef,
        scout: args.scout,
        account_candidate: args.accountCandidate,
        account_credentials: args.accountCredentials,
        registration_required: args.registrationRequired,
        registration_email_alias: args.registrationEmailAlias,
        mailbox_query: args.mailboxQuery,
        email_verification_continuation: args.task.email_verification_continuation,
    };
}
export async function prepareTaskForAgent(args) {
    await ensureDataDirectories();
    const task = await loadTask(args.taskId);
    if (!task) {
        throw new Error(`Task ${args.taskId} does not exist.`);
    }
    markTaskStageTimestamp(task, "prepare_started_at");
    const runtime = await runPreflight(await resolveBrowserRuntime(args.cdpUrl));
    const preflightPath = getLatestPreflightPath();
    await writeJsonFile(preflightPath, runtime);
    if (!runtime.ok) {
        const failure = inferPreflightFailure({ runtime, stage: "task-prepare" });
        return stopTaskForRetry({
            task,
            replayHit: false,
            detail: failure.detail,
            waitReasonCode: failure.wait_reason_code,
            evidenceRef: preflightPath,
        });
    }
    const replayPlaybook = await loadTrajectoryPlaybook(task.hostname);
    if (replayPlaybook) {
        task.escalation_level = "replay";
        task.trajectory_playbook_ref = task.hostname;
        task.phase_history.push("replay");
        await acquireBrowserOwnership("replay", task.id);
        try {
            const replayResult = await runTrajectoryReplay({
                cdpUrl: runtime.cdp_url,
                task,
                playbook: replayPlaybook,
            });
            task.latest_artifacts.push(...replayResult.artifact_refs);
            task.notes.push(replayResult.detail);
            if (replayResult.ok) {
                task.wait = replayResult.wait;
                task.terminal_class = replayResult.terminal_class;
                task.skip_reason_code = replayResult.skip_reason_code;
                markTaskStageTimestamp(task, "prepare_finished_at");
                updateTaskStatus(task, replayResult.next_status);
                await saveTask(task);
                await clearWorkerLeaseForTask(task.id);
                return {
                    mode: "replay_completed",
                    task,
                    effective_target_url: task.target_url,
                    replay_hit: true,
                };
            }
        }
        finally {
            await releaseBrowserOwnership();
        }
    }
    if (!runtime.preflight_checks.browser_use_cli.ok) {
        return stopTaskForRetry({
            task,
            replayHit: Boolean(replayPlaybook),
            detail: "task-prepare stopped because browser-use CLI is unavailable.",
            waitReasonCode: "BROWSER_USE_CLI_UNAVAILABLE",
            evidenceRef: preflightPath,
        });
    }
    task.escalation_level = "scout";
    task.phase_history.push("scout");
    await acquireBrowserOwnership("scout", task.id);
    const scoutArtifactPath = getArtifactFilePath(task.id, "scout");
    try {
        let scout = await runLightweightScout({ runtime, task });
        await writeJsonFile(scoutArtifactPath, scout);
        if (!task.latest_artifacts.includes(scoutArtifactPath)) {
            task.latest_artifacts.push(scoutArtifactPath);
        }
        task.notes.push(scout.surface_summary);
        let recoveredTargetUrl = pickRecoveredTargetUrl(task, scout);
        task.homepage_recovery_used = false;
        task.recovered_target_url = undefined;
        const homepageRecoveryRequired = mustRunHomepageRecoveryBeforeRetry({
            task,
            scout,
            homepageRecoveryAttempted: false,
        });
        if (!recoveredTargetUrl && homepageRecoveryRequired) {
            task.homepage_recovery_used = true;
            const homepageProbeUrl = buildHomepageProbeUrl(task.target_url);
            if (homepageProbeUrl) {
                const homepageProbeTask = {
                    ...task,
                    target_url: homepageProbeUrl,
                    hostname: new URL(homepageProbeUrl).hostname,
                };
                const homepageProbe = await runLightweightScout({ runtime, task: homepageProbeTask });
                const homepageProbeArtifactPath = getArtifactFilePath(task.id, "homepage-probe");
                await writeJsonFile(homepageProbeArtifactPath, homepageProbe);
                if (!task.latest_artifacts.includes(homepageProbeArtifactPath)) {
                    task.latest_artifacts.push(homepageProbeArtifactPath);
                }
                task.notes.push(`Homepage probe for stale submit path ran against ${homepageProbeUrl}: ${homepageProbe.surface_summary}`);
                recoveredTargetUrl = pickRecoveredTargetUrl(task, homepageProbe);
                if (recoveredTargetUrl) {
                    task.recovered_target_url = recoveredTargetUrl;
                    task.notes.push(`Recovered submit route ${recoveredTargetUrl} from homepage probe after stale submit path on ${task.target_url}.`);
                }
            }
        }
        if (recoveredTargetUrl) {
            task.recovered_target_url = recoveredTargetUrl;
            task.target_url = recoveredTargetUrl;
            task.hostname = new URL(recoveredTargetUrl).hostname;
            task.notes.push(`Auto-rescanned stale submit path and switched target URL to ${recoveredTargetUrl}.`);
            scout = await runLightweightScout({ runtime, task });
            await writeJsonFile(scoutArtifactPath, scout);
            task.notes.push(scout.surface_summary);
        }
        if (!scout.ok || (scout.page_snapshot.response_status ?? 0) >= 500) {
            if ((scout.page_snapshot.response_status ?? 0) >= 500) {
                task.terminal_class = "upstream_5xx";
            }
            const scoutFailureReason = !scout.ok ? inferScoutFailureReason(scout) : "DIRECTORY_UPSTREAM_5XX";
            return stopTaskForRetry({
                task,
                replayHit: Boolean(replayPlaybook),
                detail: scoutFailureReason === "SCOUT_SESSION_TIMEOUT"
                    ? "Retry later after resetting the shared CDP scout session; the page itself loaded, but the reused browser page failed to release cleanly."
                    : "Retry later after the directory becomes reachable again.",
                waitReasonCode: scoutFailureReason,
                evidenceRef: scoutArtifactPath,
                scoutArtifactRef: scoutArtifactPath,
                scout,
            });
        }
        if (scout.page_snapshot.url && scout.page_snapshot.url !== task.target_url) {
            task.target_url = scout.page_snapshot.url;
            task.hostname = new URL(scout.page_snapshot.url).hostname;
            task.notes.push(`Canonicalized target URL to ${scout.page_snapshot.url} based on scout.`);
        }
        const opportunityClass = inferOpportunityClassFromScout(task, scout);
        task.opportunity_class = opportunityClass;
        updateTaskExecutionStateFromScout({
            task,
            scout,
            artifactRef: scoutArtifactPath,
        });
        const scoutTerminalBoundary = classifyScoutTerminalBoundary({
            task,
            scout,
            evidenceRef: scoutArtifactPath,
        });
        if (scoutTerminalBoundary) {
            return stopTaskForOutcome({
                task,
                replayHit: Boolean(replayPlaybook),
                nextStatus: scoutTerminalBoundary.outcome.next_status,
                detail: scoutTerminalBoundary.outcome.detail,
                wait: scoutTerminalBoundary.outcome.wait,
                terminalClass: scoutTerminalBoundary.outcome.terminal_class,
                skipReasonCode: scoutTerminalBoundary.outcome.skip_reason_code,
                evidenceRef: scoutArtifactPath,
                scoutArtifactRef: scoutArtifactPath,
                scout,
            });
        }
        let accountCandidate = await getAccountForHostname(task.hostname);
        let accountCredentials = accountCandidate?.credential_ref
            ? await getCredential(accountCandidate.credential_ref).catch(() => undefined)
            : undefined;
        if (accountCandidate) {
            task.account_ref = accountCandidate.hostname;
        }
        const registrationRequired = !accountCandidate &&
            inferRegistrationRequired(task, scout.auth_hints);
        if (registrationRequired && !accountCandidate) {
            const draft = buildRegistrationDraft(task);
            if (draft) {
                accountCandidate = draft.account;
                accountCredentials = draft.credentials;
            }
        }
        const registrationEmailAlias = registrationRequired
            ? accountCandidate?.email_alias ?? buildPlusAlias(task.submission.submitter_email, task.hostname)
            : undefined;
        const mailboxQuery = registrationEmailAlias
            ? buildMailboxQuery(registrationEmailAlias)
            : undefined;
        if (registrationRequired && !runtime.preflight_checks.gog.ok) {
            return stopTaskForRetry({
                task,
                replayHit: Boolean(replayPlaybook),
                detail: "task-prepare stopped because gog is unavailable for an email-registration flow.",
                waitReasonCode: "GOG_UNAVAILABLE",
                evidenceRef: preflightPath,
                scoutArtifactRef: scoutArtifactPath,
                scout,
                accountCandidate,
                accountCredentials,
                registrationRequired,
                registrationEmailAlias,
                mailboxQuery,
            });
        }
        markTaskStageTimestamp(task, "prepare_finished_at");
        await saveTask(task);
        return {
            mode: "ready_for_agent_loop",
            task,
            effective_target_url: task.target_url,
            replay_hit: Boolean(replayPlaybook),
            opportunity_class: opportunityClass,
            scout_artifact_ref: scoutArtifactPath,
            scout,
            account_candidate: accountCandidate,
            account_credentials: accountCredentials,
            registration_required: registrationRequired,
            registration_email_alias: registrationEmailAlias,
            mailbox_query: mailboxQuery,
            email_verification_continuation: task.email_verification_continuation,
        };
    }
    finally {
        await releaseBrowserOwnership();
    }
}
