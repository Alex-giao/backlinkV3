import type { FlowFamily, FlowFamilySource, TaskRecord } from "../shared/types.js";
import { resolveFlowFamily } from "./index.js";

export interface TargetFlowFamilyClassification {
  flowFamily: FlowFamily;
  source: FlowFamilySource;
  reason: string;
  correctedFromFamily?: FlowFamily;
}

const FORUM_THREAD_PATH_PATTERN = /(?:^|\/)(?:forum|forums|thread|threads|topic|topics|discussion|discussions|viewtopic|showthread)(?:\/|$|[-_])/i;
const FORUM_THREAD_QUERY_KEYS = new Set(["thread", "topic", "tid", "t"]);
const FORUM_THREAD_QUERY_PATTERN = /(?:^|[?&])(?:thread|topic|tid|t)=\d+/i;
const FORUM_PROFILE_PATH_PATTERN = /(?:^|\/)(?:profile|profiles|member|members|user|users|u|account|settings)(?:\/|$|[-_])/i;

function parseTargetUrl(targetUrl: string): URL | undefined {
  try {
    return new URL(targetUrl);
  } catch {
    return undefined;
  }
}

export function isForumThreadTargetUrl(targetUrl: string): boolean {
  const parsed = parseTargetUrl(targetUrl);
  if (!parsed) {
    return false;
  }

  const evidenceText = `${parsed.hostname}${parsed.pathname}${parsed.search}`.toLowerCase();
  if (FORUM_THREAD_QUERY_PATTERN.test(parsed.search)) {
    return true;
  }
  for (const key of FORUM_THREAD_QUERY_KEYS) {
    if (parsed.searchParams.has(key)) {
      return true;
    }
  }
  if (/\b(?:viewtopic|showthread)\.php\b/i.test(parsed.pathname)) {
    return true;
  }
  if (FORUM_THREAD_PATH_PATTERN.test(parsed.pathname)) {
    return !FORUM_PROFILE_PATH_PATTERN.test(parsed.pathname);
  }
  return /(?:^|[./_-])(?:forum|forums)(?:[./_-]|$)/i.test(evidenceText) && /(?:^|[./?&=_-])(?:thread|topic)(?:[./?&=_-]|$)/i.test(evidenceText);
}

export function inferTargetFlowFamily(targetUrl: string): FlowFamily | undefined {
  if (isForumThreadTargetUrl(targetUrl)) {
    return "forum_post";
  }
  return undefined;
}

export function classifyTargetFlowFamily(args: {
  targetUrl?: string;
  requestedFlowFamily?: FlowFamily;
}): TargetFlowFamilyClassification {
  const requested = args.requestedFlowFamily;
  const inferred = args.targetUrl ? inferTargetFlowFamily(args.targetUrl) : undefined;

  if (inferred) {
    if (requested && requested !== inferred) {
      return {
        flowFamily: inferred,
        source: "corrected",
        correctedFromFamily: requested,
        reason: `Target URL has a strong forum/thread surface signal; corrected flow family from ${requested} to ${inferred}.`,
      };
    }
    return {
      flowFamily: inferred,
      source: requested ? "explicit" : "inferred",
      reason: requested
        ? `Flow family ${inferred} was supplied explicitly and matches the target forum/thread surface.`
        : `Target URL has a strong forum/thread surface signal; inferred flow family ${inferred}.`,
    };
  }

  const resolved = resolveFlowFamily(requested);
  return {
    flowFamily: resolved,
    source: requested ? "explicit" : "defaulted",
    reason: requested
      ? `Flow family ${resolved} was supplied explicitly.`
      : `No flow family was supplied and no stronger target URL signal was found; defaulted to ${resolved}.`,
  };
}

export function applyTargetFlowFamilyClassificationToTask(args: {
  task: TaskRecord;
  now?: string;
  reasonPrefix?: string;
}): boolean {
  const now = args.now ?? new Date().toISOString();
  const existingFamily = resolveFlowFamily(args.task.flow_family);
  const classification = classifyTargetFlowFamily({
    targetUrl: args.task.target_url,
    requestedFlowFamily: args.task.flow_family,
  });

  const shouldApply =
    classification.flowFamily !== existingFamily ||
    (!args.task.flow_family && classification.source === "inferred");
  if (!shouldApply) {
    return false;
  }

  args.task.flow_family = classification.flowFamily;
  args.task.flow_family_source = classification.source;
  args.task.flow_family_reason = args.reasonPrefix
    ? `${args.reasonPrefix}: ${classification.reason}`
    : classification.reason;
  args.task.flow_family_updated_at = now;
  if (classification.correctedFromFamily) {
    args.task.corrected_from_family = classification.correctedFromFamily;
  } else {
    delete args.task.corrected_from_family;
  }
  args.task.enqueued_by = args.task.enqueued_by ?? "prepare-reclassifier";
  args.task.notes.push(args.task.flow_family_reason);
  return true;
}
