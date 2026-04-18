import { ensureDataDirectories, getProfileFilePath, listTasks, readJsonFile } from "../memory/data-store.js";
import { summarizeMissingInputPreflight } from "../shared/missing-inputs.js";
import type { MissingInputPreflightReport, PromotedProfile, TaskRecord } from "../shared/types.js";

function matchesPromotedHostname(task: TaskRecord, promotedHostname?: string): boolean {
  if (!promotedHostname) {
    return true;
  }

  return task.submission.promoted_profile.hostname === promotedHostname;
}

export async function buildMissingInputPreflightReport(args: {
  promotedUrl?: string;
  promotedHostname?: string;
}): Promise<MissingInputPreflightReport> {
  await ensureDataDirectories();

  const promotedHostname = args.promotedUrl ? new URL(args.promotedUrl).hostname : args.promotedHostname;
  const allTasks = await listTasks();
  const tasks = allTasks.filter((task) => matchesPromotedHostname(task, promotedHostname));
  const profile = promotedHostname
    ? await readJsonFile<PromotedProfile>(getProfileFilePath(promotedHostname))
    : undefined;

  return summarizeMissingInputPreflight({
    tasks,
    profile,
  });
}
