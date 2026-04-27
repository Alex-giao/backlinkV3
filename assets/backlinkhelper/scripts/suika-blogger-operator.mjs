import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import {
  buildCommentCopyPrompt,
  chooseFallbackCommentCopy,
  extractRecentCopyHistory,
  validateCommentCopyPlan,
} from '../dist/shared/comment-copy-policy.js';
import { listTasks } from '../dist/memory/data-store.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const commentCopySchemaPath = path.join(scriptDir, 'comment-copy.schema.json');

function readStdin() {
  return new Promise((resolve, reject) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => s += d);
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', reject);
  });
}
function now() { return new Date().toISOString(); }
function excerpt(s, n=900) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n); }
function makeEnvelope({ctx, status, detail, terminalClass, classification, confidence=0.85, finalUrl, title, summary, linkPresent=false, steps=[]}) {
  const taskId = ctx.task.id;
  return {
    trace: {
      task_id: taskId,
      agent_backend: 'hermes-operator/suika-blogger-playwright',
      started_at: ctx.__started_at,
      finished_at: now(),
      stop_reason: terminalClass,
      final_url: finalUrl || ctx.prepare?.effective_target_url || ctx.task.target_url,
      final_title: title || '',
      final_excerpt: summary || detail,
      steps,
    },
    handoff: {
      detail,
      artifact_refs: [ctx.prepare?.scout_artifact_ref].filter(Boolean),
      current_url: finalUrl || ctx.prepare?.effective_target_url || ctx.task.target_url,
      recorded_steps: steps,
      agent_backend: 'hermes-operator/suika-blogger-playwright',
      agent_steps_count: steps.length,
      visual_verification: {
        classification,
        confidence,
        summary: summary || detail,
      },
      proposed_outcome: linkPresent ? {
        next_status: 'DONE',
        detail,
        terminal_class: 'submitted_and_verified',
      } : {
        next_status: status,
        detail,
        terminal_class: terminalClass,
      },
    },
  };
}

function findBloggerCommentFrame(page) {
  const frames = page.frames();
  return frames.find(f => /blogger\.com\/comment\/frame/.test(f.url())) || frames.find(f => /comment/i.test(f.url()));
}

async function readBodyText(page, frame) {
  return frame ? await frame.locator('body').innerText({ timeout: 5000 }).catch(() => '') : await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
}

function isGoogleSignInPrompt(text) {
  return /sign in with google|to leave a comment/i.test(text || '');
}

function isGoogleVerificationGate(text) {
  return /verify (?:it'?s|its) you|enter your password|2-step|two-factor|phone number|recovery email|couldn'?t verify/i.test(text || '');
}

async function clickFirstVisible(locator, options = {}) {
  const count = await locator.count().catch(() => 0);
  if (!count) return false;
  for (let i = 0; i < Math.min(count, 6); i += 1) {
    const item = locator.nth(i);
    if (await item.isVisible({ timeout: options.visibleTimeout ?? 1200 }).catch(() => false)) {
      await item.click({ timeout: options.clickTimeout ?? 5000, force: true });
      return true;
    }
  }
  return false;
}

function extractJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}

function readCommentPreviewFromTrace(task) {
  const traceRef = (task.latest_artifacts || []).find(ref => /-agent-loop\.json$/.test(ref));
  if (!traceRef || !fs.existsSync(traceRef)) return undefined;
  try {
    const trace = JSON.parse(fs.readFileSync(traceRef, 'utf8'));
    const fillStep = [...(trace.steps || [])].reverse().find(step => step?.action === 'fill_comment' || step?.comment_preview);
    return fillStep?.comment_preview || fillStep?.comment_html;
  } catch {
    return undefined;
  }
}

async function loadRecentCopyHistory(promotedUrl) {
  try {
    const tasks = await listTasks();
    const history = extractRecentCopyHistory(tasks, promotedUrl, 12);
    const byId = new Map(tasks.map(task => [task.id, task]));
    return history.map(item => ({
      ...item,
      comment_excerpt: item.comment_excerpt || readCommentPreviewFromTrace(byId.get(item.task_id)),
    }));
  } catch (e) {
    return [];
  }
}

function runAiCopyPlanner(prompt, steps) {
  if ((process.env.BACKLINKHELPER_COPY_MODE || 'ai').toLowerCase() === 'fallback') {
    return null;
  }
  const backend = (process.env.BACKLINKHELPER_COPY_AI_BACKEND || 'hermes').toLowerCase();
  const model = process.env.BACKLINKHELPER_COPY_AI_MODEL?.trim();

  if (backend === 'codex') {
    const outFile = path.join(os.tmpdir(), `backlink-copy-${process.pid}-${Date.now()}.json`);
    const args = [
      'exec',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--ephemeral',
      '--output-schema', commentCopySchemaPath,
      '--output-last-message', outFile,
    ];
    if (model) args.push('--model', model);
    args.push('-');
    try {
      const stdout = execFileSync('codex', args, {
        cwd: repoRoot,
        input: prompt,
        encoding: 'utf8',
        timeout: Number(process.env.BACKLINKHELPER_COPY_AI_TIMEOUT_MS || '120000'),
        maxBuffer: 4 * 1024 * 1024,
        env: process.env,
      });
      const raw = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : stdout;
      const parsed = extractJsonObject(raw);
      steps.push({ action: 'ai_copy_planner_called', backend: 'codex', ok: Boolean(parsed) });
      return parsed;
    } catch (e) {
      steps.push({ action: 'ai_copy_planner_called', backend: 'codex', ok: false, error: excerpt(e?.message || String(e), 240) });
      return null;
    } finally {
      fs.rmSync(outFile, { force: true });
    }
  }

  const args = [
    'chat',
    '-Q',
    '--source', 'tool',
    '--max-turns', '1',
    '--ignore-rules',
    '--toolsets', 'terminal',
  ];
  const provider = process.env.BACKLINKHELPER_COPY_AI_PROVIDER?.trim();
  if (provider) args.push('--provider', provider);
  if (model) args.push('--model', model);
  args.push('-q', prompt);
  try {
    const stdout = execFileSync('hermes', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: Number(process.env.BACKLINKHELPER_COPY_AI_TIMEOUT_MS || '120000'),
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    });
    const parsed = extractJsonObject(stdout);
    steps.push({ action: 'ai_copy_planner_called', backend: 'hermes', ok: Boolean(parsed) });
    return parsed;
  } catch (e) {
    steps.push({ action: 'ai_copy_planner_called', backend: 'hermes', ok: false, error: excerpt(e?.message || String(e), 240) });
    return null;
  }
}

async function buildPageCopyContext(page, title) {
  const heading = await page.locator('h1,h2,.post-title,.entry-title').first().innerText({ timeout: 3000 }).catch(() => '');
  const body = await page.locator('.post-body,.entry-content,article,main,body').first().innerText({ timeout: 5000 }).catch(() => '');
  return {
    pageTitle: excerpt(heading || title || await page.title().catch(() => ''), 180),
    pageExcerpt: excerpt(body, 1200),
  };
}

async function planCommentCopy({ ctx, page, title, promotedUrl, steps }) {
  const profile = ctx.task?.submission?.promoted_profile || {};
  const pageContext = await buildPageCopyContext(page, title);
  const recentHistory = await loadRecentCopyHistory(promotedUrl);
  const recentAnchors = recentHistory.map(item => item.anchor_text).filter(Boolean);
  const prompt = buildCommentCopyPrompt({
    promotedUrl,
    promotedName: profile.name || 'Suika Game',
    promotedDescription: profile.description || 'A casual fruit-merging browser puzzle.',
    pageTitle: pageContext.pageTitle,
    pageExcerpt: pageContext.pageExcerpt,
    recentHistory,
  });

  const aiPlan = runAiCopyPlanner(prompt, steps);
  if (aiPlan) {
    const validation = validateCommentCopyPlan(aiPlan, { promotedUrl, recentAnchors, minChars: 70, maxChars: 460 });
    if (validation.ok) {
      steps.push({
        action: 'comment_copy_plan',
        source: 'ai',
        anchor_text: aiPlan.anchor_text,
        recent_anchors: recentAnchors.slice(0, 6),
        reason: excerpt(aiPlan.reason || '', 220),
      });
      return { ...aiPlan, source: 'ai' };
    }
    steps.push({ action: 'comment_copy_plan_rejected', source: 'ai', errors: validation.errors, anchor_text: aiPlan.anchor_text });
  }

  const fallback = chooseFallbackCommentCopy({
    promotedUrl,
    pageTitle: pageContext.pageTitle,
    pageExcerpt: pageContext.pageExcerpt,
    recentAnchors,
    seed: `${ctx.task?.id || ''}|${Date.now()}`,
  });
  const fallbackValidation = validateCommentCopyPlan(fallback, { promotedUrl, recentAnchors, minChars: 60, maxChars: 520 });
  if (!fallbackValidation.ok) {
    throw new Error(`Fallback comment copy failed validation: ${fallbackValidation.errors.join('; ')}`);
  }
  steps.push({
    action: 'comment_copy_plan',
    source: 'fallback',
    anchor_text: fallback.anchor_text,
    recent_anchors: recentAnchors.slice(0, 6),
    reason: fallback.reason,
  });
  return fallback;
}

async function continueGoogleAccountChooser(authPage, steps) {
  await authPage.bringToFront().catch(() => {});
  await authPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await authPage.waitForTimeout(2500).catch(() => {});
  const authText = await authPage.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  steps.push({ action: 'google_auth_page_seen', url: authPage.url(), excerpt: excerpt(authText, 240) });
  if (isGoogleVerificationGate(authText)) {
    return { ok: false, blocked: true, detail: 'Google account is asking for additional verification/password.' };
  }

  const selectors = [
    '[data-identifier]',
    'div[role="link"][data-identifier]',
    'div[role="button"][data-identifier]',
    'text=/^Continue as /i',
    'button:has-text("Continue")',
    'div[role="button"]:has-text("Continue")',
  ];
  for (const selector of selectors) {
    if (await clickFirstVisible(authPage.locator(selector), { visibleTimeout: 1200 }).catch(() => false)) {
      steps.push({ action: 'google_auth_click', selector });
      await authPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await authPage.waitForTimeout(3500).catch(() => {});
      break;
    }
  }
  const afterText = await authPage.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  if (isGoogleVerificationGate(afterText)) {
    return { ok: false, blocked: true, detail: 'Google account is asking for additional verification/password.' };
  }
  return { ok: true, blocked: false };
}

async function attemptBloggerGoogleSignIn(page, commentFrame, steps, targetUrl) {
  const selectors = [
    '[role="button"][aria-label="Sign in with Google"]',
    'div[role="button"]:has-text("Sign in with Google")',
    '[data-tooltip="Sign in with Google"]',
    'a[href*="accounts.google.com"]',
    'a[href*="ServiceLogin"]',
    'text=/sign in with google/i',
    'text=/sign in/i',
    'button:has-text("Sign in")',
    '[role="button"]:has-text("Google")',
  ];

  let clicked = false;
  let popup = null;
  for (const selector of selectors) {
    const locator = commentFrame.locator(selector);
    const popupPromise = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
    if (await clickFirstVisible(locator, { visibleTimeout: 1200 }).catch(() => false)) {
      clicked = true;
      steps.push({ action: 'click_google_signin', selector });
      popup = await popupPromise;
      break;
    }
  }

  if (!clicked) {
    return { attempted: false, blocked: false, detail: 'Could not find a clickable Blogger Google sign-in control.' };
  }

  let authResult = { ok: true, blocked: false };
  const authPage = popup || (/accounts\.google\.com/.test(page.url()) ? page : null);
  if (authPage) {
    authResult = await continueGoogleAccountChooser(authPage, steps);
    if (authPage !== page) {
      await authPage.close().catch(() => {});
      await page.bringToFront().catch(() => {});
    }
  }
  if (authResult.blocked) {
    return { attempted: true, blocked: true, detail: authResult.detail };
  }

  await page.waitForTimeout(5000);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4500);
  const refreshedFrame = findBloggerCommentFrame(page);
  const refreshedText = await readBodyText(page, refreshedFrame);
  const refreshedTextarea = refreshedFrame?.locator('textarea[aria-label="Enter Comment"], textarea, [contenteditable="true"]').first();
  const hasTextarea = Boolean(refreshedTextarea) && await refreshedTextarea.isVisible({ timeout: 3000 }).catch(() => false);
  steps.push({ action: 'google_signin_after_reload', has_comment_textarea: hasTextarea, excerpt: excerpt(refreshedText, 240) });
  return { attempted: true, blocked: false, signedIn: hasTextarea, commentFrame: refreshedFrame, bodyText: refreshedText };
}

const input = await readStdin();
const ctx = JSON.parse(input);
ctx.__started_at = now();
const targetUrl = ctx.prepare?.effective_target_url || ctx.task?.target_url;
const promotedUrl = ctx.promotedUrl || ctx.scope?.promotedUrl || 'https://suikagame.fun/';
const cdpUrl = ctx.cdpUrl || process.env.BACKLINKHELPER_OPERATOR_CDP_URL || 'http://127.0.0.1:9224';
let browser, page;
const steps = [];
try {
  browser = await chromium.connectOverCDP(cdpUrl);
  const bctx = browser.contexts()[0] ?? await browser.newContext();
  page = bctx.pages().find(p => (p.url() || '').includes(new URL(targetUrl).hostname)) ?? await bctx.newPage();
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.bringToFront();
  await page.waitForTimeout(4500);
  const title = await page.title().catch(() => '');
  steps.push({ action: 'open_target', url: page.url(), title });

  let commentFrame = findBloggerCommentFrame(page);
  let bodyText = await readBodyText(page, commentFrame);
  if (!commentFrame) {
    console.error('No Blogger comment frame found');
    console.log(JSON.stringify(makeEnvelope({ctx, status:'SKIPPED', detail:'No Blogger comment frame found on target page.', terminalClass:'no_comment_surface', classification:'unknown', confidence:0.7, finalUrl:page.url(), title, summary:excerpt(bodyText), steps}), null, 2));
    process.exit(0);
  }
  steps.push({ action: 'inspect_comment_frame', frame_url: commentFrame.url(), excerpt: excerpt(bodyText, 300) });

  let textarea = commentFrame.locator('textarea[aria-label="Enter Comment"], textarea, [contenteditable="true"]').first();
  let textareaCount = await textarea.count().catch(() => 0);
  if (!textareaCount || !(await textarea.isVisible({ timeout: 3000 }).catch(() => false))) {
    if (isGoogleSignInPrompt(bodyText)) {
      const signInResult = await attemptBloggerGoogleSignIn(page, commentFrame, steps, targetUrl);
      if (signInResult.blocked) {
        console.error('Google account needs additional verification');
        console.log(JSON.stringify(makeEnvelope({ctx, status:'WAITING_MANUAL_AUTH', detail:signInResult.detail || 'Google account needs additional verification before Blogger comment posting.', terminalClass:'google_account_verification_required', classification:'login_gate', confidence:0.9, finalUrl:page.url(), title, summary:excerpt(bodyText), steps}), null, 2));
        process.exit(0);
      }
      commentFrame = signInResult.commentFrame || findBloggerCommentFrame(page);
      bodyText = signInResult.bodyText || await readBodyText(page, commentFrame);
      if (commentFrame) {
        textarea = commentFrame.locator('textarea[aria-label="Enter Comment"], textarea, [contenteditable="true"]').first();
        textareaCount = await textarea.count().catch(() => 0);
      }
      if (!commentFrame || !textareaCount || !(await textarea.isVisible({ timeout: 3000 }).catch(() => false))) {
        console.error('Google sign-in did not expose Blogger comment fields yet');
        console.log(JSON.stringify(makeEnvelope({ctx, status:'RETRYABLE', detail:signInResult.detail || 'Blogger Google sign-in was attempted with the shared logged-in browser session, but comment fields were not exposed yet.', terminalClass:'google_signin_retryable', classification:'login_gate', confidence:0.72, finalUrl:page.url(), title, summary:excerpt(bodyText), steps}), null, 2));
        process.exit(0);
      }
    } else {
      console.log(JSON.stringify(makeEnvelope({ctx, status:'SKIPPED', detail:'No usable visible comment textarea found.', terminalClass:'no_comment_surface', classification:'unknown', confidence:0.75, finalUrl:page.url(), title, summary:excerpt(bodyText), steps}), null, 2));
      process.exit(0);
    }
  }

  const topic = excerpt((await page.locator('h1,h2,.post-title').first().innerText({ timeout: 3000 }).catch(() => title)) || title, 120);
  const copyPlan = await planCommentCopy({ ctx, page, title: topic || title, promotedUrl, steps });
  const comment = copyPlan.comment_html;
  await textarea.fill(comment);
  steps.push({
    action: 'fill_comment',
    chars: comment.length,
    anchor_text: copyPlan.anchor_text,
    copy_source: copyPlan.source,
    comment_preview: excerpt(comment, 260),
  });

  const anonText = commentFrame.getByText(/Anonymous/i).first();
  if (await anonText.count().catch(() => 0)) {
    await anonText.click({ timeout: 5000, force: true }).catch(() => {});
    steps.push({ action: 'select_identity', identity: 'Anonymous' });
  }
  await page.waitForTimeout(1000);
  const publish = commentFrame.locator('text=/^(PUBLISH|Publish|Post Comment|Submit)$/i').last();
  if (!(await publish.count().catch(() => 0))) {
    console.log(JSON.stringify(makeEnvelope({ctx, status:'SKIPPED', detail:'Comment was fillable but no publish/submit control was found.', terminalClass:'no_submit_control', classification:'submit_form', confidence:0.8, finalUrl:page.url(), title, summary:excerpt(bodyText), steps}), null, 2));
    process.exit(0);
  }
  await publish.click({ timeout: 10000, force: true });
  steps.push({ action: 'click_publish' });
  await page.waitForTimeout(9000);
  const finalUrl = page.url();
  await page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const verify = await page.evaluate((promotedUrl) => ({
    url: location.href,
    anchors: [...document.querySelectorAll('a')].filter(a => (a.href || '').includes(new URL(promotedUrl).hostname)).map(a => ({ text:a.textContent, href:a.href, rel:a.rel })),
    text: document.body.innerText.includes(promotedUrl),
  }), promotedUrl).catch(e => ({ error: e.message, anchors: [], text: false, url: page.url() }));
  steps.push({ action: 'verify_public_page', result: verify });
  const linkPresent = verify.anchors?.length > 0 || verify.text;
  console.log(JSON.stringify(makeEnvelope({
    ctx,
    status: linkPresent ? 'DONE' : 'WAITING_SITE_RESPONSE',
    detail: linkPresent ? 'Submitted Blogger comment and verified promoted link/text on public page.' : 'Submitted Blogger comment; promoted URL not yet visible as an anchor/text on refreshed page.',
    terminalClass: linkPresent ? 'submitted_and_verified' : 'comment_moderation_pending',
    classification: linkPresent ? 'success_or_confirmation' : 'success_or_confirmation',
    confidence: linkPresent ? 0.95 : 0.78,
    finalUrl: verify.url || finalUrl,
    title,
    summary: linkPresent ? `Public verification found ${verify.anchors?.length || 0} matching anchor(s); text=${!!verify.text}.` : 'Submission appeared accepted but public verification did not find the promoted URL yet.',
    linkPresent,
    steps,
  }), null, 2));
} catch (e) {
  console.error(e?.stack || e?.message || String(e));
  console.log(JSON.stringify(makeEnvelope({ctx, status:'RETRYABLE', detail:`Operator runtime error: ${e?.message || e}`, terminalClass:'operator_runtime_error', classification:'unknown', confidence:0.4, finalUrl:page?.url?.(), title:'', summary:String(e?.message || e), steps}), null, 2));
} finally {
  // Leave the CDP browser running; close only this client connection.
  await browser?.close?.().catch(() => {});
}
