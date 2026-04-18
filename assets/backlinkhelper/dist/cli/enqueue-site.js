import { enqueueSiteTask } from "../control-plane/task-queue.js";
export async function runEnqueueSiteCommand(args) {
    const task = await enqueueSiteTask(args);
    console.log(JSON.stringify(task, null, 2));
}
