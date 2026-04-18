import { getPlaybookFilePath, readJsonFile, writeJsonFile } from "./data-store.js";
import type { TrajectoryPlaybook } from "../shared/types.js";

export async function loadTrajectoryPlaybook(
  hostname: string,
): Promise<TrajectoryPlaybook | undefined> {
  return readJsonFile<TrajectoryPlaybook>(getPlaybookFilePath(hostname));
}

export async function saveTrajectoryPlaybook(
  playbook: TrajectoryPlaybook,
): Promise<void> {
  playbook.updated_at = new Date().toISOString();
  await writeJsonFile(getPlaybookFilePath(playbook.hostname), playbook);
}
