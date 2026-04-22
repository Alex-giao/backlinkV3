import { enqueueSiteTask } from "../control-plane/task-queue.js";
export async function runEnqueueSiteCommand(args) {
    const result = await enqueueSiteTask(args);
    console.log(JSON.stringify(result, null, 2));
}
