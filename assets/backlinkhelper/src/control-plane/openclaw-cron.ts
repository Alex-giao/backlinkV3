import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPO_ROOT = path.resolve(__dirname, "../..");
const MANAGED_DESCRIPTION_PREFIX = "Managed by Backliner Helper ensure-openclaw-cron";

export interface EnsureOpenClawCronArgs {
  name: string;
  every: string;
  cdpUrl: string;
  timeoutSeconds: number;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  owner: string;
  model?: string;
  deliver: boolean;
  channel?: string;
  to?: string;
  dryRun?: boolean;
}

interface CronJobRecord {
  id: string;
  name?: string;
  description?: string;
}

interface OpenClawCronListResponse {
  jobs: CronJobRecord[];
}

function runOpenClaw(args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync("openclaw", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    const detail = [result.stdout?.trim(), result.stderr?.trim()]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(detail || `openclaw ${args.join(" ")} failed with code ${result.status}.`);
  }

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function parseJsonFromOutput<T>(output: string): T {
  const firstBrace = output.indexOf("{");
  const firstBracket = output.indexOf("[");
  const starts = [firstBrace, firstBracket].filter((value) => value >= 0);
  if (starts.length === 0) {
    throw new Error(`Could not find JSON payload in output:\n${output}`);
  }

  const start = Math.min(...starts);
  const payload = output.slice(start).trim();
  return JSON.parse(payload) as T;
}

function getManagedDescription(args: EnsureOpenClawCronArgs): string {
  return `${MANAGED_DESCRIPTION_PREFIX} | repo=${REPO_ROOT} | cdp=${args.cdpUrl}`;
}

function buildCronMessage(args: EnsureOpenClawCronArgs): string {
  return [
    "Use the workspace skill `web-backlinker-v3-operator` and run exactly one bounded Backliner Helper queue tick.",
    "",
    `Repo root: ${REPO_ROOT}`,
    `Dedicated CDP browser: ${args.cdpUrl}`,
    `Claim owner: ${args.owner}`,
    "",
    "Execution rules:",
    "- Always run repo CLI commands from the repo root via `corepack pnpm ...`.",
    `- For repo commands that accept it, always pass \`--cdp-url ${args.cdpUrl}\`.`,
    "- Before driving browser-use CLI, verify the active browser window is not effectively minimized (for example, `window.innerWidth` and `window.innerHeight` should both be >= 100). If the shared 9224 browser is in a 1x1/tiny viewport state, stop immediately, treat the browser runtime as unhealthy, and do not continue blind.",
    "- When driving browser-use CLI, always use a task-scoped `--session` derived from the current task id; never use the implicit `default` session.",
    "- Follow the single-task contract from `web-backlinker-v3-operator`; never claim a second task in the same run.",
    "- If `claim-next-task` returns `idle` or `lease_held`, reply exactly `NO_REPLY`.",
    "- If the task ends in `DONE`, `WAITING_SITE_RESPONSE`, or `RETRYABLE` with a system-owned auto-resume wait, reply exactly `NO_REPLY`.",
    "- If `task-prepare` returns `task_stopped` or `replay_completed`, inspect the resulting task state; if it does not need human action, reply exactly `NO_REPLY`.",
    "- Only send a human-visible alert when a real blocker needs intervention, especially `WAITING_POLICY_DECISION`, `WAITING_MANUAL_AUTH`, `WAITING_MISSING_INPUT`, `WAITING_RETRY_DECISION`, repeated runtime failure, or an unexpected exception before task state is safely persisted.",
    "",
    "Alert format (only when intervention is needed):",
    "- First line: `backlinkhelper blocker`",
    "- Then up to 4 concise Chinese bullets covering: task_id, hostname, current status/wait_reason_code, and the exact next action.",
    "- Do not dump raw JSON, tool payloads, or shell logs.",
  ].join("\n");
}

function findManagedJob(jobs: CronJobRecord[], name: string): CronJobRecord | undefined {
  const directMatches = jobs.filter((job) => job.name === name);
  if (directMatches.length > 1) {
    throw new Error(`Found multiple OpenClaw cron jobs named ${name}. Please clean them up manually first.`);
  }
  if (directMatches.length === 1) {
    return directMatches[0];
  }

  const managedMatches = jobs.filter((job) => job.description?.startsWith(MANAGED_DESCRIPTION_PREFIX));
  if (managedMatches.length > 1) {
    throw new Error(`Found multiple managed Backliner Helper cron jobs. Please clean them up manually first.`);
  }
  return managedMatches[0];
}

function buildCommonCronArgs(args: EnsureOpenClawCronArgs, description: string, message: string): string[] {
  const cliArgs = [
    "--name",
    args.name,
    "--description",
    description,
    "--session",
    "isolated",
    "--every",
    args.every,
    "--message",
    message,
    "--thinking",
    args.thinking,
    "--timeout-seconds",
    String(args.timeoutSeconds),
    "--wake",
    "now",
  ];

  if (args.model) {
    cliArgs.push("--model", args.model);
  }

  if (args.deliver) {
    cliArgs.push("--announce");
    if (args.channel) {
      cliArgs.push("--channel", args.channel);
    }
    if (args.to) {
      cliArgs.push("--to", args.to);
    }
  } else {
    cliArgs.push("--no-deliver");
  }

  return cliArgs;
}

export async function ensureOpenClawCron(args: EnsureOpenClawCronArgs): Promise<{
  action: "add" | "update" | "dry-run";
  jobId?: string;
  name: string;
  every: string;
  cdpUrl: string;
  deliver: boolean;
}> {
  const description = getManagedDescription(args);
  const message = buildCronMessage(args);
  const listResponse = parseJsonFromOutput<OpenClawCronListResponse>(
    runOpenClaw(["cron", "list", "--all", "--json"]).stdout,
  );
  const existing = findManagedJob(listResponse.jobs ?? [], args.name);

  if (args.dryRun) {
    return {
      action: "dry-run",
      jobId: existing?.id,
      name: args.name,
      every: args.every,
      cdpUrl: args.cdpUrl,
      deliver: args.deliver,
    };
  }

  const commonArgs = buildCommonCronArgs(args, description, message);
  if (existing) {
    runOpenClaw(["cron", "edit", existing.id, ...commonArgs]);
    return {
      action: "update",
      jobId: existing.id,
      name: args.name,
      every: args.every,
      cdpUrl: args.cdpUrl,
      deliver: args.deliver,
    };
  }

  const addOutput = runOpenClaw(["cron", "add", ...commonArgs, "--json"]);
  const created = parseJsonFromOutput<{ job?: { id?: string }; id?: string }>(addOutput.stdout);
  return {
    action: "add",
    jobId: created.job?.id ?? created.id,
    name: args.name,
    every: args.every,
    cdpUrl: args.cdpUrl,
    deliver: args.deliver,
  };
}
