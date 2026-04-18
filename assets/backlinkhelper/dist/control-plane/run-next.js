import { ensureDataDirectories } from "../memory/data-store.js";
export async function runNextTask(args) {
    await ensureDataDirectories();
    throw new Error([
        'run-next is disabled in operator-only mode.',
        'Use the Codex/OpenClaw operator path instead:',
        'claim-next-task -> task-prepare -> operator skill/browser-use -> task-record-agent-trace -> task-finalize.',
        'Repo-native OpenAI agent execution is no longer a supported runtime path.',
        `taskId=${args.taskId}`,
        `targetUrl=${args.targetUrl}`,
    ].join(' '));
}
