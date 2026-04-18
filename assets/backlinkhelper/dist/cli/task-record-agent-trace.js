import { readFile } from "node:fs/promises";
import { recordAgentTrace } from "../control-plane/task-record-agent-trace.js";
export async function runTaskRecordAgentTraceCommand(args) {
    const payload = JSON.parse(await readFile(args.payloadFile, "utf8"));
    const result = await recordAgentTrace({
        taskId: args.taskId,
        envelope: payload,
    });
    console.log(JSON.stringify(result, null, 2));
}
