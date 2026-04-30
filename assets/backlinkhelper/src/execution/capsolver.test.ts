import test from "node:test";
import assert from "node:assert/strict";

import {
  assessCaptchaSubmitReadinessFromSnapshot,
  attemptCapsolverContinuation,
  CapsolverClient,
  buildCapsolverTask,
  extractImageText,
  extractSolutionToken,
  resolveCapsolverConfig,
  type CaptchaDescriptor,
} from "./capsolver.js";

test("CapSolver config enables unattended solver from env", () => {
  const config = resolveCapsolverConfig({
    CAPSOLVER_API_KEY: "key-123",
    CAPSOLVER_MAX_POLLS: "3",
    CAPSOLVER_POLL_INTERVAL_MS: "1",
  } as NodeJS.ProcessEnv);

  assert.equal(config.enabled, true);
  assert.equal(config.apiKey, "key-123");
  assert.equal(config.maxPolls, 3);
  assert.equal(config.pollIntervalMs, 1);
});

test("CapSolver config stays disabled without API key", () => {
  const config = resolveCapsolverConfig({} as NodeJS.ProcessEnv);

  assert.equal(config.enabled, false);
  assert.equal(config.apiKey, undefined);
});

test("buildCapsolverTask maps supported CAPTCHA descriptors to official task types", () => {
  const recaptcha: CaptchaDescriptor = {
    kind: "recaptcha_v2",
    websiteURL: "https://example.com/form",
    websiteKey: "site-key",
    isInvisible: true,
    detail: "recaptcha",
  };
  assert.deepEqual(buildCapsolverTask(recaptcha), {
    type: "ReCaptchaV2TaskProxyLess",
    websiteURL: "https://example.com/form",
    websiteKey: "site-key",
    isInvisible: true,
  });

  const turnstile: CaptchaDescriptor = {
    kind: "turnstile",
    websiteURL: "https://example.com/form",
    websiteKey: "turnstile-key",
    detail: "turnstile",
  };
  assert.deepEqual(buildCapsolverTask(turnstile), {
    type: "AntiTurnstileTaskProxyLess",
    websiteURL: "https://example.com/form",
    websiteKey: "turnstile-key",
  });

  const image: CaptchaDescriptor = {
    kind: "image_to_text",
    websiteURL: "https://example.com/form",
    detail: "image",
  };
  assert.deepEqual(buildCapsolverTask(image, "base64-image"), {
    type: "ImageToTextTask",
    websiteURL: "https://example.com/form",
    module: "common",
    body: "base64-image",
  });
});

test("CapsolverClient polls token tasks until ready", async () => {
  const calls: Array<{ url: string; payload: unknown }> = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, payload: JSON.parse(String(init?.body)) });
    if (url.endsWith("/createTask")) {
      return new Response(JSON.stringify({ errorId: 0, taskId: "task-1" }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ errorId: 0, status: "ready", solution: { gRecaptchaResponse: "token-abc" } }),
      { status: 200 },
    );
  };

  const client = new CapsolverClient({
    apiKey: "secret",
    createTaskUrl: "https://api.test/createTask",
    getTaskResultUrl: "https://api.test/getTaskResult",
    pollIntervalMs: 0,
    maxPolls: 2,
    fetchImpl,
  });

  const result = await client.solve({ type: "ReCaptchaV2TaskProxyLess", websiteURL: "https://example.com", websiteKey: "k" });

  assert.equal(result.taskId, "task-1");
  assert.equal(extractSolutionToken(result.solution), "token-abc");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]?.payload, { clientKey: "secret", taskId: "task-1" });
});

test("CapsolverClient returns ImageToText solution directly from createTask", async () => {
  const fetchImpl = async (): Promise<Response> =>
    new Response(
      JSON.stringify({ errorId: 0, status: "ready", taskId: "img-1", solution: { text: "44795sds" } }),
      { status: 200 },
    );

  const client = new CapsolverClient({ apiKey: "secret", pollIntervalMs: 0, fetchImpl });
  const result = await client.solve({ type: "ImageToTextTask", websiteURL: "https://example.com", body: "abc" });

  assert.equal(result.taskId, "img-1");
  assert.equal(extractImageText(result.solution), "44795sds");
});

test("attemptCapsolverContinuation records missing Turnstile sitekey as bounded failed attempt", async () => {
  const page = {
    url: () => "https://example.com/form",
    evaluate: async () => ({
      kind: "turnstile" as const,
      websiteURL: "https://example.com/form",
      detail: "Detected Cloudflare Turnstile iframe but no sitekey was available in DOM.",
    }),
  };

  const result = await attemptCapsolverContinuation({
    page: page as never,
    config: {
      enabled: true,
      apiKey: "secret",
      createTaskUrl: "https://api.test/createTask",
      getTaskResultUrl: "https://api.test/getTaskResult",
      pollIntervalMs: 0,
      maxPolls: 1,
      requestTimeoutMs: 100,
    },
  });

  assert.equal(result.attempted, true);
  assert.equal(result.solved, false);
  assert.equal(result.captcha_kind, "turnstile");
  assert.equal(result.task_type, undefined);
  assert.match(result.detail, /missing websiteKey/);
});

test("assessCaptchaSubmitReadinessFromSnapshot blocks phpBB registration CAPTCHA submit when account fields are empty", () => {
  const readiness = assessCaptchaSubmitReadinessFromSnapshot({
    pageUrl: "https://forum.example.com/ucp.php?mode=register",
    title: "Register",
    forms: [
      {
        action: "https://forum.example.com/ucp.php?mode=register",
        text: "Register Username Email address Password Confirm password Confirmation code Submit",
        submitLabels: ["Submit"],
        containsCaptcha: true,
        controls: [
          { name: "username", label: "Username", value: "", visible: true },
          { name: "email", label: "Email address", value: "", visible: true, type: "email" },
          { name: "email_confirm", label: "Confirm email address", value: "", visible: true, type: "email" },
          { name: "new_password", label: "Password", value: "", visible: true, type: "password" },
          { name: "password_confirm", label: "Confirm password", value: "", visible: true, type: "password" },
          { name: "confirm_code", label: "Confirmation code", value: "", visible: true },
        ],
      },
    ],
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.guarded, true);
  assert.equal(readiness.form_kind, "phpbb_registration");
  assert.deepEqual(readiness.missing_fields, ["username", "email", "confirm email", "password", "confirm password"]);
  assert.match(readiness.detail, /phpBB registration form/i);
});

test("assessCaptchaSubmitReadinessFromSnapshot blocks phpBB registration CAPTCHA submit when localized security-code fields are empty", () => {
  const readiness = assessCaptchaSubmitReadinessFromSnapshot({
    pageUrl: "https://forum.example.com/ucp.php?mode=register",
    title: "Registrierung",
    forms: [
      {
        action: "https://forum.example.com/ucp.php?mode=register",
        text: "Registrierung Benutzername E-Mail-Adresse Passwort Passwort bestätigen Bestätigungscode Visuelle Bestätigung Submit",
        submitLabels: ["Submit"],
        containsCaptcha: false,
        controls: [
          { name: "username", label: "Benutzername", value: "", visible: true },
          { name: "email", label: "E-Mail-Adresse", value: "", visible: true, type: "email" },
          { name: "email_confirm", label: "E-Mail-Adresse bestätigen", value: "", visible: true, type: "email" },
          { name: "new_password", label: "Passwort", value: "", visible: true, type: "password" },
          { name: "password_confirm", label: "Passwort bestätigen", value: "", visible: true, type: "password" },
          { name: "confirm_code", label: "Bestätigungscode", value: "", visible: true },
        ],
      },
    ],
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.guarded, true);
  assert.equal(readiness.form_kind, "phpbb_registration");
  assert.deepEqual(readiness.missing_fields, ["username", "email", "confirm email", "password", "confirm password"]);
});

test("assessCaptchaSubmitReadinessFromSnapshot blocks generic forum registration CAPTCHA submit with security-code fields empty", () => {
  const readiness = assessCaptchaSubmitReadinessFromSnapshot({
    pageUrl: "https://community.example.com/register",
    title: "Create account",
    forms: [
      {
        action: "https://community.example.com/register",
        text: "Create account Username Email Password Repeat password Security code Submit",
        submitLabels: ["Submit"],
        containsCaptcha: false,
        controls: [
          { name: "user", label: "Username", value: "", visible: true },
          { name: "mail", label: "Email", value: "", visible: true, type: "email" },
          { name: "pass", label: "Password", value: "", visible: true, type: "password" },
          { name: "pass_repeat", label: "Repeat password", value: "", visible: true, type: "password" },
          { name: "security_code", label: "Security code", value: "", visible: true },
        ],
      },
    ],
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.guarded, true);
  assert.equal(readiness.form_kind, "phpbb_registration");
  assert.deepEqual(readiness.missing_fields, ["username", "email", "password", "confirm password"]);
});

test("assessCaptchaSubmitReadinessFromSnapshot allows phpBB registration CAPTCHA submit after required account fields are filled", () => {
  const readiness = assessCaptchaSubmitReadinessFromSnapshot({
    pageUrl: "https://forum.example.com/ucp.php?mode=register",
    title: "Register",
    forms: [
      {
        action: "https://forum.example.com/ucp.php?mode=register",
        text: "Register Username Email address Password Confirm password Confirmation code Submit",
        submitLabels: ["Submit"],
        containsCaptcha: true,
        controls: [
          { name: "username", label: "Username", value: "exactstatement", visible: true },
          { name: "email", label: "Email address", value: "support@example.com", visible: true, type: "email" },
          { name: "email_confirm", label: "Confirm email address", value: "support@example.com", visible: true, type: "email" },
          { name: "new_password", label: "Password", value: "secret-password", visible: true, type: "password" },
          { name: "password_confirm", label: "Confirm password", value: "secret-password", visible: true, type: "password" },
          { name: "confirm_code", label: "Confirmation code", value: "", visible: true },
        ],
      },
    ],
  });

  assert.equal(readiness.ready, true);
  assert.equal(readiness.guarded, true);
  assert.equal(readiness.form_kind, "phpbb_registration");
});

test("attemptCapsolverContinuation does not solve or submit phpBB registration CAPTCHA while account fields are empty", async () => {
  let solveCalled = false;
  let clicked = false;
  let evaluateCount = 0;
  const page = {
    url: () => "https://forum.example.com/ucp.php?mode=register",
    evaluate: async () => {
      evaluateCount += 1;
      if (evaluateCount === 1) {
        return {
          kind: "recaptcha_v2" as const,
          websiteURL: "https://forum.example.com/ucp.php?mode=register",
          websiteKey: "site-key",
          detail: "Detected reCAPTCHA v2 sitekey site-key…",
        };
      }
      return {
        pageUrl: "https://forum.example.com/ucp.php?mode=register",
        title: "Register",
        forms: [
          {
            action: "https://forum.example.com/ucp.php?mode=register",
            text: "Register Username Email address Password Confirm password Confirmation code Submit",
            submitLabels: ["Submit"],
            containsCaptcha: true,
            controls: [
              { name: "username", label: "Username", value: "", visible: true },
              { name: "email", label: "Email address", value: "", visible: true, type: "email" },
              { name: "new_password", label: "Password", value: "", visible: true, type: "password" },
              { name: "password_confirm", label: "Confirm password", value: "", visible: true, type: "password" },
            ],
          },
        ],
      };
    },
    locator: () => ({
      first() {
        return this;
      },
      count: async () => 1,
      isVisible: async () => true,
      click: async () => {
        clicked = true;
      },
      dispatchEvent: async () => {
        clicked = true;
      },
    }),
    waitForTimeout: async () => undefined,
  };
  const client = {
    solve: async () => {
      solveCalled = true;
      return {
        response: { errorId: 0, status: "ready", solution: { gRecaptchaResponse: "token-abc" } },
        taskId: "task-1",
        taskType: "ReCaptchaV2TaskProxyLess",
        solution: { gRecaptchaResponse: "token-abc" },
      };
    },
  };

  const result = await attemptCapsolverContinuation({
    page: page as never,
    submitAfterSolve: true,
    config: {
      enabled: true,
      apiKey: "secret",
      createTaskUrl: "https://api.test/createTask",
      getTaskResultUrl: "https://api.test/getTaskResult",
      pollIntervalMs: 0,
      maxPolls: 1,
      requestTimeoutMs: 100,
    },
    client: client as never,
  });

  assert.equal(result.attempted, false);
  assert.equal(result.solved, false);
  assert.equal(result.applied, false);
  assert.equal(result.submitted, false);
  assert.equal(result.submit_blocked, true);
  assert.equal(result.submit_block_reason, "REGISTRATION_REQUIRED_FIELDS_EMPTY");
  assert.deepEqual(result.missing_fields, ["username", "email", "password", "confirm password"]);
  assert.equal(solveCalled, false);
  assert.equal(clicked, false);
  assert.match(result.detail, /not invoked/i);
});
