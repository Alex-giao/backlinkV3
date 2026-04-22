import { closeBrowserUseSession } from "../execution/browser-use-cli.js";
import { acquireBrowserOwnership, releaseBrowserOwnership } from "../execution/ownership-lock.js";
import { upsertAccountRecord } from "../memory/account-registry.js";
import { putCredential } from "../memory/credential-vault.js";
import { clearPendingFinalize, clearWorkerLeaseForTask, ensureDataDirectories, getLatestPreflightPath, getPendingFinalizePath, loadTask, readJsonFile, saveTask, writeJsonFile, } from "../memory/data-store.js";
import { saveTrajectoryPlaybook } from "../memory/trajectory-playbook.js";
import { enrichWaitMetadataWithMissingFields } from "../shared/missing-inputs.js";
import { resolveBrowserRuntime } from "../shared/browser-runtime.js";
import { generateCredentialRef } from "../shared/email.js";
import { runPreflight } from "../shared/preflight.js";
import { updateTaskExecutionStateFromFinalize, updateTaskExecutionStateFromOutcome } from "../shared/task-progress.js";
import { markTaskStageTimestamp } from "../shared/task-timing.js";
import { runTakeoverFinalization } from "../execution/takeover.js";
function appendUnique(target, values) {
    for (const value of values) {
        if (!target.includes(value)) {
            target.push(value);
        }
    }
}
function inferPreflightFailure(runtime) {
    if (!runtime.preflight_checks.cdp_runtime.ok) {
        return {
            wait_reason_code: "CDP_RUNTIME_UNAVAILABLE",
            detail: `task-finalize stopped because the shared CDP runtime is unavailable: ${runtime.preflight_checks.cdp_runtime.detail}`,
        };
    }
    if (!runtime.preflight_checks.playwright.ok) {
        return {
            wait_reason_code: "PLAYWRIGHT_CDP_UNAVAILABLE",
            detail: `task-finalize stopped because Playwright could not connect to the shared browser: ${runtime.preflight_checks.playwright.detail}`,
        };
    }
    return {
        wait_reason_code: "RUNTIME_PREFLIGHT_FAILED",
        detail: "task-finalize stopped because the runtime preflight failed unexpectedly.",
    };
}
export function applyFinalizeResultToTask(args) {
    const { task, finalResult, handoff } = args;
    task.wait = finalResult.wait;
    task.status = finalResult.next_status;
    task.updated_at = new Date().toISOString();
    task.terminal_class = finalResult.terminal_class;
    task.skip_reason_code = finalResult.skip_reason_code;
    task.last_takeover_outcome = finalResult.detail;
    task.link_verification = finalResult.link_verification;
    if (finalResult.next_status !== "RETRYABLE") {
        task.email_verification_continuation = undefined;
    }
    task.lease_expires_at = undefined;
    task.visual_gate_used = Boolean(handoff.visual_verification);
    appendUnique(task.latest_artifacts, [...handoff.artifact_refs, ...finalResult.artifact_refs]);
    task.notes.push(finalResult.detail);
    task.wait = enrichWaitMetadataWithMissingFields(task).wait;
    finalResult.wait = task.wait;
}
export async function finalizeTask(args) {
    await ensureDataDirectories();
    const task = await loadTask(args.taskId);
    if (!task) {
        throw new Error(`Task ${args.taskId} does not exist.`);
    }
    const pendingFinalize = await readJsonFile(getPendingFinalizePath(args.taskId));
    if (!pendingFinalize?.handoff) {
        throw new Error(`Task ${args.taskId} does not have a pending finalization payload.`);
    }
    markTaskStageTimestamp(task, "finalize_started_at");
    const runtime = await runPreflight(await resolveBrowserRuntime(args.cdpUrl));
    const preflightPath = getLatestPreflightPath();
    await writeJsonFile(preflightPath, runtime);
    if (!runtime.ok) {
        const failure = inferPreflightFailure(runtime);
        const retryResult = {
            ok: false,
            next_status: "RETRYABLE",
            detail: failure.detail,
            artifact_refs: [],
            wait: {
                wait_reason_code: failure.wait_reason_code,
                resume_trigger: failure.detail,
                resolution_owner: "system",
                resolution_mode: "auto_resume",
                evidence_ref: preflightPath,
            },
            terminal_class: "outcome_not_confirmed",
        };
        task.wait = retryResult.wait;
        markTaskStageTimestamp(task, "finalize_finished_at");
        task.status = retryResult.next_status;
        task.updated_at = new Date().toISOString();
        task.terminal_class = retryResult.terminal_class;
        task.last_takeover_outcome = retryResult.detail;
        task.link_verification = undefined;
        task.lease_expires_at = undefined;
        task.notes.push(retryResult.detail);
        updateTaskExecutionStateFromOutcome({
            task,
            nextStatus: retryResult.next_status,
            detail: retryResult.detail,
            wait: retryResult.wait,
            terminalClass: retryResult.terminal_class,
            currentUrl: task.target_url,
            currentTitle: undefined,
            artifactRefs: [preflightPath],
            source: "finalize",
        });
        await saveTask(task);
        await clearWorkerLeaseForTask(task.id);
        return retryResult;
    }
    task.phase_history.push("takeover:finalization");
    await acquireBrowserOwnership("finalization:playwright", task.id);
    let finalResult;
    try {
        finalResult = await runTakeoverFinalization({
            runtime,
            task,
            handoff: pendingFinalize.handoff,
        });
    }
    finally {
        await releaseBrowserOwnership();
        if (pendingFinalize.handoff.browser_use_session) {
            try {
                await closeBrowserUseSession({
                    cdpUrl: runtime.cdp_url,
                    session: pendingFinalize.handoff.browser_use_session,
                });
            }
            catch {
                // Best-effort cleanup only. Finalization should stay authoritative even if
                // browser-use session teardown is imperfect.
            }
        }
    }
    markTaskStageTimestamp(task, "finalize_finished_at");
    applyFinalizeResultToTask({
        task,
        finalResult,
        handoff: pendingFinalize.handoff,
    });
    updateTaskExecutionStateFromFinalize({
        task,
        result: finalResult,
        handoff: pendingFinalize.handoff,
    });
    let accountCreated = false;
    let credentialRef = pendingFinalize.account?.credential_ref;
    if (pendingFinalize.account) {
        if (pendingFinalize.account.credential_payload) {
            credentialRef =
                credentialRef ??
                    generateCredentialRef(pendingFinalize.account.hostname, pendingFinalize.account.email_alias);
            await putCredential(credentialRef, pendingFinalize.account.credential_payload);
        }
        const account = await upsertAccountRecord({
            hostname: pendingFinalize.account.hostname,
            email: pendingFinalize.account.email,
            emailAlias: pendingFinalize.account.email_alias,
            authMode: pendingFinalize.account.auth_mode,
            verified: pendingFinalize.account.verified ||
                finalResult.next_status === "WAITING_SITE_RESPONSE" ||
                finalResult.next_status === "DONE",
            loginUrl: pendingFinalize.account.login_url,
            submitUrl: pendingFinalize.account.submit_url ?? task.target_url,
            credentialRef,
            registrationResult: pendingFinalize.account.last_registration_result,
        });
        accountCreated = true;
        task.account_ref = account.hostname;
    }
    if (finalResult.playbook) {
        await saveTrajectoryPlaybook(finalResult.playbook);
        task.trajectory_playbook_ref = finalResult.playbook.hostname;
    }
    await saveTask(task);
    await clearPendingFinalize(args.taskId);
    await clearWorkerLeaseForTask(task.id);
    return {
        ...finalResult,
        account_created: accountCreated,
        credential_ref: credentialRef,
    };
}
