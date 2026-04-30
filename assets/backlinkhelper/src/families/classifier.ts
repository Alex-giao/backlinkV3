import type { FlowFamily, FlowFamilySource, TaskRecord } from "../shared/types.js";
import { resolveFlowFamily } from "./index.js";

export interface TargetFlowFamilyClassification {
  flowFamily: FlowFamily;
  source: FlowFamilySource;
  reason: string;
  correctedFromFamily?: FlowFamily;
}

export type TargetSurfaceIntakeState = "ready" | "needs_classification";
export type TargetSurfaceIntakeSource = FlowFamilySource | "unknown";

export interface TargetSurfaceIntakeClassification {
  state: TargetSurfaceIntakeState;
  flowFamily?: FlowFamily;
  source: TargetSurfaceIntakeSource;
  reason: string;
  correctedFromFamily?: FlowFamily;
}

const FORUM_HOST_PATTERN = /(?:^|[.-])(?:forum|forums|community|communities|discuss|discourse)(?:[.-]|$)/i;
const FORUM_CONTEXT_PATH_PATTERN = /(?:^|\/)(?:forum|forums|community|communities|discussion|discussions)(?:\/|$|[-_])/i;
const FORUM_THREAD_QUERY_KEYS = new Set(["thread", "topic", "tid", "t"]);
const FORUM_PROFILE_PATH_PATTERN = /(?:^|\/)(?:profile|profiles|member|members|user|users|u|account|settings)(?:\/|$|[-_])/i;
const FORUM_CONTENT_ROUTE_SEGMENTS = new Set(["topic", "discussion", "discussions", "post", "posts"]);
const FORUM_VIEW_ROUTE_SEGMENTS = new Set(["view", "show", "read"]);
const FORUM_SHORT_CONTENT_ROUTE_SEGMENTS = new Set(["t", "d"]);
const FORUM_CONTAINER_ROUTE_SEGMENTS = new Set(["forum", "forums", "community", "communities", "discussion", "discussions"]);
const EMBEDDED_FORUM_THREAD_ROUTE_PATTERN =
  /(?:^|\/)\b(?:viewtopic|showthread)\.php(?:[?#/]|$)|(?:^|\/)\b(?:d|t)\/\d+\/[^?#\s]+\/(?:discussion|discussions|discussione)\.aspx\b|(?:^|\/)\b(?:discussion|discussions|thread|threads|topic|topics)\/(?:view\/)?\d+(?:[-/.]|$)/i;
const RESERVED_FORUM_ROUTE_SEGMENTS = new Set([
  "new",
  "create",
  "latest",
  "popular",
  "all",
  "search",
  "categories",
  "category",
  "tags",
  "tag",
  "members",
  "member",
  "users",
  "user",
  "profile",
  "profiles",
  "login",
  "register",
]);
const ZENDESK_COMMUNITY_POST_PATH_PATTERN = /(?:^|\/)hc\/(?:[a-z]{2}(?:-[a-z0-9]{2,3})?\/)?community\/posts\/\d+(?:[-/]|$)/i;
const ZENDESK_HELP_CENTER_PATH_PATTERN = /(?:^|\/)hc\//i;
const ARTICLE_DATE_PATH_PATTERN = /(?:^|\/)\d{4}\/(?:\d{1,2}\/){0,2}[a-z0-9][a-z0-9-]+\/?$/i;
const ARTICLE_SLUG_STOP_SEGMENTS = new Set([
  "about",
  "account",
  "add",
  "advertise",
  "api",
  "apps",
  "blog",
  "category",
  "contact",
  "create",
  "directory",
  "docs",
  "features",
  "forum",
  "forums",
  "help",
  "home",
  "login",
  "pricing",
  "privacy",
  "product",
  "products",
  "profile",
  "register",
  "search",
  "signin",
  "signup",
  "submit",
  "tag",
  "terms",
  "tools",
  "user",
  "users",
]);

function parseTargetUrl(targetUrl: string): URL | undefined {
  try {
    return new URL(targetUrl);
  } catch {
    return undefined;
  }
}

function normalizedPathSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
}

function hasForumContext(parsed: URL): boolean {
  return FORUM_HOST_PATTERN.test(parsed.hostname) || FORUM_CONTEXT_PATH_PATTERN.test(parsed.pathname);
}

function hasForumContentId(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return /^\d+(?:$|[._-])/.test(normalized) || /(?:^|[._-])\d+$/.test(normalized);
}

function hasNumericForumThreadQuery(parsed: URL): boolean {
  if (!hasForumContext(parsed) && !/\b(?:viewtopic|showthread)\.php\b/i.test(parsed.pathname)) {
    return false;
  }

  for (const key of Array.from(FORUM_THREAD_QUERY_KEYS)) {
    const value = parsed.searchParams.get(key);
    if (value && hasForumContentId(value)) {
      return true;
    }
  }
  return false;
}

function isReservedForumRouteSegment(segment: string): boolean {
  return RESERVED_FORUM_ROUTE_SEGMENTS.has(segment);
}

function segmentAfter(segments: string[], segmentNames: Set<string>): string | undefined {
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segmentNames.has(segments[index])) {
      const next = segments[index + 1];
      if (next && !isReservedForumRouteSegment(next)) {
        return next;
      }
    }
  }
  return undefined;
}

function hasConcreteContentRouteAfter(segments: string[], segmentNames: Set<string>): boolean {
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (!segmentNames.has(segments[index])) {
      continue;
    }

    const nextSegments = segments.slice(index + 1, index + 3).filter((segment) => !isReservedForumRouteSegment(segment));
    if (nextSegments.some(hasForumContentId)) {
      return true;
    }
  }
  return false;
}

function hasForumPostViewRoute(segments: string[]): boolean {
  for (let index = 0; index < segments.length - 2; index += 1) {
    if (!FORUM_CONTENT_ROUTE_SEGMENTS.has(segments[index]) || !FORUM_VIEW_ROUTE_SEGMENTS.has(segments[index + 1])) {
      continue;
    }
    const slug = segments[index + 2];
    if (slug && !isReservedForumRouteSegment(slug)) {
      return true;
    }
  }
  return false;
}

function decodeUrlFragment(value: string): string {
  let decoded = value;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded.replace(/\+/g, " "));
      if (next === decoded) {
        break;
      }
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function hasEmbeddedForumThreadRoute(parsed: URL): boolean {
  const fragments = [parsed.search.slice(1), ...Array.from(parsed.searchParams.values())]
    .map(decodeUrlFragment)
    .filter(Boolean);
  return fragments.some((fragment) => EMBEDDED_FORUM_THREAD_ROUTE_PATTERN.test(fragment));
}

function isForumSlugLike(segment: string): boolean {
  if (hasForumContentId(segment)) {
    return true;
  }
  const slugParts = segment.split(/[-_]+/).filter(Boolean);
  return slugParts.length >= 2;
}

function hasNestedForumSlugRoute(segments: string[]): boolean {
  for (let index = 0; index < segments.length - 2; index += 1) {
    if (!FORUM_CONTAINER_ROUTE_SEGMENTS.has(segments[index])) {
      continue;
    }
    const category = segments[index + 1];
    const slug = segments[index + 2];
    if (!category || !slug || isReservedForumRouteSegment(category) || isReservedForumRouteSegment(slug)) {
      continue;
    }
    if (FORUM_CONTENT_ROUTE_SEGMENTS.has(category) || category === "topics" || category === "threads") {
      continue;
    }
    if (isForumSlugLike(slug)) {
      return true;
    }
  }
  return false;
}

export function isForumThreadTargetUrl(targetUrl: string): boolean {
  const parsed = parseTargetUrl(targetUrl);
  if (!parsed) {
    return false;
  }

  if (ZENDESK_COMMUNITY_POST_PATH_PATTERN.test(parsed.pathname)) {
    return true;
  }
  if (ZENDESK_HELP_CENTER_PATH_PATTERN.test(parsed.pathname)) {
    return false;
  }
  if (/\b(?:viewtopic|showthread)\.php\b/i.test(parsed.pathname)) {
    return true;
  }
  if (hasEmbeddedForumThreadRoute(parsed)) {
    return true;
  }
  if (FORUM_PROFILE_PATH_PATTERN.test(parsed.pathname)) {
    return false;
  }
  if (hasNumericForumThreadQuery(parsed)) {
    return true;
  }

  const segments = normalizedPathSegments(parsed.pathname);
  const threadSegment = segmentAfter(segments, new Set(["thread", "threads"]));
  if (threadSegment && (hasForumContext(parsed) || hasForumContentId(threadSegment))) {
    return true;
  }

  if (hasForumContext(parsed) && hasForumPostViewRoute(segments)) {
    return true;
  }
  if (hasForumContext(parsed) && hasNestedForumSlugRoute(segments)) {
    return true;
  }
  if (hasForumContext(parsed) && hasConcreteContentRouteAfter(segments, FORUM_CONTENT_ROUTE_SEGMENTS)) {
    return true;
  }
  if (hasForumContext(parsed) && hasConcreteContentRouteAfter(segments, FORUM_SHORT_CONTENT_ROUTE_SEGMENTS)) {
    return true;
  }

  // Topic/category routes are too noisy to auto-correct unless they carry a
  // concrete content id (numeric prefix/suffix, or a nearby id segment) under a
  // forum/discussion context. Keep /topics/marketing and /forum/ indexes in
  // their requested family rather than treating them as posts.
  return false;
}

export function isBlogCommentArticleTargetUrl(targetUrl: string): boolean {
  const parsed = parseTargetUrl(targetUrl);
  if (!parsed) {
    return false;
  }
  if (ZENDESK_HELP_CENTER_PATH_PATTERN.test(parsed.pathname)) {
    return false;
  }
  if (isForumThreadTargetUrl(targetUrl)) {
    return false;
  }

  const segments = normalizedPathSegments(parsed.pathname);
  if (segments.length === 0) {
    return false;
  }

  const lastSegment = segments[segments.length - 1];
  if (ARTICLE_SLUG_STOP_SEGMENTS.has(lastSegment)) {
    return false;
  }
  if (ARTICLE_DATE_PATH_PATTERN.test(parsed.pathname)) {
    return true;
  }

  const hyphenParts = lastSegment.split("-").filter(Boolean);
  const hasArticleLikeSlug = hyphenParts.length >= 4 || (/^\d+/.test(lastSegment) && hyphenParts.length >= 3);
  if (!hasArticleLikeSlug) {
    return false;
  }

  return !segments.some((segment) => ARTICLE_SLUG_STOP_SEGMENTS.has(segment) && segment !== "blog");
}

export function inferTargetFlowFamily(targetUrl: string): FlowFamily | undefined {
  if (isForumThreadTargetUrl(targetUrl)) {
    return "forum_post";
  }
  if (isBlogCommentArticleTargetUrl(targetUrl)) {
    return "wp_comment";
  }
  return undefined;
}

function describeInferredSurface(flowFamily: FlowFamily): string {
  if (flowFamily === "forum_post") {
    return "forum/thread surface";
  }
  if (flowFamily === "wp_comment") {
    return "article/comment surface";
  }
  return `${flowFamily} surface`;
}

export function classifyTargetFlowFamily(args: {
  targetUrl?: string;
  requestedFlowFamily?: FlowFamily;
}): TargetFlowFamilyClassification {
  const requested = args.requestedFlowFamily;
  const inferred = args.targetUrl ? inferTargetFlowFamily(args.targetUrl) : undefined;

  if (inferred) {
    const surfaceDescription = describeInferredSurface(inferred);
    if (requested && requested !== inferred) {
      return {
        flowFamily: inferred,
        source: "corrected",
        correctedFromFamily: requested,
        reason: `Target URL has a strong ${surfaceDescription} signal; corrected flow family from ${requested} to ${inferred}.`,
      };
    }
    return {
      flowFamily: inferred,
      source: requested ? "explicit" : "inferred",
      reason: requested
        ? `Flow family ${inferred} was supplied explicitly and matches the target ${surfaceDescription}.`
        : `Target URL has a strong ${surfaceDescription} signal; inferred flow family ${inferred}.`,
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

export function classifyTargetSurfaceForIntake(args: {
  targetUrl?: string;
  requestedFlowFamily?: FlowFamily;
}): TargetSurfaceIntakeClassification {
  const requested = args.requestedFlowFamily;
  if (requested) {
    const classification = classifyTargetFlowFamily({
      targetUrl: args.targetUrl,
      requestedFlowFamily: requested,
    });
    return {
      state: "ready",
      flowFamily: classification.flowFamily,
      source: classification.source,
      reason: classification.reason,
      correctedFromFamily: classification.correctedFromFamily,
    };
  }

  const inferred = args.targetUrl ? inferTargetFlowFamily(args.targetUrl) : undefined;
  if (inferred) {
    const surfaceDescription = describeInferredSurface(inferred);
    return {
      state: "ready",
      flowFamily: inferred,
      source: "inferred",
      reason: `Target URL has a strong ${surfaceDescription} signal; inferred flow family ${inferred}.`,
    };
  }

  return {
    state: "needs_classification",
    source: "unknown",
    reason: "No flow family hint or strong target surface signal was found; target needs classification before it can enter the active queue.",
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
