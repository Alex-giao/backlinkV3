import { runNextTask } from "../control-plane/run-next.js";
export async function runNextCommand(args) {
    const result = await runNextTask(args);
    console.log(JSON.stringify(result, null, 2));
}
