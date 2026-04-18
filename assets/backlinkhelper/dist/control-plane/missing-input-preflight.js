import { ensureDataDirectories, getProfileFilePath, listTasks, readJsonFile } from "../memory/data-store.js";
import { summarizeMissingInputPreflight } from "../shared/missing-inputs.js";
function matchesPromotedHostname(task, promotedHostname) {
    if (!promotedHostname) {
        return true;
    }
    return task.submission.promoted_profile.hostname === promotedHostname;
}
export async function buildMissingInputPreflightReport(args) {
    await ensureDataDirectories();
    const promotedHostname = args.promotedUrl ? new URL(args.promotedUrl).hostname : args.promotedHostname;
    const allTasks = await listTasks();
    const tasks = allTasks.filter((task) => matchesPromotedHostname(task, promotedHostname));
    const profile = promotedHostname
        ? await readJsonFile(getProfileFilePath(promotedHostname))
        : undefined;
    return summarizeMissingInputPreflight({
        tasks,
        profile,
    });
}
