import { getFamilyConfig, resolveFlowFamily } from "../families/index.js";
import type { FlowFamily, PrepareResult, TaskRecord } from "../shared/types.js";

export interface FamilyOperatorContext {
  task: TaskRecord;
  prepare: PrepareResult;
  scope?: {
    promotedHostname?: string;
    promotedUrl?: string;
  };
  owner?: string;
  cdpUrl?: string;
  promotedUrl?: string;
  promotedHostname?: string;
}

export type FamilyOperatorRouteKind = "blogger_comment_operator" | "generic_family_agent_operator";

export interface FamilyOperatorRoute {
  kind: FamilyOperatorRouteKind;
  command: string;
}

const GENERIC_FAMILY_AGENT_COMMAND = "node scripts/family-agent-operator.mjs";
const BLOGGER_COMMENT_COMMAND = "node scripts/suika-blogger-operator.mjs";

function hostnameFromUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function hasBloggerCommentEvidence(context: FamilyOperatorContext | undefined): boolean {
  if (!context) {
    return false;
  }
  const task = context.prepare?.task ?? context.task;
  const host = (task.hostname || hostnameFromUrl(task.target_url) || "").toLowerCase();
  if (host === "blogger.com" || host.endsWith(".blogspot.com") || host.endsWith(".googleblog.com")) {
    return true;
  }

  const scout = context.prepare?.scout;
  const frameTexts = (scout?.embed_hints ?? []).flatMap((hint) => [
    hint.frame_url,
    hint.frame_title ?? "",
    hint.body_text_excerpt,
  ]);
  return frameTexts.some((value) => /https?:\/\/(?:www\.)?blogger\.com\/comment\//i.test(value));
}

export function resolveOperatorFlowFamily(context: Pick<FamilyOperatorContext, "task" | "prepare">): FlowFamily {
  return resolveFlowFamily(context.prepare?.task?.flow_family ?? context.task?.flow_family);
}

export function resolveFamilyOperatorRoute(args: { flowFamily: FlowFamily; context?: FamilyOperatorContext }): FamilyOperatorRoute {
  if (args.flowFamily === "wp_comment" && hasBloggerCommentEvidence(args.context)) {
    return {
      kind: "blogger_comment_operator",
      command: BLOGGER_COMMENT_COMMAND,
    };
  }

  return {
    kind: "generic_family_agent_operator",
    command: GENERIC_FAMILY_AGENT_COMMAND,
  };
}

function uniqueStrings(values: readonly string[] | undefined, limit = 12): string[] {
  return [...new Set(values ?? [])].slice(0, limit);
}

function familyOperatorGuidance(flowFamily: FlowFamily): string[] {
  switch (flowFamily) {
    case "saas_directory":
      return [
        "Goal: submit the promoted product/site to a SaaS/tool/startup directory only when the visible flow is truthful and free/direct enough to proceed.",
        "A pending-review / submission-received confirmation is an acceptable WAITING_SITE_RESPONSE outcome; live link verification is not required for immediate directory success unless the site publishes instantly.",
        "Do not fabricate company facts. If required fields are missing (phone, address, founder identity, funding stage, app-store URL, reciprocal URL), stop with WAITING_MISSING_INPUT and name the exact fields.",
      ];
    case "forum_profile":
      return [
        "Goal: place the promoted URL in a user/profile website, bio, about-me, signature, or social-link field.",
        "Do not confuse a forum thread/reply composer with a profile surface; if the only backlink path is posting/replying, stop or classify the boundary rather than forcing profile semantics.",
        "Success requires a saved public profile/account page where the promoted link is visible or a clear pending publication state.",
      ];
    case "forum_post":
      return [
        "Goal: add a natural forum reply/post with exactly one promoted backlink through a forum reply/post flow.",
        "Do not skip solely because the promoted site is topically different from the forum/thread; competitors often use bridge comments on these surfaces, so craft a short bridge comment that is polite, minimally relevant to the thread, and includes the promoted link once.",
        "Prefer replying to the existing target thread before creating a new topic. If replying requires a normal account, use the available login/register/email-verification continuation instead of returning a policy blocker.",
        "A submitted post awaiting moderation is WAITING_SITE_RESPONSE, not DONE. DONE requires a public thread/post with the promoted link verified.",
      ];
    case "wp_comment":
      return [
        "Goal: submit a natural comment with exactly one promoted link on a comment/reply surface.",
        "Blogger-hosted comment frames may be handled by the dedicated Blogger operator; generic comment work must still verify the actual comment form and avoid unrelated newsletter/search forms.",
        "A moderation preview or awaiting-moderation message is WAITING_SITE_RESPONSE. DONE requires the public comment/link to be visible after a fresh check.",
      ];
    case "dev_blog":
      return [
        "Goal: submit or draft a truthful developer-blog/article submission only where the site explicitly supports user submissions.",
        "Draft saved / submitted for review is a progress or waiting outcome, not DONE unless a public page with the promoted link is verified.",
        "Do not fabricate product claims or author credentials; stop with WAITING_MISSING_INPUT when required truthful content is missing.",
      ];
  }
}

function familyConfigSummary(flowFamily: FlowFamily): Record<string, unknown> {
  const config = getFamilyConfig(flowFamily);
  return {
    submit_signals: uniqueStrings(config.pageAssessment.submitSignals),
    register_signals: uniqueStrings(config.pageAssessment.registerSignals),
    login_signals: uniqueStrings(config.pageAssessment.loginSignals),
    field_hints: uniqueStrings(config.scout.fieldHints),
    confirmation_signals: uniqueStrings(config.taskProgress.confirmationSignals),
    captcha_signals: uniqueStrings(config.taskProgress.captchaSignals),
    requires_live_link_verification_for_success: config.semanticContract.requires_live_link_verification_for_success,
    pending_wait_reason_codes: config.semanticContract.pending_wait_reason_codes ?? [],
    review_wait_reason_codes: config.semanticContract.review_wait_reason_codes ?? [],
    policy_wait_reason_codes: config.semanticContract.policy_wait_reason_codes ?? [],
  };
}

function compactContext(context: FamilyOperatorContext): Record<string, unknown> {
  const task = context.prepare?.task ?? context.task;
  return {
    task: {
      id: task.id,
      target_url: task.target_url,
      hostname: task.hostname,
      flow_family: task.flow_family,
      flow_family_source: task.flow_family_source,
      flow_family_reason: task.flow_family_reason,
      status: task.status,
      run_count: task.run_count,
      latest_artifacts: task.latest_artifacts,
      notes: task.notes?.slice(-8),
      submission: task.submission,
    },
    prepare: {
      mode: context.prepare.mode,
      effective_target_url: context.prepare.effective_target_url,
      replay_hit: context.prepare.replay_hit,
      opportunity_class: context.prepare.opportunity_class,
      scout_artifact_ref: context.prepare.scout_artifact_ref,
      scout: context.prepare.scout,
      account_candidate: context.prepare.account_candidate
        ? {
            hostname: context.prepare.account_candidate.hostname,
            email: context.prepare.account_candidate.email,
            auth_mode: context.prepare.account_candidate.auth_mode,
            verified: context.prepare.account_candidate.verified,
            login_url: context.prepare.account_candidate.login_url,
            submit_url: context.prepare.account_candidate.submit_url,
          }
        : undefined,
      registration_required: context.prepare.registration_required,
      registration_email_alias: context.prepare.registration_email_alias,
      mailbox_query: context.prepare.mailbox_query,
    },
    scope: context.scope,
    owner: context.owner,
    cdpUrl: context.cdpUrl,
    promotedUrl: context.promotedUrl ?? context.scope?.promotedUrl,
    promotedHostname: context.promotedHostname ?? context.scope?.promotedHostname,
  };
}

export function buildFamilyOperatorPrompt(args: {
  context: FamilyOperatorContext;
  flowFamily?: FlowFamily;
}): string {
  const flowFamily = args.flowFamily ?? resolveOperatorFlowFamily(args.context);
  const route = resolveFamilyOperatorRoute({ flowFamily, context: args.context });
  const profile = (args.context.prepare?.task ?? args.context.task).submission?.promoted_profile;
  const promptPayload = compactContext(args.context);

  return [
    "You are the bounded family-aware operator for one BacklinkHelper V3 task.",
    `family: ${flowFamily}`,
    `route: ${route.kind}`,
    "",
    "Mission:",
    ...familyOperatorGuidance(flowFamily).map((line) => `- ${line}`),
    "",
    "Hard boundaries:",
    "- Operate exactly this one task. Do not run claim-next-task, unattended-campaign, unattended-scope-tick, follow-up-tick, task-record-agent-trace, or task-finalize.",
    "- Do not run task-finalize. The parent runner will record and finalize after your AgentTraceEnvelope JSON is returned.",
    "- Use the supplied shared CDP endpoint for browser evidence. Do not start a new long-lived browser unless the supplied CDP is unreachable and you record that as runtime evidence.",
    "- Never ask a human. Phone/passkey/2FA, missing truthful business inputs, paid/reciprocal policy, CAPTCHA solver limits, or stale/dead paths are bounded outcomes; ordinary login/register/email verification or an already logged-in Google/shared-browser session is a continuation path, not a blocker.",
    "- Do not fabricate business facts, personal identity, phone/address, funding data, testimonials, or product capabilities.",
    "- For forum_post/comment surfaces, do not return WAITING_POLICY_DECISION merely because the promoted site is topically different from the page. Prefer a concise bridge comment and proceed until a real site/auth/runtime boundary is proven.",
    "- Stop as soon as you have enough evidence for success, pending review, missing input, true policy/auth/captcha boundary, or retryable runtime/site failure.",
    "",
    "Execution hints:",
    "- Prefer Hermes-native tools, repo-native helpers, and Playwright from this workspace. You may create temporary artifacts under data/artifacts or /tmp, but your final answer must be only AgentTraceEnvelope JSON.",
    "- If browser-use CLI is healthy, task-scoped browser-use evidence is useful; otherwise use Playwright over shared CDP and record the fallback in trace.steps.",
    "- Fresh URL/title/body/screenshot evidence beats stale scout evidence.",
    "- Include visual_verification when the conclusion depends on visible page state.",
    "- For submitted-but-not-live outcomes, use WAITING_SITE_RESPONSE with a family-specific terminal_class/wait reason when appropriate.",
    "- For verified live backlink outcomes, use DONE and terminal_class submitted_and_verified.",
    "- For missing fields, use WAITING_MISSING_INPUT and include proposed_outcome.wait.missing_fields if you can name them.",
    "- Output exactly one JSON object matching the AgentTraceEnvelope shape. Do not wrap it in Markdown, do not include commentary before or after it, and do not ask follow-up questions.",
    "",
    "Family contract summary:",
    JSON.stringify(familyConfigSummary(flowFamily), null, 2),
    "",
    "Promoted profile:",
    JSON.stringify(profile ?? {}, null, 2),
    "",
    "Operator context JSON:",
    JSON.stringify(promptPayload, null, 2),
    "",
    "Required final output:",
    "- Return exactly one AgentTraceEnvelope JSON object and no Markdown.",
    "- Minimal shape: { trace: { task_id, agent_backend, started_at, finished_at, stop_reason, final_url, final_title, final_excerpt, steps }, handoff: { detail, artifact_refs, current_url, recorded_steps, agent_trace_ref, agent_backend, agent_steps_count, proposed_outcome, visual_verification? } }.",
    "- proposed_outcome must use proposed_outcome.next_status (not status) plus detail; allowed statuses: WAITING_SITE_RESPONSE, DONE, SKIPPED, WAITING_MISSING_INPUT, WAITING_MANUAL_AUTH, WAITING_POLICY_DECISION, WAITING_EXTERNAL_EVENT, RETRYABLE.",
    "- trace.task_id must equal the task id. steps may be concise legacy step objects; include action, url, title/excerpt, and outcome where available.",
  ].join("\n");
}

// Backwards-compatible export name for older scripts/tests; the prompt is no longer Codex-specific.
export const buildCodexFamilyOperatorPrompt = buildFamilyOperatorPrompt;
