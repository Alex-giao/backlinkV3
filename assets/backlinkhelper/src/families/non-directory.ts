import type { FamilyConfig } from "./types.js";

const SHARED_AUTH_HINTS = [
  "sign in",
  "log in",
  "create account",
  "register",
  "join",
  "password",
  "continue with google",
  "sign in with google",
  "login with google",
  "with google",
  "with github",
  "with twitter",
] as const;

const SHARED_ANTI_BOT_HINTS = [
  "captcha",
  "cloudflare",
  "verify you are human",
  "loading captcha",
  "i'm not a robot",
  "recaptcha",
  "hcaptcha",
  "turnstile",
] as const;

const SHARED_OVERLAY_SIGNALS = [
  "cookie",
  "accept all",
  "accept cookies",
  "consent",
  "privacy choices",
  "human verification",
  "are you human",
  "verify you are human",
  "turnstile",
  "captcha",
] as const;

const SHARED_REASON_INFERENCE = {
  paidSignals: ["paid", "sponsored listing", "subscription", "sponsor", "sponsored", "pricing", "payment"],
  captchaSignals: ["captcha", "recaptcha", "hcaptcha", "turnstile", "human verification", "security code", "visual confirmation"],
  manualAuthSignals: ["login wall", "requires unsupported authentication", "password", "2fa", "passkey"],
  missingInputSignals: ["required input", "missing required fields", "required fields", "all fields are required"],
  staleSubmitSignals: ["stale submit path", "404_or_stale_submit_path"],
  reciprocalSignals: ["reciprocal backlink", "add our backlink", "add our link", "link back to us", "live reciprocal backlink url"],
  runtimeSignals: ["runtime", "config conflict", "session mismatch", "preflight", "timeout"],
  externalEventSignals: ["please check your email", "check your email", "verify your email", "email verification", "confirmation email"],
} as const;

export const FORUM_PROFILE_FAMILY: FamilyConfig = {
  flowFamily: "forum_profile",
  scout: {
    fieldHints: ["website", "bio", "about me", "signature", "headline", "display name", "social links", "member profile", "account settings", "profile"],
    authHints: SHARED_AUTH_HINTS,
    antiBotHints: SHARED_ANTI_BOT_HINTS,
    evidenceSignals: ["edit profile", "profile settings", "account settings", "member profile", "website", "bio", "about me", "signature", "social links"],
  },
  pageAssessment: {
    submitSignals: ["edit profile", "update profile", "profile settings", "account settings", "member profile", "save profile", "about me", "signature", "website", "social links"],
    loginSignals: ["password", "sign in", "log in", "login", "passkey", "verify it's you", "verify its you", "2fa", "two-factor"],
    registerSignals: ["sign up", "create account", "register", "join now", "start free"],
    dashboardSignals: ["profile", "member profile", "account settings", "dashboard", "sidebar", "logout", "sign out"],
    overlaySignals: SHARED_OVERLAY_SIGNALS,
  },
  completeness: {
    core_ready_fields: ["company_name", "contact_email", "primary_category"],
    flow_ready_fields: [],
    conditional_ready_fields: [],
  },
  taskProgress: {
    submitSignals: ["edit profile", "update profile", "profile settings", "account settings", "member profile", "save profile", "signature", "website", "social links"],
    formSignals: ["website", "bio", "about me", "signature", "headline", "display name", "social links", "member profile", "account settings", "profile"],
    authSignals: SHARED_AUTH_HINTS,
    confirmationSignals: ["profile updated", "changes saved", "saved successfully"],
    captchaSignals: ["captcha", "verify you are human", "cloudflare"],
  },
  reasonInference: {
    terminalSuccessSignals: [],
    ...SHARED_REASON_INFERENCE,
  },
  takeover: {
    successSignals: ["profile updated", "changes saved", "saved successfully"],
    emailVerificationSignals: SHARED_REASON_INFERENCE.externalEventSignals,
    pendingSignals: ["profile updated", "changes saved", "saved successfully"],
  },
  semanticContract: {
    requires_live_link_verification_for_success: true,
    pending_wait_reason_codes: ["PROFILE_PUBLICATION_PENDING"],
  },
};

export const WP_COMMENT_FAMILY: FamilyConfig = {
  flowFamily: "wp_comment",
  scout: {
    fieldHints: ["comment", "message", "website", "name", "email", "reply", "akismet", "moderation"],
    authHints: SHARED_AUTH_HINTS,
    antiBotHints: [...SHARED_ANTI_BOT_HINTS, "akismet", "spam"],
    evidenceSignals: ["leave a reply", "post comment", "submit comment", "comment", "awaiting moderation", "comment posted"],
  },
  pageAssessment: {
    submitSignals: ["leave a reply", "post comment", "submit comment", "comment", "reply"],
    loginSignals: ["password", "sign in", "log in", "login", "passkey", "verify it's you", "verify its you", "2fa", "two-factor"],
    registerSignals: ["sign up", "create account", "register", "join now", "start free"],
    dashboardSignals: ["dashboard", "profile", "logout", "sign out"],
    overlaySignals: SHARED_OVERLAY_SIGNALS,
  },
  completeness: {
    core_ready_fields: ["company_name", "contact_email", "primary_category"],
    flow_ready_fields: [],
    conditional_ready_fields: [],
  },
  taskProgress: {
    submitSignals: ["leave a reply", "post comment", "submit comment", "comment", "reply"],
    formSignals: ["comment", "message", "website", "name", "email", "reply"],
    authSignals: SHARED_AUTH_HINTS,
    confirmationSignals: ["comment is awaiting moderation", "your comment is awaiting moderation", "comment submitted", "comment posted", "your comment has been posted"],
    captchaSignals: ["captcha", "verify you are human", "cloudflare"],
  },
  reasonInference: {
    terminalSuccessSignals: [],
    ...SHARED_REASON_INFERENCE,
  },
  takeover: {
    successSignals: ["comment is awaiting moderation", "your comment is awaiting moderation", "comment submitted", "comment posted", "your comment has been posted"],
    emailVerificationSignals: SHARED_REASON_INFERENCE.externalEventSignals,
    pendingSignals: ["comment is awaiting moderation", "your comment is awaiting moderation", "comment submitted"],
    publishedSignals: ["comment posted", "your comment has been posted", "comment published"],
    antiSpamSignals: ["akismet", "comment looks like spam", "duplicate comment detected", "spam detected", "anti-spam", "clean talk", "cleantalk"],
  },
  semanticContract: {
    requires_live_link_verification_for_success: true,
    pending_wait_reason_codes: ["COMMENT_MODERATION_PENDING"],
    review_wait_reason_codes: ["COMMENT_PUBLISHED_NO_LINK"],
    policy_wait_reason_codes: ["COMMENT_ANTI_SPAM_BLOCKED"],
  },
};

export const DEV_BLOG_FAMILY: FamilyConfig = {
  flowFamily: "dev_blog",
  scout: {
    fieldHints: ["title", "summary", "markdown", "editor", "tags", "publish", "draft", "submit for review", "write post", "write article"],
    authHints: SHARED_AUTH_HINTS,
    antiBotHints: SHARED_ANTI_BOT_HINTS,
    evidenceSignals: ["write post", "new post", "submit article", "submit for review", "publish", "draft", "editor", "draft saved", "submitted for review"],
  },
  pageAssessment: {
    submitSignals: ["write post", "new post", "submit article", "submit for review", "publish", "draft", "editor", "write article"],
    loginSignals: ["password", "sign in", "log in", "login", "passkey", "verify it's you", "verify its you", "2fa", "two-factor"],
    registerSignals: ["sign up", "create account", "register", "join now", "start free"],
    dashboardSignals: ["dashboard", "profile", "editor", "drafts", "logout", "sign out"],
    overlaySignals: SHARED_OVERLAY_SIGNALS,
  },
  completeness: {
    core_ready_fields: ["company_name", "contact_email", "primary_category"],
    flow_ready_fields: [],
    conditional_ready_fields: [],
  },
  taskProgress: {
    submitSignals: ["write post", "new post", "submit article", "submit for review", "publish", "editor"],
    formSignals: ["title", "summary", "markdown", "editor", "tags", "publish", "draft"],
    authSignals: SHARED_AUTH_HINTS,
    confirmationSignals: ["submitted for review", "article submitted", "published", "article published"],
    progressSignals: ["draft saved", "saved draft"],
    captchaSignals: ["captcha", "verify you are human", "cloudflare"],
  },
  reasonInference: {
    terminalSuccessSignals: [],
    ...SHARED_REASON_INFERENCE,
  },
  takeover: {
    successSignals: ["draft saved", "submitted for review", "article submitted", "published", "article published"],
    emailVerificationSignals: SHARED_REASON_INFERENCE.externalEventSignals,
    pendingSignals: ["submitted for review", "article submitted", "pending editorial review"],
    draftSignals: ["draft saved", "saved draft"],
    publishedSignals: ["published", "article published", "post published", "is now live"],
  },
  semanticContract: {
    requires_live_link_verification_for_success: true,
    pending_wait_reason_codes: ["ARTICLE_SUBMITTED_PENDING_EDITORIAL", "ARTICLE_PUBLICATION_PENDING"],
    progress_wait_reason_codes: ["ARTICLE_DRAFT_SAVED"],
    review_wait_reason_codes: ["ARTICLE_PUBLISHED_NO_LINK"],
  },
};
