#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveFamilyOperatorRoute,
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
    throw new Error('Family operator output did not contain a parseable AgentTraceEnvelope JSON object.');
  }
  throw new Error('Family operator output does not contain a JSON object.');
}

function isEnvelopeForTask(value, expectedTaskId) {
  if (!value || typeof value !== 'object') return false;
  if (!value.trace || typeof value.trace !== 'object') return false;
  if (!value.handoff || typeof value.handoff !== 'object') return false;
  if (expectedTaskId && value.trace.task_id !== expectedTaskId) return false;
  return true;
}

function commandParts(command) {
  const [cmd, ...args] = command.split(/\s+/).filter(Boolean);
  return { cmd, args };
}

function runRouteCommand(command, input, env) {
  return new Promise((resolve, reject) => {
    const { cmd, args } = commandParts(command);
    const child = spawn(cmd, args, {
      cwd: repoRoot,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code !== 0) {
        reject(new Error(`Family operator command failed (${command}) code=${code ?? 'null'} signal=${signal ?? 'none'} stderr=${stderr.trim()}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}

try {
  const stdin = await readStdin();
  const context = JSON.parse(stdin);
  const expectedTaskId = context?.prepare?.task?.id || context?.task?.id;
  const flowFamily = resolveOperatorFlowFamily(context);
  const route = resolveFamilyOperatorRoute({ flowFamily, context });
  const result = await runRouteCommand(route.command, stdin, {
    ...process.env,
    BACKLINKHELPER_OPERATOR_FLOW_FAMILY: flowFamily,
    BACKLINKHELPER_OPERATOR_ROUTE_KIND: route.kind,
    BACKLINKHELPER_REPO_CWD: repoRoot,
    BACKLINKHELPER_SINGLE_TASK_OPERATOR_GUARD: process.env.BACKLINKHELPER_SINGLE_TASK_OPERATOR_GUARD || '1',
  });

  if (result.stderr.trim() && process.env.BACKLINKHELPER_OPERATOR_DEBUG === '1') {
    process.stderr.write(result.stderr);
  }
  const routedEnvelope = extractBalancedJson(result.stdout, (value) => isEnvelopeForTask(value, expectedTaskId));
  process.stdout.write(`${JSON.stringify(routedEnvelope)}\n`);
} catch (error) {
  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
}
