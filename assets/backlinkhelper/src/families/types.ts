import type { FlowFamily } from "../shared/types.js";

export interface FamilyScoutConfig {
  fieldHints: readonly string[];
  authHints: readonly string[];
  antiBotHints: readonly string[];
  evidenceSignals: readonly string[];
}

export interface FamilyPageAssessmentConfig {
  submitSignals: readonly string[];
  loginSignals: readonly string[];
  registerSignals: readonly string[];
  dashboardSignals: readonly string[];
  overlaySignals: readonly string[];
}

export interface FamilyCompletenessProfile {
  core_ready_fields: readonly string[];
  flow_ready_fields: readonly string[];
  conditional_ready_fields: readonly string[];
}

export interface FamilyTaskProgressConfig {
  submitSignals: readonly string[];
  formSignals: readonly string[];
  authSignals: readonly string[];
  confirmationSignals: readonly string[];
  progressSignals?: readonly string[];
  captchaSignals: readonly string[];
}

export interface FamilyReasonInferenceConfig {
  terminalSuccessSignals: readonly string[];
  externalEventSignals: readonly string[];
  paidSignals: readonly string[];
  captchaSignals: readonly string[];
  manualAuthSignals: readonly string[];
  missingInputSignals: readonly string[];
  staleSubmitSignals: readonly string[];
  reciprocalSignals: readonly string[];
  runtimeSignals: readonly string[];
}

export interface FamilyTakeoverConfig {
  successSignals: readonly string[];
  emailVerificationSignals: readonly string[];
  pendingSignals?: readonly string[];
  draftSignals?: readonly string[];
  publishedSignals?: readonly string[];
  antiSpamSignals?: readonly string[];
}

export interface FamilySemanticContract {
  requires_live_link_verification_for_success: boolean;
  pending_wait_reason_codes?: readonly string[];
  progress_wait_reason_codes?: readonly string[];
  review_wait_reason_codes?: readonly string[];
  policy_wait_reason_codes?: readonly string[];
}

export interface FamilyConfig {
  flowFamily: FlowFamily;
  scout: FamilyScoutConfig;
  pageAssessment: FamilyPageAssessmentConfig;
  completeness: FamilyCompletenessProfile;
  taskProgress: FamilyTaskProgressConfig;
  reasonInference: FamilyReasonInferenceConfig;
  takeover: FamilyTakeoverConfig;
  semanticContract: FamilySemanticContract;
}
