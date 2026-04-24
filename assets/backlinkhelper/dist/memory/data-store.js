import { mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, "../..");
function configuredDataRoot() {
    const legacyDataRoot = process.env.BACKLINER_DATA_ROOT?.trim();
    if (legacyDataRoot) {
        return legacyDataRoot;
    }
    const stateDir = process.env.BACKLINKHELPER_STATE_DIR?.trim();
    if (stateDir) {
        return stateDir;
    }
    return undefined;
}
function defaultDataRoot() {
    const hermesHome = process.env.HERMES_HOME?.trim()
        ? path.resolve(process.env.HERMES_HOME.trim())
        : path.join(homedir(), ".hermes");
    return path.join(hermesHome, "state", "backlinkhelper-v3");
}
export const DATA_ROOT = path.resolve(configuredDataRoot() ?? defaultDataRoot());
export const DATA_DIRECTORIES = {
    accounts: path.join(DATA_ROOT, "accounts"),
    artifacts: path.join(DATA_ROOT, "artifacts"),
    playbooks: path.join(DATA_ROOT, "playbooks", "sites"),
    profiles: path.join(DATA_ROOT, "profiles"),
    reports: path.join(DATA_ROOT, "reports"),
    runs: path.join(DATA_ROOT, "runs"),
    runtime: path.join(DATA_ROOT, "runtime"),
    tasks: path.join(DATA_ROOT, "tasks"),
    vault: path.join(DATA_ROOT, "vault"),
};
export async function ensureDataDirectories() {
    await Promise.all(Object.values(DATA_DIRECTORIES).map((directoryPath) => mkdir(directoryPath, { recursive: true })));
}
export async function readJsonFile(filePath) {
    try {
        const content = await readFile(filePath, "utf8");
        return JSON.parse(content);
    }
    catch (error) {
        const typedError = error;
        if (typedError.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}
export async function writeJsonFile(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
export function hostnameToKey(hostname) {
    return hostname.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
}
export function getTaskFilePath(taskId) {
    return path.join(DATA_DIRECTORIES.tasks, `${taskId}.json`);
}
export function getArtifactFilePath(taskId, artifactName) {
    return path.join(DATA_DIRECTORIES.artifacts, `${taskId}-${artifactName}.json`);
}
export function getOwnershipLockPath() {
    return path.join(DATA_DIRECTORIES.runtime, "browser-ownership-lock.json");
}
export const WORKER_LEASE_GROUPS = ["active", "follow_up"];
export function getWorkerLeasePath(group = "active") {
    return group === "active"
        ? path.join(DATA_DIRECTORIES.runtime, "task-worker-lease.json")
        : path.join(DATA_DIRECTORIES.runtime, `task-worker-lease-${group}.json`);
}
export function getPendingFinalizePath(taskId) {
    return path.join(DATA_DIRECTORIES.runtime, `${taskId}-pending-finalize.json`);
}
export function getLatestPreflightPath() {
    return path.join(DATA_DIRECTORIES.runs, "latest-preflight.json");
}
export function getRuntimeIncidentPath() {
    return path.join(DATA_DIRECTORIES.runtime, "runtime-incident.json");
}
export function getRuntimeRecoveryStatusPath() {
    return path.join(DATA_DIRECTORIES.runtime, "runtime-recovery-status.json");
}
export function getPlaybookFilePath(hostname) {
    return path.join(DATA_DIRECTORIES.playbooks, `${hostnameToKey(hostname)}.json`);
}
export function getProfileFilePath(hostname) {
    return path.join(DATA_DIRECTORIES.profiles, `${hostnameToKey(hostname)}.json`);
}
export function getAccountFilePath(hostname) {
    return path.join(DATA_DIRECTORIES.accounts, `${hostnameToKey(hostname)}.json`);
}
export function getCredentialFilePath(credentialRef) {
    return path.join(DATA_DIRECTORIES.vault, `${hostnameToKey(credentialRef)}.json`);
}
export async function loadTask(taskId) {
    return readJsonFile(getTaskFilePath(taskId));
}
export async function saveTask(task) {
    await writeJsonFile(getTaskFilePath(task.id), task);
}
export async function listTasks() {
    await mkdir(DATA_DIRECTORIES.tasks, { recursive: true });
    const entries = await readdir(DATA_DIRECTORIES.tasks, { withFileTypes: true });
    const tasks = await Promise.all(entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => readJsonFile(path.join(DATA_DIRECTORIES.tasks, entry.name))));
    return tasks.filter((task) => Boolean(task));
}
export async function loadWorkerLease(group = "active") {
    return readJsonFile(getWorkerLeasePath(group));
}
export async function loadAllWorkerLeases() {
    const leases = await Promise.all(WORKER_LEASE_GROUPS.map(async (group) => [group, await loadWorkerLease(group)]));
    return Object.fromEntries(leases);
}
export async function saveWorkerLease(lease, group = lease.group ?? "active") {
    await writeJsonFile(getWorkerLeasePath(group), {
        ...lease,
        group,
    });
}
export async function clearWorkerLease(group = "active") {
    const leasePath = getWorkerLeasePath(group);
    try {
        await unlink(leasePath);
    }
    catch (error) {
        const typedError = error;
        if (typedError.code !== "ENOENT") {
            throw error;
        }
    }
}
export async function clearWorkerLeaseForTask(taskId) {
    let cleared = false;
    for (const group of WORKER_LEASE_GROUPS) {
        const existingLease = await loadWorkerLease(group);
        if (!existingLease || existingLease.task_id !== taskId) {
            continue;
        }
        await clearWorkerLease(group);
        cleared = true;
    }
    return cleared;
}
export async function clearPendingFinalize(taskId) {
    try {
        await rm(getPendingFinalizePath(taskId), { force: true });
    }
    catch (error) {
        const typedError = error;
        if (typedError.code !== "ENOENT") {
            throw error;
        }
    }
}
export async function loadAccountRecord(hostname) {
    return readJsonFile(getAccountFilePath(hostname));
}
export async function saveAccountRecord(account) {
    await writeJsonFile(getAccountFilePath(account.hostname), account);
}
export async function loadCredentialRecord(credentialRef) {
    return readJsonFile(getCredentialFilePath(credentialRef));
}
export async function saveCredentialRecord(record) {
    await writeJsonFile(getCredentialFilePath(record.credential_ref), record);
}
export async function deleteCredentialRecord(credentialRef) {
    try {
        await rm(getCredentialFilePath(credentialRef), { force: true });
    }
    catch (error) {
        const typedError = error;
        if (typedError.code !== "ENOENT") {
            throw error;
        }
    }
}
