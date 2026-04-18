import type { FlowFamily } from "../shared/types.js";
import { getFamilyConfig, resolveFlowFamily } from "./index.js";

export interface FamilyPromptContext {
  flowFamily: FlowFamily;
  label: string;
  continuationCues: string[];
  formCues: string[];
  authCues: string[];
  confirmationCues: string[];
  captchaCues: string[];
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

export function describeFlowFamily(flowFamily?: FlowFamily): string {
  switch (resolveFlowFamily(flowFamily)) {
    case "forum_profile":
      return "forum profile";
    case "wp_comment":
      return "WordPress comment";
    case "dev_blog":
      return "developer blog";
    case "saas_directory":
    default:
      return "SaaS directory";
  }
}

export function summarizeCueList(values: readonly string[], limit = 6): string {
  const items = dedupe(values).slice(0, limit);
  return items.length > 0 ? items.join(" | ") : "none";
}

export function buildFamilyPromptContext(flowFamily?: FlowFamily): FamilyPromptContext {
  const resolved = resolveFlowFamily(flowFamily);
  const config = getFamilyConfig(resolved);
  return {
    flowFamily: resolved,
    label: describeFlowFamily(resolved),
    continuationCues: dedupe([...config.pageAssessment.submitSignals, ...config.taskProgress.submitSignals]),
    formCues: dedupe(config.taskProgress.formSignals),
    authCues: dedupe([...config.pageAssessment.loginSignals, ...config.pageAssessment.registerSignals]),
    confirmationCues: dedupe([
      ...config.taskProgress.confirmationSignals,
      ...config.takeover.successSignals,
      ...config.takeover.emailVerificationSignals,
    ]),
    captchaCues: dedupe([...config.taskProgress.captchaSignals, ...config.reasonInference.captchaSignals]),
  };
}
