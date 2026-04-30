import { pathToFileURL } from "node:url";
import { runClaimNextTaskCommand } from "./claim-next-task.js";
import { runDbSmokeCommand } from "./db-smoke.js";
import { runEnqueueSiteCommand } from "./enqueue-site.js";
import { runImportBacklinkCsvCommand } from "./import-backlink-csv.js";
import { runFollowUpTickCommand } from "./follow-up-tick.js";
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
import { runUnattendedCampaignCommand } from "./unattended-campaign-runner.js";
import { runUnattendedScopeTickCommand } from "./unattended-scope-tick.js";
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
export const SUPPORTED_COMMANDS = [
    "start-browser",
    "preflight",
    "enqueue-site",
    "db-smoke",
    "import-backlink-csv",
    "guarded-drain-status",
    "mailbox-triage",
    "follow-up-tick",
    "unattended-campaign",
    "unattended-scope-tick",
    "missing-input-preflight",
    "init-gate",
    "update-promoted-dossier",
    "claim-next-task",
    "task-prepare",
    "task-record-agent-trace",
    "task-finalize",
    "run-next",
    "repartition-retry-decisions",
];
export function buildUnknownCommandMessage() {
    return `Unknown command. Use ${SUPPORTED_COMMANDS.map((command) => `"${command}"`).join(", ").replace(/, ([^,]+)$/, ", or $1")}.`;
}
const SINGLE_TASK_OPERATOR_FORBIDDEN_COMMANDS = new Set([
    "enqueue-site",
    "import-backlink-csv",
    "follow-up-tick",
    "unattended-campaign",
    "unattended-scope-tick",
    "update-promoted-dossier",
    "claim-next-task",
    "task-prepare",
    "task-record-agent-trace",
    "task-finalize",
    "run-next",
    "repartition-retry-decisions",
]);
export function assertCommandAllowedInSingleTaskOperatorMode(command, env = process.env) {
    if (env.BACKLINKHELPER_SINGLE_TASK_OPERATOR_GUARD !== "1" || !command) {
        return;
    }
    if (SINGLE_TASK_OPERATOR_FORBIDDEN_COMMANDS.has(command)) {
        throw new Error(`Command ${command} is blocked by BACKLINKHELPER_SINGLE_TASK_OPERATOR_GUARD for single-task family operators.`);
    }
}
async function main() {
    const [, , command, ...rest] = process.argv;
    assertCommandAllowedInSingleTaskOperatorMode(command);
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
                enqueuedBy: readFlag(rest, "--enqueued-by"),
            });
            return;
        case "db-smoke":
            await runDbSmokeCommand();
            return;
        case "import-backlink-csv":
            await runImportBacklinkCsvCommand({
                csvPath: requireFlag(rest, "--csv"),
                urlColumn: readFlag(rest, "--url-column"),
                source: readFlag(rest, "--source"),
                limit: readOptionalInt(rest, "--limit"),
                offset: readFlag(rest, "--offset") ? Number(readFlag(rest, "--offset")) : undefined,
                flowFamily: readFlag(rest, "--flow-family"),
                enqueue: readBooleanFlag(rest, "--enqueue"),
                promotedUrl: readFlag(rest, "--promoted-url"),
                promotedName: readFlag(rest, "--promoted-name"),
                promotedDescription: readFlag(rest, "--promoted-description"),
                submitterEmailBase: readFlag(rest, "--submitter-email-base"),
                taskIdPrefix: readFlag(rest, "--task-id-prefix"),
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
        case "follow-up-tick":
            await runFollowUpTickCommand({
                owner: readFlag(rest, "--owner") ?? "follow-up-worker",
                taskIdPrefix: readFlag(rest, "--task-id-prefix"),
                promotedHostname: readFlag(rest, "--promoted-hostname"),
                promotedUrl: readFlag(rest, "--promoted-url"),
            });
            return;
        case "unattended-campaign":
            await runUnattendedCampaignCommand({
                owner: readFlag(rest, "--owner") ?? "unattended-campaign-worker",
                lane: readFlag(rest, "--lane"),
                taskIdPrefix: readFlag(rest, "--task-id-prefix"),
                promotedHostname: readFlag(rest, "--promoted-hostname"),
                promotedUrl: readFlag(rest, "--promoted-url"),
                promotedName: readFlag(rest, "--promoted-name"),
                promotedDescription: readFlag(rest, "--promoted-description"),
                submitterEmailBase: readFlag(rest, "--submitter-email-base"),
                confirmSubmit: readBooleanFlag(rest, "--confirm-submit"),
                flowFamily: readFlag(rest, "--flow-family"),
                candidateLimit: readOptionalInt(rest, "--candidate-limit"),
                cdpUrl,
                dryRun: readBooleanFlag(rest, "--dry-run"),
                maxActiveTasks: readOptionalInt(rest, "--max-active-tasks"),
                maxScopeTicks: readOptionalInt(rest, "--max-scope-ticks"),
                maxFollowUpTicks: readOptionalInt(rest, "--max-follow-up-ticks"),
                followUp: readBooleanFlag(rest, "--no-follow-up") ? false : undefined,
                operatorCommand: readFlag(rest, "--operator-command") ?? process.env.BACKLINKHELPER_OPERATOR_COMMAND,
                operatorTimeoutMs: readFlag(rest, "--operator-timeout-ms")
                    ? Number(readFlag(rest, "--operator-timeout-ms"))
                    : undefined,
            });
            return;
        case "unattended-scope-tick":
            await runUnattendedScopeTickCommand({
                owner: readFlag(rest, "--owner") ?? "unattended-scope-worker",
                lane: readFlag(rest, "--lane"),
                taskIdPrefix: readFlag(rest, "--task-id-prefix"),
                promotedHostname: readFlag(rest, "--promoted-hostname"),
                promotedUrl: readFlag(rest, "--promoted-url"),
                promotedName: readFlag(rest, "--promoted-name"),
                promotedDescription: readFlag(rest, "--promoted-description"),
                submitterEmailBase: readFlag(rest, "--submitter-email-base"),
                confirmSubmit: readBooleanFlag(rest, "--confirm-submit"),
                flowFamily: readFlag(rest, "--flow-family"),
                candidateLimit: readOptionalInt(rest, "--candidate-limit"),
                dryRun: readBooleanFlag(rest, "--dry-run"),
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
                lane: readFlag(rest, "--lane"),
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
            throw new Error(buildUnknownCommandMessage());
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        if (process.env.BACKLINKHELPER_DEBUG_STACK === "1" && error instanceof Error) {
            console.error(error.stack ?? error.message);
        }
        else {
            console.error(error instanceof Error ? error.message : error);
        }
        process.exitCode = 1;
    });
}
