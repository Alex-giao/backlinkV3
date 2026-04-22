import { verifyLinkCandidates } from "../execution/link-verifier.js";
import { getAccountForHostname } from "../memory/account-registry.js";
import {
  clearWorkerLeaseForTask,
  ensureDataDirectories,
  getArtifactFilePath,
  saveTask,
  writeJsonFile,
} from "../memory/data-store.js";
import { buildMailboxQuery, buildPlusAlias } from "../shared/email.js";
import { triageRecentUnreadEmails } from "../shared/gog.js";
import type { GogMessageCandidate } from "../shared/gog.js";
import type {
  EmailVerificationContinuation,
  LinkVerificationResult,
  TaskRecord,
  WaitMetadata,
  WorkerLease,
} from "../shared/types.js";
import { claimNextTask } from "./task-queue.js";

interface FollowUpEmailTriageResult {
  query_plans: Array<{ source: string; query: string }>;
  scanned_count: number;
  filtered_window_count: number;
  candidates: GogMessageCandidate[];
}

interface LightweightFetchedPage {
  finalUrl: string;
  httpStatus: number;
  html: string;
}

export interface LightweightFollowUpEvaluation {
  action: "restore_waiting" | "activate_ready" | "complete_done";
  detail: string;
  nextTargetUrl?: string;
  triage?: FollowUpEmailTriageResult;
  continuation?: EmailVerificationContinuation;
  linkVerification?: LinkVerificationResult;
}

const LIGHTWEIGHT_SITE_RESPONSE_REASON_CODES = new Set([
  "SITE_RESPONSE_PENDING",
  "PROFILE_PUBLICATION_PENDING",
  "COMMENT_MODERATION_PENDING",
  "ARTICLE_SUBMITTED_PENDING_EDITORIAL",
  "ARTICLE_PUBLICATION_PENDING",
]);

function dedupePush(target: string[], value: string): void {
  if (!target.includes(value)) {
    target.push(value);
  }
}

function updateTaskStatus(task: TaskRecord, status: TaskRecord["status"]): void {
  task.status = status;
  task.updated_at = new Date().toISOString();
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^www\./i, "").toLowerCase();
}

function parseHttpUrl(raw?: string): URL | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function matchesTaskHostname(rawUrl: string | undefined, taskHostname: string): boolean {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) {
    return false;
  }
  return normalizeHostname(parsed.hostname) === normalizeHostname(taskHostname);
}

function resolveFollowUpMailboxInputs(task: TaskRecord, account: Awaited<ReturnType<typeof getAccountForHostname>>): {
  mailboxQuery?: string;
  primaryEmail?: string;
  emailAlias?: string;
} {
  const primaryEmail = account?.email ?? task.submission.submitter_email;
  const emailAlias =
    account?.email_alias ??
    buildPlusAlias(task.submission.submitter_email, account?.hostname ?? task.hostname);

  return {
    mailboxQuery: emailAlias ? buildMailboxQuery(emailAlias) : undefined,
    primaryEmail,
    emailAlias,
  };
}

function resolveContinuationUrlCandidates(args: {
  task: TaskRecord;
  account: Awaited<ReturnType<typeof getAccountForHostname>>;
}): string[] {
  const candidates = [
    args.account?.submit_url,
    args.account?.login_url,
    args.task.recovered_target_url,
    args.task.target_url,
  ];
  return candidates.filter((candidate): candidate is string => matchesTaskHostname(candidate, args.task.hostname));
}

function buildEmailVerificationContinuation(args: {
  kind: EmailVerificationContinuation["kind"];
  candidate: GogMessageCandidate;
  detail: string;
  suggestedTargetUrl?: string;
}): EmailVerificationContinuation {
  return {
    kind: args.kind,
    verification_code: args.kind === "verification_code" ? args.candidate.verification_code : undefined,
    source_message_id: args.candidate.id,
    source_email: args.candidate.from,
    observed_at: args.candidate.date_iso ?? new Date().toISOString(),
    suggested_target_url: args.suggestedTargetUrl,
    detail: args.detail,
  };
}

function resolveLightweightSiteResponseUrl(task: TaskRecord): string | undefined {
  const candidates = [task.link_verification?.live_page_url, task.recovered_target_url, task.target_url];
  for (const candidate of candidates) {
    if (matchesTaskHostname(candidate, task.hostname)) {
      return candidate;
    }
  }
  return undefined;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ");
}

function stripHtmlTags(text: string): string {
  return decodeHtmlEntities(text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function readAnchorAttribute(attributes: string, name: string): string | undefined {
  const pattern = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = attributes.match(pattern);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value ? decodeHtmlEntities(value.trim()) : undefined;
}

function hasBooleanAnchorAttribute(attributes: string, name: string): boolean {
  const pattern = new RegExp(`(?:^|\\s)${name}(?:\\s|=|$)`, "i");
  return pattern.test(attributes);
}

function inferStaticAnchorVisibility(attributes: string): boolean {
  const style = readAnchorAttribute(attributes, "style") ?? "";
  const ariaHidden = readAnchorAttribute(attributes, "aria-hidden") ?? "false";
  if (hasBooleanAnchorAttribute(attributes, "hidden")) {
    return false;
  }
  if (/display\s*:\s*none/i.test(style)) {
    return false;
  }
  if (/visibility\s*:\s*hidden/i.test(style)) {
    return false;
  }
  if (/opacity\s*:\s*0(?:\.0+)?(?:\s*[;}]|$)/i.test(style)) {
    return false;
  }
  if (/^true$/i.test(ariaHidden)) {
    return false;
  }
  return true;
}

function extractLinkCandidatesFromHtml(args: {
  html: string;
  baseUrl: string;
}): Array<{ href: string; text?: string; rel?: string; isVisible: boolean }> {
  const candidates: Array<{ href: string; text?: string; rel?: string; isVisible: boolean }> = [];
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of args.html.matchAll(anchorPattern)) {
    const attributes = match[1] ?? "";
    const innerHtml = match[2] ?? "";
    const rawHref = readAnchorAttribute(attributes, "href");
    if (!rawHref) {
      continue;
    }

    let href: string;
    try {
      href = new URL(rawHref, args.baseUrl).toString();
    } catch {
      continue;
    }

    candidates.push({
      href,
      text: stripHtmlTags(innerHtml) || undefined,
      rel: readAnchorAttribute(attributes, "rel"),
      isVisible: inferStaticAnchorVisibility(attributes),
    });
  }
  return candidates;
}

async function fetchLightweightPageHtml(url: string): Promise<LightweightFetchedPage> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    redirect: "follow",
    headers: {
      "user-agent": "HermesBacklinkHelper/1.0 (+lightweight-follow-up)",
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
    },
  });

  return {
    finalUrl: response.url || url,
    httpStatus: response.status,
    html: await response.text(),
  };
}

export async function evaluateLightweightFollowUp(args: {
  task: TaskRecord;
  lease: WorkerLease;
  lookupAccount?: typeof getAccountForHostname;
  triageEmails?: typeof triageRecentUnreadEmails;
  fetchPageHtml?: (url: string) => Promise<LightweightFetchedPage>;
}): Promise<LightweightFollowUpEvaluation> {
  const previousStatus = args.lease.previous_status;
  const previousWait = args.lease.previous_wait;

  if (
    previousStatus === "WAITING_EXTERNAL_EVENT" &&
    previousWait?.wait_reason_code === "EMAIL_VERIFICATION_PENDING"
  ) {
    const lookupAccount = args.lookupAccount ?? getAccountForHostname;
    const triageEmails = args.triageEmails ?? triageRecentUnreadEmails;
    const account = await lookupAccount(args.task.account_ref ?? args.task.hostname);
    const mailboxInputs = resolveFollowUpMailboxInputs(args.task, account);
    const triage = await triageEmails({
      mailboxQuery: mailboxInputs.mailboxQuery,
      primaryEmail: mailboxInputs.primaryEmail,
      emailAlias: mailboxInputs.emailAlias,
      hostname: args.task.hostname,
    });

    const topCandidate = triage.candidates[0];
    if (topCandidate?.magic_link) {
      const detail = `Verification email yielded a magic link for ${args.task.hostname}; returning the task to the active lane.`;
      return {
        action: "activate_ready",
        detail,
        nextTargetUrl: topCandidate.magic_link,
        triage,
        continuation: buildEmailVerificationContinuation({
          kind: "magic_link",
          candidate: topCandidate,
          detail,
          suggestedTargetUrl: topCandidate.magic_link,
        }),
      };
    }

    if (topCandidate?.verification_code) {
      const continuationUrl = resolveContinuationUrlCandidates({
        task: args.task,
        account,
      })[0];
      const detail =
        `Verification email yielded a code-only continuation for ${args.task.hostname}; returning the task to the active lane.`;
      return {
        action: "activate_ready",
        detail,
        nextTargetUrl: continuationUrl,
        triage,
        continuation: buildEmailVerificationContinuation({
          kind: "verification_code",
          candidate: topCandidate,
          detail,
          suggestedTargetUrl: continuationUrl,
        }),
      };
    }

    return {
      action: "restore_waiting",
      detail: "No actionable verification email with a magic link was found during lightweight follow-up.",
      triage,
    };
  }

  if (
    previousStatus === "WAITING_SITE_RESPONSE" &&
    LIGHTWEIGHT_SITE_RESPONSE_REASON_CODES.has(previousWait?.wait_reason_code ?? "")
  ) {
    const checkUrl = resolveLightweightSiteResponseUrl(args.task);
    if (!checkUrl) {
      return {
        action: "restore_waiting",
        detail: "No lightweight public-page recheck URL is available yet for this waiting checkpoint.",
      };
    }

    const fetchPage = args.fetchPageHtml ?? fetchLightweightPageHtml;
    const page = await fetchPage(checkUrl);
    if (!matchesTaskHostname(page.finalUrl, args.task.hostname)) {
      return {
        action: "restore_waiting",
        detail: `Lightweight public-page recheck redirected outside the task host (${page.finalUrl}); leaving the task in waiting state.`,
      };
    }

    const linkVerification = verifyLinkCandidates({
      livePageUrl: page.finalUrl,
      targetUrl: args.task.submission.promoted_profile.url,
      candidates: extractLinkCandidatesFromHtml({
        html: page.html,
        baseUrl: page.finalUrl,
      }),
    });

    if (linkVerification.verification_status === "verified_link_present") {
      return {
        action: "complete_done",
        detail: `Lightweight public-page recheck verified the live backlink for ${args.task.hostname}; marking the task done.`,
        linkVerification,
      };
    }

    return {
      action: "restore_waiting",
      detail: `Lightweight public-page recheck inspected ${page.finalUrl} (HTTP ${page.httpStatus}) and the promoted backlink is still not visible; task remains waiting.`,
      linkVerification,
    };
  }

  return {
    action: "restore_waiting",
    detail: "No lightweight follow-up action exists yet for this waiting checkpoint.",
  };
}

export function applyLightweightFollowUpAction(args: {
  task: TaskRecord;
  lease: WorkerLease;
  evaluation: LightweightFollowUpEvaluation;
  artifactRef: string;
}): TaskRecord {
  const task: TaskRecord = {
    ...args.task,
    latest_artifacts: [...args.task.latest_artifacts],
    notes: [...args.task.notes],
  };
  dedupePush(task.latest_artifacts, args.artifactRef);
  task.lease_expires_at = undefined;
  task.updated_at = new Date().toISOString();
  task.last_takeover_outcome = args.evaluation.detail;

  if (args.evaluation.linkVerification) {
    task.link_verification = args.evaluation.linkVerification;
  }

  if (args.evaluation.action === "activate_ready") {
    if (args.evaluation.nextTargetUrl) {
      task.target_url = args.evaluation.nextTargetUrl;
      try {
        task.hostname = new URL(args.evaluation.nextTargetUrl).hostname;
      } catch {
        task.hostname = task.hostname;
      }
    }
    task.email_verification_continuation =
      args.evaluation.continuation?.kind === "verification_code"
        ? args.evaluation.continuation
        : undefined;
    task.wait = undefined;
    task.terminal_class = undefined;
    task.skip_reason_code = undefined;
    updateTaskStatus(task, "READY");
  } else if (args.evaluation.action === "complete_done") {
    task.email_verification_continuation = undefined;
    task.wait = undefined;
    task.terminal_class = undefined;
    task.skip_reason_code = undefined;
    updateTaskStatus(task, "DONE");
  } else {
    task.email_verification_continuation = undefined;
    task.wait = args.lease.previous_wait as WaitMetadata | undefined;
    task.terminal_class = args.lease.previous_terminal_class;
    task.skip_reason_code = args.lease.previous_skip_reason_code;
    updateTaskStatus(task, args.lease.previous_status ?? "WAITING_EXTERNAL_EVENT");
  }

  task.notes.push(args.evaluation.detail);
  return task;
}

export async function runFollowUpTick(args: {
  owner: string;
  taskIdPrefix?: string;
  promotedHostname?: string;
  promotedUrl?: string;
}): Promise<
  | { mode: "idle" | "lease_held"; reapedTaskId?: string; lease?: WorkerLease }
  | {
      mode: "restored_waiting" | "activated_ready" | "completed_done";
      reapedTaskId?: string;
      lease: WorkerLease;
      task: TaskRecord;
      artifact_ref: string;
      detail: string;
    }
> {
  await ensureDataDirectories();

  const claim = await claimNextTask({
    owner: args.owner,
    lane: "follow_up",
    scope: {
      taskIdPrefix: args.taskIdPrefix,
      promotedHostname: args.promotedHostname,
      promotedUrl: args.promotedUrl,
    },
  });

  if (claim.mode !== "claimed" || !claim.task || !claim.lease) {
    return {
      mode: claim.mode === "lease_held" ? "lease_held" : "idle",
      reapedTaskId: claim.reapedTaskId,
      lease: claim.lease,
    };
  }

  const artifactRef = getArtifactFilePath(claim.task.id, "follow-up");
  let evaluation: LightweightFollowUpEvaluation;
  try {
    evaluation = await evaluateLightweightFollowUp({
      task: claim.task,
      lease: claim.lease,
    });
  } catch (error) {
    evaluation = {
      action: "restore_waiting",
      detail:
        error instanceof Error
          ? `Lightweight follow-up failed and restored the waiting checkpoint: ${error.message}`
          : "Lightweight follow-up failed and restored the waiting checkpoint.",
    };
  }

  await writeJsonFile(artifactRef, {
    stage: "follow_up",
    task_id: claim.task.id,
    lane: claim.lease.lane,
    previous_status: claim.lease.previous_status,
    previous_wait: claim.lease.previous_wait,
    evaluation,
  });

  const updatedTask = applyLightweightFollowUpAction({
    task: claim.task,
    lease: claim.lease,
    evaluation,
    artifactRef,
  });
  await saveTask(updatedTask);
  await clearWorkerLeaseForTask(updatedTask.id);

  return {
    mode:
      evaluation.action === "activate_ready"
        ? "activated_ready"
        : evaluation.action === "complete_done"
          ? "completed_done"
          : "restored_waiting",
    reapedTaskId: claim.reapedTaskId,
    lease: claim.lease,
    task: updatedTask,
    artifact_ref: artifactRef,
    detail: evaluation.detail,
  };
}
