export type BrowserRuntimeSource =
  | "cli"
  | "BACKLINK_BROWSER_CDP_URL"
  | "BROWSER_USE_CDP_URL"
  | "CHROME_CDP_URL"
  | "autodiscovered_external"
  | "default_local";

export interface PreflightCheckResult {
  ok: boolean;
  detail: string;
}

export interface BrowserRuntime {
  cdp_url: string;
  ok: boolean;
  source: BrowserRuntimeSource;
  browser_name: string;
  protocol_version: string;
  preflight_checks: {
    cdp_runtime: PreflightCheckResult;
    playwright: PreflightCheckResult;
    browser_use_cli: PreflightCheckResult;
    agent_backend: PreflightCheckResult;
    gog: PreflightCheckResult;
  };
}

export interface AgentBackendConfig {
  backend: "openai";
  model: string;
  base_url: string;
  api_key_env: string;
}

export type PromotedProfileFieldSourceType =
  | "scraped_public"
  | "user_confirmed"
  | "operator_default"
  | "repo_inferred"
  | "external_system";

export type PromotedProfileFieldReuseScope = "promoted_site" | "campaign";

export interface PromotedProfileFieldValue {
  key: string;
  label: string;
  value: string;
  source_type: PromotedProfileFieldSourceType;
  confidence: MissingInputFieldConfidence;
  verified_at?: string;
  updated_at: string;
  reuse_scope: PromotedProfileFieldReuseScope;
  allowed_for_autofill: boolean;
  source_ref?: string;
  notes?: string;
}

export interface PromotedProfile {
  url: string;
  hostname: string;
  name: string;
  description: string;
  category_hints: string[];
  tagline?: string;
  long_description?: string;
  feature_bullets?: string[];
  pricing_summary?: string;
  company_name?: string;
  contact_email?: string;
  country?: string;
  state_province?: string;
  founded_date?: string;
  primary_category?: string;
  logo_url?: string;
  dossier_fields?: Record<string, PromotedProfileFieldValue>;
  social_links?: PromotedProfileSocialLinks;
  source_pages?: string[];
  probe_version?: string;
  probed_at?: string;
  source: "cli" | "site_metadata" | "deep_probe" | "fallback";
}

export interface PromotedProfileSocialLinks {
  x?: string;
  linkedin?: string;
  github?: string;
  youtube?: string;
}

export interface SubmissionContext {
  promoted_profile: PromotedProfile;
  submitter_email?: string;
  confirm_submit: boolean;
}

export type AccountAuthMode =
  | "password_email"
  | "email_code"
  | "magic_link"
  | "google_oauth";

export type FlowFamily = "saas_directory" | "forum_profile" | "wp_comment" | "dev_blog";

export type FlowFamilySource = "explicit" | "defaulted" | "carried_forward" | "corrected";

export type TaskLane = "directory_active" | "non_directory_active" | "follow_up";

export type ClaimLane = TaskLane | "active_any";

export type WorkerLeaseGroup = "active" | "follow_up";

export type TargetPreflightViability = "promising" | "unclear" | "deprioritized";

export type TargetPreflightSignalKind =
  | "positive_submit_signal"
  | "family_path_signal"
  | "auth_surface_signal"
  | "content_surface_signal"
  | "commercial_barrier_signal"
  | "historical_success_signal"
  | "historical_fast_fail_signal"
  | "historical_waiting_signal";

export interface TargetPreflightSignal {
  kind: TargetPreflightSignalKind;
  detail: string;
  score_delta: number;
}

export interface TargetPreflightAssessment {
  version: number;
  assessed_at: string;
  promoted_hostname: string;
  exact_target_hostname: string;
  queue_priority_score: number;
  viability: TargetPreflightViability;
  historical_exact_host_hits: number;
  historical_success_count: number;
  historical_fast_fail_count: number;
  historical_waiting_count: number;
  signals: TargetPreflightSignal[];
}

export interface TaskStageTimestamps {
  enqueued_at?: string;
  claimed_at?: string;
  prepare_started_at?: string;
  prepare_finished_at?: string;
  trace_recorded_at?: string;
  finalize_started_at?: string;
  finalize_finished_at?: string;
}

export type LinkRelFlag = "ugc" | "sponsored" | "nofollow";

export type LinkVerificationStatus = "verified_link_present" | "link_hidden" | "link_missing";

export type LinkVisibleState = "visible" | "hidden" | "missing";

export interface LinkVerificationResult {
  verification_status: LinkVerificationStatus;
  expected_target_url: string;
  live_page_url?: string;
  target_link_url?: string;
  anchor_text?: string;
  rel?: string;
  rel_flags: LinkRelFlag[];
  visible_state: LinkVisibleState;
  detail: string;
  verified_at: string;
}

export type TaskStatus =
  | "READY"
  | "RUNNING"
  | "WAITING_EXTERNAL_EVENT"
  | "WAITING_POLICY_DECISION"
  | "WAITING_MISSING_INPUT"
  | "WAITING_MANUAL_AUTH"
  | "WAITING_RETRY_DECISION"
  | "WAITING_SITE_RESPONSE"
  | "RETRYABLE"
  | "DONE"
  | "SKIPPED";

export type ResolutionOwner = "system" | "gog" | "none";

export type ResolutionMode = "auto_resume" | "terminal_audit";

export type TerminalClass =
  | "login_required"
  | "email_verification_pending"
  | "captcha_blocked"
  | "paid_listing"
  | "upstream_5xx"
  | "outcome_not_confirmed"
  | "takeover_runtime_error";

export type OpportunityClass = "fast_terminal" | "deep_first" | "recovery_ambiguous";

export type AgentDecisionAction =
  | "open_url"
  | "click_index"
  | "input_index"
  | "select_index"
  | "keys"
  | "wait"
  | "finish_submission_attempt"
  | "classify_terminal"
  | "abort_retryable";

export type MissingInputFieldClass =
  | "public_factual"
  | "operator_default"
  | "external_prerequisite"
  | "site_specific"
  | "policy_sensitive";

export type MissingInputFieldConfidence = "low" | "medium" | "high";

export type MissingInputAskPriority = "low" | "medium" | "high";

export type MissingInputRecommendedResolution =
  | "backfill_from_dossier"
  | "ask_user_once"
  | "needs_policy_decision"
  | "skip_if_unavailable"
  | "leave_task_waiting";

export interface MissingInputField {
  key: string;
  label: string;
  field_class?: MissingInputFieldClass;
  required?: boolean;
  site_label?: string;
  canonical_value_candidate?: string;
  source_hint?: string;
  confidence?: MissingInputFieldConfidence;
  can_auto_resolve?: boolean;
  should_ask_user?: boolean;
  ask_priority?: MissingInputAskPriority;
  missing_reason?: string;
  evidence_refs?: string[];
  recommended_resolution?: MissingInputRecommendedResolution;
}

export interface WaitMetadata {
  wait_reason_code: string;
  resume_trigger: string;
  resolution_owner: ResolutionOwner;
  resolution_mode: ResolutionMode;
  evidence_ref: string;
  missing_fields?: MissingInputField[];
}

export interface TaskInteractionFrontier {
  node_id: string;
  context_type: string;
  url?: string;
  title?: string;
  depth: number;
  confidence: PageClassificationConfidence;
  reached_via_action_id?: string;
  next_best_actions: string[];
  updated_at: string;
}

export interface TaskBlocker {
  blocker_id: string;
  node_id: string;
  context_type: string;
  url?: string;
  title?: string;
  blocker_type: string;
  detail: string[];
  severity: "soft" | "hard";
  unblock_requirement: string;
  can_auto_resume: boolean;
  consumes_retry_budget: boolean;
  evidence_refs: string[];
  source: "prepare" | "agent_trace" | "finalize" | "system";
  updated_at: string;
  status: "active" | "resolved";
}

export interface TaskDiscoveredAction {
  action_id: string;
  from_node_id: string;
  from_context_type: string;
  from_url?: string;
  action_type: string;
  label: string;
  selector_hint?: string;
  outcome: string;
  to_node_id?: string;
  to_context_type?: string;
  to_url?: string;
  evidence_refs: string[];
  repeatable: boolean;
  updated_at: string;
}

export interface TaskEvidence {
  evidence_id: string;
  node_id: string;
  context_type: string;
  url?: string;
  title?: string;
  type: string;
  signal: string;
  confidence: PageClassificationConfidence;
  path?: string;
  content?: string;
  source: "scout" | "agent_trace" | "finalize" | "system";
  created_at: string;
}

export interface TaskReusableFragment {
  fragment_id: string;
  matched_at_node_id: string;
  confidence: PageClassificationConfidence;
  preconditions: string[];
  recommended_next_actions: string[];
  local_proof: string[];
  source: "scout" | "agent_trace" | "finalize";
  updated_at: string;
}

export interface TaskExecutionState {
  version: number;
  frontier?: TaskInteractionFrontier;
  blockers: TaskBlocker[];
  discovered_actions: TaskDiscoveredAction[];
  evidence: TaskEvidence[];
  reusable_fragments: TaskReusableFragment[];
}

export type EmailVerificationContinuationKind = "magic_link" | "verification_code";

export interface EmailVerificationContinuation {
  kind: EmailVerificationContinuationKind;
  source_message_id?: string;
  source_email?: string;
  observed_at: string;
  suggested_target_url?: string;
  verification_code?: string;
  detail: string;
}

export interface TaskRecord {
  id: string;
  target_url: string;
  hostname: string;
  flow_family?: FlowFamily;
  flow_family_source?: FlowFamilySource;
  flow_family_reason?: string;
  flow_family_updated_at?: string;
  corrected_from_family?: FlowFamily;
  enqueued_by?: string;
  submission: SubmissionContext;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  run_count: number;
  escalation_level: "none" | "replay" | "scout" | "takeover";
  takeover_attempts: number;
  last_takeover_at?: string;
  last_takeover_outcome?: string;
  reactivation_cooldown_until?: string;
  reactivation_cooldown_reason?: string;
  reactivation_cooldown_count?: number;
  trajectory_playbook_ref?: string;
  account_ref?: string;
  lease_expires_at?: string;
  terminal_class?: TerminalClass;
  skip_reason_code?: string;
  wait?: WaitMetadata;
  opportunity_class?: OpportunityClass;
  homepage_recovery_used?: boolean;
  visual_gate_used?: boolean;
  recovered_target_url?: string;
  email_verification_continuation?: EmailVerificationContinuation;
  link_verification?: LinkVerificationResult;
  target_preflight?: TargetPreflightAssessment;
  queue_priority_score?: number;
  stage_timestamps?: TaskStageTimestamps;
  execution_state?: TaskExecutionState;
  phase_history: string[];
  latest_artifacts: string[];
  notes: string[];
}

export interface WorkerLease {
  task_id: string;
  owner: string;
  acquired_at: string;
  expires_at: string;
  group?: WorkerLeaseGroup;
  lane?: ClaimLane;
  previous_status?: TaskStatus;
  previous_wait?: WaitMetadata;
  previous_terminal_class?: TerminalClass;
  previous_skip_reason_code?: string;
}

export interface AccountRecord {
  hostname: string;
  email: string;
  email_alias: string;
  auth_mode: AccountAuthMode;
  verified: boolean;
  login_url?: string;
  submit_url?: string;
  credential_ref?: string;
  created_at: string;
  last_used_at: string;
  last_registration_result: string;
}

export interface CredentialPayload {
  email: string;
  password?: string;
  username?: string;
}

export interface CredentialVaultRecord {
  credential_ref: string;
  encrypted_payload: string;
  created_at: string;
  updated_at: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  response_status?: number;
  body_text_excerpt: string;
  screenshot_ref?: string;
}

export interface ScoutEmbedHint {
  frame_index: number;
  provider:
    | "typeform"
    | "tally"
    | "jotform"
    | "hubspot"
    | "google_forms"
    | "airtable_form"
    | "fillout"
    | "recaptcha"
    | "unknown";
  frame_url: string;
  frame_title?: string;
  body_text_excerpt: string;
  cta_candidates: string[];
  submit_candidates: string[];
  screenshot_ref?: string;
  likely_interactive: boolean;
}

export interface ScoutLinkCandidate {
  text: string;
  href: string;
  kind: "submit" | "register" | "auth" | "other";
}

export type VisualPageClassification =
  | "submit_form"
  | "register_gate"
  | "login_gate"
  | "404_or_stale_submit_path"
  | "dashboard_or_menu"
  | "marketing_or_homepage"
  | "captcha_or_human_verification"
  | "success_or_confirmation"
  | "unknown";

export interface VisualVerificationResult {
  classification: VisualPageClassification;
  confidence: number;
  summary: string;
  model?: string;
  attempted_models?: string[];
}

export interface VisualRecoveryHint {
  recovery_possible: boolean;
  confidence: number;
  summary: string;
  target_text_candidates: string[];
  target_kind?: "submit" | "login" | "signup" | "form" | "other" | "unknown";
  model?: string;
  attempted_models?: string[];
}

export type PageClassificationConfidence = "high" | "medium" | "low";

export type PageAmbiguityFlag =
  | "not_found_but_reachable"
  | "mixed_submit_and_auth_signals"
  | "login_vs_register_ambiguous"
  | "dashboard_like"
  | "overlay_or_interstitial_present"
  | "no_visible_form_but_possible_entry"
  | "post_click_state_unclear";

export interface PageAssessment {
  page_reachable: boolean;
  classification_confidence: PageClassificationConfidence;
  ambiguity_flags: PageAmbiguityFlag[];
  visual_verification_required: boolean;
}

export interface ScoutResult {
  ok: boolean;
  surface_summary: string;
  field_hints: string[];
  auth_hints: string[];
  anti_bot_hints: string[];
  submit_candidates: string[];
  evidence_sufficiency: boolean;
  visual_probe_recommended?: boolean;
  embed_hints: ScoutEmbedHint[];
  link_candidates: ScoutLinkCandidate[];
  page_snapshot: PageSnapshot;
  page_assessment?: PageAssessment;
}

export interface AgentObservationElement {
  index: number;
  descriptor: string;
  text: string;
  allowed_actions: Array<"click_index" | "input_index" | "select_index">;
}

export interface AgentObservation {
  url: string;
  title: string;
  raw_text_excerpt: string;
  elements: AgentObservationElement[];
  page_assessment?: PageAssessment;
}

export interface AgentDecisionInput {
  task_id: string;
  hostname: string;
  flow_family?: FlowFamily;
  submission: SubmissionContext;
  opportunity_class?: OpportunityClass;
  registration?: {
    required: boolean;
    allow_public_signup: boolean;
    email?: string;
    username?: string;
    password?: string;
    existing_account_ref?: string;
  };
  scout_hints: Pick<ScoutResult, "field_hints" | "auth_hints" | "anti_bot_hints" | "submit_candidates">;
  scout_page_assessment?: PageAssessment;
  observation: AgentObservation;
  recent_actions: Array<{
    step_number: number;
    action: AgentDecisionAction;
    detail: string;
    result: "ok" | "failed";
  }>;
  budget: {
    elapsed_ms: number;
    remaining_actions: number;
    repeated_surface_count: number;
    repeated_action_count: number;
    no_progress_streak: number;
  };
  policy: {
    allow_paid_listing: boolean;
    allow_reciprocal: boolean;
    allow_captcha_bypass: boolean;
    allow_google_oauth_chooser: boolean;
    allow_password_login: boolean;
    allow_2fa: boolean;
  };
}

export interface AgentDecision {
  action: AgentDecisionAction;
  url?: string;
  index?: number;
  text?: string;
  value?: string;
  keys?: string;
  wait_kind?: "text" | "selector";
  wait_target?: string;
  wait_timeout_ms?: number;
  wait_state?: "attached" | "detached" | "visible" | "hidden";
  next_status?: TaskStatus;
  wait_reason_code?: string;
  resume_trigger?: string;
  resolution_owner?: ResolutionOwner;
  resolution_mode?: ResolutionMode;
  terminal_class?: TerminalClass;
  skip_reason_code?: string;
  detail?: string;
  reason: string;
  confidence: number;
  expected_signal: string;
  stop_if_observed: string[];
}

export interface AgentLoopTraceStep {
  step_number: number;
  observation: AgentObservation;
  decision: AgentDecision;
  execution: {
    ok: boolean;
    detail: string;
    before_url: string;
    after_url: string;
    duration_ms: number;
  };
}

export interface AgentLoopTrace {
  task_id: string;
  agent_backend: string;
  started_at: string;
  finished_at: string;
  stop_reason: string;
  final_url: string;
  final_title: string;
  final_excerpt: string;
  steps: AgentLoopTraceStep[];
}

export interface ProposedOutcome {
  next_status: TaskStatus;
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
  visual_verification?: VisualVerificationResult;
  vision_recovery_attempts?: Array<Record<string, unknown>>;
  pending_account?: AccountDraft;
}

export interface AccountDraft {
  hostname: string;
  email: string;
  email_alias: string;
  auth_mode: AccountAuthMode;
  verified: boolean;
  login_url?: string;
  submit_url?: string;
  credential_ref?: string;
  credential_payload?: CredentialPayload;
  last_registration_result: string;
}

export interface AgentTraceEnvelope {
  trace: AgentLoopTrace;
  handoff: TakeoverHandoff;
  account?: AccountDraft;
}

export type ReplayStep =
  | { action: "goto"; url: string }
  | { action: "wait_for_text"; text: string; timeout_ms?: number }
  | { action: "wait_for_selector"; selector: string; timeout_ms?: number; state?: "attached" | "detached" | "visible" | "hidden" }
  | { action: "wait_for_url_includes"; value: string; timeout_ms?: number }
  | { action: "click_text"; text: string; exact?: boolean }
  | { action: "click_role"; role: "button" | "link" | "textbox"; name: string }
  | { action: "click_selector"; selector: string }
  | { action: "fill_label"; label: string; value: string; exact?: boolean }
  | { action: "fill_placeholder"; placeholder: string; value: string }
  | { action: "fill_selector"; selector: string; value: string }
  | { action: "select_selector"; selector: string; value: string }
  | { action: "press_key"; key: string }
  | { action: "assert_text"; text: string }
  | { action: "screenshot"; name: string };

export interface TrajectoryPlaybook {
  id: string;
  hostname: string;
  capture_source: "manual" | "agent_live_takeover";
  surface_signature: string;
  preconditions: string[];
  steps: ReplayStep[];
  anchors: string[];
  postconditions: string[];
  success_signals: string[];
  fallback_notes: string[];
  replay_confidence: number;
  distilled_from_trace_ref?: string;
  agent_backend?: string;
  created_at: string;
  updated_at: string;
}

export interface ReplayResult {
  ok: boolean;
  next_status: TaskStatus;
  detail: string;
  artifact_refs: string[];
  wait?: WaitMetadata;
  terminal_class?: TerminalClass;
  skip_reason_code?: string;
}

export interface TakeoverResult {
  ok: boolean;
  next_status: TaskStatus;
  detail: string;
  artifact_refs: string[];
  wait?: WaitMetadata;
  terminal_class?: TerminalClass;
  skip_reason_code?: string;
  playbook?: TrajectoryPlaybook;
  agent_trace_ref?: string;
  agent_backend?: string;
  agent_steps_count?: number;
  link_verification?: LinkVerificationResult;
}

export interface PrepareResult {
  mode: "replay_completed" | "ready_for_agent_loop" | "task_stopped";
  task: TaskRecord;
  effective_target_url: string;
  replay_hit: boolean;
  opportunity_class?: OpportunityClass;
  scout_artifact_ref?: string;
  scout?: ScoutResult;
  account_candidate?: AccountRecord;
  account_credentials?: CredentialPayload;
  registration_required?: boolean;
  registration_email_alias?: string;
  mailbox_query?: string;
  email_verification_continuation?: EmailVerificationContinuation;
}

export interface MissingInputResolvedField extends MissingInputField {
  value: string;
  source: string;
}

export interface MissingInputFieldSummary extends MissingInputField {
  count: number;
  example_task_ids: string[];
  example_hostnames: string[];
}

export interface MissingInputCompleteness {
  core_ready: boolean;
  flow_ready: boolean;
  conditional_ready: boolean;
  missing_core_fields: string[];
  missing_flow_fields: string[];
  missing_conditional_fields: string[];
}

export interface MissingInputPreflightReport {
  promoted_hostname?: string;
  tasks_inspected: number;
  tasks_missing_input: number;
  resolved_fields: MissingInputResolvedField[];
  auto_resolvable_fields: MissingInputResolvedField[];
  unresolved_fields: MissingInputFieldSummary[];
  completeness: MissingInputCompleteness;
  user_prompt?: string;
}

export type InitGateMode = "interactive" | "unattended";

export type InitGateStatus = "ready_to_execute" | "needs_user_input" | "blocked_unattended";

export interface InitGateResult {
  mode: InitGateMode;
  status: InitGateStatus;
  blocking: boolean;
  summary: string;
  report: MissingInputPreflightReport;
}

export interface FinalizeResult extends TakeoverResult {
  account_created?: boolean;
  credential_ref?: string;
}
