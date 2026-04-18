import {
  ensureDataDirectories,
  getArtifactFilePath,
  getPendingFinalizePath,
  loadTask,
  saveTask,
  writeJsonFile,
} from "../memory/data-store.js";
import { updateTaskExecutionStateFromTrace } from "../shared/task-progress.js";
import type { AgentTraceEnvelope } from "../shared/types.js";

export async function recordAgentTrace(args: {
  taskId: string;
  envelope: AgentTraceEnvelope;
}): Promise<{ task_id: string; trace_ref: string; pending_finalize_ref: string }> {
  await ensureDataDirectories();
  if (args.envelope.trace.task_id !== args.taskId) {
    throw new Error(
      `Trace payload task_id ${args.envelope.trace.task_id} does not match requested task ${args.taskId}.`,
    );
  }

  const task = await loadTask(args.taskId);
  if (!task) {
    throw new Error(`Task ${args.taskId} does not exist.`);
  }

  const tracePath = getArtifactFilePath(args.taskId, "agent-loop");
  const pendingFinalizePath = getPendingFinalizePath(args.taskId);
  await writeJsonFile(tracePath, args.envelope.trace);
  await writeJsonFile(pendingFinalizePath, {
    handoff: args.envelope.handoff,
    account: args.envelope.account,
  });

  if (!task.latest_artifacts.includes(tracePath)) {
    task.latest_artifacts.push(tracePath);
  }
  task.notes.push(`Recorded Codex-driven agent trace with ${args.envelope.trace.steps.length} step(s).`);
  task.last_takeover_outcome = args.envelope.handoff.detail;
  updateTaskExecutionStateFromTrace({
    task,
    trace: args.envelope.trace,
    handoff: args.envelope.handoff,
  });
  await saveTask(task);

  return {
    task_id: args.taskId,
    trace_ref: tracePath,
    pending_finalize_ref: pendingFinalizePath,
  };
}
