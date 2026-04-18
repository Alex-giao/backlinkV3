import { runNextTask } from "../control-plane/run-next.js";

export async function runNextCommand(args: {
  taskId: string;
  targetUrl: string;
  promotedUrl: string;
  promotedName?: string;
  promotedDescription?: string;
  submitterEmail?: string;
  confirmSubmit: boolean;
  cdpUrl?: string;
}): Promise<void> {
  const result = await runNextTask(args);
  console.log(JSON.stringify(result, null, 2));
}
