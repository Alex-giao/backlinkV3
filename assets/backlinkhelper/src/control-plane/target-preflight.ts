import { resolveFlowFamily } from "../families/index.js";
import type {
  FlowFamily,
  TargetPreflightAssessment,
  TargetPreflightSignal,
  TargetPreflightSignalKind,
  TaskRecord,
} from "../shared/types.js";

const FAST_FAIL_REASON_CODES = new Set([
  "STALE_SUBMIT_PATH",
  "DIRECTORY_NAVIGATION_FAILED",
  "DIRECTORY_UPSTREAM_5XX",
  "DIRECTORY_LOGIN_REQUIRED",
  "PAID_OR_SPONSORED_LISTING",
  "REQUIRED_INPUT_MISSING",
]);

const COMMERCIAL_BARRIER_PATTERN = /\b(pricing|checkout|subscribe|premium|sponsor|sponsored|advertis(?:e|ing)|payment|paywall|plan)\b/i;
const GENERIC_AUTH_PATTERN = /\b(login|sign[-_ ]?in|account|dashboard|admin)\b/i;
const DIRECTORY_SUBMIT_PATTERN = /\b(submit|add[-_ ]?listing|list[-_ ]?your|directory|startup|tool|product|community)\b/i;
const FORUM_PROFILE_PATTERN = /\b(profile|user|member|members|join|signup|sign[-_ ]?up|register|settings)\b/i;
const WP_COMMENT_PATTERN = /\b(article|post|blog|news|story|discussion|comment)\b/i;
const DEV_BLOG_PATTERN = /\b(new|write|editor|create|post|publish|submit|story)\b/i;
const CONTENT_PATH_PATTERN = /\b(blog|docs|article|post|story|news|guide|tutorial|comment)\b/i;

function compareByUpdatedAtDesc(left: TaskRecord, right: TaskRecord): number {
  return new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime();
}

function compareByCreatedAtDesc(left: TaskRecord, right: TaskRecord): number {
  return new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
}

function addSignal(
  signals: TargetPreflightSignal[],
  kind: TargetPreflightSignalKind,
  detail: string,
  scoreDelta: number,
): number {
  signals.push({ kind, detail, score_delta: scoreDelta });
  return scoreDelta;
}

function buildUrlEvidenceText(targetUrl: string): string {
  const parsed = new URL(targetUrl);
  return `${parsed.hostname}${parsed.pathname}${parsed.search}`;
}

function isHistoricalSuccess(task: TaskRecord): boolean {
  return task.status === "DONE";
}

function isHistoricalWaiting(task: TaskRecord): boolean {
  return task.status === "WAITING_SITE_RESPONSE" || task.status === "WAITING_EXTERNAL_EVENT";
}

function isHistoricalFastFail(task: TaskRecord): boolean {
  if (
    task.status === "SKIPPED" ||
    task.status === "WAITING_MANUAL_AUTH" ||
    task.status === "WAITING_POLICY_DECISION" ||
    task.status === "WAITING_MISSING_INPUT"
  ) {
    return true;
  }

  const reasonCode = task.wait?.wait_reason_code ?? task.skip_reason_code ?? "";
  return FAST_FAIL_REASON_CODES.has(reasonCode);
}

function scoreFamilyPath(args: {
  targetUrl: string;
  flowFamily?: FlowFamily;
}): TargetPreflightSignal[] {
  const signals: TargetPreflightSignal[] = [];
  const flowFamily = resolveFlowFamily(args.flowFamily);
  const evidenceText = buildUrlEvidenceText(args.targetUrl);
  const parsed = new URL(args.targetUrl);
  const pathDepth = parsed.pathname.split("/").filter(Boolean).length;

  switch (flowFamily) {
    case "saas_directory": {
      if (DIRECTORY_SUBMIT_PATTERN.test(evidenceText)) {
        addSignal(signals, "family_path_signal", "Directory-like URL/path suggests a public submit or listing surface.", 18);
      } else if (parsed.pathname === "/" || parsed.pathname === "") {
        addSignal(signals, "family_path_signal", "Root or homepage target is plausible for a directory scout entrypoint.", 8);
      }
      break;
    }
    case "forum_profile": {
      if (FORUM_PROFILE_PATTERN.test(evidenceText)) {
        addSignal(signals, "family_path_signal", "Profile/member/join path matches a forum-profile style target.", 16);
      }
      break;
    }
    case "wp_comment": {
      if (WP_COMMENT_PATTERN.test(evidenceText) || pathDepth >= 2) {
        addSignal(signals, "family_path_signal", "Article-like path depth looks compatible with comment-style submission surfaces.", 14);
      } else {
        addSignal(signals, "family_path_signal", "Homepage-like target is less informative for comment workflows and should be deprioritized.", -8);
      }
      break;
    }
    case "dev_blog": {
      if (DEV_BLOG_PATTERN.test(evidenceText)) {
        addSignal(signals, "family_path_signal", "Write/editor/create path matches a dev-blog publication surface.", 18);
      }
      break;
    }
  }

  return signals;
}

export function findExactHostDuplicateTasks(args: {
  tasks: TaskRecord[];
  promotedHostname: string;
  targetHostname: string;
  excludeTaskId?: string;
}): TaskRecord[] {
  return args.tasks
    .filter(
      (task) =>
        task.id !== args.excludeTaskId &&
        task.submission.promoted_profile.hostname === args.promotedHostname &&
        task.hostname === args.targetHostname,
    )
    .sort(compareByUpdatedAtDesc);
}

export function buildTargetPreflightAssessment(args: {
  targetUrl: string;
  promotedHostname: string;
  flowFamily?: FlowFamily;
  historicalTasks?: TaskRecord[];
  excludeTaskId?: string;
  now?: string;
}): TargetPreflightAssessment {
  const now = args.now ?? new Date().toISOString();
  const targetHostname = new URL(args.targetUrl).hostname;
  const evidenceText = buildUrlEvidenceText(args.targetUrl);
  const signals: TargetPreflightSignal[] = [];
  let score = 50;

  for (const signal of scoreFamilyPath({
    targetUrl: args.targetUrl,
    flowFamily: args.flowFamily,
  })) {
    signals.push(signal);
    score += signal.score_delta;
  }

  if (DIRECTORY_SUBMIT_PATTERN.test(evidenceText) || DEV_BLOG_PATTERN.test(evidenceText)) {
    score += addSignal(signals, "positive_submit_signal", "URL contains explicit submit/create keywords that usually justify an early scout.", 10);
  }

  const resolvedFamily = resolveFlowFamily(args.flowFamily);
  if (GENERIC_AUTH_PATTERN.test(evidenceText) && resolvedFamily !== "forum_profile") {
    score += addSignal(signals, "auth_surface_signal", "URL looks auth-heavy; it may still work, but it is a weaker first candidate for the active slot.", -12);
  }

  if (CONTENT_PATH_PATTERN.test(evidenceText) && resolvedFamily === "saas_directory") {
    score += addSignal(signals, "content_surface_signal", "Content-heavy URL is less likely to be the shortest path for a directory-style submission.", -8);
  }

  if (COMMERCIAL_BARRIER_PATTERN.test(evidenceText)) {
    score += addSignal(signals, "commercial_barrier_signal", "URL hints at pricing/sponsorship/paywall surfaces that often end as policy or payment blockers.", -18);
  }

  const historicalTasks = findExactHostDuplicateTasks({
    tasks: args.historicalTasks ?? [],
    promotedHostname: args.promotedHostname,
    targetHostname,
    excludeTaskId: args.excludeTaskId,
  }).sort(compareByCreatedAtDesc);
  const historicalSuccessCount = historicalTasks.filter(isHistoricalSuccess).length;
  const historicalFastFailCount = historicalTasks.filter(isHistoricalFastFail).length;
  const historicalWaitingCount = historicalTasks.filter(isHistoricalWaiting).length;

  if (historicalSuccessCount > 0) {
    score += addSignal(
      signals,
      "historical_success_signal",
      `This exact host already produced ${historicalSuccessCount} successful task(s) for the same promoted profile.`,
      Math.min(16, historicalSuccessCount * 8),
    );
  }

  if (historicalFastFailCount > 0) {
    score += addSignal(
      signals,
      "historical_fast_fail_signal",
      `This exact host already produced ${historicalFastFailCount} fast-fail / terminal-negative task(s).`,
      -Math.min(20, historicalFastFailCount * 6),
    );
  }

  if (historicalWaitingCount > 0) {
    score += addSignal(
      signals,
      "historical_waiting_signal",
      `This exact host already has ${historicalWaitingCount} waiting task(s); prefer reusing them over opening a fresh queue slot.`,
      -Math.min(12, historicalWaitingCount * 4),
    );
  }

  const clampedScore = Math.max(0, Math.min(100, score));
  const viability = clampedScore >= 60 ? "promising" : clampedScore >= 40 ? "unclear" : "deprioritized";

  return {
    version: 1,
    assessed_at: now,
    promoted_hostname: args.promotedHostname,
    exact_target_hostname: targetHostname,
    queue_priority_score: clampedScore,
    viability,
    historical_exact_host_hits: historicalTasks.length,
    historical_success_count: historicalSuccessCount,
    historical_fast_fail_count: historicalFastFailCount,
    historical_waiting_count: historicalWaitingCount,
    signals,
  };
}
