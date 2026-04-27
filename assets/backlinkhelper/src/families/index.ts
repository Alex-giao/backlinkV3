import type { FlowFamily } from "../shared/types.js";
import { DEV_BLOG_FAMILY, FORUM_POST_FAMILY, FORUM_PROFILE_FAMILY, WP_COMMENT_FAMILY } from "./non-directory.js";
import { SAAS_DIRECTORY_FAMILY } from "./saas-directory.js";
import type { FamilyConfig } from "./types.js";

const FAMILY_CONFIGS: Record<FlowFamily, FamilyConfig> = {
  saas_directory: SAAS_DIRECTORY_FAMILY,
  forum_profile: FORUM_PROFILE_FAMILY,
  forum_post: FORUM_POST_FAMILY,
  wp_comment: WP_COMMENT_FAMILY,
  dev_blog: DEV_BLOG_FAMILY,
};

export function resolveFlowFamily(flowFamily?: FlowFamily): FlowFamily {
  return flowFamily ?? "saas_directory";
}

export function getFamilyConfig(flowFamily?: FlowFamily): FamilyConfig {
  const resolved = resolveFlowFamily(flowFamily);
  return FAMILY_CONFIGS[resolved];
}
