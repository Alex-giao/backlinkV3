import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

import {
  acquireWorkerLock,
  classifyCampaignRun,
  refreshWorkerLock,
  releaseWorkerLock,
  shouldStopWorkerLoop,
} from '../dist/shared/watchdog-worker-policy.js';

const cwd = '/home/gc/backlinkV3/assets/backlinkhelper';
const env = { ...process.env, BACKLINKHELPER_STORE: 'd1', BACKLINKHELPER_D1_DATABASE_NAME: 'backlinkhelper-v3' };
const runtimeDir = '/home/gc/.hermes/state/backlinkhelper-v3/runtime';
fs.mkdirSync(runtimeDir, { recursive: true });
const cdp = process.env.BACKLINKHELPER_CDP_URL || 'http://127.0.0.1:9224';
const promotedUrl = process.env.BACKLINKHELPER_PROMOTED_URL || 'https://suikagame.fun/';
const promotedHostname = new URL(promotedUrl).hostname.replace(/^www\./i, '').toLowerCase();
const maxIterations = Number(process.env.BACKLINKHELPER_LOOP_ITERS || '10');
const successTarget = process.env.BACKLINKHELPER_SUCCESS_TARGET
  ? Number(process.env.BACKLINKHELPER_SUCCESS_TARGET)
  : undefined;
const operatorTimeoutMs = Number(process.env.BACKLINKHELPER_OPERATOR_TIMEOUT_MS || '420000');
const workerMaxRuntimeMs = Number(process.env.BACKLINKHELPER_WORKER_MAX_RUNTIME_MS || '540000');
const workerMinRemainingMs = Number(
  process.env.BACKLINKHELPER_WORKER_MIN_REMAINING_MS || String(Math.min(operatorTimeoutMs + 30000, 300000)),
);
const workerIdleLimit = Number(process.env.BACKLINKHELPER_WORKER_IDLE_LIMIT || '2');
const workerLockStaleMs = Number(process.env.BACKLINKHELPER_WORKER_LOCK_STALE_MS || '900000');
const workerLockEnabled = process.env.BACKLINKHELPER_WORKER_LOCK !== '0';
const workerStartedAtMs = Date.now();
const workerOwnerId = `${os.hostname()}:${process.pid}:${workerStartedAtMs}`;
const workerLockDir = path.join(runtimeDir, `${promotedHostname.replace(/[^a-z0-9.-]+/gi, '-')}-watchdog-worker.lock`);
function runCli(args, opts={}) {
  try {
    const out = execFileSync('node', ['dist/cli/index.js', ...args], { cwd, env, encoding: 'utf8', timeout: opts.timeout || 300000, maxBuffer: 20*1024*1024 });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: e.stdout?.toString() || '', err: e.stderr?.toString() || e.message };
  }
}
function pendingFiles() {
  return fs.readdirSync(runtimeDir).filter(f => /^unattended-.*-pending-finalize\.json$/.test(f)).map(f => path.join(runtimeDir, f));
}
async function openFinalizeUrl(taskId, pendingFile) {
  let url;
  try { url = JSON.parse(fs.readFileSync(pendingFile, 'utf8')).handoff?.current_url; } catch {}
  if (!url) return;
  const host = new URL(url).hostname;
  const browser = await chromium.connectOverCDP(cdp);
  const ctx = browser.contexts()[0] ?? await browser.newContext();
  let page = ctx.pages().find(p => (p.url() || '').includes(host)) ?? await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(async () => { await page.goto(url, { waitUntil: 'load', timeout: 60000 }); });
  await page.bringToFront().catch(()=>{});
  await page.waitForTimeout(2500);
  await browser.close().catch(()=>{});
}
async function finalizePending() {
  const results = [];
  for (const file of pendingFiles()) {
    const taskId = path.basename(file).replace(/-pending-finalize\.json$/, '');
    await openFinalizeUrl(taskId, file).catch(e => results.push({ taskId, open_error: e.message }));
    const fin = runCli(['task-finalize', '--task-id', taskId, '--cdp-url', cdp], { timeout: 300000 });
    results.push({ taskId, ok: fin.ok, out: fin.out.slice(-2000), err: fin.err });
  }
  return results;
}
function parseJsonObject(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}
function compactStatusFromOutput(text) {
  const j = parseJsonObject(text);
  if (!j) return { raw: text };
  return {
    business: j.business_report?.overview,
    status: j.system_status_report?.status_counts,
    totals: j.system_status_report?.totals,
  };
}
function submittedSuccessFromStatus(status) {
  return Number(status?.business?.submitted_success ?? NaN);
}

async function main() {
  const lockResult = workerLockEnabled
    ? acquireWorkerLock({
        lockDir: workerLockDir,
        ownerId: workerOwnerId,
        staleMs: workerLockStaleMs,
        metadata: { pid: process.pid, promoted_hostname: promotedHostname, mode: 'suika-unattended-loop' },
      })
    : { acquired: true, recovered_stale: false, lock: undefined };

  if (!lockResult.acquired) {
    console.log(JSON.stringify({
      worker: 'suika-unattended-loop',
      promoted_url: promotedUrl,
      promoted_hostname: promotedHostname,
      status: 'already_running',
      reason: lockResult.reason,
      lock_age_ms: lockResult.age_ms,
      lock: lockResult.lock,
    }, null, 2));
    return;
  }

  const summary = [];
  let idleCount = 0;
  let workerStopReason = 'max_iterations';
  let submittedSuccess;

  try {
    for (let i=0; i<maxIterations; i++) {
      const preStop = shouldStopWorkerLoop({
        iteration: i,
        maxIterations,
        idleCount,
        idleLimit: workerIdleLimit,
        startedAtMs: workerStartedAtMs,
        nowMs: Date.now(),
        maxRuntimeMs: workerMaxRuntimeMs,
        minRemainingMs: workerMinRemainingMs,
        submittedSuccess,
        successTarget,
      });
      if (preStop) {
        workerStopReason = preStop;
        break;
      }

      if (workerLockEnabled) {
        refreshWorkerLock({ lockDir: workerLockDir, ownerId: workerOwnerId });
      }
      const beforePending = pendingFiles().length;
      const campaignTimeoutMs = Math.min(600000, Math.max(60000, operatorTimeoutMs + 120000));
      const campaign = runCli([
        'unattended-campaign',
        '--promoted-url', promotedUrl,
        '--max-active-tasks', '1',
        '--max-scope-ticks', '8',
        '--candidate-limit', process.env.BACKLINKHELPER_CANDIDATE_LIMIT || '500',
        '--no-follow-up',
        '--cdp-url', cdp,
        '--operator-command', 'node scripts/suika-blogger-operator.mjs',
        '--operator-timeout-ms', String(operatorTimeoutMs),
      ], { timeout: campaignTimeoutMs });
      const campaignResult = campaign.ok ? parseJsonObject(campaign.out) : undefined;
      const campaignClass = campaign.ok && campaignResult
        ? classifyCampaignRun(campaignResult)
        : { productive: false, idle: false, hard_stop: true, reason: 'campaign_cli_error' };
      const finalized = await finalizePending();
      const status = runCli(['guarded-drain-status', '--promoted-hostname', promotedHostname], { timeout: 180000 });
      const compactStatus = compactStatusFromOutput(status.out);
      const nextSubmittedSuccess = submittedSuccessFromStatus(compactStatus);
      if (Number.isFinite(nextSubmittedSuccess)) {
        submittedSuccess = nextSubmittedSuccess;
      }

      idleCount = campaignClass.idle ? idleCount + 1 : 0;
      summary.push({
        iter: i+1,
        campaign_ok: campaign.ok,
        campaign_stop_reason: campaignResult?.stop_reason,
        campaign_classification: campaignClass,
        campaign_tail: (campaign.out || campaign.err || '').slice(-1200),
        beforePending,
        finalized,
        idleCount,
        status: compactStatus,
      });

      if (workerLockEnabled) {
        refreshWorkerLock({ lockDir: workerLockDir, ownerId: workerOwnerId });
      }

      if (campaignClass.hard_stop) {
        workerStopReason = `campaign_${campaignClass.reason}`;
        break;
      }

      const postStop = shouldStopWorkerLoop({
        iteration: i + 1,
        maxIterations,
        idleCount,
        idleLimit: workerIdleLimit,
        startedAtMs: workerStartedAtMs,
        nowMs: Date.now(),
        maxRuntimeMs: workerMaxRuntimeMs,
        minRemainingMs: workerMinRemainingMs,
        submittedSuccess,
        successTarget,
      });
      if (postStop) {
        workerStopReason = postStop;
        break;
      }
    }
  } finally {
    if (workerLockEnabled) {
      releaseWorkerLock({ lockDir: workerLockDir, ownerId: workerOwnerId });
    }
  }

  const status = runCli(['guarded-drain-status', '--promoted-hostname', promotedHostname], { timeout: 180000 });
  const compactStatus = compactStatusFromOutput(status.out);
  console.log(JSON.stringify({
    worker: 'suika-unattended-loop',
    promoted_url: promotedUrl,
    promoted_hostname: promotedHostname,
    lock: workerLockEnabled ? { acquired: true, recovered_stale: lockResult.recovered_stale, lock_dir: workerLockDir } : { enabled: false },
    config: {
      maxIterations,
      workerMaxRuntimeMs,
      workerMinRemainingMs,
      workerIdleLimit,
      operatorTimeoutMs,
      candidateLimit: process.env.BACKLINKHELPER_CANDIDATE_LIMIT || '500',
    },
    workerStopReason,
    elapsedMs: Date.now() - workerStartedAtMs,
    summary,
    compactStatus,
  }, null, 2));
}

await main();
