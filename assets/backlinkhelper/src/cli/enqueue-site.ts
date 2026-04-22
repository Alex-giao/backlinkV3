import type { FlowFamily } from "../shared/types.js";
import { enqueueSiteTask } from "../control-plane/task-queue.js";

export async function runEnqueueSiteCommand(args: {
  taskId: string;
  targetUrl: string;
  promotedUrl: string;
  promotedName?: string;
  promotedDescription?: string;
  submitterEmailBase?: string;
  confirmSubmit: boolean;
  flowFamily?: FlowFamily;
  enqueuedBy?: string;
}): Promise<void> {
  const result = await enqueueSiteTask(args);
  console.log(JSON.stringify(result, null, 2));
}
