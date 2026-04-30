import { ensureDataDirectories, getArtifactFilePath, getPendingFinalizePath, loadTask, saveTask, writeJsonFile, } from "../memory/data-store.js";
import { updateTaskExecutionStateFromTrace } from "../shared/task-progress.js";
import { markTaskStageTimestamp } from "../shared/task-timing.js";
export async function recordAgentTrace(args) {
    await ensureDataDirectories();
    if (args.envelope.trace.task_id !== args.taskId) {
        throw new Error(`Trace payload task_id ${args.envelope.trace.task_id} does not match requested task ${args.taskId}.`);
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
    const agentBackend = args.envelope.trace.agent_backend || args.envelope.handoff.agent_backend || "unknown-agent";
    task.notes.push(`Recorded ${agentBackend} agent trace with ${args.envelope.trace.steps.length} step(s).`);
    markTaskStageTimestamp(task, "trace_recorded_at");
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
