import type { TaskRecord, TaskStageTimestamps } from "./types.js";

export type TaskStageTimestampKey = keyof TaskStageTimestamps;

export function markTaskStageTimestamp(
  task: Pick<TaskRecord, "stage_timestamps">,
  stage: TaskStageTimestampKey,
  at: string = new Date().toISOString(),
): string {
  task.stage_timestamps = {
    ...(task.stage_timestamps ?? {}),
    [stage]: at,
  };
  return at;
}
