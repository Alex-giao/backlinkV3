import { finalizeTask } from "../control-plane/task-finalize.js";

export async function runTaskFinalizeCommand(args: {
  taskId: string;
  cdpUrl?: string;
}): Promise<void> {
  const result = await finalizeTask(args);
  console.log(JSON.stringify(result, null, 2));
}
