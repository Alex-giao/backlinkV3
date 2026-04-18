import { prepareTaskForAgent } from "../control-plane/task-prepare.js";

export async function runTaskPrepareCommand(args: {
  taskId: string;
  cdpUrl?: string;
}): Promise<void> {
  const result = await prepareTaskForAgent(args);
  console.log(JSON.stringify(result, null, 2));
}
