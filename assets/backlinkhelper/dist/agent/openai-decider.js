import { buildFamilyPromptContext, summarizeCueList } from "../families/prompt-context.js";
const OPENAI_RESPONSE_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        action: {
            type: "string",
            enum: [
                "open_url",
                "click_index",
                "input_index",
                "select_index",
                "keys",
                "wait",
                "finish_submission_attempt",
                "classify_terminal",
                "abort_retryable",
            ],
        },
        url: { type: ["string", "null"] },
        index: { type: ["number", "null"] },
        text: { type: ["string", "null"] },
        value: { type: ["string", "null"] },
        keys: { type: ["string", "null"] },
        wait_kind: { type: ["string", "null"], enum: ["text", "selector", null] },
        wait_target: { type: ["string", "null"] },
        wait_timeout_ms: { type: ["number", "null"] },
        wait_state: {
            type: ["string", "null"],
            enum: ["attached", "detached", "visible", "hidden", null],
        },
        next_status: {
            type: ["string", "null"],
            enum: [
                "READY",
                "RUNNING",
                "WAITING_EXTERNAL_EVENT",
                "WAITING_POLICY_DECISION",
                "WAITING_MISSING_INPUT",
                "WAITING_MANUAL_AUTH",
                "WAITING_RETRY_DECISION",
                "WAITING_SITE_RESPONSE",
                "RETRYABLE",
                "DONE",
                "SKIPPED",
                null,
            ],
        },
        wait_reason_code: { type: ["string", "null"] },
        resume_trigger: { type: ["string", "null"] },
        resolution_owner: { type: ["string", "null"], enum: ["system", "gog", "none", null] },
        resolution_mode: { type: ["string", "null"], enum: ["auto_resume", "terminal_audit", null] },
        terminal_class: {
            type: ["string", "null"],
            enum: [
                "login_required",
                "captcha_blocked",
                "paid_listing",
                "upstream_5xx",
                "outcome_not_confirmed",
                "takeover_runtime_error",
                null,
            ],
        },
        skip_reason_code: { type: ["string", "null"] },
        detail: { type: ["string", "null"] },
        reason: { type: "string" },
        confidence: { type: "number" },
        expected_signal: { type: "string" },
        stop_if_observed: {
            type: "array",
            items: { type: "string" },
        },
    },
    required: [
        "action",
        "url",
        "index",
        "text",
        "value",
        "keys",
        "wait_kind",
        "wait_target",
        "wait_timeout_ms",
        "wait_state",
        "next_status",
        "wait_reason_code",
        "resume_trigger",
        "resolution_owner",
        "resolution_mode",
        "terminal_class",
        "skip_reason_code",
        "detail",
        "reason",
        "confidence",
        "expected_signal",
        "stop_if_observed",
    ],
};
const COMMON_SYSTEM_PROMPT = [
    "You are the unattended browser control brain for a backlink submission system.",
    "Your job is to choose exactly one next browser-use CLI action.",
    "Success rate is the top priority, but you must obey hard unattended boundaries.",
    "Never ask a human for help. If you hit a forbidden boundary, classify it and stop.",
    "Allowed unattended auth:",
    "- Google account chooser on an already logged-in Chrome profile",
    "- consent / continue screens",
    "- reusing existing login state",
    "- user-visible OAuth buttons such as 'with Google' when they are actually rendered on the page",
    "- public, visible email/password signup forms when registration.allow_public_signup=true and you use only the provided registration credentials",
    "Forbidden unattended actions:",
    "- entering passwords on existing-account login forms or on signup flows without provided registration credentials",
    "- handling 2FA, passkeys, SMS, device approval",
    "- bypassing CAPTCHA or managed anti-bot challenges",
    "- making paid listing decisions",
    "- using hidden or non-interactable auth inputs via DOM dispatch, JS injection, or forced selector fills",
    "If a visible auth surface shows OAuth buttons but local email/password fields are hidden or not interactable, treat the route as OAuth-only.",
    "Do not infer a local signup path just because hidden inputs exist in the DOM.",
    "Prefer a user-visible Google OAuth route over a speculative local email-signup route when both seem possible.",
    "If `scout_page_assessment.visual_verification_required` or `observation.page_assessment.visual_verification_required` is true, treat the page as low-confidence: do not rush into login-required, no-entry, or marketing-page conclusions while the page is still reachable.",
    "On reachable pages with mixed submit/auth signals or soft-404/stale-submit-path signs, keep searching for the true submit or sign-up entry before classifying manual auth.",
    "Treat visible family-appropriate continuation paths as credible progress surfaces, not as manual-auth blockers.",
    "Only classify WAITING_MANUAL_AUTH when the current surface is clearly an existing-account login wall and there is no credible sign-up or submit path left to try.",
    "If registration.required=true and the site is showing a public account-creation form, prefer continuing with signup over manual-auth classification.",
    "If opportunity_class='deep_first', prioritize advancing the real submit flow and avoid stopping after a single reachable observation unless a hard blocker or success signal is already clear.",
    "When public signup is allowed, you may fill visible username/email/password/confirm-password fields using the supplied registration credentials for this site.",
    "When you are confident the submit attempt has already been made, use finish_submission_attempt.",
    "When the page has clearly reached a policy, auth, or missing-input boundary, use classify_terminal with a concrete status and reason code.",
    "When you are stuck without a confident next move, use abort_retryable instead of wandering.",
    "Return only the structured JSON matching the schema.",
];
export function buildSystemPrompt(flowFamily) {
    const family = buildFamilyPromptContext(flowFamily);
    return [
        ...COMMON_SYSTEM_PROMPT,
        `Current flow family: ${family.label} (${family.flowFamily}).`,
        `Family-appropriate continuation cues: ${summarizeCueList(family.continuationCues)}.`,
        `Family-appropriate form cues: ${summarizeCueList(family.formCues)}.`,
        `Family-appropriate auth cues: ${summarizeCueList(family.authCues)}.`,
        `Family-appropriate confirmation / wait cues: ${summarizeCueList(family.confirmationCues)}.`,
        `Family-appropriate CAPTCHA / human-verification cues: ${summarizeCueList(family.captchaCues)}.`,
        "Do not import examples from other families when the current family already provides a clearer interpretation.",
    ].join("\n");
}
function extractOutputText(payload) {
    if (payload.output_text?.trim()) {
        return payload.output_text.trim();
    }
    for (const outputItem of payload.output ?? []) {
        for (const contentItem of outputItem.content ?? []) {
            if ("text" in contentItem && typeof contentItem.text === "string" && contentItem.text.trim()) {
                return contentItem.text.trim();
            }
            if ("value" in contentItem && typeof contentItem.value === "string" && contentItem.value.trim()) {
                return contentItem.value.trim();
            }
        }
    }
    return undefined;
}
function sanitizeDecision(raw) {
    const normalizedText = raw.action === "input_index" && typeof raw.text !== "string" && typeof raw.value === "string"
        ? raw.value
        : raw.text;
    if (raw.action === "input_index" && raw.index === undefined && !normalizedText) {
        return {
            ...raw,
            action: "abort_retryable",
            detail: raw.detail ??
                "Model proposed input_index without a concrete target. Stop and let runtime recovery handle the next move.",
            wait_reason_code: raw.wait_reason_code ?? "VISUAL_VERIFICATION_REQUIRED",
            resolution_owner: raw.resolution_owner ?? "system",
            resolution_mode: raw.resolution_mode ?? "auto_resume",
            next_status: raw.next_status ?? "RETRYABLE",
            text: normalizedText,
            confidence: Math.min(1, Math.max(0, Number.isFinite(raw.confidence) ? raw.confidence : 0)),
            stop_if_observed: Array.isArray(raw.stop_if_observed) ? raw.stop_if_observed.slice(0, 8) : [],
        };
    }
    return {
        ...raw,
        text: normalizedText,
        confidence: Math.min(1, Math.max(0, Number.isFinite(raw.confidence) ? raw.confidence : 0)),
        stop_if_observed: Array.isArray(raw.stop_if_observed) ? raw.stop_if_observed.slice(0, 8) : [],
    };
}
export function createOpenAIDecider(config) {
    const apiKey = process.env[config.api_key_env]?.trim();
    if (!apiKey) {
        throw new Error(`Missing required environment variable ${config.api_key_env} for the OpenAI agent backend.`);
    }
    return {
        backend: "openai",
        config,
        async decide(input) {
            const response = await fetch(`${config.base_url}/responses`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: config.model,
                    instructions: buildSystemPrompt(input.flow_family),
                    input: JSON.stringify(input),
                    max_output_tokens: 1_200,
                    text: {
                        format: {
                            type: "json_schema",
                            name: "agent_decision",
                            strict: true,
                            schema: OPENAI_RESPONSE_SCHEMA,
                        },
                    },
                }),
                signal: AbortSignal.timeout(60_000),
            });
            const payload = (await response.json().catch(async () => ({
                error: { message: await response.text().catch(() => "OpenAI API returned a non-JSON response.") },
            })));
            if (!response.ok) {
                throw new Error(payload.error?.message ?? `OpenAI API returned ${response.status}.`);
            }
            const outputText = extractOutputText(payload);
            if (!outputText) {
                throw new Error("OpenAI agent backend returned no structured output text.");
            }
            const parsed = JSON.parse(outputText);
            return sanitizeDecision(parsed);
        },
    };
}
