const DEFAULT_CREATE_TASK_URL = "https://api.capsolver.com/createTask";
const DEFAULT_GET_TASK_RESULT_URL = "https://api.capsolver.com/getTaskResult";
function readPositiveInt(value, fallback) {
    if (!value) {
        return fallback;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
export function resolveCapsolverConfig(env = process.env) {
    const apiKey = env.CAPSOLVER_API_KEY || env.CAPSOLVER_CLIENT_KEY || env.CAP_SOLVER_API_KEY;
    return {
        enabled: Boolean(apiKey),
        apiKey,
        createTaskUrl: env.CAPSOLVER_CREATE_TASK_URL || DEFAULT_CREATE_TASK_URL,
        getTaskResultUrl: env.CAPSOLVER_GET_TASK_RESULT_URL || DEFAULT_GET_TASK_RESULT_URL,
        pollIntervalMs: readPositiveInt(env.CAPSOLVER_POLL_INTERVAL_MS, 1_000),
        maxPolls: readPositiveInt(env.CAPSOLVER_MAX_POLLS, 25),
        requestTimeoutMs: readPositiveInt(env.CAPSOLVER_REQUEST_TIMEOUT_MS, 20_000),
    };
}
async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
function summarizeError(response) {
    return [response.errorCode, response.errorDescription].filter(Boolean).join(": ") || "CapSolver returned an error.";
}
async function postJson(fetchImpl, url, payload, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        const text = await response.text();
        let json;
        try {
            json = text ? JSON.parse(text) : {};
        }
        catch {
            throw new Error(`CapSolver returned non-JSON response (${response.status}): ${text.slice(0, 200)}`);
        }
        if (!response.ok) {
            throw new Error(`CapSolver HTTP ${response.status}: ${text.slice(0, 300)}`);
        }
        return json;
    }
    finally {
        clearTimeout(timeout);
    }
}
export class CapsolverClient {
    apiKey;
    createTaskUrl;
    getTaskResultUrl;
    pollIntervalMs;
    maxPolls;
    requestTimeoutMs;
    fetchImpl;
    constructor(options) {
        this.apiKey = options.apiKey;
        this.createTaskUrl = options.createTaskUrl ?? DEFAULT_CREATE_TASK_URL;
        this.getTaskResultUrl = options.getTaskResultUrl ?? DEFAULT_GET_TASK_RESULT_URL;
        this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
        this.maxPolls = options.maxPolls ?? 25;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
        this.fetchImpl = options.fetchImpl ?? fetch;
    }
    async solve(task) {
        const createResponse = await postJson(this.fetchImpl, this.createTaskUrl, { clientKey: this.apiKey, task }, this.requestTimeoutMs);
        if (createResponse.errorId) {
            throw new Error(summarizeError(createResponse));
        }
        if (task.type === "ImageToTextTask") {
            if (createResponse.status === "ready" && createResponse.solution) {
                return {
                    response: createResponse,
                    taskId: createResponse.taskId,
                    taskType: task.type,
                    solution: createResponse.solution,
                };
            }
            throw new Error(`CapSolver ImageToTextTask did not return an immediate ready solution: ${JSON.stringify(createResponse)}`);
        }
        if (!createResponse.taskId) {
            throw new Error(`CapSolver did not return taskId: ${JSON.stringify(createResponse)}`);
        }
        for (let poll = 0; poll < this.maxPolls; poll += 1) {
            if (poll > 0 || this.pollIntervalMs > 0) {
                await sleep(this.pollIntervalMs);
            }
            const resultResponse = await postJson(this.fetchImpl, this.getTaskResultUrl, { clientKey: this.apiKey, taskId: createResponse.taskId }, this.requestTimeoutMs);
            if (resultResponse.errorId) {
                throw new Error(summarizeError(resultResponse));
            }
            if (resultResponse.status === "ready") {
                return {
                    response: resultResponse,
                    taskId: createResponse.taskId,
                    taskType: task.type,
                    solution: resultResponse.solution,
                };
            }
            if (resultResponse.status === "failed") {
                throw new Error(`CapSolver task failed: ${JSON.stringify(resultResponse)}`);
            }
        }
        throw new Error(`CapSolver task ${createResponse.taskId} timed out after ${this.maxPolls} polls.`);
    }
}
export function buildCapsolverTask(descriptor, imageBodyBase64) {
    if (descriptor.kind === "recaptcha_v2") {
        if (!descriptor.websiteKey) {
            throw new Error("reCAPTCHA v2 descriptor is missing websiteKey.");
        }
        return {
            type: "ReCaptchaV2TaskProxyLess",
            websiteURL: descriptor.websiteURL,
            websiteKey: descriptor.websiteKey,
            ...(descriptor.isInvisible ? { isInvisible: true } : {}),
        };
    }
    if (descriptor.kind === "turnstile") {
        if (!descriptor.websiteKey) {
            throw new Error("Turnstile descriptor is missing websiteKey.");
        }
        return {
            type: "AntiTurnstileTaskProxyLess",
            websiteURL: descriptor.websiteURL,
            websiteKey: descriptor.websiteKey,
        };
    }
    if (!imageBodyBase64) {
        throw new Error("ImageToText descriptor is missing image body.");
    }
    return {
        type: "ImageToTextTask",
        websiteURL: descriptor.websiteURL,
        module: "common",
        body: imageBodyBase64,
    };
}
export function extractSolutionToken(solution) {
    const candidates = [
        solution?.gRecaptchaResponse,
        solution?.token,
        solution?.captchaToken,
        solution?.cf_clearance,
    ];
    return candidates.find((value) => typeof value === "string" && value.length > 0);
}
export function extractImageText(solution) {
    const text = solution?.text;
    if (typeof text === "string" && text.trim()) {
        return text.trim();
    }
    const answers = solution?.answers;
    if (Array.isArray(answers)) {
        const first = answers.find((value) => typeof value === "string" && value.trim());
        return typeof first === "string" ? first.trim() : undefined;
    }
    return undefined;
}
function compactWhitespace(value) {
    return (value ?? "").replace(/\s+/g, " ").trim();
}
function normalizeControlCorpus(control) {
    return compactWhitespace([
        control.name,
        control.id,
        control.label,
        control.placeholder,
        control.type,
    ].filter(Boolean).join(" ")).toLowerCase();
}
const CAPTCHA_FIELD_SIGNAL_PATTERN = /(?:captcha|recaptcha|turnstile|confirmation\s+code|confirm_code|security\s+code|verification\s+code|visual\s+confirmation|bestätigungscode|bestätigung\s+der\s+registrierung|automatisierte\s+anmeldungen|verify\s+you\s+are\s+human|i'?m\s+not\s+a\s+robot)/i;
const REGISTRATION_SIGNAL_PATTERN = /(?:register|registration|create\s+account|sign\s+up|signup|registrierung|anmeldung)/i;
const CONFIRM_FIELD_SIGNAL_PATTERN = /(?:confirm|confirmation|repeat|retype|bestätigen|bestaetigen|wiederholen)/i;
function isUsableAccountControl(control) {
    if (control.disabled) {
        return false;
    }
    if (control.visible === false) {
        return false;
    }
    const corpus = normalizeControlCorpus(control);
    return !CAPTCHA_FIELD_SIGNAL_PATTERN.test(corpus);
}
function hasFilledValue(control) {
    return typeof control.value === "string" && control.value.trim().length > 0;
}
function findControl(controls, predicate) {
    return controls.find((control) => isUsableAccountControl(control) && predicate(control, normalizeControlCorpus(control)));
}
function findMissingIfPresent(controls, label, predicate, requiredIfPresent = true) {
    const control = findControl(controls, predicate);
    if (!control) {
        return requiredIfPresent ? label : undefined;
    }
    return hasFilledValue(control) ? undefined : label;
}
function isPhpbbRegistrationForm(snapshot, form) {
    const controls = form.controls ?? [];
    const controlCorpus = controls.map(normalizeControlCorpus).join(" ");
    const pageAndFormCorpus = compactWhitespace([
        snapshot.pageUrl,
        snapshot.title,
        form.action,
        form.id,
        form.className,
        form.text,
        controlCorpus,
    ].filter(Boolean).join(" ")).toLowerCase();
    const hasPhpbbSignal = /ucp\.php(?:\?|$)/i.test(pageAndFormCorpus) ||
        /\bphpbb\b/i.test(pageAndFormCorpus) ||
        /\b(?:new_password|password_confirm|email_confirm|confirm_code)\b/i.test(pageAndFormCorpus);
    const hasRegistrationSignal = REGISTRATION_SIGNAL_PATTERN.test(pageAndFormCorpus);
    const hasRegistrationShape = hasPhpbbSignal || hasRegistrationSignal;
    const hasCaptchaSignal = form.containsCaptcha === true || CAPTCHA_FIELD_SIGNAL_PATTERN.test(pageAndFormCorpus);
    const hasUsername = Boolean(findControl(controls, (_control, corpus) => /\buser(?:name)?\b|\blogin name\b/.test(corpus)));
    const hasEmail = Boolean(findControl(controls, (control, corpus) => control.type === "email" || /\be-?mail\b|\bemail\b/.test(corpus)));
    const hasPassword = Boolean(findControl(controls, (control, corpus) => control.type === "password" || /\bpassword\b|\bpasswort\b/.test(corpus)));
    return hasRegistrationShape && hasRegistrationSignal && hasCaptchaSignal && hasUsername && hasEmail && hasPassword;
}
function getPhpbbRegistrationMissingFields(form) {
    const controls = form.controls ?? [];
    const missing = [
        findMissingIfPresent(controls, "username", (_control, corpus) => /\buser(?:name)?\b|\blogin name\b/.test(corpus)),
        findMissingIfPresent(controls, "email", (control, corpus) => (control.type === "email" || /\be-?mail\b|\bemail\b/.test(corpus)) && !CONFIRM_FIELD_SIGNAL_PATTERN.test(corpus)),
        findMissingIfPresent(controls, "confirm email", (_control, corpus) => CONFIRM_FIELD_SIGNAL_PATTERN.test(corpus) && /\be-?mail\b|\bemail\b/.test(corpus), false),
        findMissingIfPresent(controls, "password", (control, corpus) => (control.type === "password" || /\bpassword\b|\bpasswort\b/.test(corpus)) &&
            !CONFIRM_FIELD_SIGNAL_PATTERN.test(corpus) &&
            !/\bcurrent\b/.test(corpus)),
        findMissingIfPresent(controls, "confirm password", (_control, corpus) => CONFIRM_FIELD_SIGNAL_PATTERN.test(corpus) && /\bpassword\b|\bpasswort\b/.test(corpus), false),
    ].filter((value) => Boolean(value));
    return [...new Set(missing)];
}
export function assessCaptchaSubmitReadinessFromSnapshot(snapshot) {
    for (const form of snapshot.forms ?? []) {
        if (!isPhpbbRegistrationForm(snapshot, form)) {
            continue;
        }
        const missingFields = getPhpbbRegistrationMissingFields(form);
        if (missingFields.length > 0) {
            return {
                ready: false,
                guarded: true,
                form_kind: "phpbb_registration",
                missing_fields: missingFields,
                detail: `phpBB registration form still has empty account fields before CAPTCHA submit: ${missingFields.join(", ")}.`,
            };
        }
        return {
            ready: true,
            guarded: true,
            form_kind: "phpbb_registration",
            missing_fields: [],
            detail: "phpBB registration form account fields are filled; CAPTCHA submit is allowed.",
        };
    }
    return {
        ready: true,
        guarded: false,
        missing_fields: [],
        detail: "No guarded CAPTCHA registration form was detected.",
    };
}
export async function captureCaptchaSubmitReadinessSnapshot(page) {
    return page.evaluate(() => {
        const isVisible = (element) => {
            if (!(element instanceof HTMLElement)) {
                return false;
            }
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.05 && rect.width > 0 && rect.height > 0;
        };
        const labelFor = (control) => {
            const labels = "labels" in control && control.labels ? [...control.labels].map((label) => label.textContent ?? "") : [];
            const ariaLabel = control.getAttribute("aria-label") ?? "";
            const ariaLabelledBy = (control.getAttribute("aria-labelledby") ?? "")
                .split(/\s+/)
                .map((id) => document.getElementById(id)?.textContent ?? "")
                .join(" ");
            return [labels.join(" "), ariaLabel, ariaLabelledBy].join(" ").replace(/\s+/g, " ").trim() || undefined;
        };
        const forms = [...document.forms].map((form) => {
            const controls = [...form.querySelectorAll("input, textarea, select")].map((control) => ({
                name: control.getAttribute("name") ?? undefined,
                id: control.id || undefined,
                label: labelFor(control),
                placeholder: control.getAttribute("placeholder") ?? undefined,
                type: control instanceof HTMLInputElement ? control.type : control.tagName.toLowerCase(),
                value: control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement ? control.value : undefined,
                required: control.required,
                visible: isVisible(control),
                disabled: control.disabled,
            }));
            const submitLabels = [...form.querySelectorAll('input[type="submit"], button[type="submit"], button:not([type])')]
                .map((submit) => (submit instanceof HTMLInputElement ? submit.value : submit.textContent) ?? "")
                .map((text) => text.replace(/\s+/g, " ").trim())
                .filter(Boolean);
            const corpus = [form.textContent, form.innerHTML].join(" ").toLowerCase();
            return {
                action: form.action || form.getAttribute("action") || undefined,
                method: form.method || undefined,
                id: form.id || undefined,
                className: typeof form.className === "string" ? form.className : undefined,
                text: (form.textContent ?? "").replace(/\s+/g, " ").trim(),
                submitLabels,
                containsCaptcha: /captcha|recaptcha|turnstile|cf-turnstile|g-recaptcha|confirmation\s+code|confirm_code|security\s+code|verification\s+code|visual\s+confirmation|bestätigungscode|bestätigung\s+der\s+registrierung|automatisierte\s+anmeldungen|verify\s+you\s+are\s+human/i.test(corpus),
                controls,
            };
        });
        return {
            pageUrl: window.location.href,
            title: document.title,
            forms,
        };
    });
}
export async function detectTokenCaptchaDescriptor(page, websiteURL = page.url()) {
    return page.evaluate((url) => {
        const isVisible = (element) => {
            if (!(element instanceof HTMLElement)) {
                return false;
            }
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.05 && rect.width > 0 && rect.height > 0;
        };
        const fromRecaptchaIframe = () => {
            const iframe = [...document.querySelectorAll('iframe[src*="recaptcha/api2/anchor"], iframe[src*="google.com/recaptcha"], iframe[src*="recaptcha.net/recaptcha"]')].find((node) => node.src);
            if (!iframe?.src) {
                return undefined;
            }
            try {
                return new URL(iframe.src).searchParams.get("k") || undefined;
            }
            catch {
                return undefined;
            }
        };
        const recaptchaNode = document.querySelector(".g-recaptcha[data-sitekey], [data-sitekey][class*='recaptcha' i]");
        const recaptchaKey = recaptchaNode?.getAttribute("data-sitekey") || fromRecaptchaIframe();
        if (recaptchaKey) {
            const invisible = recaptchaNode?.getAttribute("data-size") === "invisible" || Boolean(document.querySelector(".grecaptcha-badge"));
            return {
                kind: "recaptcha_v2",
                websiteURL: url,
                websiteKey: recaptchaKey,
                isInvisible: invisible,
                detail: `Detected reCAPTCHA v2 sitekey ${recaptchaKey.slice(0, 8)}…`,
            };
        }
        const turnstileNode = document.querySelector(".cf-turnstile[data-sitekey], [data-sitekey][class*='turnstile' i], [data-sitekey][data-callback]");
        const turnstileIframe = [...document.querySelectorAll('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]')].find((node) => node.src);
        const turnstileKey = turnstileNode?.getAttribute("data-sitekey");
        if (turnstileKey || turnstileIframe) {
            return {
                kind: "turnstile",
                websiteURL: url,
                websiteKey: turnstileKey || undefined,
                detail: turnstileKey
                    ? `Detected Cloudflare Turnstile sitekey ${turnstileKey.slice(0, 8)}…`
                    : "Detected Cloudflare Turnstile iframe but no sitekey was available in DOM.",
            };
        }
        return undefined;
    }, websiteURL);
}
function locatorForFirstVisible(page, selector) {
    return page.locator(selector).first();
}
async function isVisibleLocator(locator) {
    return (await locator.count().catch(() => 0)) > 0 && (await locator.isVisible().catch(() => false));
}
export async function detectImageCaptchaDescriptor(page, websiteURL = page.url()) {
    const imageSelector = [
        'img[id*="captcha" i]',
        'img[class*="captcha" i]',
        'img[src*="captcha" i]',
        'img[alt*="captcha" i]',
        'img[id*="verify" i]',
        'img[src*="verify" i]',
        'img[alt*="verification" i]',
        'img[src*="security" i]',
    ].join(", ");
    const inputSelector = [
        'input[name*="captcha" i]',
        'input[id*="captcha" i]',
        'input[placeholder*="captcha" i]',
        'input[name*="verify" i]',
        'input[id*="verify" i]',
        'input[placeholder*="verification" i]',
        'input[name*="security" i]',
        'input[id*="security" i]',
        'input[name*="code" i]',
        'input[id*="code" i]',
        'input[placeholder*="code" i]',
    ].join(", ");
    const image = locatorForFirstVisible(page, imageSelector);
    const input = locatorForFirstVisible(page, inputSelector);
    if (!(await isVisibleLocator(image)) || !(await isVisibleLocator(input))) {
        return undefined;
    }
    return {
        kind: "image_to_text",
        websiteURL,
        imageSelector,
        inputSelector,
        detail: "Detected visible image CAPTCHA plus a likely CAPTCHA/code input.",
    };
}
async function detectSupportedCaptchaDescriptor(page, websiteURL = page.url()) {
    return (await detectTokenCaptchaDescriptor(page, websiteURL)) ?? (await detectImageCaptchaDescriptor(page, websiteURL));
}
async function applyTokenToPage(page, kind, token) {
    await page.evaluate(({ captchaKind, captchaToken }) => {
        const setValue = (element) => {
            element.value = captchaToken;
            element.setAttribute("value", captchaToken);
            element.dispatchEvent(new Event("input", { bubbles: true }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
        };
        if (captchaKind === "recaptcha_v2") {
            document.querySelectorAll('textarea[name="g-recaptcha-response"], #g-recaptcha-response').forEach(setValue);
        }
        else {
            document.querySelectorAll('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]').forEach(setValue);
        }
        const seen = new Set();
        const callbacks = [];
        const visit = (value, depth = 0) => {
            if (!value || depth > 4 || seen.has(value)) {
                return;
            }
            seen.add(value);
            if (typeof value === "function") {
                callbacks.push(value);
                return;
            }
            if (typeof value !== "object") {
                return;
            }
            for (const [key, child] of Object.entries(value)) {
                if (/callback/i.test(key) && typeof child === "function") {
                    callbacks.push(child);
                }
                else if (typeof child === "object" && child) {
                    visit(child, depth + 1);
                }
            }
        };
        if (captchaKind === "recaptcha_v2") {
            visit(window.___grecaptcha_cfg);
        }
        callbacks.slice(0, 10).forEach((callback) => {
            try {
                callback(captchaToken);
            }
            catch {
                // Best-effort callback invocation only.
            }
        });
    }, { captchaKind: kind, captchaToken: token });
}
async function fillImageCaptcha(page, descriptor, text) {
    if (!descriptor.inputSelector) {
        throw new Error("Image CAPTCHA descriptor has no input selector.");
    }
    await locatorForFirstVisible(page, descriptor.inputSelector).fill(text);
}
async function clickLikelySubmit(page) {
    const selectors = [
        'form#commentform input#submit',
        'form#commentform button#submit',
        '#commentform input[type="submit"]',
        '#commentform button[type="submit"]',
        'form[action*="comment" i] input[type="submit"]',
        'form[action*="comment" i] button[type="submit"]',
        'form:has(textarea) input[type="submit"]',
        'form:has(textarea) button[type="submit"]',
        'form:has(input[type="password"]) input[type="submit"]',
        'form:has(input[type="password"]) button[type="submit"]',
        'input#submit',
        'button#submit',
        'input[type="submit"]',
        'button[type="submit"]',
        'button:has-text("Submit")',
        'button:has-text("Sign Up")',
        'button:has-text("Register")',
        'button:has-text("Add Comment")',
        'input[value*="Submit" i]',
        'input[value*="Register" i]',
        'input[value*="Comment" i]',
    ];
    for (const selector of selectors) {
        const candidate = page.locator(selector).first();
        if (await isVisibleLocator(candidate)) {
            await candidate.click({ timeout: 5_000 }).catch(async () => {
                await candidate.dispatchEvent("click");
            });
            return true;
        }
    }
    return false;
}
function summarizeSolution(descriptor, solution) {
    if (descriptor.kind === "image_to_text") {
        const text = extractImageText(solution);
        return text ? `image text length=${text.length}` : "image text missing";
    }
    const token = extractSolutionToken(solution);
    return token ? `token length=${token.length}` : "token missing";
}
export async function attemptCapsolverContinuation(args) {
    const websiteURL = args.websiteURL || args.page.url();
    const descriptor = await detectSupportedCaptchaDescriptor(args.page, websiteURL);
    if (!descriptor) {
        return {
            attempted: false,
            solved: false,
            applied: false,
            submitted: false,
            provider: "capsolver",
            detail: "No supported CAPTCHA descriptor was found on the current page.",
        };
    }
    if (args.submitAfterSolve) {
        const readiness = await captureCaptchaSubmitReadinessSnapshot(args.page)
            .then(assessCaptchaSubmitReadinessFromSnapshot)
            .catch(() => undefined);
        if (readiness && !readiness.ready) {
            return {
                attempted: false,
                solved: false,
                applied: false,
                submitted: false,
                provider: "capsolver",
                captcha_kind: descriptor.kind,
                submit_blocked: true,
                submit_block_reason: "REGISTRATION_REQUIRED_FIELDS_EMPTY",
                form_kind: readiness.form_kind,
                missing_fields: readiness.missing_fields,
                detail: `${readiness.detail} CapSolver was not invoked to avoid submitting an incomplete registration form.`,
            };
        }
    }
    const config = args.config ?? resolveCapsolverConfig();
    if (!config.enabled || !config.apiKey) {
        return {
            attempted: false,
            solved: false,
            applied: false,
            submitted: false,
            provider: "capsolver",
            captcha_kind: descriptor.kind,
            detail: `Supported ${descriptor.kind} CAPTCHA detected, but CAPSOLVER_API_KEY/CAPSOLVER_CLIENT_KEY is not configured.`,
        };
    }
    let task;
    try {
        let imageBodyBase64;
        if (descriptor.kind === "image_to_text") {
            if (!descriptor.imageSelector) {
                throw new Error("Image CAPTCHA descriptor has no image selector.");
            }
            const imageBuffer = await locatorForFirstVisible(args.page, descriptor.imageSelector).screenshot({ type: "png" });
            imageBodyBase64 = Buffer.from(imageBuffer).toString("base64");
        }
        task = buildCapsolverTask(descriptor, imageBodyBase64);
        const client = args.client ?? new CapsolverClient({
            apiKey: config.apiKey,
            createTaskUrl: config.createTaskUrl,
            getTaskResultUrl: config.getTaskResultUrl,
            pollIntervalMs: config.pollIntervalMs,
            maxPolls: config.maxPolls,
            requestTimeoutMs: config.requestTimeoutMs,
        });
        const result = await client.solve(task);
        if (descriptor.kind === "image_to_text") {
            const text = extractImageText(result.solution);
            if (!text) {
                return {
                    attempted: true,
                    solved: false,
                    applied: false,
                    submitted: false,
                    provider: "capsolver",
                    captcha_kind: descriptor.kind,
                    task_type: task.type,
                    task_id: result.taskId,
                    solution_summary: summarizeSolution(descriptor, result.solution),
                    detail: "CapSolver returned no usable image text.",
                };
            }
            await fillImageCaptcha(args.page, descriptor, text);
        }
        else {
            const token = extractSolutionToken(result.solution);
            if (!token) {
                return {
                    attempted: true,
                    solved: false,
                    applied: false,
                    submitted: false,
                    provider: "capsolver",
                    captcha_kind: descriptor.kind,
                    task_type: task.type,
                    task_id: result.taskId,
                    solution_summary: summarizeSolution(descriptor, result.solution),
                    detail: "CapSolver returned no usable token.",
                };
            }
            await applyTokenToPage(args.page, descriptor.kind, token);
        }
        const submitted = args.submitAfterSolve ? await clickLikelySubmit(args.page) : false;
        if (submitted) {
            await args.page.waitForTimeout(2_000).catch(() => { });
        }
        return {
            attempted: true,
            solved: true,
            applied: true,
            submitted,
            provider: "capsolver",
            captcha_kind: descriptor.kind,
            task_type: task.type,
            task_id: result.taskId,
            solution_summary: summarizeSolution(descriptor, result.solution),
            detail: submitted
                ? `CapSolver solved ${descriptor.kind}, applied the solution, and clicked the likely submit control.`
                : `CapSolver solved ${descriptor.kind} and applied the solution.`,
        };
    }
    catch (error) {
        return {
            attempted: true,
            solved: false,
            applied: false,
            submitted: false,
            provider: "capsolver",
            captcha_kind: descriptor.kind,
            task_type: task?.type,
            detail: error instanceof Error ? `CapSolver attempt failed: ${error.message}` : "CapSolver attempt failed.",
        };
    }
}
