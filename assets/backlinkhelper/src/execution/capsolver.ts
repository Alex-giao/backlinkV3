import type { Locator, Page } from "playwright";

export type CapsolverSupportedCaptchaKind = "recaptcha_v2" | "turnstile" | "image_to_text";

export interface CapsolverRuntimeConfig {
  enabled: boolean;
  apiKey?: string;
  createTaskUrl: string;
  getTaskResultUrl: string;
  pollIntervalMs: number;
  maxPolls: number;
  requestTimeoutMs: number;
}

export interface CaptchaDescriptor {
  kind: CapsolverSupportedCaptchaKind;
  websiteURL: string;
  websiteKey?: string;
  isInvisible?: boolean;
  imageSelector?: string;
  inputSelector?: string;
  detail: string;
}

export interface CapsolverAttemptRecord extends Record<string, unknown> {
  attempted: boolean;
  solved: boolean;
  applied: boolean;
  submitted: boolean;
  provider: "capsolver";
  captcha_kind?: CapsolverSupportedCaptchaKind;
  task_type?: string;
  task_id?: string;
  solution_summary?: string;
  detail: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface CapsolverClientOptions {
  apiKey: string;
  createTaskUrl?: string;
  getTaskResultUrl?: string;
  pollIntervalMs?: number;
  maxPolls?: number;
  requestTimeoutMs?: number;
  fetchImpl?: FetchLike;
}

export interface CapsolverTaskPayload extends Record<string, unknown> {
  type: string;
}

export interface CapsolverApiResponse {
  errorId?: number;
  errorCode?: string | null;
  errorDescription?: string | null;
  taskId?: string;
  status?: "idle" | "processing" | "ready" | "failed" | string;
  solution?: Record<string, unknown>;
}

export interface CapsolverSolveResult {
  response: CapsolverApiResponse;
  taskId?: string;
  taskType: string;
  solution?: Record<string, unknown>;
}

const DEFAULT_CREATE_TASK_URL = "https://api.capsolver.com/createTask";
const DEFAULT_GET_TASK_RESULT_URL = "https://api.capsolver.com/getTaskResult";

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveCapsolverConfig(env: NodeJS.ProcessEnv = process.env): CapsolverRuntimeConfig {
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeError(response: CapsolverApiResponse): string {
  return [response.errorCode, response.errorDescription].filter(Boolean).join(": ") || "CapSolver returned an error.";
}

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<CapsolverApiResponse> {
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
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`CapSolver returned non-JSON response (${response.status}): ${text.slice(0, 200)}`);
    }
    if (!response.ok) {
      throw new Error(`CapSolver HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return json as CapsolverApiResponse;
  } finally {
    clearTimeout(timeout);
  }
}

export class CapsolverClient {
  private readonly apiKey: string;
  private readonly createTaskUrl: string;
  private readonly getTaskResultUrl: string;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: CapsolverClientOptions) {
    this.apiKey = options.apiKey;
    this.createTaskUrl = options.createTaskUrl ?? DEFAULT_CREATE_TASK_URL;
    this.getTaskResultUrl = options.getTaskResultUrl ?? DEFAULT_GET_TASK_RESULT_URL;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.maxPolls = options.maxPolls ?? 25;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async solve(task: CapsolverTaskPayload): Promise<CapsolverSolveResult> {
    const createResponse = await postJson(
      this.fetchImpl,
      this.createTaskUrl,
      { clientKey: this.apiKey, task },
      this.requestTimeoutMs,
    );

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
      const resultResponse = await postJson(
        this.fetchImpl,
        this.getTaskResultUrl,
        { clientKey: this.apiKey, taskId: createResponse.taskId },
        this.requestTimeoutMs,
      );
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

export function buildCapsolverTask(descriptor: CaptchaDescriptor, imageBodyBase64?: string): CapsolverTaskPayload {
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

export function extractSolutionToken(solution: Record<string, unknown> | undefined): string | undefined {
  const candidates = [
    solution?.gRecaptchaResponse,
    solution?.token,
    solution?.captchaToken,
    solution?.cf_clearance,
  ];
  return candidates.find((value): value is string => typeof value === "string" && value.length > 0);
}

export function extractImageText(solution: Record<string, unknown> | undefined): string | undefined {
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

export async function detectTokenCaptchaDescriptor(page: Page, websiteURL = page.url()): Promise<CaptchaDescriptor | undefined> {
  return page.evaluate((url) => {
    const isVisible = (element: Element | null): boolean => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.05 && rect.width > 0 && rect.height > 0;
    };
    const fromRecaptchaIframe = (): string | undefined => {
      const iframe = [...document.querySelectorAll<HTMLIFrameElement>('iframe[src*="recaptcha/api2/anchor"], iframe[src*="google.com/recaptcha"], iframe[src*="recaptcha.net/recaptcha"]')].find((node) => node.src);
      if (!iframe?.src) {
        return undefined;
      }
      try {
        return new URL(iframe.src).searchParams.get("k") || undefined;
      } catch {
        return undefined;
      }
    };
    const recaptchaNode = document.querySelector<HTMLElement>(".g-recaptcha[data-sitekey], [data-sitekey][class*='recaptcha' i]");
    const recaptchaKey = recaptchaNode?.getAttribute("data-sitekey") || fromRecaptchaIframe();
    if (recaptchaKey) {
      const invisible = recaptchaNode?.getAttribute("data-size") === "invisible" || Boolean(document.querySelector(".grecaptcha-badge"));
      return {
        kind: "recaptcha_v2" as const,
        websiteURL: url,
        websiteKey: recaptchaKey,
        isInvisible: invisible,
        detail: `Detected reCAPTCHA v2 sitekey ${recaptchaKey.slice(0, 8)}…`,
      };
    }

    const turnstileNode = document.querySelector<HTMLElement>(".cf-turnstile[data-sitekey], [data-sitekey][class*='turnstile' i], [data-sitekey][data-callback]");
    const turnstileIframe = [...document.querySelectorAll<HTMLIFrameElement>('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]')].find((node) => node.src);
    const turnstileKey = turnstileNode?.getAttribute("data-sitekey");
    if (turnstileKey || turnstileIframe) {
      return {
        kind: "turnstile" as const,
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

function locatorForFirstVisible(page: Page, selector: string): Locator {
  return page.locator(selector).first();
}

async function isVisibleLocator(locator: Locator): Promise<boolean> {
  return (await locator.count().catch(() => 0)) > 0 && (await locator.isVisible().catch(() => false));
}

export async function detectImageCaptchaDescriptor(page: Page, websiteURL = page.url()): Promise<CaptchaDescriptor | undefined> {
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

async function detectSupportedCaptchaDescriptor(page: Page, websiteURL = page.url()): Promise<CaptchaDescriptor | undefined> {
  return (await detectTokenCaptchaDescriptor(page, websiteURL)) ?? (await detectImageCaptchaDescriptor(page, websiteURL));
}

async function applyTokenToPage(page: Page, kind: "recaptcha_v2" | "turnstile", token: string): Promise<void> {
  await page.evaluate(
    ({ captchaKind, captchaToken }) => {
      const setValue = (element: HTMLInputElement | HTMLTextAreaElement) => {
        element.value = captchaToken;
        element.setAttribute("value", captchaToken);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      };

      if (captchaKind === "recaptcha_v2") {
        document.querySelectorAll<HTMLTextAreaElement>('textarea[name="g-recaptcha-response"], #g-recaptcha-response').forEach(setValue);
      } else {
        document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]').forEach(setValue);
      }

      const seen = new Set<unknown>();
      const callbacks: Array<(token: string) => unknown> = [];
      const visit = (value: unknown, depth = 0) => {
        if (!value || depth > 4 || seen.has(value)) {
          return;
        }
        seen.add(value);
        if (typeof value === "function") {
          callbacks.push(value as (token: string) => unknown);
          return;
        }
        if (typeof value !== "object") {
          return;
        }
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          if (/callback/i.test(key) && typeof child === "function") {
            callbacks.push(child as (token: string) => unknown);
          } else if (typeof child === "object" && child) {
            visit(child, depth + 1);
          }
        }
      };

      if (captchaKind === "recaptcha_v2") {
        visit((window as unknown as { ___grecaptcha_cfg?: unknown }).___grecaptcha_cfg);
      }
      callbacks.slice(0, 10).forEach((callback) => {
        try {
          callback(captchaToken);
        } catch {
          // Best-effort callback invocation only.
        }
      });
    },
    { captchaKind: kind, captchaToken: token },
  );
}

async function fillImageCaptcha(page: Page, descriptor: CaptchaDescriptor, text: string): Promise<void> {
  if (!descriptor.inputSelector) {
    throw new Error("Image CAPTCHA descriptor has no input selector.");
  }
  await locatorForFirstVisible(page, descriptor.inputSelector).fill(text);
}

async function clickLikelySubmit(page: Page): Promise<boolean> {
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

function summarizeSolution(descriptor: CaptchaDescriptor, solution: Record<string, unknown> | undefined): string {
  if (descriptor.kind === "image_to_text") {
    const text = extractImageText(solution);
    return text ? `image text length=${text.length}` : "image text missing";
  }
  const token = extractSolutionToken(solution);
  return token ? `token length=${token.length}` : "token missing";
}

export async function attemptCapsolverContinuation(args: {
  page: Page;
  websiteURL?: string;
  submitAfterSolve?: boolean;
  config?: CapsolverRuntimeConfig;
  client?: CapsolverClient;
}): Promise<CapsolverAttemptRecord> {
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

  let task: CapsolverTaskPayload | undefined;

  try {
    let imageBodyBase64: string | undefined;
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
    } else {
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
      await args.page.waitForTimeout(2_000).catch(() => {});
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
  } catch (error) {
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
