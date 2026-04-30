#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  buildFamilyOperatorPrompt,
  resolveOperatorFlowFamily,
} from '../dist/control-plane/family-operator-dispatcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = process.env.BACKLINKHELPER_REPO_CWD || path.resolve(__dirname, '..');

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('error', reject);
    process.stdin.on('end', () => resolve(data));
  });
}

function agentTraceEnvelopeSchema() {
  return {
    type: 'object',
    additionalProperties: true,
    required: ['trace', 'handoff'],
    properties: {
      trace: {
        type: 'object',
        additionalProperties: true,
        required: ['task_id', 'agent_backend', 'started_at', 'finished_at', 'stop_reason', 'final_url', 'final_title', 'final_excerpt', 'steps'],
        properties: {
          task_id: { type: 'string' },
          agent_backend: { type: 'string' },
          started_at: { type: 'string' },
          finished_at: { type: 'string' },
          stop_reason: { type: 'string' },
          final_url: { type: 'string' },
          final_title: { type: 'string' },
          final_excerpt: { type: 'string' },
          steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      handoff: {
        type: 'object',
        additionalProperties: true,
        required: ['detail', 'artifact_refs', 'current_url', 'recorded_steps', 'agent_trace_ref', 'agent_backend', 'agent_steps_count'],
        properties: {
          detail: { type: 'string' },
          artifact_refs: { type: 'array', items: { type: 'string' } },
          current_url: { type: 'string' },
          recorded_steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
          agent_trace_ref: { type: 'string' },
          agent_backend: { type: 'string' },
          agent_steps_count: { type: 'number' },
          proposed_outcome: { type: 'object', additionalProperties: true },
          visual_verification: { type: 'object', additionalProperties: true },
        },
      },
      account: { type: 'object', additionalProperties: true },
    },
  };
}

function stripMarkdownFence(text) {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1].trim() : trimmed;
}

function extractBalancedJson(text, accepts) {
  const source = stripMarkdownFence(text);
  const tryCandidate = (candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      if (!accepts || accepts(parsed)) {
        return parsed;
      }
    } catch {}
    return undefined;
  };

  const whole = tryCandidate(source);
  if (whole) {
    return whole;
  }

  let sawJsonLikeObject = false;
  for (let start = source.indexOf('{'); start >= 0; start = source.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const parsed = tryCandidate(source.slice(start, i + 1));
          if (parsed) {
            return parsed;
          }
          sawJsonLikeObject = true;
          break;
        }
      }
    }
  }

  if (sawJsonLikeObject) {
    throw new Error('Family agent output did not contain a parseable AgentTraceEnvelope JSON object.');
  }
  throw new Error('Family agent output does not contain a JSON object.');
}

function assertEnvelope(value, expectedTaskId) {
  if (!value || typeof value !== 'object') throw new Error('Agent output is not an object.');
  if (!value.trace || typeof value.trace !== 'object') throw new Error('Agent output is missing trace.');
  if (!value.handoff || typeof value.handoff !== 'object') throw new Error('Agent output is missing handoff.');
  if (value.trace.task_id !== expectedTaskId) {
    throw new Error(`Agent output task_id ${value.trace.task_id} does not match expected ${expectedTaskId}.`);
  }
}

function isEnvelopeForTask(value, expectedTaskId) {
  try {
    assertEnvelope(value, expectedTaskId);
    return true;
  } catch {
    return false;
  }
}

function buildCodexArgs(paths) {
  const configured = process.env.BACKLINKHELPER_CODEX_ARGS;
  if (configured) {
    return configured
      .split(/\s+/)
      .filter(Boolean)
      .concat(['--cd', repoRoot, '--output-last-message', paths.outputPath, '--output-schema', paths.schemaPath, '-']);
  }

  const args = ['exec', '-c', 'shell_environment_policy.inherit="all"'];
  const model = process.env.BACKLINKHELPER_CODEX_MODEL;
  if (model) {
    args.push('--model', model);
  }
  const sandboxMode = process.env.BACKLINKHELPER_CODEX_SANDBOX_MODE || 'workspace-write';
  if (process.env.BACKLINKHELPER_CODEX_BYPASS_APPROVALS === '1') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--sandbox', sandboxMode);
  }
  args.push('--cd', repoRoot, '--output-last-message', paths.outputPath, '--output-schema', paths.schemaPath, '-');
  return args;
}

function buildHermesArgs(prompt) {
  const configured = process.env.BACKLINKHELPER_HERMES_ARGS;
  if (configured) {
    return configured
      .split(/\s+/)
      .filter(Boolean)
      .concat(['--query', prompt]);
  }

  const args = ['chat', '--quiet'];
  const source = process.env.BACKLINKHELPER_HERMES_SOURCE || 'tool:backlinkhelper-family-agent';
  args.push('--source', source);

  const maxTurns = process.env.BACKLINKHELPER_HERMES_MAX_TURNS || '80';
  args.push('--max-turns', maxTurns);

  const toolsets = process.env.BACKLINKHELPER_HERMES_TOOLSETS || 'terminal,file,browser,web,vision';
  if (toolsets) {
    args.push('--toolsets', toolsets);
  }

  const skills = process.env.BACKLINKHELPER_HERMES_SKILLS || 'openclaw-imports/web-backlinker-v3-operator';
  if (skills) {
    args.push('--skills', skills);
  }

  const provider = process.env.BACKLINKHELPER_HERMES_PROVIDER;
  if (provider) {
    args.push('--provider', provider);
  }

  const model = process.env.BACKLINKHELPER_HERMES_MODEL;
  if (model) {
    args.push('--model', model);
  }

  if (process.env.BACKLINKHELPER_HERMES_YOLO === '1') {
    args.push('--yolo');
  }

  args.push('--query', prompt);
  return args;
}

function runHermes(prompt, extraEnv) {
  return new Promise((resolve, reject) => {
    const args = buildHermesArgs(prompt);
    const child = spawn('hermes', args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        HERMES_ACCEPT_HOOKS: process.env.HERMES_ACCEPT_HOOKS || '1',
        NO_COLOR: process.env.NO_COLOR || '1',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const terminate = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
    };
    process.once('SIGTERM', terminate);
    process.once('SIGINT', terminate);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      process.off('SIGTERM', terminate);
      process.off('SIGINT', terminate);
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      process.off('SIGTERM', terminate);
      process.off('SIGINT', terminate);
      if (code !== 0) {
        reject(new Error(`hermes chat failed code=${code ?? 'null'} signal=${signal ?? 'none'} stderr=${stderr.trim()} stdout_tail=${stdout.slice(-2000)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function selectedAgentBackend() {
  const backend = (process.env.BACKLINKHELPER_FAMILY_AGENT_BACKEND || 'hermes').trim().toLowerCase();
  if (backend === 'hermes' || backend === 'hermes-native') return 'hermes';
  if (backend === 'codex') return 'codex';
  throw new Error(`Unsupported BACKLINKHELPER_FAMILY_AGENT_BACKEND=${backend}. Expected hermes or codex.`);
}

function stampEnvelopeBackend(envelope, backend) {
  const label = backend === 'hermes' ? 'hermes-native' : 'codex-cli';
  envelope.trace ??= {};
  envelope.handoff ??= {};
  envelope.trace.agent_backend ||= label;
  envelope.handoff.agent_backend ||= label;
  return envelope;
}

function runCodex(prompt, paths, extraEnv) {
  return new Promise((resolve, reject) => {
    const args = buildCodexArgs(paths);
    const child = spawn('codex', args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const terminate = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
    };
    process.once('SIGTERM', terminate);
    process.once('SIGINT', terminate);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      process.off('SIGTERM', terminate);
      process.off('SIGINT', terminate);
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      process.off('SIGTERM', terminate);
      process.off('SIGINT', terminate);
      if (code !== 0) {
        reject(new Error(`codex exec failed code=${code ?? 'null'} signal=${signal ?? 'none'} stderr=${stderr.trim()} stdout_tail=${stdout.slice(-2000)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(prompt);
  });
}

function readStubEnvelope() {
  const raw = process.env.BACKLINKHELPER_FAMILY_AGENT_STUB_ENVELOPE;
  if (!raw) return undefined;
  if (raw.trim().startsWith('{')) return JSON.parse(raw);
  return JSON.parse(fs.readFileSync(raw, 'utf8'));
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backlink-family-agent-'));
try {
  const stdin = await readStdin();
  const context = JSON.parse(stdin);
  const flowFamily = resolveOperatorFlowFamily(context);
  const expectedTaskId = context?.prepare?.task?.id || context?.task?.id;
  if (!expectedTaskId) {
    throw new Error('Operator context is missing task id.');
  }

  const stubEnvelope = readStubEnvelope();
  if (stubEnvelope) {
    assertEnvelope(stubEnvelope, expectedTaskId);
    process.stdout.write(`${JSON.stringify(stubEnvelope)}\n`);
    process.exit(0);
  }

  const prompt = buildFamilyOperatorPrompt({ context, flowFamily });
  const backend = selectedAgentBackend();
  const operatorEnv = {
    BACKLINKHELPER_OPERATOR_FLOW_FAMILY: flowFamily,
    BACKLINKHELPER_REPO_CWD: repoRoot,
    BACKLINKHELPER_OPERATOR_EXPECTED_TASK_ID: expectedTaskId,
    BACKLINKHELPER_SINGLE_TASK_OPERATOR_GUARD: '1',
  };

  let finalMessage;
  if (backend === 'codex') {
    const outputPath = path.join(tmpDir, 'last-message.json');
    const schemaPath = path.join(tmpDir, 'agent-trace-envelope.schema.json');
    fs.writeFileSync(schemaPath, JSON.stringify(agentTraceEnvelopeSchema(), null, 2));

    const result = await runCodex(prompt, { outputPath, schemaPath }, operatorEnv);
    finalMessage = fs.existsSync(outputPath)
      ? fs.readFileSync(outputPath, 'utf8')
      : result.stdout;
  } else {
    const result = await runHermes(prompt, operatorEnv);
    finalMessage = result.stdout;
  }

  const envelope = stampEnvelopeBackend(
    extractBalancedJson(finalMessage, (value) => isEnvelopeForTask(value, expectedTaskId)),
    backend,
  );
  assertEnvelope(envelope, expectedTaskId);
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
} catch (error) {
  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
