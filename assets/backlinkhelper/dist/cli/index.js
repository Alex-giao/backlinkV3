import { pathToFileURL } from "node:url";
import { runClaimNextTaskCommand } from "./claim-next-task.js";
import { runEnsureOpenClawCronCommand } from "./ensure-openclaw-cron.js";
import { runEnqueueSiteCommand } from "./enqueue-site.js";
import { runGuardedDrainStatusCommand } from "./guarded-drain-status.js";
import { runInitGateCommand } from "./init-gate.js";
import { runMailboxTriageCommand } from "./mailbox-triage.js";
import { runMissingInputPreflightCommand } from "./missing-input-preflight.js";
import { runPreflightCommand } from "./preflight.js";
import { runRepartitionRetryDecisionsCommand } from "./repartition-retry-decisions.js";
import { runNextCommand } from "./run-next.js";
import { runStartBrowserCommand } from "./start-browser.js";
import { runTaskFinalizeCommand } from "./task-finalize.js";
import { runTaskPrepareCommand } from "./task-prepare.js";
import { runTaskRecordAgentTraceCommand } from "./task-record-agent-trace.js";
import { runUpdatePromotedDossierCommand } from "./update-promoted-dossier.js";
function readFlag(argv, flagName) {
    const index = argv.indexOf(flagName);
    if (index === -1) {
        return undefined;
    }
    return argv[index + 1];
}
function requireFlag(argv, flagName) {
    const value = readFlag(argv, flagName);
    if (!value) {
        throw new Error(`Missing required flag ${flagName}.`);
    }
    return value;
}
function readBooleanFlag(argv, flagName) {
    return argv.includes(flagName);
}
function readThinkingFlag(argv, flagName) {
    const value = readFlag(argv, flagName);
    if (!value) {
        return "low";
    }
    if (["off", "minimal", "low", "medium", "high", "xhigh"].includes(value)) {
        return value;
    }
    throw new Error(`Unsupported thinking level ${value}.`);
}
function readOptionalInt(argv, flagName) {
    const value = readFlag(argv, flagName);
    if (!value) {
        return undefined;
    }
    const numeric = Number.parseInt(value, 10);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        throw new Error(`Invalid integer for ${flagName}: ${value}`);
    }
    return numeric;
}
function readCsvFlag(argv, flagName) {
    const value = readFlag(argv, flagName);
    if (!value) {
        return undefined;
    }
    return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}
function readMultiFlag(argv, flagName) {
    const values = [];
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === flagName && argv[index + 1]) {
            values.push(argv[index + 1]);
        }
    }
    return values;
}
export function resolveTargetUrlFlag(argv) {
    return readFlag(argv, "--target-url") ?? readFlag(argv, "--directory-url");
}
async function main() {
    const [, , command, ...rest] = process.argv;
    const cdpUrl = readFlag(rest, "--cdp-url");
    switch (command) {
        case "start-browser":
            await runStartBrowserCommand({
                port: readFlag(rest, "--port") ? Number(readFlag(rest, "--port")) : undefined,
                headed: readBooleanFlag(rest, "--headed"),
            });
            return;
        case "preflight":
            await runPreflightCommand({ cdpUrl });
            return;
        case "ensure-openclaw-cron":
            await runEnsureOpenClawCronCommand({
                name: readFlag(rest, "--name") ?? "backliner-helper:queue-worker",
                every: readFlag(rest, "--every") ?? "5m",
                cdpUrl: cdpUrl ?? process.env.BACKLINK_BROWSER_CDP_URL ?? "http://127.0.0.1:9224",
                timeoutSeconds: readFlag(rest, "--timeout-seconds")
                    ? Number(readFlag(rest, "--timeout-seconds"))
                    : 900,
                thinking: readThinkingFlag(rest, "--thinking"),
                owner: readFlag(rest, "--owner") ?? "openclaw-cron-worker",
                model: readFlag(rest, "--model"),
                deliver: !readBooleanFlag(rest, "--no-deliver"),
                channel: readFlag(rest, "--channel"),
                to: readFlag(rest, "--to"),
                dryRun: readBooleanFlag(rest, "--dry-run"),
            });
            return;
        case "enqueue-site":
            await runEnqueueSiteCommand({
                taskId: requireFlag(rest, "--task-id"),
                targetUrl: resolveTargetUrlFlag(rest) ?? requireFlag(rest, "--target-url"),
                promotedUrl: requireFlag(rest, "--promoted-url"),
                promotedName: readFlag(rest, "--promoted-name"),
                promotedDescription: readFlag(rest, "--promoted-description"),
                submitterEmailBase: readFlag(rest, "--submitter-email-base"),
                confirmSubmit: readBooleanFlag(rest, "--confirm-submit"),
                flowFamily: readFlag(rest, "--flow-family"),
            });
            return;
        case "guarded-drain-status":
            await runGuardedDrainStatusCommand({
                cdpUrl,
                taskIdPrefix: readFlag(rest, "--task-id-prefix"),
                promotedHostname: readFlag(rest, "--promoted-hostname"),
                promotedUrl: readFlag(rest, "--promoted-url"),
            });
            return;
        case "mailbox-triage":
            await runMailboxTriageCommand({
                mailboxQuery: readFlag(rest, "--mailbox-query") ?? readFlag(rest, "--query"),
                hostname: readFlag(rest, "--hostname"),
                primaryEmail: readFlag(rest, "--primary-email"),
                emailAlias: readFlag(rest, "--email-alias"),
                account: readFlag(rest, "--account"),
                windowHours: readFlag(rest, "--window-hours") ? Number(readFlag(rest, "--window-hours")) : undefined,
                maxSearch: readFlag(rest, "--max-search") ? Number(readFlag(rest, "--max-search")) : undefined,
                maxCandidates: readFlag(rest, "--max-candidates")
                    ? Number(readFlag(rest, "--max-candidates"))
                    : undefined,
            });
            return;
        case "missing-input-preflight":
            await runMissingInputPreflightCommand({
                promotedUrl: readFlag(rest, "--promoted-url"),
            });
            return;
        case "init-gate":
            await runInitGateCommand({
                promotedUrl: readFlag(rest, "--promoted-url"),
                promotedHostname: readFlag(rest, "--promoted-hostname"),
                mode: readFlag(rest, "--mode") ?? "interactive",
            });
            return;
        case "update-promoted-dossier":
            await runUpdatePromotedDossierCommand({
                promotedUrl: requireFlag(rest, "--promoted-url"),
                updates: readMultiFlag(rest, "--set"),
                sourceType: readFlag(rest, "--source-type"),
            });
            return;
        case "claim-next-task":
            await runClaimNextTaskCommand({
                owner: readFlag(rest, "--owner") ?? "codex-operator",
                taskIdPrefix: readFlag(rest, "--task-id-prefix"),
                promotedHostname: readFlag(rest, "--promoted-hostname"),
                promotedUrl: readFlag(rest, "--promoted-url"),
                requireCompleteProfile: readBooleanFlag(rest, "--require-complete-profile"),
                initGateMode: readFlag(rest, "--init-gate-mode") ?? "unattended",
            });
            return;
        case "task-prepare":
            await runTaskPrepareCommand({
                taskId: requireFlag(rest, "--task-id"),
                cdpUrl,
            });
            return;
        case "task-record-agent-trace":
            await runTaskRecordAgentTraceCommand({
                taskId: requireFlag(rest, "--task-id"),
                payloadFile: requireFlag(rest, "--payload-file"),
            });
            return;
        case "task-finalize":
            await runTaskFinalizeCommand({
                taskId: requireFlag(rest, "--task-id"),
                cdpUrl,
            });
            return;
        case "run-next":
            await runNextCommand({
                taskId: requireFlag(rest, "--task-id"),
                targetUrl: resolveTargetUrlFlag(rest) ?? requireFlag(rest, "--target-url"),
                promotedUrl: requireFlag(rest, "--promoted-url"),
                promotedName: readFlag(rest, "--promoted-name"),
                promotedDescription: readFlag(rest, "--promoted-description"),
                submitterEmail: readFlag(rest, "--submitter-email"),
                confirmSubmit: readBooleanFlag(rest, "--confirm-submit"),
                cdpUrl,
            });
            return;
        case "repartition-retry-decisions":
            await runRepartitionRetryDecisionsCommand({
                apply: readBooleanFlag(rest, "--apply"),
                limit: readOptionalInt(rest, "--limit"),
                cdpUrl,
                taskIdPrefix: readFlag(rest, "--task-id-prefix"),
                promotedHostname: readFlag(rest, "--promoted-hostname"),
                promotedUrl: readFlag(rest, "--promoted-url"),
                applyBuckets: readCsvFlag(rest, "--apply-buckets"),
                maxApply: readOptionalInt(rest, "--max-apply"),
            });
            return;
        default:
            throw new Error('Unknown command. Use "start-browser", "preflight", "ensure-openclaw-cron", "enqueue-site", "guarded-drain-status", "mailbox-triage", "missing-input-preflight", "init-gate", "update-promoted-dossier", "claim-next-task", "task-prepare", "task-record-agent-trace", "task-finalize", "run-next", or "repartition-retry-decisions".');
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}
