import { getPlaybookFilePath, readJsonFile, writeJsonFile } from "./data-store.js";
export async function loadTrajectoryPlaybook(hostname) {
    return readJsonFile(getPlaybookFilePath(hostname));
}
export async function saveTrajectoryPlaybook(playbook) {
    playbook.updated_at = new Date().toISOString();
    await writeJsonFile(getPlaybookFilePath(playbook.hostname), playbook);
}
