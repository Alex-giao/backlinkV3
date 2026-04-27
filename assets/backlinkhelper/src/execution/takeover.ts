import path from "node:path";

import { resolveAgentBackendConfig } from "../agent/decider.js";
import { getFamilyConfig } from "../families/index.js";
import {
  clickBrowserUseElement,
  getBrowserUseSnapshot,
  inputBrowserUseElement,
  openBrowserUseUrl,
  saveBrowserUseScreenshot,
  selectBrowserUseElement,
  sendBrowserUseKeys,
  settleBrowserUsePage,
  waitForBrowserUseSelector,
  waitForBrowserUseText,
} from "./browser-use-cli.js";
import { runVisualRecoveryHint, runVisualVerification } from "./visual-verify.js";
import { verifyLinkOnPage } from "./link-verifier.js";
import { attemptCapsolverContinuation, type CapsolverAttemptRecord } from "./capsolver.js";
import {
  DATA_DIRECTORIES,
  getArtifactFilePath,
  writeJsonFile,
} from "../memory/data-store.js";
import { extractMissingInputFields } from "../shared/missing-inputs.js";
import { AGENT_LOOP_RUNTIME_BUDGET_MS } from "../shared/runtime-budgets.js";
import { inferPageAssessment } from "../shared/page-assessment.js";
import { withConnectedPage } from "../shared/playwright-session.js";
import type {
  AgentDecision,
  AgentDecisionAction,
  AgentDecisionInput,
  AgentLoopTrace,
  AgentLoopTraceStep,
  AgentObservation,
  AgentObservationElement,
  BrowserRuntime,
  LinkVerificationResult,
  ReplayStep,
  ScoutResult,
  TakeoverResult,
  TaskRecord,
  TerminalClass,
  TrajectoryPlaybook,
  WaitMetadata,
  PageAssessment,
  VisualRecoveryHint,
} from "../shared/types.js";

export interface ProposedOutcome {
  next_status: TakeoverResult["next_status"];
  detail: string;
  wait?: WaitMetadata;
  terminal_class?: TerminalClass;
  skip_reason_code?: string;
}

export interface TakeoverHandoff {
  detail: string;
  artifact_refs: string[];
  current_url: string;
  browser_use_session?: string;
  recorded_steps: ReplayStep[];
  agent_trace_ref: string;
  agent_backend: string;
  agent_steps_count: number;
  proposed_outcome?: ProposedOutcome;
  visual_verification?: import("../shared/types.js").VisualVerificationResult;
  vision_recovery_attempts?: Array<Record<string, unknown>>;
  pending_account?: import("../shared/types.js").AccountDraft;
}

export interface AgentLoopResult {
  handoff?: TakeoverHandoff;
  takeover_result?: TakeoverResult;
}

export const UNATTENDED_POLICY = {
  allow_paid_listing: false,
  allow_reciprocal: false,
  allow_captcha_bypass: true,
  allow_google_oauth_chooser: true,
  allow_password_login: false,
  allow_public_signup: true,
  allow_2fa: false,
} as const;

const AGENT_LOOP_MAX_DURATION_MS = AGENT_LOOP_RUNTIME_BUDGET_MS;
const AGENT_LOOP_MAX_ACTIONS = 120;
const MAX_REPEATED_SURFACE_COUNT = 4;
const MAX_REPEATED_ACTION_COUNT = 3;
const MAX_NO_PROGRESS_STREAK = 12;
const MAX_STATE_ELEMENTS = 120;
const FINALIZATION_POST_CLICK_PROBE_COUNT = 2;
const FINALIZATION_POST_CLICK_PROBE_WAIT_MS = 700;
const MAX_NOVEL_VISION_RECOVERY_ATTEMPTS = 2;

interface StopBoundaryContext {
  goal: string;
  failureReason: string;
  detail: string;
}

interface VisionRecoveryAttempt extends Record<string, unknown> {
  goal: string;
  failure_reason: string;
  surface_signature: string;
  url: string;
  screenshot_path: string;
  summary: string;
  target_text_candidates: string[];
  matched_text?: string;
  matched_index?: number;
  recovery_possible: boolean;
  applied: boolean;
  confidence?: number;
  model?: string;
}

interface FinalizationPageStateSample {
  currentUrl: string;
  title: string;
  bodyText: string;
  visibleSurfaceText: string;
  hasVisibleOverlaySurface: boolean;
  surfaceFingerprint: string;
}

interface FinalizationPageContextValidation {
  ok: boolean;
  expected_hostname: string;
  actual_hostname?: string;
  detail?: string;
}

function normalizeComparableHostname(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return value.replace(/^www\./i, "").toLowerCase();
  }
}

export function validateFinalizationPageContext(args: {
  currentUrl?: string;
  handoffUrl?: string;
  taskHostname: string;
}): FinalizationPageContextValidation {
  const expectedHostname =
    normalizeComparableHostname(args.handoffUrl) ?? normalizeComparableHostname(args.taskHostname) ?? args.taskHostname;
  const actualHostname = normalizeComparableHostname(args.currentUrl);

  if (!actualHostname) {
    return {
      ok: false,
      expected_hostname: expectedHostname,
      detail:
        `Finalization could not confirm the active page URL for ${expectedHostname}. Refusing to persist verification evidence without a bound page context.`,
    };
  }

  if (actualHostname === expectedHostname) {
    return {
      ok: true,
      expected_hostname: expectedHostname,
      actual_hostname: actualHostname,
    };
  }

  return {
    ok: false,
    expected_hostname: expectedHostname,
    actual_hostname: actualHostname,
    detail:
      `Finalization inspected ${actualHostname}, but this task is bound to ${expectedHostname}. Refusing to persist cross-host verification evidence.`,
  };
}

type EarlyTerminalHypothesis =
  | "success_submitted"
  | "email_verification_pending_but_submitted"
  | "captcha_blocked"
  | "paid_or_sponsored"
  | "manual_auth_required"
  | "missing_input"
  | "reciprocal_backlink_required"
  | "stale_submit_path_but_recoverable"
  | "unknown";

type EarlyTerminalBusinessOutcome =
  | "submitted_success"
  | "blocked_missing_input"
  | "blocked_manual_auth"
  | "blocked_policy"
  | "unknown_needs_review";

export interface EarlyTerminalClassification {
  hypothesis: EarlyTerminalHypothesis;
  confidence: number;
  supporting_signals: string[];
  contradicting_signals: string[];
  evidence_sufficiency: "sufficient" | "insufficient";
  recommended_state: ProposedOutcome["next_status"];
  recommended_business_outcome: EarlyTerminalBusinessOutcome;
  allow_rerun: boolean;
  outcome: ProposedOutcome;
}

function inferWait(
  code: string,
  resolutionOwner: WaitMetadata["resolution_owner"],
  resolutionMode: WaitMetadata["resolution_mode"],
  resumeTrigger: string,
  evidenceRef: string,
): WaitMetadata {
  return {
    wait_reason_code: code,
    resume_trigger: resumeTrigger,
    resolution_owner: resolutionOwner,
    resolution_mode: resolutionMode,
    evidence_ref: evidenceRef,
  };
}

function inferTerminalAuditWait(
  code: string,
  evidenceRef: string,
  summary: string,
): WaitMetadata {
  return inferWait(
    code,
    "none",
    "terminal_audit",
    `Terminal audit only. ${summary}`,
    evidenceRef,
  );
}

function inferAutoResumeWait(
  code: string,
  owner: WaitMetadata["resolution_owner"],
  resumeTrigger: string,
  evidenceRef: string,
): WaitMetadata {
  return inferWait(code, owner, "auto_resume", resumeTrigger, evidenceRef);
}

function buildPaidListingSkipOutcome(evidenceRef: string): ProposedOutcome {
  return {
    next_status: "SKIPPED",
    detail:
      "Directory requires a paid or sponsored listing and was skipped by the default unpaid submission policy.",
    terminal_class: "paid_listing",
    skip_reason_code: "paid_or_sponsored_listing",
  };
}

function buildCaptchaSkipOutcome(evidenceRef: string): ProposedOutcome {
  return {
    next_status: "SKIPPED",
    detail:
      "Directory requires CAPTCHA or managed human verification and was skipped by the unattended policy.",
    terminal_class: "captcha_blocked",
    skip_reason_code: "captcha_or_human_verification_required",
  };
}

function buildManualAuthOutcome(evidenceRef: string, detail?: string): ProposedOutcome {
  return {
    next_status: "WAITING_MANUAL_AUTH",
    detail:
      detail ?? "Directory requires unsupported authentication for unattended mode and was classified as a terminal audit state.",
    wait: inferTerminalAuditWait(
      "DIRECTORY_LOGIN_REQUIRED",
      evidenceRef,
      "Password, 2FA, suspicious-login, or unsupported auth flows are not resumed automatically.",
    ),
    terminal_class: "login_required",
  };
}

function buildSiteResponseOutcome(evidenceRef: string, detail?: string): ProposedOutcome {
  return {
    next_status: "WAITING_SITE_RESPONSE",
    detail: detail ?? "Submission appears to be accepted and waiting for directory review.",
    wait: inferAutoResumeWait(
      "SITE_RESPONSE_PENDING",
      "system",
      "Keep polling or reporting until the directory publishes a final review outcome.",
      evidenceRef,
    ),
  };
}

function buildMissingInputOutcome(args: {
  evidenceRef: string;
  missingFields: WaitMetadata["missing_fields"];
  detail?: string;
}): ProposedOutcome {
  const labels = args.missingFields?.map((field) => field.label).filter(Boolean) ?? [];
  const detail =
    args.detail ??
    (labels.length > 0
      ? `Directory requires real submission inputs that are still missing: ${labels.join(", ")}.`
      : "Directory requires real submission inputs that are still missing.");

  return {
    next_status: "WAITING_MISSING_INPUT",
    detail,
    wait: {
      wait_reason_code: "REQUIRED_INPUT_MISSING",
      resume_trigger: detail,
      resolution_owner: "none",
      resolution_mode: "terminal_audit",
      evidence_ref: args.evidenceRef,
      missing_fields: args.missingFields,
    },
  };
}

function buildPolicyWaitOutcome(args: {
  waitReasonCode: string;
  evidenceRef: string;
  detail: string;
}): ProposedOutcome {
  return {
    next_status: "WAITING_POLICY_DECISION",
    detail: args.detail,
    wait: inferTerminalAuditWait(args.waitReasonCode, args.evidenceRef, args.detail),
  };
}

function buildAmbiguousReachableRetryOutcome(
  waitReasonCode: string,
  detail: string,
  evidenceRef: string,
): ProposedOutcome {
  return {
    next_status: "RETRYABLE",
    detail,
    wait: inferAutoResumeWait(waitReasonCode, "system", detail, evidenceRef),
    terminal_class: "outcome_not_confirmed",
  };
}

function containsConfiguredSignal(text: string, signals?: readonly string[]): boolean {
  if (!signals || signals.length === 0) {
    return false;
  }
  const normalized = text.toLowerCase();
  return signals.some((signal) => normalized.includes(signal.toLowerCase()));
}

function buildFamilyWaitingOutcome(args: {
  waitReasonCode: string;
  detail: string;
  resumeTrigger: string;
  evidenceRef: string;
}): ProposedOutcome {
  return {
    next_status: "WAITING_SITE_RESPONSE",
    detail: args.detail,
    wait: inferAutoResumeWait(args.waitReasonCode, "system", args.resumeTrigger, args.evidenceRef),
  };
}

function buildFamilyRetryAuditOutcome(args: {
  waitReasonCode: string;
  detail: string;
  evidenceRef: string;
}): ProposedOutcome {
  return {
    next_status: "WAITING_RETRY_DECISION",
    detail: args.detail,
    wait: inferTerminalAuditWait(args.waitReasonCode, args.evidenceRef, args.detail),
    terminal_class: "outcome_not_confirmed",
  };
}

function buildFamilyProgressRetryOutcome(args: {
  waitReasonCode: string;
  detail: string;
  resumeTrigger: string;
  evidenceRef: string;
}): ProposedOutcome {
  return {
    next_status: "RETRYABLE",
    detail: args.detail,
    wait: inferAutoResumeWait(args.waitReasonCode, "system", args.resumeTrigger, args.evidenceRef),
    terminal_class: "outcome_not_confirmed",
  };
}

function buildVerifiedLiveLinkDoneOutcome(args: {
  flowFamily?: TaskRecord["flow_family"];
  detail: string;
}): ProposedOutcome {
  const family = args.flowFamily ?? "saas_directory";
  const familyLabel = family === "forum_profile"
    ? "Public forum profile"
    : family === "wp_comment"
      ? "Public comment"
      : family === "dev_blog"
        ? "Published article"
        : "Submission";
  return {
    next_status: "DONE",
    detail: `${familyLabel} is live and the promoted backlink was verified. ${args.detail}`.trim(),
  };
}

export function applyFamilySpecificOutcomeGuard(args: {
  outcome: ProposedOutcome;
  flowFamily?: TaskRecord["flow_family"];
  bodyText: string;
  evidenceRef: string;
  linkVerification?: LinkVerificationResult;
}): ProposedOutcome {
  const flowFamily = args.flowFamily ?? "saas_directory";
  if (flowFamily === "saas_directory") {
    return args.outcome;
  }

  if (args.linkVerification?.verification_status === "verified_link_present") {
    return buildVerifiedLiveLinkDoneOutcome({
      flowFamily,
      detail: args.linkVerification.detail,
    });
  }

  const waitReasonCode = args.outcome.wait?.wait_reason_code;
  if (flowFamily === "forum_profile") {
    if (waitReasonCode === "PROFILE_PUBLICATION_PENDING") {
      return buildFamilyWaitingOutcome({
        waitReasonCode: "PROFILE_PUBLICATION_PENDING",
        detail: "Profile changes were saved, but the public profile backlink is not yet verified live.",
        resumeTrigger: "Re-check the public profile page until the backlink is visible and verified.",
        evidenceRef: args.evidenceRef,
      });
    }
    return args.outcome;
  }

  if (flowFamily === "wp_comment") {
    if (waitReasonCode === "COMMENT_ANTI_SPAM_BLOCKED") {
      return buildPolicyWaitOutcome({
        waitReasonCode: "COMMENT_ANTI_SPAM_BLOCKED",
        evidenceRef: args.evidenceRef,
        detail: "Comment submission hit an anti-spam or server-side moderation barrier and needs review instead of generic retry churn.",
      });
    }
    if (waitReasonCode === "COMMENT_PUBLISHED_NO_LINK") {
      return buildFamilyRetryAuditOutcome({
        waitReasonCode: "COMMENT_PUBLISHED_NO_LINK",
        detail: "The public comment appears live, but the promoted backlink is missing or hidden on the live thread.",
        evidenceRef: args.evidenceRef,
      });
    }
    if (waitReasonCode === "COMMENT_MODERATION_PENDING") {
      return buildFamilyWaitingOutcome({
        waitReasonCode: "COMMENT_MODERATION_PENDING",
        detail: "Comment was accepted but is still awaiting public visibility; do not count it as success until the live comment and backlink are verified.",
        resumeTrigger: "Re-check the public thread until the comment and backlink are live.",
        evidenceRef: args.evidenceRef,
      });
    }
    return args.outcome;
  }

  if (flowFamily === "dev_blog") {
    if (waitReasonCode === "ARTICLE_DRAFT_SAVED") {
      return buildFamilyProgressRetryOutcome({
        waitReasonCode: "ARTICLE_DRAFT_SAVED",
        detail: "Article draft was saved, but the post has not been submitted for review or published yet.",
        resumeTrigger: "Continue from the saved draft in a later automation pass.",
        evidenceRef: args.evidenceRef,
      });
    }
    if (waitReasonCode === "ARTICLE_SUBMITTED_PENDING_EDITORIAL") {
      return buildFamilyWaitingOutcome({
        waitReasonCode: "ARTICLE_SUBMITTED_PENDING_EDITORIAL",
        detail: "Article was submitted for review and is waiting for editorial publication; success still requires a live verified backlink.",
        resumeTrigger: "Re-check the article until it is published publicly and the backlink is verified.",
        evidenceRef: args.evidenceRef,
      });
    }
    if (waitReasonCode === "ARTICLE_PUBLICATION_PENDING" || waitReasonCode === "ARTICLE_PUBLISHED_NO_LINK") {
      return buildFamilyRetryAuditOutcome({
        waitReasonCode: "ARTICLE_PUBLISHED_NO_LINK",
        detail: "Published article is live, but the promoted backlink is missing or hidden on the public post.",
        evidenceRef: args.evidenceRef,
      });
    }
  }

  return args.outcome;
}

function looksLikePaidGate(bodyText: string): boolean {
  return [
    /\bpaid (?:listing|submission|review|placement|plan)\b/i,
    /\b(?:featured|sponsored) (?:listing|placement|submission|review)\b/i,
    /\bone-time payment\b/i,
    /\bsubmit pay\b/i,
    /\bupgrade listing\b/i,
    /\b(?:checkout|payment|pay now|stripe)\b[\s\S]{0,60}\b(?:listing|submission|review|featured|sponsored)\b/i,
    /\bpricing\b[\s\S]{0,80}\b(?:listing|submission|review|featured|sponsored|directory)\b/i,
    /\$\s?\d[\s\S]{0,40}\b(?:listing|submission|review|featured|sponsored|plan)\b/i,
  ].some((pattern) => pattern.test(bodyText));
}

function looksLikeReciprocalRequirement(bodyText: string): boolean {
  return [
    /\breciprocal backlink\b/i,
    /\badd our backlink\b/i,
    /\badd our link\b/i,
    /\blink back to us\b/i,
    /\blive reciprocal backlink url\b/i,
    /\bplace (?:our )?link on your site\b/i,
  ].some((pattern) => pattern.test(bodyText));
}

function hasExplicitMissingInputSignal(bodyText: string): boolean {
  return [
    /\bmissing required fields?\b/i,
    /\brequired fields?\s*:/i,
    /\bplease complete all required fields\b/i,
    /\bplease (?:enter|provide|fill in|complete)\b[\s\S]{0,80}\b(?:before submitting|required)\b/i,
    /\bthis field is required\b/i,
  ].some((pattern) => pattern.test(bodyText));
}

function buildEarlyTerminalClassification(args: {
  hypothesis: EarlyTerminalHypothesis;
  confidence: number;
  supportingSignals: string[];
  evidenceSufficiency: "sufficient" | "insufficient";
  recommendedBusinessOutcome: EarlyTerminalBusinessOutcome;
  allowRerun: boolean;
  outcome: ProposedOutcome;
  contradictingSignals?: string[];
}): EarlyTerminalClassification {
  return {
    hypothesis: args.hypothesis,
    confidence: args.confidence,
    supporting_signals: [...new Set(args.supportingSignals)],
    contradicting_signals: [...new Set(args.contradictingSignals ?? [])],
    evidence_sufficiency: args.evidenceSufficiency,
    recommended_state: args.outcome.next_status,
    recommended_business_outcome: args.recommendedBusinessOutcome,
    allow_rerun: args.allowRerun,
    outcome: args.outcome,
  };
}

function describeVisualVerification(
  visual: import("../shared/types.js").VisualVerificationResult,
): string {
  const modelPart = visual.model ? ` model=${visual.model};` : "";
  return `Visual verification${modelPart} confidence=${visual.confidence.toFixed(2)} classified the reachable page as ${visual.classification}: ${visual.summary}`;
}

function isAllowedGoogleOauthTransition(bodyText: string, currentUrl: string): boolean {
  const normalized = bodyText.toLowerCase();
  return (
    UNATTENDED_POLICY.allow_google_oauth_chooser &&
    (currentUrl.includes("accounts.google.com") ||
      normalized.includes("continue with google") ||
      normalized.includes("login with google") ||
      normalized.includes("sign in with google"))
  );
}

export function classifyEarlyTerminalOutcome(args: {
  currentUrl: string;
  title?: string;
  bodyText: string;
  evidenceRef: string;
  flowFamily?: TaskRecord["flow_family"];
}): EarlyTerminalClassification {
  const normalized = args.bodyText.toLowerCase();
  const boundaryCorpus = `${args.currentUrl} ${args.title ?? ""}`.toLowerCase();
  const familyConfig = getFamilyConfig(args.flowFamily);
  const containsAny = (needles: readonly string[]) => needles.some((needle) => normalized.includes(needle));
  const boundaryHasAny = (needles: readonly string[]) => needles.some((needle) => boundaryCorpus.includes(needle.toLowerCase()));
  const isForumProfileSurface = boundaryHasAny(["profile", "member", "account", "settings"]);
  const isCommentSurface = boundaryHasAny(["comment", "reply", "#comment", "comments"]);
  const isDevBlogEditorSurface = boundaryHasAny(["write post", "new post", "editor", "/new", "draft", "publish", "review"]);
  const pageAssessment = inferPageAssessment({
    url: args.currentUrl,
    title: args.title,
    bodyText: args.bodyText,
    postClickStateUnclear: true,
    flowFamily: args.flowFamily,
  });

  if (looksLikePaidGate(args.bodyText)) {
    if (!UNATTENDED_POLICY.allow_paid_listing) {
      return buildEarlyTerminalClassification({
        hypothesis: "paid_or_sponsored",
        confidence: 0.98,
        supportingSignals: ["paid_gate_terms"],
        evidenceSufficiency: "sufficient",
        recommendedBusinessOutcome: "blocked_policy",
        allowRerun: false,
        outcome: buildPaidListingSkipOutcome(args.evidenceRef),
      });
    }

    return buildEarlyTerminalClassification({
      hypothesis: "paid_or_sponsored",
      confidence: 0.98,
      supportingSignals: ["paid_gate_terms"],
      evidenceSufficiency: "sufficient",
      recommendedBusinessOutcome: "blocked_policy",
      allowRerun: false,
      outcome: {
        next_status: "WAITING_POLICY_DECISION",
        detail: "Directory reached a paid or sponsored listing flow and was classified as a terminal audit state.",
        wait: inferTerminalAuditWait(
          "PAID_OR_SPONSORED_LISTING",
          args.evidenceRef,
          "Payment and sponsorship decisions are reported for audit, not resumed automatically.",
        ),
        terminal_class: "paid_listing",
      },
    });
  }

  if (
    normalized.includes("captcha") ||
    normalized.includes("loading captcha") ||
    normalized.includes("i'm not a robot") ||
    normalized.includes("verify you are human")
  ) {
    if (!UNATTENDED_POLICY.allow_captcha_bypass) {
      return buildEarlyTerminalClassification({
        hypothesis: "captcha_blocked",
        confidence: 0.98,
        supportingSignals: ["captcha_terms"],
        evidenceSufficiency: "sufficient",
        recommendedBusinessOutcome: "blocked_policy",
        allowRerun: false,
        outcome: buildCaptchaSkipOutcome(args.evidenceRef),
      });
    }

    return buildEarlyTerminalClassification({
      hypothesis: "captcha_blocked",
      confidence: 0.98,
      supportingSignals: ["captcha_terms"],
      evidenceSufficiency: "sufficient",
      recommendedBusinessOutcome: "blocked_policy",
      allowRerun: false,
      outcome: {
        next_status: "WAITING_POLICY_DECISION",
        detail: "Submission hit CAPTCHA or managed bot verification and was classified as a terminal audit state.",
        wait: inferTerminalAuditWait(
          "CAPTCHA_BLOCKED",
          args.evidenceRef,
          "CAPTCHA and managed anti-bot gates are not resumed automatically.",
        ),
        terminal_class: "captcha_blocked",
      },
    });
  }

  if (looksLikeReciprocalRequirement(args.bodyText)) {
    return buildEarlyTerminalClassification({
      hypothesis: "reciprocal_backlink_required",
      confidence: 0.96,
      supportingSignals: ["reciprocal_backlink_requirement"],
      evidenceSufficiency: "sufficient",
      recommendedBusinessOutcome: "blocked_policy",
      allowRerun: false,
      outcome: buildPolicyWaitOutcome({
        waitReasonCode: "RECIPROCAL_BACKLINK_REQUIRED",
        evidenceRef: args.evidenceRef,
        detail:
          "Directory requires a reciprocal backlink or live backlink URL before it will accept the listing.",
      }),
    });
  }

  const missingFields = extractMissingInputFields([args.title, args.bodyText]);
  if (missingFields.length > 0 && hasExplicitMissingInputSignal(args.bodyText)) {
    return buildEarlyTerminalClassification({
      hypothesis: "missing_input",
      confidence: 0.94,
      supportingSignals: ["explicit_missing_required_fields", ...missingFields.map((field) => `missing_field:${field.key}`)],
      evidenceSufficiency: "sufficient",
      recommendedBusinessOutcome: "blocked_missing_input",
      allowRerun: false,
      outcome: buildMissingInputOutcome({
        evidenceRef: args.evidenceRef,
        missingFields,
      }),
    });
  }

  if (
    pageAssessment.page_reachable &&
    pageAssessment.ambiguity_flags.includes("not_found_but_reachable") &&
    (pageAssessment.ambiguity_flags.includes("mixed_submit_and_auth_signals") ||
      pageAssessment.ambiguity_flags.includes("no_visible_form_but_possible_entry"))
  ) {
    return buildEarlyTerminalClassification({
      hypothesis: "stale_submit_path_but_recoverable",
      confidence: 0.8,
      supportingSignals: ["reachable_soft_404", "recoverable_submit_path"],
      evidenceSufficiency: "insufficient",
      recommendedBusinessOutcome: "unknown_needs_review",
      allowRerun: true,
      outcome: buildAmbiguousReachableRetryOutcome(
        "STALE_SUBMIT_PATH",
        "Reachable page looked like a stale submit path or soft-404 surface. Re-scan the real submit entry before concluding manual auth or no-entry.",
        args.evidenceRef,
      ),
    });
  }

  if (
    pageAssessment.page_reachable &&
    pageAssessment.visual_verification_required &&
    (pageAssessment.ambiguity_flags.includes("mixed_submit_and_auth_signals") ||
      pageAssessment.ambiguity_flags.includes("login_vs_register_ambiguous"))
  ) {
    return buildEarlyTerminalClassification({
      hypothesis: "unknown",
      confidence: 0.55,
      supportingSignals: ["mixed_submit_auth_signals"],
      evidenceSufficiency: "insufficient",
      recommendedBusinessOutcome: "unknown_needs_review",
      allowRerun: true,
      outcome: buildAmbiguousReachableRetryOutcome(
        "VISUAL_VERIFICATION_REQUIRED",
        "Reachable page exposed mixed submit/auth signals. Capture screenshot evidence and re-verify the page state before concluding login-required or manual-auth.",
        args.evidenceRef,
      ),
    });
  }

  if (!isAllowedGoogleOauthTransition(args.bodyText, args.currentUrl)) {
    if (containsAny(familyConfig.pageAssessment.loginSignals)) {
      return buildEarlyTerminalClassification({
        hypothesis: "manual_auth_required",
        confidence: 0.9,
        supportingSignals: ["existing_account_auth_terms"],
        evidenceSufficiency: "sufficient",
        recommendedBusinessOutcome: "blocked_manual_auth",
        allowRerun: false,
        outcome: buildManualAuthOutcome(args.evidenceRef),
      });
    }
  }

  if (containsAny(familyConfig.takeover.emailVerificationSignals)) {
    const requiresLiveVerification = args.flowFamily === "forum_profile" || args.flowFamily === "wp_comment" || args.flowFamily === "dev_blog";
    return buildEarlyTerminalClassification({
      hypothesis: "email_verification_pending_but_submitted",
      confidence: 0.95,
      supportingSignals: ["email_verification_checkpoint"],
      evidenceSufficiency: "sufficient",
      recommendedBusinessOutcome: requiresLiveVerification ? "unknown_needs_review" : "submitted_success",
      allowRerun: false,
      outcome: {
        next_status: "WAITING_EXTERNAL_EVENT",
        detail: "Directory is waiting for email verification.",
        wait: inferAutoResumeWait(
          "EMAIL_VERIFICATION_PENDING",
          "gog",
          "Wait for gog to fetch the verification email or magic link automatically.",
          args.evidenceRef,
        ),
      },
    });
  }

  if (args.flowFamily === "forum_profile" && isForumProfileSurface && containsConfiguredSignal(args.bodyText, familyConfig.takeover.pendingSignals ?? familyConfig.takeover.successSignals)) {
    return buildEarlyTerminalClassification({
      hypothesis: "unknown",
      confidence: 0.9,
      supportingSignals: ["profile_save_confirmation"],
      evidenceSufficiency: "sufficient",
      recommendedBusinessOutcome: "unknown_needs_review",
      allowRerun: false,
      outcome: buildFamilyWaitingOutcome({
        waitReasonCode: "PROFILE_PUBLICATION_PENDING",
        detail: "Profile changes were saved, but the public profile backlink is not yet verified live.",
        resumeTrigger: "Re-check the public profile page until the backlink is visible and verified.",
        evidenceRef: args.evidenceRef,
      }),
    });
  }

  if (args.flowFamily === "wp_comment") {
    if (isCommentSurface && containsConfiguredSignal(args.bodyText, familyConfig.takeover.antiSpamSignals)) {
      return buildEarlyTerminalClassification({
        hypothesis: "unknown",
        confidence: 0.92,
        supportingSignals: ["comment_antispam_boundary"],
        evidenceSufficiency: "sufficient",
        recommendedBusinessOutcome: "blocked_policy",
        allowRerun: false,
        outcome: buildPolicyWaitOutcome({
          waitReasonCode: "COMMENT_ANTI_SPAM_BLOCKED",
          evidenceRef: args.evidenceRef,
          detail: "Comment submission hit an anti-spam or server-side moderation barrier and needs review instead of generic retry churn.",
        }),
      });
    }

    if (isCommentSurface && containsConfiguredSignal(args.bodyText, familyConfig.takeover.pendingSignals ?? familyConfig.takeover.successSignals)) {
      return buildEarlyTerminalClassification({
        hypothesis: "unknown",
        confidence: 0.9,
        supportingSignals: ["comment_moderation_pending"],
        evidenceSufficiency: "sufficient",
        recommendedBusinessOutcome: "unknown_needs_review",
        allowRerun: false,
        outcome: buildFamilyWaitingOutcome({
          waitReasonCode: "COMMENT_MODERATION_PENDING",
          detail: "Comment was accepted but is still awaiting public visibility; do not count it as success until the live comment and backlink are verified.",
          resumeTrigger: "Re-check the public thread until the comment and backlink are live.",
          evidenceRef: args.evidenceRef,
        }),
      });
    }
  }

  if (args.flowFamily === "dev_blog") {
    if (isDevBlogEditorSurface && containsConfiguredSignal(args.bodyText, familyConfig.takeover.draftSignals)) {
      return buildEarlyTerminalClassification({
        hypothesis: "unknown",
        confidence: 0.91,
        supportingSignals: ["article_draft_saved"],
        evidenceSufficiency: "sufficient",
        recommendedBusinessOutcome: "unknown_needs_review",
        allowRerun: true,
        outcome: buildFamilyProgressRetryOutcome({
          waitReasonCode: "ARTICLE_DRAFT_SAVED",
          detail: "Article draft was saved, but the post has not been submitted for review or published yet.",
          resumeTrigger: "Continue from the saved draft in a later automation pass.",
          evidenceRef: args.evidenceRef,
        }),
      });
    }

    if (isDevBlogEditorSurface && containsConfiguredSignal(args.bodyText, familyConfig.takeover.pendingSignals)) {
      return buildEarlyTerminalClassification({
        hypothesis: "unknown",
        confidence: 0.9,
        supportingSignals: ["article_submitted_pending_editorial"],
        evidenceSufficiency: "sufficient",
        recommendedBusinessOutcome: "unknown_needs_review",
        allowRerun: false,
        outcome: buildFamilyWaitingOutcome({
          waitReasonCode: "ARTICLE_SUBMITTED_PENDING_EDITORIAL",
          detail: "Article was submitted for review and is waiting for editorial publication; success still requires a live verified backlink.",
          resumeTrigger: "Re-check the article until it is published publicly and the backlink is verified.",
          evidenceRef: args.evidenceRef,
        }),
      });
    }

    if (containsConfiguredSignal(args.bodyText, familyConfig.takeover.publishedSignals ?? familyConfig.takeover.successSignals)) {
      return buildEarlyTerminalClassification({
        hypothesis: "unknown",
        confidence: 0.88,
        supportingSignals: ["article_publication_reported"],
        evidenceSufficiency: "sufficient",
        recommendedBusinessOutcome: "unknown_needs_review",
        allowRerun: false,
        outcome: buildFamilyWaitingOutcome({
          waitReasonCode: "ARTICLE_PUBLICATION_PENDING",
          detail: "Article publication was reported by the site, but success still requires a live verified backlink.",
          resumeTrigger: "Re-check the published article until the backlink is verified.",
          evidenceRef: args.evidenceRef,
        }),
      });
    }
  }

  if (containsAny(familyConfig.takeover.successSignals)) {
    return buildEarlyTerminalClassification({
      hypothesis: "success_submitted",
      confidence: 0.96,
      supportingSignals: ["submission_confirmation_terms"],
      evidenceSufficiency: "sufficient",
      recommendedBusinessOutcome: "submitted_success",
      allowRerun: false,
      outcome: buildSiteResponseOutcome(args.evidenceRef),
    });
  }

  return buildEarlyTerminalClassification({
    hypothesis: "unknown",
    confidence: 0.4,
    supportingSignals: ["no_decisive_terminal_evidence"],
    evidenceSufficiency: "insufficient",
    recommendedBusinessOutcome: "unknown_needs_review",
    allowRerun: true,
    outcome: {
      next_status: "RETRYABLE",
      detail: "Takeover could not confirm a successful submission state.",
      wait: inferAutoResumeWait(
        "OUTCOME_NOT_CONFIRMED",
        "system",
        "Retry automatically later or inspect the latest artifact to improve the agent loop.",
        args.evidenceRef,
      ),
      terminal_class: "outcome_not_confirmed",
    },
  });
}

function inferCurrentOutcome(args: {
  currentUrl: string;
  title?: string;
  bodyText: string;
  evidenceRef: string;
  flowFamily?: TaskRecord["flow_family"];
}): ProposedOutcome {
  return classifyEarlyTerminalOutcome(args).outcome;
}

function buildPlaybook(args: {
  task: TaskRecord;
  currentUrl: string;
  recordedSteps: ReplayStep[];
  detail: string;
  agentTraceRef: string;
  agentBackend: string;
}): TrajectoryPlaybook {
  const familyConfig = getFamilyConfig(args.task.flow_family);
  return {
    id: `playbook-${args.task.hostname}`,
    hostname: args.task.hostname,
    capture_source: "agent_live_takeover",
    surface_signature: `${args.task.hostname}:${args.currentUrl}`,
    preconditions: [`Reach ${args.task.target_url}`],
    steps: args.recordedSteps,
    anchors: [args.task.hostname, args.task.submission.promoted_profile.name],
    postconditions: [args.detail],
    success_signals: [...familyConfig.takeover.successSignals, ...familyConfig.takeover.emailVerificationSignals],
    fallback_notes: ["If replay fails, rerun scout and the agent-driven browser-use loop."],
    replay_confidence: 0.6,
    distilled_from_trace_ref: args.agentTraceRef,
    agent_backend: args.agentBackend,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function deriveAllowedActions(element: { descriptor: string }): AgentObservationElement["allowed_actions"] {
  const descriptor = element.descriptor.toLowerCase();
  const allowedActions = new Set<AgentObservationElement["allowed_actions"][number]>(["click_index"]);

  if (
    descriptor.includes("<input") ||
    descriptor.includes("<textarea") ||
    descriptor.includes("role=textbox") ||
    descriptor.includes("textbox")
  ) {
    allowedActions.add("input_index");
  }

  if (
    descriptor.includes("<select") ||
    descriptor.includes("role=combobox") ||
    descriptor.includes("combobox")
  ) {
    allowedActions.add("select_index");
  }

  return [...allowedActions];
}

function buildObservation(args: {
  snapshot: Awaited<ReturnType<typeof getBrowserUseSnapshot>>;
  scout: ScoutResult;
  flowFamily?: TaskRecord["flow_family"];
}): AgentObservation {
  return {
    url: args.snapshot.url,
    title: args.snapshot.title,
    raw_text_excerpt: args.snapshot.raw_text.slice(0, 4_000),
    elements: args.snapshot.elements.slice(0, MAX_STATE_ELEMENTS).map((element) => ({
      index: element.index,
      descriptor: element.descriptor,
      text: element.text,
      allowed_actions: deriveAllowedActions(element),
    })),
    page_assessment: inferPageAssessment({
      url: args.snapshot.url,
      title: args.snapshot.title,
      bodyText: args.snapshot.raw_text,
      submitCandidates: args.scout.submit_candidates,
      fieldHints: args.scout.field_hints,
      authHints: args.scout.auth_hints,
      antiBotHints: args.scout.anti_bot_hints,
      embedHintsCount: args.scout.embed_hints.length,
      visualProbeRecommended: args.scout.visual_probe_recommended,
      postClickStateUnclear: true,
      flowFamily: args.flowFamily,
    }),
  };
}

function isDecisiveReplayStep(step: ReplayStep | undefined): boolean {
  if (!step) {
    return false;
  }

  switch (step.action) {
    case "click_text":
    case "click_role":
    case "click_selector":
      return true;
    case "press_key":
      return /\b(?:enter|return|space)\b/i.test(step.key);
    default:
      return false;
  }
}

const POST_CLICK_AUTH_OR_BLOCK_PATTERNS = [
  /\bsign in\b/i,
  /\blog in\b/i,
  /\blogin\b/i,
  /\bsign up\b/i,
  /\bregister\b/i,
  /\bcreate account\b/i,
  /\bpassword\b/i,
  /\bpasskey\b/i,
  /\bverify (?:it'?s|its) you\b/i,
  /\btwo-factor\b/i,
  /\b2fa\b/i,
  /\bcontinue with google\b/i,
  /\bcontinue with email\b/i,
  /\bcheck your email\b/i,
  /\bverify your email\b/i,
  /\bcaptcha\b/i,
  /\bhuman verification\b/i,
  /\baccess denied\b/i,
  /\bnot authorized\b/i,
  /\bpermission denied\b/i,
  /\berror\b/i,
];

function countPatternMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function scoreFinalizationPageStateSample(sample: FinalizationPageStateSample): number {
  const combinedText = [sample.title, sample.bodyText, sample.visibleSurfaceText].join("\n");
  const authOrBlockMatches = countPatternMatches(combinedText, POST_CLICK_AUTH_OR_BLOCK_PATTERNS);

  return (
    (sample.hasVisibleOverlaySurface ? 5 : 0) +
    (sample.visibleSurfaceText ? 2 : 0) +
    Math.min(authOrBlockMatches, 6)
  );
}

export function choosePreferredFinalizationPageStateSample(args: {
  current: FinalizationPageStateSample;
  candidate: FinalizationPageStateSample;
}): FinalizationPageStateSample {
  const currentScore = scoreFinalizationPageStateSample(args.current);
  const candidateScore = scoreFinalizationPageStateSample(args.candidate);

  if (candidateScore > currentScore) {
    return args.candidate;
  }

  if (candidateScore < currentScore) {
    return args.current;
  }

  if (
    args.candidate.hasVisibleOverlaySurface &&
    args.candidate.surfaceFingerprint !== args.current.surfaceFingerprint
  ) {
    return args.candidate;
  }

  if (
    args.candidate.bodyText !== args.current.bodyText &&
    args.candidate.bodyText.length > args.current.bodyText.length + 120
  ) {
    return args.candidate;
  }

  return args.current;
}

function normalizeRecoveryText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function buildRecoverySurfaceSignature(args: {
  url: string;
  title?: string;
  rawTextExcerpt?: string;
  goal: string;
}): string {
  return normalizeRecoveryText(
    [args.goal, args.url, args.title ?? "", (args.rawTextExcerpt ?? "").slice(0, 500)].join("\n"),
  );
}

export function shouldAttemptVisionRecovery(args: {
  observation: AgentObservation;
  boundary: StopBoundaryContext;
  attempts: VisionRecoveryAttempt[];
}): boolean {
  if (!args.observation.page_assessment?.page_reachable) {
    return false;
  }

  if (args.attempts.length >= MAX_NOVEL_VISION_RECOVERY_ATTEMPTS) {
    return false;
  }

  const signature = buildRecoverySurfaceSignature({
    url: args.observation.url,
    title: args.observation.title,
    rawTextExcerpt: args.observation.raw_text_excerpt,
    goal: args.boundary.goal,
  });

  return !args.attempts.some((attempt) => attempt.surface_signature === signature);
}

function scoreRecoveryCandidateMatch(args: {
  element: AgentObservationElement;
  candidate: string;
  targetKind?: VisualRecoveryHint["target_kind"];
}): number {
  if (!args.element.allowed_actions.includes("click_index")) {
    return -1;
  }

  const candidate = normalizeRecoveryText(args.candidate);
  if (!candidate) {
    return -1;
  }

  const text = normalizeRecoveryText(args.element.text);
  const descriptor = normalizeRecoveryText(args.element.descriptor);
  const combined = `${text}\n${descriptor}`;
  let score = 0;

  if (text === candidate) score += 120;
  else if (text.includes(candidate)) score += 95;
  else if (combined.includes(candidate)) score += 70;
  else {
    const candidateTokens = candidate.split(/\s+/).filter((token) => token.length >= 3);
    const matchedTokens = candidateTokens.filter((token) => combined.includes(token)).length;
    if (matchedTokens === 0) {
      return -1;
    }
    score += matchedTokens * 18;
  }

  if (args.targetKind === "submit" && /submit|get listed|add|publish|launch/i.test(args.element.text)) {
    score += 18;
  }
  if (args.targetKind === "signup" && /sign up|register|create account|join/i.test(args.element.text)) {
    score += 18;
  }
  if (args.targetKind === "login" && /sign in|log in|continue/i.test(args.element.text)) {
    score += 18;
  }
  if (args.targetKind === "form" && /continue|next|start|submit|open/i.test(args.element.text)) {
    score += 10;
  }

  return score;
}

function findRecoveryElement(args: {
  observation: AgentObservation;
  hint: VisualRecoveryHint;
}): AgentObservationElement | undefined {
  let best:
    | {
        element: AgentObservationElement;
        score: number;
      }
    | undefined;

  for (const candidate of args.hint.target_text_candidates) {
    for (const element of args.observation.elements) {
      const score = scoreRecoveryCandidateMatch({
        element,
        candidate,
        targetKind: args.hint.target_kind,
      });
      if (score < 0) {
        continue;
      }

      if (!best || score > best.score) {
        best = { element, score };
      }
    }
  }

  return best?.element;
}

export function hasCredibleSignupContinuation(args: {
  title?: string;
  bodyText?: string;
  currentUrl?: string;
}): boolean {
  const normalized = normalizeRecoveryText(
    [args.currentUrl ?? "", args.title ?? "", args.bodyText ?? ""].join("\n"),
  );
  const hasSignupCta =
    /sign up|register|create account|create my account|create startup|don't have an account yet|dont have an account yet/.test(
      normalized,
    );
  const hasStrongSignupCopy =
    /create an account to continue|create startup|join betalist|join [a-z0-9_-]+|already have .* account\? sign in/.test(
      normalized,
    );
  const registerFieldSignals = [
    /username/,
    /email/,
    /password/,
    /password confirmation/,
    /confirm password/,
  ].filter((pattern) => pattern.test(normalized)).length;
  return (hasSignupCta && registerFieldSignals >= 2) || (hasSignupCta && hasStrongSignupCopy);
}

export function applySignupContinuationGuard(args: {
  outcome: ProposedOutcome;
  visualVerification?: import("../shared/types.js").VisualVerificationResult;
  evidenceRef: string;
  currentUrl?: string;
  title?: string;
  bodyText?: string;
}): ProposedOutcome {
  if (
    !hasCredibleSignupContinuation({
      currentUrl: args.currentUrl,
      title: args.title,
      bodyText: args.bodyText,
    })
  ) {
    return args.outcome;
  }

  const looksManualAuthish =
    args.outcome.next_status === "WAITING_MANUAL_AUTH" ||
    (args.outcome.next_status === "RETRYABLE" && args.visualVerification?.classification === "login_gate");

  if (!looksManualAuthish) {
    return args.outcome;
  }

  const detail =
    "Reachable auth surface still exposes a credible sign-up continuation, so this should stay retryable instead of being parked as manual auth.";
  return buildAmbiguousReachableRetryOutcome("SIGNUP_FLOW_AVAILABLE", detail, args.evidenceRef);
}

async function maybeRecoverFromStopBoundary(args: {
  runtime: BrowserRuntime;
  session: string;
  task: TaskRecord;
  scout: ScoutResult;
  observation: AgentObservation;
  boundary: StopBoundaryContext;
  attempts: VisionRecoveryAttempt[];
  recordedSteps: ReplayStep[];
}): Promise<AgentObservation | undefined> {
  if (!shouldAttemptVisionRecovery({ observation: args.observation, boundary: args.boundary, attempts: args.attempts })) {
    return undefined;
  }

  const screenshotPath = path.join(
    DATA_DIRECTORIES.artifacts,
    `${args.task.id}-vision-recovery-${args.attempts.length + 1}.png`,
  );
  await saveBrowserUseScreenshot({
    cdpUrl: args.runtime.cdp_url,
    session: args.session,
    filePath: screenshotPath,
  }).catch(() => undefined);

  const attempt: VisionRecoveryAttempt = {
    goal: args.boundary.goal,
    failure_reason: args.boundary.failureReason,
    surface_signature: buildRecoverySurfaceSignature({
      url: args.observation.url,
      title: args.observation.title,
      rawTextExcerpt: args.observation.raw_text_excerpt,
      goal: args.boundary.goal,
    }),
    url: args.observation.url,
    screenshot_path: screenshotPath,
    summary: "Vision recovery not attempted.",
    target_text_candidates: [],
    recovery_possible: false,
    applied: false,
  };

  args.attempts.push(attempt);

  const hint = await runVisualRecoveryHint({
    config: resolveAgentBackendConfig(),
    screenshotPath,
    pageUrl: args.observation.url,
    pageTitle: args.observation.title,
    bodyExcerpt: args.observation.raw_text_excerpt,
    submitCandidates: args.scout.submit_candidates,
    authHints: args.scout.auth_hints,
    fieldHints: args.scout.field_hints,
    antiBotHints: args.scout.anti_bot_hints,
    linkCandidates: args.scout.link_candidates,
    flowFamily: args.task.flow_family,
    goal: args.boundary.goal,
    failureReason: args.boundary.failureReason,
  }).catch(() => undefined);

  if (!hint) {
    attempt.summary = "Vision recovery hint unavailable.";
    return undefined;
  }

  attempt.summary = hint.summary;
  attempt.target_text_candidates = hint.target_text_candidates.slice();
  attempt.recovery_possible = hint.recovery_possible;
  attempt.confidence = hint.confidence;
  attempt.model = hint.model;

  if (!hint.recovery_possible || hint.confidence < 0.55 || hint.target_text_candidates.length === 0) {
    return undefined;
  }

  const matchedElement = findRecoveryElement({
    observation: args.observation,
    hint,
  });
  if (!matchedElement) {
    return undefined;
  }

  attempt.matched_text = matchedElement.text;
  attempt.matched_index = matchedElement.index;

  await clickBrowserUseElement({
    cdpUrl: args.runtime.cdp_url,
    session: args.session,
    index: matchedElement.index,
  });
  await settleBrowserUsePage();

  const nextSnapshot = await getBrowserUseSnapshot({
    cdpUrl: args.runtime.cdp_url,
    session: args.session,
  });
  const nextObservation = buildObservation({ snapshot: nextSnapshot, scout: args.scout, flowFamily: args.task.flow_family });
  const progressed =
    nextObservation.url !== args.observation.url ||
    nextObservation.raw_text_excerpt !== args.observation.raw_text_excerpt;
  if (!progressed) {
    return undefined;
  }

  attempt.applied = true;
  args.recordedSteps.push({
    action: "click_text",
    text: matchedElement.text || hint.target_text_candidates[0],
    exact: false,
  });
  return nextObservation;
}

async function sampleFinalizationPageState(
  page: import("playwright").Page,
): Promise<FinalizationPageStateSample> {
  return page.evaluate(() => {
    function normalizeText(value: string): string {
      return value.replace(/\s+/g, " ").trim();
    }

    function isVisibleSurface(element: Element): element is HTMLElement {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity || "1") < 0.05
      ) {
        return false;
      }

      const rect = element.getBoundingClientRect();
      return rect.width >= 180 && rect.height >= 80;
    }

    function surfaceText(element: Element): string {
      if (!(element instanceof HTMLElement)) {
        return "";
      }

      return normalizeText(element.innerText || element.textContent || "").slice(0, 1_500);
    }

    const surfaceSelectors = [
      "dialog",
      "[role='dialog']",
      "[role='alertdialog']",
      "[aria-modal='true']",
      "[data-modal]",
      "[data-dialog]",
      "[data-drawer]",
      "[class*='modal']",
      "[class*='Modal']",
      "[class*='dialog']",
      "[class*='Dialog']",
      "[class*='drawer']",
      "[class*='Drawer']",
      "[class*='overlay']",
      "[class*='Overlay']",
      "[class*='interstitial']",
      "[class*='Interstitial']",
    ];

    const visibleSurfaces = Array.from(document.querySelectorAll(surfaceSelectors.join(",")))
      .filter(isVisibleSurface)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const role = element.getAttribute("role") ?? "";
        const text = surfaceText(element);
        const score =
          rect.width * rect.height +
          (role === "dialog" || role === "alertdialog" || element.matches("[aria-modal='true']")
            ? 250_000
            : 0);

        return {
          tagName: element.tagName.toLowerCase(),
          role,
          id: element.id ?? "",
          className: element.className,
          text,
          score,
        };
      })
      .filter((surface) => surface.text.length > 0)
      .sort((left, right) => right.score - left.score);

    const topSurfaces = visibleSurfaces.slice(0, 2);
    const visibleSurfaceText = topSurfaces
      .map((surface) => surface.text)
      .join("\n")
      .slice(0, 2_500);
    const prominentSurface = topSurfaces[0];
    const surfaceFingerprint = prominentSurface
      ? normalizeText(
          `${prominentSurface.tagName}|${prominentSurface.role}|${prominentSurface.id}|${String(prominentSurface.className)}|${prominentSurface.text.slice(0, 180)}`,
        ).toLowerCase()
      : "";

    return {
      currentUrl: window.location.href,
      title: document.title,
      bodyText: normalizeText(document.body?.innerText ?? "").slice(0, 8_000),
      visibleSurfaceText,
      hasVisibleOverlaySurface: topSurfaces.length > 0,
      surfaceFingerprint,
    };
  });
}

async function captureFinalizationPageState(args: {
  page: import("playwright").Page;
  recordedSteps: ReplayStep[];
}): Promise<FinalizationPageStateSample> {
  let preferredSample = await sampleFinalizationPageState(args.page);
  if (!isDecisiveReplayStep(args.recordedSteps.at(-1))) {
    return preferredSample;
  }

  for (let probe = 0; probe < FINALIZATION_POST_CLICK_PROBE_COUNT; probe += 1) {
    await args.page.waitForTimeout(FINALIZATION_POST_CLICK_PROBE_WAIT_MS);
    const nextSample = await sampleFinalizationPageState(args.page);
    preferredSample = choosePreferredFinalizationPageStateSample({
      current: preferredSample,
      candidate: nextSample,
    });
  }

  return preferredSample;
}

function mergeFinalizationVisibleText(
  bodyText: string,
  visibleSurfaceText: string,
): string {
  if (!visibleSurfaceText) {
    return bodyText;
  }

  if (bodyText.includes(visibleSurfaceText)) {
    return bodyText;
  }

  return `${visibleSurfaceText}\n${bodyText}`.trim();
}

function findObservedElement(
  observation: AgentObservation,
  index: number | undefined,
): AgentObservationElement | undefined {
  if (typeof index !== "number") {
    return undefined;
  }

  return observation.elements.find((element) => element.index === index);
}

function extractDescriptorAttribute(
  descriptor: string,
  attributeName: string,
): string | undefined {
  const patterns = [
    new RegExp(`${attributeName}="([^"]+)"`, "i"),
    new RegExp(`${attributeName}='([^']+)'`, "i"),
    new RegExp(`${attributeName}=([^\\s>]+)`, "i"),
  ];

  for (const pattern of patterns) {
    const match = descriptor.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return undefined;
}

function inferReplaySelector(
  element: AgentObservationElement,
): string | undefined {
  const id = extractDescriptorAttribute(element.descriptor, "id");
  if (id) {
    return `#${id}`;
  }

  const name = extractDescriptorAttribute(element.descriptor, "name");
  if (name) {
    const tagName = element.descriptor.match(/<([a-z0-9-]+)/i)?.[1]?.toLowerCase();
    if (tagName) {
      return `${tagName}[name="${name}"]`;
    }

    return `[name="${name}"]`;
  }

  const ariaLabel = extractDescriptorAttribute(element.descriptor, "aria-label");
  if (ariaLabel) {
    return `[aria-label="${ariaLabel}"]`;
  }

  return undefined;
}

function inferReplayClickStep(
  element: AgentObservationElement | undefined,
): ReplayStep | undefined {
  if (!element) {
    return undefined;
  }

  const stableText = element.text.trim();
  if (stableText && stableText.length <= 100) {
    return { action: "click_text", text: stableText };
  }

  const selector = inferReplaySelector(element);
  if (selector) {
    return { action: "click_selector", selector };
  }

  return undefined;
}

function inferReplayInputStep(args: {
  element: AgentObservationElement | undefined;
  value: string;
}): ReplayStep | undefined {
  if (!args.element) {
    return undefined;
  }

  const placeholder = extractDescriptorAttribute(args.element.descriptor, "placeholder");
  if (placeholder) {
    return { action: "fill_placeholder", placeholder, value: args.value };
  }

  const selector = inferReplaySelector(args.element);
  if (selector) {
    return { action: "fill_selector", selector, value: args.value };
  }

  return undefined;
}

function inferReplaySelectStep(args: {
  element: AgentObservationElement | undefined;
  value: string;
}): ReplayStep | undefined {
  if (!args.element) {
    return undefined;
  }

  const selector = inferReplaySelector(args.element);
  if (selector) {
    return { action: "select_selector", selector, value: args.value };
  }

  return undefined;
}

function buildReplayStepFromDecision(args: {
  decision: AgentDecision;
  observation: AgentObservation;
}): ReplayStep | undefined {
  const { decision, observation } = args;
  const element = findObservedElement(observation, decision.index);

  switch (decision.action) {
    case "open_url":
      return decision.url ? { action: "goto", url: decision.url } : undefined;
    case "click_index":
      return inferReplayClickStep(element);
    case "input_index":
      return typeof decision.text === "string"
        ? inferReplayInputStep({ element, value: decision.text })
        : undefined;
    case "select_index":
      return typeof decision.value === "string"
        ? inferReplaySelectStep({ element, value: decision.value })
        : undefined;
    case "keys":
      return decision.keys ? { action: "press_key", key: decision.keys } : undefined;
    case "wait":
      if (!decision.wait_kind || !decision.wait_target) {
        return undefined;
      }

      if (decision.wait_kind === "text") {
        return {
          action: "wait_for_text",
          text: decision.wait_target,
          timeout_ms: decision.wait_timeout_ms,
        };
      }

      return {
        action: "wait_for_selector",
        selector: decision.wait_target,
        timeout_ms: decision.wait_timeout_ms,
        state: decision.wait_state,
      };
    case "finish_submission_attempt":
    case "classify_terminal":
    case "abort_retryable":
      return undefined;
  }
}

function buildWaitFromDecision(
  decision: AgentDecision,
  evidenceRef: string,
): WaitMetadata | undefined {
  if (!decision.next_status || !decision.wait_reason_code) {
    return undefined;
  }

  if (decision.next_status === "WAITING_POLICY_DECISION") {
    return inferTerminalAuditWait(
      decision.wait_reason_code,
      evidenceRef,
      decision.resume_trigger ?? decision.detail ?? "Agent classified this page as a policy boundary.",
    );
  }

  if (decision.next_status === "WAITING_MANUAL_AUTH") {
    return inferTerminalAuditWait(
      decision.wait_reason_code,
      evidenceRef,
      decision.resume_trigger ?? decision.detail ?? "Agent classified this page as unsupported authentication.",
    );
  }

  if (decision.next_status === "WAITING_MISSING_INPUT") {
    return inferTerminalAuditWait(
      decision.wait_reason_code,
      evidenceRef,
      decision.resume_trigger ?? decision.detail ?? "Agent classified this page as missing required inputs.",
    );
  }

  return inferWait(
    decision.wait_reason_code,
    decision.resolution_owner ?? "system",
    decision.resolution_mode ?? "auto_resume",
    decision.resume_trigger ?? decision.detail ?? "Agent requested an explicit wait state.",
    evidenceRef,
  );
}

function normalizeAgentProposal(
  decision: AgentDecision,
  evidenceRef: string,
): ProposedOutcome {
  if (
    !UNATTENDED_POLICY.allow_paid_listing &&
    decision.wait_reason_code === "PAID_OR_SPONSORED_LISTING"
  ) {
    return buildPaidListingSkipOutcome(evidenceRef);
  }

  if (
    !UNATTENDED_POLICY.allow_captcha_bypass &&
    decision.wait_reason_code === "CAPTCHA_BLOCKED"
  ) {
    return buildCaptchaSkipOutcome(evidenceRef);
  }

  return {
    next_status: decision.next_status ?? "RETRYABLE",
    detail: decision.detail ?? decision.reason,
    wait: buildWaitFromDecision(decision, evidenceRef),
    terminal_class: decision.terminal_class,
    skip_reason_code: decision.skip_reason_code,
  };
}

function buildRetryableOutcome(args: {
  detail: string;
  evidenceRef: string;
}): ProposedOutcome {
  return {
    next_status: "RETRYABLE",
    detail: args.detail,
    wait: inferAutoResumeWait(
      "OUTCOME_NOT_CONFIRMED",
      "system",
      "Retry automatically later or inspect the latest agent trace before adjusting the loop.",
      args.evidenceRef,
    ),
    terminal_class: "outcome_not_confirmed",
  };
}

function chooseFinalOutcome(args: {
  inferred: ProposedOutcome;
  proposed?: ProposedOutcome;
}): ProposedOutcome {
  if (!args.proposed) {
    return args.inferred;
  }

  if (args.proposed.next_status === "RETRYABLE" && args.inferred.next_status !== "RETRYABLE") {
    return args.inferred;
  }

  return args.proposed;
}

const VISUAL_FALLBACK_SUCCESS_STATUSES = new Set<ProposedOutcome["next_status"]>([
  "WAITING_SITE_RESPONSE",
  "DONE",
]);
const VISUAL_FALLBACK_EXTERNAL_WAIT_STATUSES = new Set<ProposedOutcome["next_status"]>([
  "WAITING_EXTERNAL_EVENT",
]);
const VISUAL_FALLBACK_INFRA_WAIT_CODES = new Set([
  "TAKEOVER_RUNTIME_ERROR",
  "FINALIZATION_SESSION_FAILED",
  "CDP_RUNTIME_UNAVAILABLE",
  "PLAYWRIGHT_CDP_UNAVAILABLE",
  "RUNTIME_PREFLIGHT_FAILED",
]);
const UPSTREAM_FAILURE_PATTERNS = [
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /bad gateway/,
  /service unavailable/,
  /gateway timeout/,
  /temporarily unavailable/,
  /origin (?:is )?(?:down|offline|unreachable)/,
  /web server is down/,
  /site unavailable/,
];

function looksLikeUpstreamFailureSurface(args: {
  currentUrl?: string;
  title?: string;
  bodyText?: string;
  outcome: ProposedOutcome;
}): boolean {
  if (args.outcome.terminal_class === "upstream_5xx") {
    return true;
  }

  const normalized = [
    args.currentUrl,
    args.title,
    args.bodyText,
    args.outcome.detail,
    args.outcome.wait?.wait_reason_code,
    args.outcome.skip_reason_code,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .toLowerCase();

  return UPSTREAM_FAILURE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function shouldRunVisualFallback(args: {
  outcome: ProposedOutcome;
  pageAssessment?: PageAssessment;
  screenshotAvailable: boolean;
  currentUrl?: string;
  title?: string;
  bodyText?: string;
}): boolean {
  if (!args.screenshotAvailable) {
    return false;
  }

  if (!args.pageAssessment?.page_reachable) {
    return false;
  }

  if (VISUAL_FALLBACK_SUCCESS_STATUSES.has(args.outcome.next_status)) {
    return false;
  }

  if (VISUAL_FALLBACK_EXTERNAL_WAIT_STATUSES.has(args.outcome.next_status)) {
    return false;
  }

  if (args.outcome.terminal_class === "takeover_runtime_error") {
    return false;
  }

  if (
    args.outcome.wait?.wait_reason_code &&
    VISUAL_FALLBACK_INFRA_WAIT_CODES.has(args.outcome.wait.wait_reason_code)
  ) {
    return false;
  }

  if (looksLikeUpstreamFailureSurface(args)) {
    return false;
  }

  return true;
}

export function mustRunVisualGateBeforeClosure(args: {
  outcome: ProposedOutcome;
  pageAssessment?: PageAssessment;
  screenshotAvailable: boolean;
  currentUrl?: string;
  title?: string;
  bodyText?: string;
  visualVerificationProvided: boolean;
}): boolean {
  if (args.visualVerificationProvided) {
    return false;
  }

  return shouldRunVisualFallback({
    outcome: args.outcome,
    pageAssessment: args.pageAssessment,
    screenshotAvailable: args.screenshotAvailable,
    currentUrl: args.currentUrl,
    title: args.title,
    bodyText: args.bodyText,
  });
}

export function applyVisualVerificationGuard(args: {
  outcome: ProposedOutcome;
  visualVerification?: import("../shared/types.js").VisualVerificationResult;
  evidenceRef: string;
}): ProposedOutcome {
  const visual = args.visualVerification;
  if (!visual || visual.confidence < 0.55) {
    return args.outcome;
  }

  const visualDetail = describeVisualVerification(visual);

  if (args.outcome.next_status === "RETRYABLE") {
    if (visual.classification === "success_or_confirmation") {
      return buildSiteResponseOutcome(args.evidenceRef, visualDetail);
    }

    if (visual.classification === "captcha_or_human_verification") {
      return {
        ...buildCaptchaSkipOutcome(args.evidenceRef),
        detail: visualDetail,
      };
    }

    if (visual.classification === "login_gate") {
      return buildManualAuthOutcome(args.evidenceRef, visualDetail);
    }
  }

  if (args.outcome.next_status === "WAITING_MANUAL_AUTH" && visual.classification === "success_or_confirmation") {
    return buildSiteResponseOutcome(args.evidenceRef, visualDetail);
  }

  if (args.outcome.next_status === "WAITING_MANUAL_AUTH" && visual.classification === "captcha_or_human_verification") {
    return {
      ...buildCaptchaSkipOutcome(args.evidenceRef),
      detail: visualDetail,
    };
  }

  if (args.outcome.next_status === "WAITING_MANUAL_AUTH" && visual.classification !== "login_gate") {
    const waitReasonCode =
      visual.classification === "404_or_stale_submit_path"
        ? "STALE_SUBMIT_PATH"
        : "VISUAL_VERIFICATION_REQUIRED";
    return buildAmbiguousReachableRetryOutcome(
      waitReasonCode,
      visualDetail,
      args.evidenceRef,
    );
  }

  return args.outcome;
}

function actionSignature(decision: AgentDecision): string {
  return [
    decision.action,
    decision.url ?? "",
    decision.index ?? "",
    decision.text ?? "",
    decision.value ?? "",
    decision.keys ?? "",
    decision.wait_kind ?? "",
    decision.wait_target ?? "",
  ].join("|");
}

function buildRecentActions(traceSteps: AgentLoopTraceStep[]): AgentDecisionInput["recent_actions"] {
  return traceSteps.slice(-8).map((step) => ({
    step_number: step.step_number,
    action: step.decision.action,
    detail: step.execution.detail,
    result: step.execution.ok ? "ok" : "failed",
  }));
}

async function executeAgentDecision(args: {
  runtime: BrowserRuntime;
  session: string;
  decision: AgentDecision;
  observation: AgentObservation;
  recordedSteps: ReplayStep[];
}): Promise<{ ok: boolean; detail: string }> {
  const { decision } = args;
  const replayStep = buildReplayStepFromDecision({
    decision,
    observation: args.observation,
  });

  switch (decision.action) {
    case "open_url":
      if (!decision.url) {
        throw new Error("Agent returned open_url without a url.");
      }

      await openBrowserUseUrl({
        cdpUrl: args.runtime.cdp_url,
        session: args.session,
        url: decision.url,
      });
      if (replayStep) {
        args.recordedSteps.push(replayStep);
      }
      return { ok: true, detail: `Opened ${decision.url}.` };

    case "click_index":
      if (typeof decision.index !== "number") {
        throw new Error("Agent returned click_index without an index.");
      }

      await clickBrowserUseElement({
        cdpUrl: args.runtime.cdp_url,
        session: args.session,
        index: decision.index,
      });
      if (replayStep) {
        args.recordedSteps.push(replayStep);
      }
      return { ok: true, detail: `Clicked browser-use element ${decision.index}.` };

    case "input_index":
      if (
        typeof decision.index !== "number" ||
        (typeof decision.text !== "string" && typeof decision.value !== "string")
      ) {
        throw new Error("Agent returned input_index without an index or text.");
      }

      await inputBrowserUseElement({
        cdpUrl: args.runtime.cdp_url,
        session: args.session,
        index: decision.index,
        text: decision.text ?? decision.value ?? "",
      });
      if (replayStep) {
        args.recordedSteps.push(replayStep);
      }
      return { ok: true, detail: `Filled browser-use element ${decision.index}.` };

    case "select_index":
      if (typeof decision.index !== "number" || typeof decision.value !== "string") {
        throw new Error("Agent returned select_index without an index or value.");
      }

      await selectBrowserUseElement({
        cdpUrl: args.runtime.cdp_url,
        session: args.session,
        index: decision.index,
        value: decision.value,
      });
      if (replayStep) {
        args.recordedSteps.push(replayStep);
      }
      return { ok: true, detail: `Selected "${decision.value}" on browser-use element ${decision.index}.` };

    case "keys":
      if (!decision.keys) {
        throw new Error("Agent returned keys without a key chord.");
      }

      await sendBrowserUseKeys({
        cdpUrl: args.runtime.cdp_url,
        session: args.session,
        keys: decision.keys,
      });
      if (replayStep) {
        args.recordedSteps.push(replayStep);
      }
      return { ok: true, detail: `Sent browser-use keys "${decision.keys}".` };

    case "wait":
      if (!decision.wait_kind || !decision.wait_target) {
        throw new Error("Agent returned wait without wait_kind or wait_target.");
      }

      if (decision.wait_kind === "text") {
        await waitForBrowserUseText({
          cdpUrl: args.runtime.cdp_url,
          session: args.session,
          text: decision.wait_target,
          timeoutMs: decision.wait_timeout_ms,
        });
      } else {
        await waitForBrowserUseSelector({
          cdpUrl: args.runtime.cdp_url,
          session: args.session,
          selector: decision.wait_target,
          state: decision.wait_state,
          timeoutMs: decision.wait_timeout_ms,
        });
      }

      if (replayStep) {
        args.recordedSteps.push(replayStep);
      }
      return { ok: true, detail: `Waited for ${decision.wait_kind} "${decision.wait_target}".` };

    case "finish_submission_attempt":
    case "classify_terminal":
    case "abort_retryable":
      return { ok: true, detail: decision.detail ?? decision.reason };
  }
}

function buildTraceStep(args: {
  stepNumber: number;
  observation: AgentObservation;
  decision: AgentDecision;
  ok: boolean;
  detail: string;
  beforeUrl: string;
  afterUrl: string;
  durationMs: number;
}): AgentLoopTraceStep {
  return {
    step_number: args.stepNumber,
    observation: args.observation,
    decision: args.decision,
    execution: {
      ok: args.ok,
      detail: args.detail,
      before_url: args.beforeUrl,
      after_url: args.afterUrl,
      duration_ms: args.durationMs,
    },
  };
}

function buildTraceArtifact(args: {
  task: TaskRecord;
  agentBackend: string;
  startedAt: string;
  stopReason: string;
  finalObservation: AgentObservation;
  steps: AgentLoopTraceStep[];
}): AgentLoopTrace {
  return {
    task_id: args.task.id,
    agent_backend: args.agentBackend,
    started_at: args.startedAt,
    finished_at: new Date().toISOString(),
    stop_reason: args.stopReason,
    final_url: args.finalObservation.url,
    final_title: args.finalObservation.title,
    final_excerpt: args.finalObservation.raw_text_excerpt,
    steps: args.steps,
  };
}

export function buildBrowserUseSessionName(taskId: string, startedAtMs: number): string {
  const suffix = startedAtMs.toString(36).slice(-6);
  return `task-${taskId}-${suffix}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 64);
}

function chooseInitialBrowserUseUrl(taskTargetUrl: string, scout: ScoutResult): string {
  const preferredProviders = new Set([
    "typeform",
    "tally",
    "jotform",
    "hubspot",
    "google_forms",
    "airtable_form",
  ]);
  const interactiveEmbed = scout.embed_hints.find(
    (hint) =>
      hint.likely_interactive &&
      preferredProviders.has(hint.provider) &&
      /^https?:\/\//i.test(hint.frame_url),
  );
  return interactiveEmbed?.frame_url || taskTargetUrl;
}

function buildOperatorOnlyLoopDisabledError(): Error {
  return new Error(
    [
      "Repo-native agent execution is disabled in operator-only mode.",
      "Use the Codex/OpenClaw operator path instead:",
      "claim-next-task -> task-prepare -> operator skill/browser-use -> task-record-agent-trace -> task-finalize.",
    ].join(" "),
  );
}

export async function runAgentDrivenBrowserUseLoop(_args: {
  runtime: BrowserRuntime;
  task: TaskRecord;
  scout: ScoutResult;
  accountCandidate?: import("../shared/types.js").AccountRecord;
  accountCredentials?: import("../shared/types.js").CredentialPayload;
  registrationRequired?: boolean;
}): Promise<AgentLoopResult> {
  throw buildOperatorOnlyLoopDisabledError();
}

export async function runTakeoverFinalization(args: {
  runtime: BrowserRuntime;
  task: TaskRecord;
  handoff: TakeoverHandoff;
}): Promise<TakeoverResult> {
  try {
    return await withConnectedPage(
      args.runtime.cdp_url,
      async (page) => {
        const artifactPath = getArtifactFilePath(args.task.id, "finalization");
        const screenshotPath = path.join(DATA_DIRECTORIES.artifacts, `${args.task.id}-finalization.png`);

        let pageState = await captureFinalizationPageState({
          page,
          recordedSteps: args.handoff.recorded_steps,
        }).catch(async () => ({
          currentUrl: page.url() || args.handoff.current_url,
          title: await page.title().catch(() => ""),
          bodyText: await page.locator("body").innerText().catch(() => ""),
          visibleSurfaceText: "",
          hasVisibleOverlaySurface: false,
          surfaceFingerprint: "",
        }));
        let currentUrl = pageState.currentUrl || args.handoff.current_url;
        let title = pageState.title;
        let bodyText = mergeFinalizationVisibleText(
          pageState.bodyText,
          pageState.visibleSurfaceText,
        );
        let screenshotAvailable = false;
        let captchaSolverAttempt: CapsolverAttemptRecord | undefined;
        try {
          await page.screenshot({ path: screenshotPath, fullPage: false });
          screenshotAvailable = true;
        } catch {
          screenshotAvailable = false;
        }

        const pageContextValidation = validateFinalizationPageContext({
          currentUrl,
          handoffUrl: args.handoff.current_url,
          taskHostname: args.task.hostname,
        });
        if (!pageContextValidation.ok) {
          const guardedOutcome = buildAmbiguousReachableRetryOutcome(
            "FINALIZATION_PAGE_CONTEXT_MISMATCH",
            pageContextValidation.detail ??
              "Finalization lost the task-bound page context and refused to persist cross-host evidence.",
            artifactPath,
          );
          await writeJsonFile(artifactPath, {
            stage: "finalization",
            target_url: args.task.target_url,
            current_url: currentUrl,
            title,
            body_excerpt: bodyText.slice(0, 2_000),
            visible_surface_excerpt: pageState.visibleSurfaceText.slice(0, 1_000),
            visible_overlay_surface_detected: pageState.hasVisibleOverlaySurface,
            page_context_validation: pageContextValidation,
            recorded_steps: args.handoff.recorded_steps,
            proposed_outcome: args.handoff.proposed_outcome,
            final_outcome: guardedOutcome,
            captcha_solver_attempt: captchaSolverAttempt,
            visual_verification: args.handoff.visual_verification,
            vision_recovery_attempts: args.handoff.vision_recovery_attempts,
            agent_trace_ref: args.handoff.agent_trace_ref,
            agent_backend: args.handoff.agent_backend,
            agent_steps_count: args.handoff.agent_steps_count,
          });

          return {
            ok: false,
            next_status: guardedOutcome.next_status,
            detail: guardedOutcome.detail,
            artifact_refs: [artifactPath, screenshotPath],
            wait: guardedOutcome.wait,
            terminal_class: guardedOutcome.terminal_class,
            agent_trace_ref: args.handoff.agent_trace_ref,
            agent_backend: args.handoff.agent_backend,
            agent_steps_count: args.handoff.agent_steps_count,
          };
        }

        captchaSolverAttempt = await attemptCapsolverContinuation({
          page,
          websiteURL: currentUrl,
          submitAfterSolve: true,
        });
        if (captchaSolverAttempt.solved && captchaSolverAttempt.applied) {
          pageState = await captureFinalizationPageState({
            page,
            recordedSteps: args.handoff.recorded_steps,
          }).catch(async () => ({
            currentUrl: page.url() || currentUrl,
            title: await page.title().catch(() => title),
            bodyText: await page.locator("body").innerText().catch(() => bodyText),
            visibleSurfaceText: "",
            hasVisibleOverlaySurface: false,
            surfaceFingerprint: "",
          }));
          currentUrl = pageState.currentUrl || currentUrl;
          title = pageState.title;
          bodyText = mergeFinalizationVisibleText(pageState.bodyText, pageState.visibleSurfaceText);
          try {
            await page.screenshot({ path: screenshotPath, fullPage: false });
            screenshotAvailable = true;
          } catch {
            screenshotAvailable = false;
          }
        }

        const linkVerification = await verifyLinkOnPage({
          page,
          targetUrl: args.task.submission.promoted_profile.url,
        }).catch((error) => ({
          verification_status: "link_missing" as const,
          expected_target_url: args.task.submission.promoted_profile.url,
          live_page_url: currentUrl,
          rel_flags: [],
          visible_state: "missing" as const,
          detail: error instanceof Error ? `Link verification failed: ${error.message}` : "Link verification failed.",
          verified_at: new Date().toISOString(),
        }));

        const pageAssessment = inferPageAssessment({
          url: currentUrl,
          title,
          bodyText,
          postClickStateUnclear: true,
          flowFamily: args.task.flow_family,
        });

        const earlyTerminalClassification = classifyEarlyTerminalOutcome({
          currentUrl,
          title,
          bodyText,
          evidenceRef: artifactPath,
          flowFamily: args.task.flow_family,
        });
        const inferredOutcome = earlyTerminalClassification.outcome;
        const baselineOutcome = chooseFinalOutcome({
          inferred: inferredOutcome,
          proposed: args.handoff.proposed_outcome,
        });

        const visualGateRequired = mustRunVisualGateBeforeClosure({
          outcome: baselineOutcome,
          pageAssessment,
          screenshotAvailable,
          currentUrl,
          title,
          bodyText,
          visualVerificationProvided: Boolean(args.handoff.visual_verification),
        });
        const visualVerification = visualGateRequired || args.handoff.visual_verification
          ? args.handoff.visual_verification
          : undefined;

        const finalOutcome = visualGateRequired && !visualVerification
          ? buildAmbiguousReachableRetryOutcome(
              "VISUAL_VERIFICATION_REQUIRED",
              "Reachable page still lacked hard terminal evidence, but no visual verification payload was provided. Capture screenshot evidence and re-verify before closing this task.",
              artifactPath,
            )
          : applyVisualVerificationGuard({
              outcome: baselineOutcome,
              visualVerification,
              evidenceRef: artifactPath,
            });
        const signupGuardedOutcome = applySignupContinuationGuard({
          outcome: finalOutcome,
          visualVerification,
          evidenceRef: artifactPath,
          currentUrl,
          title,
          bodyText,
        });
        const guardedOutcome = applyFamilySpecificOutcomeGuard({
          outcome: signupGuardedOutcome,
          flowFamily: args.task.flow_family,
          bodyText,
          evidenceRef: artifactPath,
          linkVerification,
        });

        await writeJsonFile(artifactPath, {
          stage: "finalization",
          target_url: args.task.target_url,
          current_url: currentUrl,
          title,
          body_excerpt: bodyText.slice(0, 2_000),
          visible_surface_excerpt: pageState.visibleSurfaceText.slice(0, 1_000),
          visible_overlay_surface_detected: pageState.hasVisibleOverlaySurface,
          page_assessment: pageAssessment,
          early_terminal_classifier: earlyTerminalClassification,
          recorded_steps: args.handoff.recorded_steps,
          proposed_outcome: args.handoff.proposed_outcome,
          final_outcome: guardedOutcome,
          captcha_solver_attempt: captchaSolverAttempt,
          visual_verification: visualVerification,
          link_verification: linkVerification,
          vision_recovery_attempts: args.handoff.vision_recovery_attempts,
          agent_trace_ref: args.handoff.agent_trace_ref,
          agent_backend: args.handoff.agent_backend,
          agent_steps_count: args.handoff.agent_steps_count,
        });

        const playbook =
          guardedOutcome.next_status === "WAITING_SITE_RESPONSE" ||
          guardedOutcome.next_status === "WAITING_EXTERNAL_EVENT" ||
          guardedOutcome.next_status === "DONE"
            ? buildPlaybook({
                task: args.task,
                currentUrl,
                recordedSteps: args.handoff.recorded_steps,
                detail: guardedOutcome.detail,
                agentTraceRef: args.handoff.agent_trace_ref,
                agentBackend: args.handoff.agent_backend,
              })
            : undefined;

        return {
          ok:
            guardedOutcome.next_status === "WAITING_SITE_RESPONSE" ||
            guardedOutcome.next_status === "WAITING_EXTERNAL_EVENT" ||
            guardedOutcome.next_status === "DONE",
          next_status: guardedOutcome.next_status,
          detail: guardedOutcome.detail,
          artifact_refs: [artifactPath, screenshotPath],
          wait: guardedOutcome.wait,
          terminal_class: guardedOutcome.terminal_class,
          skip_reason_code: guardedOutcome.skip_reason_code,
          playbook,
          agent_trace_ref: args.handoff.agent_trace_ref,
          agent_backend: args.handoff.agent_backend,
          agent_steps_count: args.handoff.agent_steps_count,
          link_verification: linkVerification,
        };
      },
      {
        preferredUrl: args.handoff.current_url,
        operationTimeoutMs: 45_000,
        pageCloseTimeoutMs: 2_000,
        browserCloseTimeoutMs: 2_000,
      },
    );
  } catch (error) {
    const evidenceRef = getArtifactFilePath(args.task.id, "finalization");
    const rawMessage = error instanceof Error ? error.message : "Finalization session failed.";
    const isPlaywrightAttachFailure = /connectovercdp|browsertype\.connectovercdp|playwright/i.test(rawMessage);
    const detail = isPlaywrightAttachFailure
      ? `Playwright could not reconnect to the shared browser for finalization: ${rawMessage}`
      : `Finalization session failed: ${rawMessage}`;
    return {
      ok: false,
      next_status: "RETRYABLE",
      detail,
      artifact_refs: [],
      wait: inferWait(
        isPlaywrightAttachFailure ? "PLAYWRIGHT_CDP_UNAVAILABLE" : "FINALIZATION_SESSION_FAILED",
        "system",
        "auto_resume",
        rawMessage,
        evidenceRef,
      ),
      terminal_class: "outcome_not_confirmed",
      agent_trace_ref: args.handoff.agent_trace_ref,
      agent_backend: args.handoff.agent_backend,
      agent_steps_count: args.handoff.agent_steps_count,
    };
  }
}
