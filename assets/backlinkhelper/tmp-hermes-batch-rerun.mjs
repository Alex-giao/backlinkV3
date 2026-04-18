// DEPRECATED for live operator runs.
// This tmp helper is debug-only scaffolding and must not be treated as the canonical
// site-execution path, because hardcoded entry keywords / scripted form choreography
// over-constrain agent judgment and violate the operator skill philosophy.
import path from 'node:path';
import { chromium } from 'playwright';
import {
  DATA_DIRECTORIES,
  ensureDataDirectories,
  getArtifactFilePath,
  getProfileFilePath,
  loadTask,
  readJsonFile,
  saveTask,
} from './dist/memory/data-store.js';
import { claimNextTask } from './dist/control-plane/task-queue.js';
import { prepareTaskForAgent } from './dist/control-plane/task-prepare.js';
import { recordAgentTrace } from './dist/control-plane/task-record-agent-trace.js';
import { finalizeTask } from './dist/control-plane/task-finalize.js';
import { buildMissingInputPreflightReport } from './dist/control-plane/missing-input-preflight.js';

const cdpUrl = process.argv[2] || 'http://127.0.0.1:9224';
const maxTasks = Number(process.argv[3] || '999');
const owner = process.argv[4] || 'hermes-batch';
const taskIdPrefix = process.argv[5] || '';

function nowIso() {
  return new Date().toISOString();
}

function makeSummaryLine(message) {
  process.stdout.write(`${message}\n`);
}

function byPriority(a, b) {
  return a - b;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function loadLatestProfile(task) {
  const hostname = task.submission?.promoted_profile?.hostname;
  if (!hostname) return task.submission?.promoted_profile;
  return (await readJsonFile(getProfileFilePath(hostname))) || task.submission?.promoted_profile;
}

async function acceptCommonBanners(page) {
  const texts = ['Accept', 'Accept all', 'I agree', 'Got it', 'Allow all'];
  for (const text of texts) {
    const button = page.getByRole('button', { name: new RegExp(`^${escapeRegex(text)}$`, 'i') }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
  }
}

async function clickFirstVisible(page, candidates) {
  for (const candidate of candidates) {
    const regex = candidate instanceof RegExp ? candidate : new RegExp(escapeRegex(candidate), 'i');
    for (const role of ['button', 'link']) {
      const locator = page.getByRole(role, { name: regex }).first();
      if (await locator.isVisible().catch(() => false)) {
        await locator.click({ timeout: 5000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1000);
        return true;
      }
    }
  }
  return false;
}

async function ensureSubmitSurface(page) {
  const meaningfulVisibleFields = await page.locator('input, textarea, select').evaluateAll((elements) => {
    return elements.filter((el) => {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'hidden' || type === 'radio' || type === 'checkbox' || type === 'submit' || type === 'button') {
        return false;
      }
      return Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    }).length;
  }).catch(() => 0);
  if (meaningfulVisibleFields >= 3) {
    return;
  }
  await clickFirstVisible(page, [
    /submit tool/i,
    /submit website/i,
    /submit your site/i,
    /submit your tool/i,
    /submit startup/i,
    /add startup/i,
    /contribute/i,
    /add your website/i,
    /add website/i,
    /add listing/i,
    /get listed/i,
    /suggest/i,
  ]);
}

async function fillByLabelLike(page, patterns, value, steps) {
  if (!value) return false;
  for (const pattern of patterns) {
    const labelLocator = page.getByLabel(pattern, { exact: false }).first();
    if (await labelLocator.isVisible().catch(() => false)) {
      await labelLocator.fill(value, { timeout: 5000 }).catch(() => {});
      steps.push({ action: 'fill_label', label: String(pattern), value });
      return true;
    }
  }
  return false;
}

async function fillByPlaceholderLike(page, patterns, value, steps) {
  if (!value) return false;
  for (const pattern of patterns) {
    const locator = page.getByPlaceholder(pattern).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.fill(value, { timeout: 5000 }).catch(() => {});
      steps.push({ action: 'fill_placeholder', placeholder: String(pattern), value });
      return true;
    }
  }
  return false;
}

async function fillBySelector(page, selectors, value, steps) {
  if (!value) return false;
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.fill(value, { timeout: 5000 }).catch(() => {});
      steps.push({ action: 'fill_selector', selector, value });
      return true;
    }
  }
  return false;
}

async function selectFirstMatchingOption(page, profile, steps) {
  const selects = page.locator('select');
  const count = await selects.count().catch(() => 0);
  const desired = [
    profile.primary_category,
    'Finance',
    'Financial Services',
    'AI Tools',
    'Business',
    'Productivity',
  ].filter(Boolean);
  for (let i = 0; i < count; i += 1) {
    const select = selects.nth(i);
    if (!(await select.isVisible().catch(() => false))) continue;
    const html = await select.evaluate((el) => el.outerHTML).catch(() => '');
    if (!/category|categories/i.test(html)) continue;
    for (const value of desired) {
      const success = await select.selectOption({ label: value }).then(() => true).catch(() => false);
      if (success) {
        steps.push({ action: 'select_selector', selector: `select:nth-of-type(${i + 1})`, value });
        return true;
      }
    }
  }
  return false;
}

async function checkTerms(page, steps) {
  const checkboxes = page.locator('input[type="checkbox"]');
  const count = await checkboxes.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const checkbox = checkboxes.nth(i);
    if (!(await checkbox.isVisible().catch(() => false))) continue;
    const containerText = await checkbox.evaluate((el) => el.parentElement?.innerText || '').catch(() => '');
    if (!/terms|rules|agree|policy/i.test(containerText)) continue;
    await checkbox.check({ timeout: 4000 }).catch(() => checkbox.click({ timeout: 4000 }).catch(() => {}));
    steps.push({ action: 'click_selector', selector: `input[type="checkbox"]:nth-of-type(${i + 1})` });
  }
}

async function manualAttempt({ task, profile, cdpUrl }) {
  const browser = await chromium.connectOverCDP(cdpUrl);
  let page;
  let context;
  let createdContext = false;
  const startedAt = nowIso();
  const steps = [];
  try {
    context = browser.contexts()[0];
    if (!context) {
      context = await browser.newContext({ ignoreHTTPSErrors: true });
      createdContext = true;
    }
    page = await context.newPage();
    await page.goto(task.target_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    steps.push({ action: 'goto', url: task.target_url });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await acceptCommonBanners(page);
    await ensureSubmitSurface(page);

    const fullName = profile.company_name || profile.name;
    const submitterEmail = task.submission.submitter_email || profile.contact_email || 'support@exactstatement.com';
    const longDescription = profile.long_description || profile.description;
    const shortDescription = profile.tagline || profile.description;

    await fillByLabelLike(page, [/^name$/i, /company name/i, /tool name/i, /startup name/i, /product name/i, /title/i], fullName, steps);
    await fillByPlaceholderLike(page, ['Name', 'Tool Name', 'Company Name', 'Product Name'], fullName, steps);
    await fillBySelector(page, ['input[name*="name"]', 'input[id*="name"]'], fullName, steps);

    await fillByLabelLike(page, [/email/i], submitterEmail, steps);
    await fillByPlaceholderLike(page, ['Email'], submitterEmail, steps);
    await fillBySelector(page, ['input[type="email"]', 'input[name*="email"]'], submitterEmail, steps);

    await fillByLabelLike(page, [/tool url/i, /website url/i, /^url$/i, /website/i, /link/i], profile.url, steps);
    await fillByPlaceholderLike(page, ['Tool URL', 'Website URL', 'URL', 'Website'], profile.url, steps);
    await fillBySelector(page, ['input[type="url"]', 'input[name*="url"]', 'input[id*="url"]'], profile.url, steps);

    await fillByLabelLike(page, [/short description/i, /tagline/i], shortDescription, steps);
    await fillByPlaceholderLike(page, ['Short Description', 'Tagline'], shortDescription, steps);

    await fillByLabelLike(page, [/description/i, /about/i], longDescription, steps);
    await fillByPlaceholderLike(page, ['Description', 'About'], longDescription, steps);
    await fillBySelector(page, ['textarea', 'textarea[name*="description"]'], longDescription, steps);

    await fillByLabelLike(page, [/country/i], profile.country, steps);
    await fillByLabelLike(page, [/state/i, /province/i], profile.state_province, steps);
    await fillByLabelLike(page, [/founded date/i, /date founded/i], profile.founded_date, steps);

    await selectFirstMatchingOption(page, profile, steps);
    await checkTerms(page, steps);

    const beforeText = await page.locator('body').innerText().catch(() => '');
    let submitClicked = await page.locator('input[type="submit"], button[type="submit"]').first().click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (!submitClicked) {
      submitClicked = await clickFirstVisible(page, [
        /^submit$/i,
        /^send$/i,
        /^contribute$/i,
        /submit tool/i,
        /submit website/i,
        /add listing/i,
        /publish/i,
        /continue/i,
        /join .*startups/i,
      ]);
    }
    if (submitClicked) {
      steps.push({ action: 'click_text', text: 'submit-ish' });
      await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }

    const screenshotPath = path.join(DATA_DIRECTORIES.artifacts, `${task.id}-hermes-manual.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const title = await page.title().catch(() => '');
    const currentUrl = page.url();

    let detail = submitClicked
      ? 'Hermes manual rerun interacted with the live submit surface and left the result for finalization to classify.'
      : 'Hermes manual rerun opened the prepared target and captured the current surface, but the outcome is still not confirmed.';
    if (/awaiting approval|pending review|submitted|thank you|thanks for submitting|successfully submitted/i.test(bodyText)) {
      detail = 'Hermes manual rerun reached a confirmation-like state before finalization.';
    } else if (/captcha|i am not a robot|recaptcha|turnstile|human verification/i.test(bodyText)) {
      detail = 'Hermes manual rerun hit a human-verification boundary before finalization.';
    } else if (/login|sign in|log in/.test(bodyText) && !/create account|register|sign up/.test(bodyText)) {
      detail = 'Hermes manual rerun reached a login-like boundary before finalization.';
    }

    return {
      startedAt,
      finishedAt: nowIso(),
      currentUrl,
      title,
      bodyText,
      detail,
      artifactRefs: [screenshotPath],
      steps,
      stopReason: submitClicked ? 'manual_submit_attempt' : 'manual_surface_capture',
      finalExcerpt: bodyText.slice(0, 1500),
      submitClicked,
    };
  } finally {
    await page?.close({ runBeforeUnload: false }).catch(() => {});
    if (createdContext) {
      await context?.close().catch(() => {});
    }
    await browser.close().catch(() => {});
  }
}

async function processOne(taskId) {
  const prep = await prepareTaskForAgent({ taskId, cdpUrl });
  if (prep.mode !== 'ready_for_agent_loop') {
    const finalTask = await loadTask(taskId);
    return {
      task_id: taskId,
      prepare_mode: prep.mode,
      final_status: finalTask?.status,
      detail: finalTask?.last_takeover_outcome || prep.task?.last_takeover_outcome || prep.mode,
    };
  }

  const task = await loadTask(taskId);
  const profile = await loadLatestProfile(task);
  const attempt = await manualAttempt({ task, profile, cdpUrl });
  const payloadPath = path.join(DATA_DIRECTORIES.runtime, `${taskId}-hermes-manual-envelope.json`);
  const envelope = {
    trace: {
      task_id: taskId,
      agent_backend: 'codex_session',
      started_at: attempt.startedAt,
      finished_at: attempt.finishedAt,
      stop_reason: attempt.stopReason,
      final_url: attempt.currentUrl,
      final_title: attempt.title,
      final_excerpt: attempt.finalExcerpt,
      steps: [],
    },
    handoff: {
      detail: attempt.detail,
      artifact_refs: attempt.artifactRefs,
      current_url: attempt.currentUrl,
      recorded_steps: attempt.steps,
      agent_trace_ref: payloadPath,
      agent_backend: 'codex_session',
      agent_steps_count: attempt.steps.length,
    },
  };
  await recordAgentTrace({ taskId, envelope });
  const finalized = await finalizeTask({ taskId, cdpUrl });
  return {
    task_id: taskId,
    prepare_mode: prep.mode,
    final_status: finalized.next_status,
    wait_reason_code: finalized.wait?.wait_reason_code || null,
    detail: finalized.detail,
    artifact_refs: finalized.artifact_refs,
    manual_current_url: attempt.currentUrl,
    manual_title: attempt.title,
    manual_submit_clicked: attempt.submitClicked,
    manual_artifact_refs: attempt.artifactRefs,
  };
}

async function main() {
  await ensureDataDirectories();
  const preflightMissing = await buildMissingInputPreflightReport({ promotedUrl: 'https://exactstatement.com/' });
  makeSummaryLine(JSON.stringify({ preflight_missing: preflightMissing }, null, 2));
  const results = [];
  let processed = 0;
  while (processed < maxTasks) {
    const claim = await claimNextTask({
      owner,
      scope: taskIdPrefix ? { taskIdPrefix } : undefined,
    });
    if (claim.mode !== 'claimed' || !claim.task) {
      results.push({ mode: claim.mode, lease: claim.lease || null, reapedTaskId: claim.reapedTaskId || null });
      break;
    }
    makeSummaryLine(`CLAIMED ${claim.task.id}`);
    try {
      const result = await processOne(claim.task.id);
      results.push(result);
      makeSummaryLine(`DONE ${claim.task.id} -> ${result.final_status || result.prepare_mode}`);
    } catch (error) {
      results.push({ task_id: claim.task.id, error: error instanceof Error ? error.message : String(error) });
      makeSummaryLine(`ERROR ${claim.task.id} -> ${error instanceof Error ? error.message : String(error)}`);
      const task = await loadTask(claim.task.id).catch(() => null);
      if (task) {
        task.status = 'RETRYABLE';
        task.updated_at = nowIso();
        task.last_takeover_outcome = `Hermes batch rerun crashed: ${error instanceof Error ? error.message : String(error)}`;
        task.notes.push(task.last_takeover_outcome);
        await saveTask(task);
      }
    }
    processed += 1;
  }
  console.log(JSON.stringify({ processed, results }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
