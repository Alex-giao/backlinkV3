export function markTaskStageTimestamp(task, stage, at = new Date().toISOString()) {
    task.stage_timestamps = {
        ...(task.stage_timestamps ?? {}),
        [stage]: at,
    };
    return at;
}
