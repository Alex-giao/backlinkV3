import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildFamilyPromptContext, summarizeCueList } from "../families/prompt-context.js";
function extractOutputText(payload) {
    return (payload.output ?? [])
        .flatMap((item) => item.content ?? [])
        .filter((item) => item.type === "output_text")
        .map((item) => item.text ?? "")
        .join("")
        .trim();
}
function inferMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".jpg" || ext === ".jpeg") {
        return "image/jpeg";
    }
    if (ext === ".webp") {
        return "image/webp";
    }
    if (ext === ".gif") {
        return "image/gif";
    }
    return "image/png";
}
function clampConfidence(value) {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
        return 0;
    }
    return Math.min(1, Math.max(0, numeric));
}
const CLASSIFICATIONS = [
    "submit_form",
    "register_gate",
    "login_gate",
    "404_or_stale_submit_path",
    "dashboard_or_menu",
    "marketing_or_homepage",
    "captcha_or_human_verification",
    "success_or_confirmation",
    "unknown",
];
const INLINE_CAPTCHA_SIGNALS = [
    "captcha",
    "human verification",
    "verify you are human",
    "visual confirmation",
    "security code",
    "i'm not a robot",
    "im not a robot",
    "turnstile",
    "recaptcha",
    "this helps prevent automated registrations",
];
const SUCCESS_SIGNALS = [
    "thank you",
    "submission received",
    "pending review",
    "check your email",
    "verify your email",
    "we will review",
    "successfully submitted",
    "thanks for submitting",
];
const FAILURE_SIGNALS = [
    "error trying to send your message",
    "please try again later",
    "submission failed",
    "something went wrong",
    "invalid",
    "required field",
    "fix the following",
];
function buildVisualSuccessSignals(flowFamily) {
    const family = buildFamilyPromptContext(flowFamily);
    return [...new Set([...SUCCESS_SIGNALS, ...family.confirmationCues])];
}
function buildInlineCaptchaSignals(flowFamily) {
    const family = buildFamilyPromptContext(flowFamily);
    return [...new Set([...INLINE_CAPTCHA_SIGNALS, ...family.captchaCues])];
}
function buildFamilyPromptLines(flowFamily) {
    const family = buildFamilyPromptContext(flowFamily);
    return [
        `Flow family: ${family.label} (${family.flowFamily})`,
        `Family-appropriate progress cues: ${summarizeCueList(family.continuationCues)}`,
        `Family-appropriate form cues: ${summarizeCueList(family.formCues)}`,
        `Family-appropriate auth cues: ${summarizeCueList(family.authCues)}`,
        `Family-appropriate confirmation cues: ${summarizeCueList(family.confirmationCues)}`,
    ];
}
function includesAny(text, needles) {
    return needles.some((needle) => text.includes(needle));
}
function buildSignalText(args) {
    return [
        args.pageUrl,
        args.pageTitle,
        args.bodyExcerpt,
        ...(args.submitCandidates ?? []),
        ...(args.authHints ?? []),
        ...(args.fieldHints ?? []),
        ...(args.antiBotHints ?? []),
        ...(args.linkCandidates ?? []).flatMap((candidate) => [candidate.text, candidate.href, candidate.kind]),
    ]
        .filter((value) => Boolean(value))
        .join("\n")
        .toLowerCase();
}
export function buildVisualPrompt(args, mode) {
    const instructions = [
        "Classify this webpage screenshot into exactly one coarse category.",
        "Prefer unknown when evidence is mixed.",
        "Use family-appropriate cues as the primary interpretation layer; avoid importing cues from unrelated families.",
        "If the page looks like a soft-404 or stale submit path with submit/auth navigation mixed together, classify as 404_or_stale_submit_path.",
        "Only classify login_gate when the screen is clearly an existing-account login wall and there is no credible sign-up or submit path.",
        "Do not classify login_gate just because a header login box exists if the main content is an active family-appropriate progress surface.",
        "Classify as captcha_or_human_verification when solving a visible security code, visual confirmation, CAPTCHA, turnstile, or human-verification challenge is required before submission can continue, even if the surrounding page is otherwise a normal form.",
        "Classify as success_or_confirmation only when the page clearly shows acceptance, pending review, check-email, verify-email, thank-you, or a family-appropriate completion state and there is no dominant failure message.",
        "If the page still shows a form plus an explicit submission error, do not classify success_or_confirmation; prefer submit_form or unknown.",
    ];
    if (mode === "boundary_recheck") {
        instructions.push("Re-check the screenshot carefully for boundary cases between submit_form, captcha_or_human_verification, and success_or_confirmation.", "When the page contains both a form and an inline CAPTCHA/security-code requirement, prefer captcha_or_human_verification over submit_form.", "When the page contains both a form and an inline error after submission, prefer submit_form or unknown, not success_or_confirmation.");
    }
    return [
        ...instructions,
        ...buildFamilyPromptLines(args.flowFamily),
        `URL: ${args.pageUrl}`,
        `Title: ${args.pageTitle ?? ""}`,
        `Body excerpt: ${(args.bodyExcerpt ?? "").slice(0, 2000)}`,
        `Submit candidates: ${(args.submitCandidates ?? []).join(" | ")}`,
        `Auth hints: ${(args.authHints ?? []).join(" | ")}`,
        `Field hints: ${(args.fieldHints ?? []).join(" | ")}`,
        `Anti-bot hints: ${(args.antiBotHints ?? []).join(" | ")}`,
        `Link candidates: ${(args.linkCandidates ?? [])
            .slice(0, 8)
            .map((candidate) => `${candidate.kind}:${candidate.text}->${candidate.href}`)
            .join(" | ")}`,
    ].join("\n");
}
export function shouldRunBoundaryRecheck(args, result) {
    const signalText = buildSignalText(args);
    const hasInlineCaptchaSignal = includesAny(signalText, buildInlineCaptchaSignals(args.flowFamily));
    const hasSuccessSignal = includesAny(signalText, buildVisualSuccessSignals(args.flowFamily));
    const hasFailureSignal = includesAny(signalText, FAILURE_SIGNALS);
    if (result.classification === "submit_form" || result.classification === "unknown") {
        return hasInlineCaptchaSignal || hasSuccessSignal || hasFailureSignal;
    }
    if (result.classification === "success_or_confirmation" && hasFailureSignal) {
        return true;
    }
    return false;
}
async function invokeVisualClassification(args) {
    const response = await fetch(`${args.baseUrl.replace(/\/$/, "")}/responses`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${args.apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: args.model,
            input: [
                {
                    role: "user",
                    content: [
                        { type: "input_text", text: args.prompt },
                        { type: "input_image", image_url: args.imageUrl },
                    ],
                },
            ],
            text: {
                format: {
                    type: "json_schema",
                    name: "visual_verification",
                    schema: {
                        type: "object",
                        additionalProperties: false,
                        required: ["classification", "confidence", "summary"],
                        properties: {
                            classification: { type: "string", enum: [...CLASSIFICATIONS] },
                            confidence: { type: "number", minimum: 0, maximum: 1 },
                            summary: { type: "string" },
                        },
                    },
                    strict: true,
                },
            },
        }),
    });
    if (!response.ok) {
        throw new Error(`Visual verification failed for ${args.model} (${response.status}): ${await response.text()}`);
    }
    const payload = (await response.json());
    const raw = extractOutputText(payload);
    if (!raw) {
        throw new Error(`Visual verification returned no output text for ${args.model}.`);
    }
    const parsed = JSON.parse(raw);
    const classification = String(parsed.classification ?? "unknown");
    return {
        classification: CLASSIFICATIONS.includes(classification)
            ? classification
            : "unknown",
        confidence: clampConfidence(parsed.confidence),
        summary: String(parsed.summary ?? ""),
        model: args.model,
    };
}
async function invokeVisualRecoveryHint(args) {
    const response = await fetch(`${args.baseUrl.replace(/\/$/, "")}/responses`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${args.apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: args.model,
            input: [
                {
                    role: "user",
                    content: [
                        { type: "input_text", text: args.prompt },
                        { type: "input_image", image_url: args.imageUrl },
                    ],
                },
            ],
            text: {
                format: {
                    type: "json_schema",
                    name: "visual_recovery_hint",
                    schema: {
                        type: "object",
                        additionalProperties: false,
                        required: ["recovery_possible", "confidence", "summary", "target_text_candidates", "target_kind"],
                        properties: {
                            recovery_possible: { type: "boolean" },
                            confidence: { type: "number", minimum: 0, maximum: 1 },
                            summary: { type: "string" },
                            target_text_candidates: {
                                type: "array",
                                items: { type: "string" },
                                maxItems: 5,
                            },
                            target_kind: {
                                type: "string",
                                enum: ["submit", "login", "signup", "form", "other", "unknown"],
                            },
                        },
                    },
                    strict: true,
                },
            },
        }),
    });
    if (!response.ok) {
        throw new Error(`Visual recovery hint failed for ${args.model} (${response.status}): ${await response.text()}`);
    }
    const payload = (await response.json());
    const raw = extractOutputText(payload);
    if (!raw) {
        throw new Error(`Visual recovery hint returned no output text for ${args.model}.`);
    }
    const parsed = JSON.parse(raw);
    const targetKind = String(parsed.target_kind ?? "unknown");
    const validKinds = ["submit", "login", "signup", "form", "other", "unknown"];
    return {
        recovery_possible: Boolean(parsed.recovery_possible),
        confidence: clampConfidence(parsed.confidence),
        summary: String(parsed.summary ?? ""),
        target_text_candidates: Array.isArray(parsed.target_text_candidates)
            ? parsed.target_text_candidates
                .map((value) => String(value ?? "").trim())
                .filter(Boolean)
                .slice(0, 5)
            : [],
        target_kind: validKinds.includes(targetKind) ? targetKind : "unknown",
        model: args.model,
    };
}
export function buildRecoveryPrompt(args) {
    return [
        "You are helping recover a stuck browser automation flow.",
        "The page is reachable, but the automation is about to stop unless you can identify one visible next action.",
        "Only suggest a recovery when a user-visible control on the current screen is likely to move the flow forward.",
        "Never invent hidden controls, selectors, or off-screen elements.",
        "Prefer buttons, links, tabs, toggles, or CTA text that are actually visible on the screen.",
        "Use family-appropriate cues as the primary interpretation layer; avoid importing cues from unrelated families.",
        "If the current screen is a login/register mixed surface, prefer the visible path that keeps unattended progress possible.",
        "If no credible recovery action is visible, return recovery_possible=false and an empty candidate list.",
        ...buildFamilyPromptLines(args.flowFamily),
        `Goal: ${args.goal}`,
        `Failure reason: ${args.failureReason}`,
        `URL: ${args.pageUrl}`,
        `Title: ${args.pageTitle ?? ""}`,
        `Body excerpt: ${(args.bodyExcerpt ?? "").slice(0, 2000)}`,
        `Submit candidates: ${(args.submitCandidates ?? []).join(" | ")}`,
        `Auth hints: ${(args.authHints ?? []).join(" | ")}`,
        `Field hints: ${(args.fieldHints ?? []).join(" | ")}`,
        `Anti-bot hints: ${(args.antiBotHints ?? []).join(" | ")}`,
        `Link candidates: ${(args.linkCandidates ?? [])
            .slice(0, 10)
            .map((candidate) => `${candidate.kind}:${candidate.text}->${candidate.href}`)
            .join(" | ")}`,
    ].join("\n");
}
function buildModelCandidates(primary) {
    const extras = [
        process.env.BACKLINKHELPER_VISUAL_MODEL?.trim(),
        "gpt-4.1-mini",
        "gpt-4o-mini",
    ].filter((value) => Boolean(value));
    return [...new Set([primary, ...extras])];
}
export async function runVisualVerification(args) {
    const apiKey = process.env[args.config.api_key_env]?.trim();
    if (!apiKey) {
        return undefined;
    }
    const imageBuffer = await readFile(args.screenshotPath);
    const imageUrl = `data:${inferMimeType(args.screenshotPath)};base64,${imageBuffer.toString("base64")}`;
    const prompt = buildVisualPrompt(args, "primary");
    const attemptedModels = [];
    let lastError;
    for (const model of buildModelCandidates(args.config.model)) {
        attemptedModels.push(model);
        try {
            const primaryResult = await invokeVisualClassification({
                apiKey,
                baseUrl: args.config.base_url,
                model,
                imageUrl,
                prompt,
            });
            let finalResult = primaryResult;
            if (shouldRunBoundaryRecheck(args, primaryResult)) {
                const boundaryResult = await invokeVisualClassification({
                    apiKey,
                    baseUrl: args.config.base_url,
                    model,
                    imageUrl,
                    prompt: buildVisualPrompt(args, "boundary_recheck"),
                });
                finalResult = {
                    ...boundaryResult,
                    summary: `[boundary-recheck] ${boundaryResult.summary}`,
                };
            }
            return {
                ...finalResult,
                model,
                attempted_models: attemptedModels.slice(),
            };
        }
        catch (error) {
            lastError =
                error instanceof Error
                    ? new Error(`Visual verification returned invalid JSON for ${model}: ${error.message}`)
                    : new Error(`Visual verification returned invalid JSON for ${model}.`);
            continue;
        }
    }
    if (lastError) {
        throw lastError;
    }
    return undefined;
}
export async function runVisualRecoveryHint(args) {
    const apiKey = process.env[args.config.api_key_env]?.trim();
    if (!apiKey) {
        return undefined;
    }
    const imageBuffer = await readFile(args.screenshotPath);
    const imageUrl = `data:${inferMimeType(args.screenshotPath)};base64,${imageBuffer.toString("base64")}`;
    const prompt = buildRecoveryPrompt(args);
    const attemptedModels = [];
    let lastError;
    for (const model of buildModelCandidates(args.config.model)) {
        attemptedModels.push(model);
        try {
            return {
                ...(await invokeVisualRecoveryHint({
                    apiKey,
                    baseUrl: args.config.base_url,
                    model,
                    imageUrl,
                    prompt,
                })),
                model,
                attempted_models: attemptedModels.slice(),
            };
        }
        catch (error) {
            lastError =
                error instanceof Error
                    ? new Error(`Visual recovery hint returned invalid JSON for ${model}: ${error.message}`)
                    : new Error(`Visual recovery hint returned invalid JSON for ${model}.`);
            continue;
        }
    }
    if (lastError) {
        throw lastError;
    }
    return undefined;
}
