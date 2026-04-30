import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildFamilyOperatorPrompt,
  resolveFamilyOperatorRoute,
  resolveOperatorFlowFamily,
} from "./family-operator-dispatcher.js";
import type { PrepareResult, TaskRecord } from "../shared/types.js";

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-0001",
    target_url: "https://target.example/submit",
    hostname: "target.example",
    flow_family: "saas_directory",
    submission: {
      promoted_profile: {
        url: "https://suikagame.fun/",
        hostname: "suikagame.fun",
        name: "Suika Game",
        description: "A fruit merge browser puzzle.",
        category_hints: ["game"],
        source: "fallback",
        probe_version: "unit-test",
        probed_at: "2026-04-27T00:00:00.000Z",
      },
      submitter_email: "operator@example.com",
      confirm_submit: false,
    },
    status: "RUNNING",
    created_at: "2026-04-27T00:00:00.000Z",
    updated_at: "2026-04-27T00:00:00.000Z",
    run_count: 1,
    escalation_level: "none",
    takeover_attempts: 0,
    phase_history: [],
    latest_artifacts: [],
    notes: [],
    ...overrides,
  };
}

function makePrepare(task: TaskRecord): PrepareResult {
  return {
    mode: "ready_for_agent_loop",
    task,
    effective_target_url: task.target_url,
    replay_hit: false,
    scout_artifact_ref: `/tmp/${task.id}-scout.json`,
    scout: {
      ok: true,
      surface_summary: "Reachable submit surface.",
      page_snapshot: {
        url: task.target_url,
        title: "Submit",
        body_text_excerpt: "Submit your website",
      },
      submit_candidates: ["Submit"],
      evidence_sufficiency: true,
      auth_hints: [],
      anti_bot_hints: [],
      field_hints: [],
      link_candidates: [],
      embed_hints: [],
    },
  };
}

test("resolveOperatorFlowFamily uses prepared task family before stale outer task family", () => {
  const outerTask = makeTask({ flow_family: "wp_comment" });
  const preparedTask = makeTask({ id: outerTask.id, flow_family: "forum_profile" });

  assert.equal(
    resolveOperatorFlowFamily({ task: outerTask, prepare: makePrepare(preparedTask) }),
    "forum_profile",
  );
});

test("resolveFamilyOperatorRoute sends ordinary wp_comment pages to the generic family agent", () => {
  const task = makeTask({
    flow_family: "wp_comment",
    target_url: "https://fashionpotluck.com/lifestyle/dress-to-impress-occasion-dress-for-every-social-calendar",
    hostname: "fashionpotluck.com",
  });

  assert.deepEqual(resolveFamilyOperatorRoute({ flowFamily: "wp_comment", context: { task, prepare: makePrepare(task) } }), {
    kind: "generic_family_agent_operator",
    command: "node scripts/family-agent-operator.mjs",
  });
});

test("resolveFamilyOperatorRoute keeps Blogger comment capability only when Blogger evidence is present", () => {
  const task = makeTask({
    flow_family: "wp_comment",
    target_url: "https://blog.example.com/post/1",
    hostname: "blog.example.com",
  });
  const prepare = makePrepare(task);
  prepare.scout!.embed_hints = [
    {
      frame_index: 0,
      provider: "unknown",
      frame_url: "https://www.blogger.com/comment/frame/12345",
      body_text_excerpt: "Post a comment",
      cta_candidates: [],
      submit_candidates: ["Publish"],
      likely_interactive: true,
    },
  ];

  assert.deepEqual(resolveFamilyOperatorRoute({ flowFamily: "wp_comment", context: { task, prepare } }), {
    kind: "blogger_comment_operator",
    command: "node scripts/suika-blogger-operator.mjs",
  });

  for (const flowFamily of ["saas_directory", "forum_profile", "forum_post"] as const) {
    assert.deepEqual(resolveFamilyOperatorRoute({ flowFamily }), {
      kind: "generic_family_agent_operator",
      command: "node scripts/family-agent-operator.mjs",
    });
  }
});

test("buildFamilyOperatorPrompt carries family contract and forbids claiming/finalizing", () => {
  const task = makeTask({ flow_family: "forum_post", target_url: "https://forum.example/thread/123" });
  const prompt = buildFamilyOperatorPrompt({
    context: {
      task,
      prepare: makePrepare(task),
      scope: { promotedHostname: "suikagame.fun", promotedUrl: "https://suikagame.fun/" },
      owner: "unit-test",
      cdpUrl: "http://127.0.0.1:9224",
      promotedUrl: "https://suikagame.fun/",
      promotedHostname: "suikagame.fun",
    },
    flowFamily: "forum_post",
  });

  assert.match(prompt, /family:\s*forum_post/i);
  assert.match(prompt, /Do not skip solely because the promoted site is topically different/i);
  assert.match(prompt, /bridge comment/i);
  assert.match(prompt, /prequalified backlink surfaces from competitor evidence/i);
  assert.match(prompt, /Do not proactively research or stop on generic site terms/i);
  assert.doesNotMatch(prompt, /Do not create spammy off-topic posts just to place a link/i);
  assert.match(prompt, /Do not run claim-next-task/i);
  assert.match(prompt, /Do not run task-finalize/i);
  assert.match(prompt, /AgentTraceEnvelope JSON/i);
  assert.match(prompt, /proposed_outcome\.next_status/i);
  assert.match(prompt, /CAPTCHA_SOLVER_CONTINUATION/);
  assert.match(prompt, /Bestätigungscode/);
});

test("suika unattended watchdog uses the family-aware dispatcher, not the Blogger-only operator directly", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts", "suika-unattended-loop.mjs"), "utf8");

  assert.match(script, /family-aware-operator-dispatcher\.mjs/);
  assert.doesNotMatch(script, /--operator-command', 'node scripts\/suika-blogger-operator\.mjs'/);
});

test("family-aware dispatcher does not spawn route commands through a shell and propagates the single-task guard", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts", "family-aware-operator-dispatcher.mjs"), "utf8");

  assert.match(script, /shell:\s*false/);
  assert.doesNotMatch(script, /shell:\s*true/);
  assert.match(script, /BACKLINKHELPER_SINGLE_TASK_OPERATOR_GUARD:\s*process\.env\.BACKLINKHELPER_SINGLE_TASK_OPERATOR_GUARD \|\| '1'/);
});

test("generic family agent defaults to Hermes-native single-task guardrails", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts", "family-agent-operator.mjs"), "utf8");

  assert.match(script, /BACKLINKHELPER_FAMILY_AGENT_BACKEND \|\| 'hermes'/);
  assert.match(script, /spawn\('hermes'/);
  assert.match(script, /terminal,file,browser,web,vision/);
  assert.match(script, /BACKLINKHELPER_SINGLE_TASK_OPERATOR_GUARD:\s*'1'/);
});

test("generic family agent keeps Codex fallback sandboxed behind an explicit backend switch", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts", "family-agent-operator.mjs"), "utf8");

  assert.match(script, /backend === 'codex'/);
  assert.match(script, /workspace-write/);
  assert.match(script, /shell_environment_policy\.inherit/);
  assert.match(script, /BACKLINKHELPER_CODEX_BYPASS_APPROVALS === '1'/);
  assert.match(script, /BACKLINKHELPER_SINGLE_TASK_OPERATOR_GUARD:\s*'1'/);
  assert.doesNotMatch(script, /BACKLINKHELPER_CODEX_BYPASS_APPROVALS === '0'/);
});

test("generic family agent extracts final envelope after brace-shaped Hermes logs", () => {
  const task = makeTask({ id: "task-noisy-hermes", flow_family: "saas_directory" });
  const envelope = {
    trace: {
      task_id: task.id,
      agent_backend: "hermes-native",
      started_at: "2026-04-28T00:00:00.000Z",
      finished_at: "2026-04-28T00:00:01.000Z",
      stop_reason: "target_not_saas_directory_submission_surface",
      final_url: task.target_url,
      final_title: "Submit",
      final_excerpt: "No suitable submit surface.",
      steps: [],
    },
    handoff: {
      detail: "No suitable submit surface.",
      artifact_refs: [],
      current_url: task.target_url,
      recorded_steps: [],
      agent_trace_ref: `/tmp/${task.id}-agent-loop.json`,
      agent_backend: "hermes-native",
      agent_steps_count: 0,
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-hermes-"));
  try {
    const fakeHermesPath = path.join(tmpDir, "hermes");
    fs.writeFileSync(
      fakeHermesPath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('debug before final: {unquoted: true}\\n');",
        `process.stdout.write(${JSON.stringify(`${JSON.stringify(envelope)}\n`)});`,
        "",
      ].join("\n"),
    );
    fs.chmodSync(fakeHermesPath, 0o755);

    const result = spawnSync(process.execPath, ["scripts/family-agent-operator.mjs"], {
      cwd: process.cwd(),
      input: JSON.stringify({
        task,
        prepare: makePrepare(task),
        scope: { promotedHostname: "suikagame.fun", promotedUrl: "https://suikagame.fun/" },
        owner: "unit-test",
        cdpUrl: "http://127.0.0.1:9224",
        promotedUrl: "https://suikagame.fun/",
        promotedHostname: "suikagame.fun",
      }),
      env: {
        ...process.env,
        PATH: `${tmpDir}${path.delimiter}${process.env.PATH ?? ""}`,
        BACKLINKHELPER_HERMES_TOOLSETS: "",
        BACKLINKHELPER_HERMES_SKILLS: "",
        BACKLINKHELPER_HERMES_MAX_TURNS: "1",
      },
      encoding: "utf8",
      timeout: 10_000,
    });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.trace.task_id, task.id);
    assert.equal(parsed.handoff.current_url, task.target_url);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
