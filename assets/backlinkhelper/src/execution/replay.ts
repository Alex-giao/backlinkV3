import path from "node:path";

import { DATA_DIRECTORIES } from "../memory/data-store.js";
import { withConnectedPage } from "../shared/playwright-session.js";
import type {
  ReplayResult,
  ReplayStep,
  TaskRecord,
  TrajectoryPlaybook,
  WaitMetadata,
} from "../shared/types.js";

function resolveTemplate(value: string, task: TaskRecord): string {
  const replacements: Record<string, string> = {
    promoted_url: task.submission.promoted_profile.url,
    promoted_name: task.submission.promoted_profile.name,
    promoted_description: task.submission.promoted_profile.description,
    submitter_email: task.submission.submitter_email ?? "",
  };

  return value.replace(/\{\{(promoted_url|promoted_name|promoted_description|submitter_email)\}\}/g, (_, key: string) => {
    return replacements[key] ?? "";
  });
}

async function pickUsableLocator(args: {
  locator: import("playwright").Locator;
  requireEditable?: boolean;
  description: string;
}): Promise<import("playwright").Locator> {
  const count = Math.min(await args.locator.count(), 25);
  let sawHiddenCandidate = false;

  for (let index = 0; index < count; index += 1) {
    const candidate = args.locator.nth(index);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) {
      sawHiddenCandidate = true;
      continue;
    }

    const enabled = await candidate.isEnabled().catch(() => true);
    if (!enabled) {
      continue;
    }

    if (args.requireEditable) {
      const editable = await candidate.isEditable().catch(() => false);
      if (!editable) {
        continue;
      }
    }

    return candidate;
  }

  if (count > 0 && sawHiddenCandidate) {
    throw new Error(`${args.description} matched only hidden or non-interactable elements.`);
  }

  return args.locator.first();
}

async function runStep(
  page: import("playwright").Page,
  step: ReplayStep,
  task: TaskRecord,
): Promise<void> {
  switch (step.action) {
    case "goto":
      await page.goto(resolveTemplate(step.url, task), { waitUntil: "domcontentloaded" });
      return;
    case "wait_for_text":
      await page.getByText(resolveTemplate(step.text, task)).waitFor({
        state: "visible",
        timeout: step.timeout_ms,
      });
      return;
    case "wait_for_selector":
      await page.locator(resolveTemplate(step.selector, task)).first().waitFor({
        state: step.state ?? "visible",
        timeout: step.timeout_ms,
      });
      return;
    case "click_text":
      await page
        .getByText(resolveTemplate(step.text, task), { exact: step.exact ?? false })
        .first()
        .click();
      return;
    case "click_role":
      await page.getByRole(step.role, { name: resolveTemplate(step.name, task) }).click();
      return;
    case "click_selector":
      await (
        await pickUsableLocator({
          locator: page.locator(resolveTemplate(step.selector, task)),
          description: `click_selector(${step.selector})`,
        })
      ).click();
      return;
    case "fill_label":
      await (
        await pickUsableLocator({
          locator: page.getByLabel(resolveTemplate(step.label, task), { exact: step.exact ?? false }),
          requireEditable: true,
          description: `fill_label(${step.label})`,
        })
      ).fill(resolveTemplate(step.value, task));
      return;
    case "fill_placeholder":
      await (
        await pickUsableLocator({
          locator: page.getByPlaceholder(resolveTemplate(step.placeholder, task)),
          requireEditable: true,
          description: `fill_placeholder(${step.placeholder})`,
        })
      ).fill(resolveTemplate(step.value, task));
      return;
    case "fill_selector":
      await (
        await pickUsableLocator({
          locator: page.locator(resolveTemplate(step.selector, task)),
          requireEditable: true,
          description: `fill_selector(${step.selector})`,
        })
      ).fill(resolveTemplate(step.value, task));
      return;
    case "select_selector":
      await (
        await pickUsableLocator({
          locator: page.locator(resolveTemplate(step.selector, task)),
          description: `select_selector(${step.selector})`,
        })
      ).selectOption({ label: resolveTemplate(step.value, task) });
      return;
    case "press_key":
      await page.keyboard.press(resolveTemplate(step.key, task));
      return;
    case "wait_for_url_includes":
      await page.waitForURL(
        (value) => value.toString().includes(resolveTemplate(step.value, task)),
        {
          timeout: step.timeout_ms,
        },
      );
      return;
    case "assert_text": {
      const pageText = await page.locator("body").innerText();
      const resolvedText = resolveTemplate(step.text, task);
      if (!pageText.includes(resolvedText)) {
        throw new Error(`Expected page text to include "${resolvedText}".`);
      }
      return;
    }
    case "screenshot":
      await page.screenshot({
        path: path.join(DATA_DIRECTORIES.artifacts, `${step.name}.png`),
        fullPage: true,
      });
      return;
  }
}

function inferReplayWait(
  wait_reason_code: string,
  resume_trigger: string,
  resolution_owner: WaitMetadata["resolution_owner"],
  resolution_mode: WaitMetadata["resolution_mode"],
  evidence_ref: string,
): WaitMetadata {
  return {
    wait_reason_code,
    resume_trigger,
    resolution_owner,
    resolution_mode,
    evidence_ref,
  };
}

function inferReplayOutcome(
  pageText: string,
  playbook: TrajectoryPlaybook,
  evidenceRef: string,
): Pick<ReplayResult, "next_status" | "wait" | "terminal_class"> {
  const normalized = pageText.toLowerCase();
  const successSignals = playbook.success_signals.map((signal) => signal.toLowerCase());
  if (successSignals.some((signal) => normalized.includes(signal))) {
    return {
      next_status: "WAITING_SITE_RESPONSE",
      wait: inferReplayWait(
        "SITE_RESPONSE_PENDING",
        "Keep polling or reporting until the directory publishes a final review outcome.",
        "system",
        "auto_resume",
        evidenceRef,
      ),
    };
  }

  if (normalized.includes("verify your email") || normalized.includes("check your email")) {
    return {
      next_status: "WAITING_EXTERNAL_EVENT",
      wait: inferReplayWait(
        "EMAIL_VERIFICATION_PENDING",
        "Wait for gog to retrieve the verification email or magic link automatically.",
        "gog",
        "auto_resume",
        evidenceRef,
      ),
    };
  }

  return {
    next_status: "RETRYABLE",
    wait: inferReplayWait(
      "OUTCOME_NOT_CONFIRMED",
      "Retry automatically later or fall back to scout to rebuild page evidence.",
      "system",
      "auto_resume",
      evidenceRef,
    ),
    terminal_class: "outcome_not_confirmed",
  };
}

export async function runTrajectoryReplay(args: {
  cdpUrl: string;
  task: TaskRecord;
  playbook: TrajectoryPlaybook;
}): Promise<ReplayResult> {
  const artifactRefs: string[] = [];

  try {
    return await withConnectedPage(args.cdpUrl, async (page) => {
      try {
        for (const step of args.playbook.steps) {
          await runStep(page, step, args.task);
          if (step.action === "screenshot") {
            artifactRefs.push(path.join(DATA_DIRECTORIES.artifacts, `${step.name}.png`));
          }
        }

        const pageText = await page.locator("body").innerText().catch(() => "");
        const outcome = inferReplayOutcome(
          pageText,
          args.playbook,
          artifactRefs[artifactRefs.length - 1] ?? `${args.task.hostname}:replay`,
        );

        return {
          ok: outcome.next_status !== "RETRYABLE",
          next_status: outcome.next_status,
          detail: `Replay completed with ${args.playbook.steps.length} step(s).`,
          artifact_refs: artifactRefs,
          wait: outcome.wait,
          terminal_class: outcome.terminal_class,
        };
      } catch (error) {
        return {
          ok: false,
          next_status: "RETRYABLE",
          detail: error instanceof Error ? `Replay failed: ${error.message}` : "Replay failed.",
          artifact_refs: artifactRefs,
        };
      }
    }, {
      freshPage: true,
      operationTimeoutMs: 60_000,
      pageCloseTimeoutMs: 2_000,
      browserCloseTimeoutMs: 2_000,
    });
  } catch (error) {
    return {
      ok: false,
      next_status: "RETRYABLE",
      detail: error instanceof Error ? `Replay session failed: ${error.message}` : "Replay session failed.",
      artifact_refs: artifactRefs,
    };
  }
}
