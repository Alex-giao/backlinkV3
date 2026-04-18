import { DEV_BLOG_FAMILY, FORUM_PROFILE_FAMILY, WP_COMMENT_FAMILY } from "./non-directory.js";
import { SAAS_DIRECTORY_FAMILY } from "./saas-directory.js";
const FAMILY_CONFIGS = {
    saas_directory: SAAS_DIRECTORY_FAMILY,
    forum_profile: FORUM_PROFILE_FAMILY,
    wp_comment: WP_COMMENT_FAMILY,
    dev_blog: DEV_BLOG_FAMILY,
};
export function resolveFlowFamily(flowFamily) {
    return flowFamily ?? "saas_directory";
}
export function getFamilyConfig(flowFamily) {
    const resolved = resolveFlowFamily(flowFamily);
    return FAMILY_CONFIGS[resolved];
}
