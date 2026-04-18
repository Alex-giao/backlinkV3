import { readFile } from "node:fs/promises";

import { recordAgentTrace } from "../control-plane/task-record-agent-trace.js";
import type { AgentTraceEnvelope } from "../shared/types.js";

export async function runTaskRecordAgentTraceCommand(args: {
  taskId: string;
  payloadFile: string;
}): Promise<void> {
  const payload = JSON.parse(
    await readFile(args.payloadFile, "utf8"),
  ) as AgentTraceEnvelope;
  const result = await recordAgentTrace({
    taskId: args.taskId,
    envelope: payload,
  });
  console.log(JSON.stringify(result, null, 2));
}
