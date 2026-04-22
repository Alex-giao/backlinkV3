import { pathToFileURL } from "node:url";

import { runClaimNextTaskCommand } from "./claim-next-task.js";
import { runEnqueueSiteCommand } from "./enqueue-site.js";
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
import { runUpdatePromotedDossierCommand } from "./update-promoted-dossier.js";

function readFlag(argv: string[], flagName: string): string | undefined {
  const index = argv.indexOf(flagName);
  if (index === -1) {
    return undefined;
  }

  return argv[index + 1];
}

function requireFlag(argv: string[], flagName: string): string {
  const value = readFlag(argv, flagName);
  if (!value) {
    throw new Error(`Missing required flag ${flagName}.`);
  }

  return value;
}

function readBooleanFlag(argv: string[], flagName: string): boolean {
  return argv.includes(flagName);
}

function readOptionalInt(argv: string[], flagName: string): number | undefined {
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

function readCsvFlag(argv: string[], flagName: string): string[] | undefined {
  const value = readFlag(argv, flagName);
  if (!value) {
    return undefined;
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readMultiFlag(argv: string[], flagName: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flagName && argv[index + 1]) {
      values.push(argv[index + 1]);
    }
  }
  return values;
}

export function resolveTargetUrlFlag(argv: string[]): string | undefined {
  return readFlag(argv, "--target-url") ?? readFlag(argv, "--directory-url");
}

export const SUPPORTED_COMMANDS = [
  "start-browser",
  "preflight",
  "enqueue-site",
  "guarded-drain-status",
  "mailbox-triage",
  "follow-up-tick",
  "missing-input-preflight",
  "init-gate",
  "update-promoted-dossier",
  "claim-next-task",
  "task-prepare",
  "task-record-agent-trace",
  "task-finalize",
  "run-next",
  "repartition-retry-decisions",
] as const;

export function buildUnknownCommandMessage(): string {
  return `Unknown command. Use ${SUPPORTED_COMMANDS.map((command) => `"${command}"`).join(", ").replace(/, ([^,]+)$/, ", or $1")}.`;
}

async function main(): Promise<void> {
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
    case "enqueue-site":
      await runEnqueueSiteCommand({
        taskId: requireFlag(rest, "--task-id"),
        targetUrl: resolveTargetUrlFlag(rest) ?? requireFlag(rest, "--target-url"),
        promotedUrl: requireFlag(rest, "--promoted-url"),
        promotedName: readFlag(rest, "--promoted-name"),
        promotedDescription: readFlag(rest, "--promoted-description"),
        submitterEmailBase: readFlag(rest, "--submitter-email-base"),
        confirmSubmit: readBooleanFlag(rest, "--confirm-submit"),
        flowFamily: readFlag(rest, "--flow-family") as "saas_directory" | "forum_profile" | "wp_comment" | "dev_blog" | undefined,
        enqueuedBy: readFlag(rest, "--enqueued-by"),
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
    case "missing-input-preflight":
      await runMissingInputPreflightCommand({
        promotedUrl: readFlag(rest, "--promoted-url"),
      });
      return;
    case "init-gate":
      await runInitGateCommand({
        promotedUrl: readFlag(rest, "--promoted-url"),
        promotedHostname: readFlag(rest, "--promoted-hostname"),
        mode: (readFlag(rest, "--mode") as "interactive" | "unattended" | undefined) ?? "interactive",
      });
      return;
    case "update-promoted-dossier":
      await runUpdatePromotedDossierCommand({
        promotedUrl: requireFlag(rest, "--promoted-url"),
        updates: readMultiFlag(rest, "--set"),
        sourceType: readFlag(rest, "--source-type") as
          | "scraped_public"
          | "user_confirmed"
          | "operator_default"
          | "repo_inferred"
          | "external_system"
          | undefined,
      });
      return;
    case "claim-next-task":
      await runClaimNextTaskCommand({
        owner: readFlag(rest, "--owner") ?? "codex-operator",
        lane: readFlag(rest, "--lane") as "active_any" | "directory_active" | "non_directory_active" | "follow_up" | undefined,
        taskIdPrefix: readFlag(rest, "--task-id-prefix"),
        promotedHostname: readFlag(rest, "--promoted-hostname"),
        promotedUrl: readFlag(rest, "--promoted-url"),
        requireCompleteProfile: readBooleanFlag(rest, "--require-complete-profile"),
        initGateMode: (readFlag(rest, "--init-gate-mode") as "interactive" | "unattended" | undefined) ?? "unattended",
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
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
