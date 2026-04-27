import { mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AccountRecord,
  CredentialVaultRecord,
  TaskRecord,
  WorkerLease,
  WorkerLeaseGroup,
} from "../shared/types.js";
import { createWranglerD1DataStore } from "./wrangler-d1-data-store.js";
import type { DataStoreBackend, TargetSiteRecord } from "./sql-data-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPO_ROOT = path.resolve(__dirname, "../..");

function configuredDataRoot(): string | undefined {
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

function defaultDataRoot(): string {
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
} as const;

export type BacklinkHelperStoreKind = "file" | "d1";

async function ensureFileDataDirectories(): Promise<void> {
  await Promise.all(
    Object.values(DATA_DIRECTORIES).map((directoryPath) =>
      mkdir(directoryPath, { recursive: true }),
    ),
  );
}

export async function readJsonFile<T>(
  filePath: string,
): Promise<T | undefined> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (error) {
    const typedError = error as NodeJS.ErrnoException;
    if (typedError.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

export async function writeJsonFile(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function hostnameToKey(hostname: string): string {
  return hostname.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
}

export function getTaskFilePath(taskId: string): string {
  return path.join(DATA_DIRECTORIES.tasks, `${taskId}.json`);
}

export function getArtifactFilePath(taskId: string, artifactName: string): string {
  return path.join(DATA_DIRECTORIES.artifacts, `${taskId}-${artifactName}.json`);
}

export function getOwnershipLockPath(): string {
  return path.join(DATA_DIRECTORIES.runtime, "browser-ownership-lock.json");
}

export const WORKER_LEASE_GROUPS: WorkerLeaseGroup[] = ["active", "follow_up"];

export function getWorkerLeasePath(group: WorkerLeaseGroup = "active"): string {
  return group === "active"
    ? path.join(DATA_DIRECTORIES.runtime, "task-worker-lease.json")
    : path.join(DATA_DIRECTORIES.runtime, `task-worker-lease-${group}.json`);
}

export function getPendingFinalizePath(taskId: string): string {
  return path.join(DATA_DIRECTORIES.runtime, `${taskId}-pending-finalize.json`);
}

export function getLatestPreflightPath(): string {
  return path.join(DATA_DIRECTORIES.runs, "latest-preflight.json");
}

export function getRuntimeIncidentPath(): string {
  return path.join(DATA_DIRECTORIES.runtime, "runtime-incident.json");
}

export function getRuntimeRecoveryStatusPath(): string {
  return path.join(DATA_DIRECTORIES.runtime, "runtime-recovery-status.json");
}

export function getPlaybookFilePath(hostname: string): string {
  return path.join(DATA_DIRECTORIES.playbooks, `${hostnameToKey(hostname)}.json`);
}

export function getProfileFilePath(hostname: string): string {
  return path.join(DATA_DIRECTORIES.profiles, `${hostnameToKey(hostname)}.json`);
}

export function getAccountFilePath(hostname: string): string {
  return path.join(DATA_DIRECTORIES.accounts, `${hostnameToKey(hostname)}.json`);
}

export function getCredentialFilePath(credentialRef: string): string {
  return path.join(DATA_DIRECTORIES.vault, `${hostnameToKey(credentialRef)}.json`);
}

export class FileDataStore implements DataStoreBackend {
  readonly kind = "file" as const;

  async ensureDataDirectories(): Promise<void> {
    await ensureFileDataDirectories();
  }

  async loadTask(taskId: string): Promise<TaskRecord | undefined> {
    return readJsonFile<TaskRecord>(getTaskFilePath(taskId));
  }

  async saveTask(task: TaskRecord): Promise<void> {
    await writeJsonFile(getTaskFilePath(task.id), task);
  }

  async listTasks(): Promise<TaskRecord[]> {
    await mkdir(DATA_DIRECTORIES.tasks, { recursive: true });
    const entries = await readdir(DATA_DIRECTORIES.tasks, { withFileTypes: true });
    const tasks = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => readJsonFile<TaskRecord>(path.join(DATA_DIRECTORIES.tasks, entry.name))),
    );

    return tasks.filter((task): task is TaskRecord => Boolean(task));
  }

  async loadWorkerLease(group: WorkerLeaseGroup = "active"): Promise<WorkerLease | undefined> {
    return readJsonFile<WorkerLease>(getWorkerLeasePath(group));
  }

  async loadAllWorkerLeases(): Promise<Record<WorkerLeaseGroup, WorkerLease | undefined>> {
    const leases = await Promise.all(WORKER_LEASE_GROUPS.map(async (group) => [group, await this.loadWorkerLease(group)] as const));
    return Object.fromEntries(leases) as Record<WorkerLeaseGroup, WorkerLease | undefined>;
  }

  async saveWorkerLease(
    lease: WorkerLease,
    group: WorkerLeaseGroup = lease.group ?? "active",
  ): Promise<void> {
    await writeJsonFile(getWorkerLeasePath(group), {
      ...lease,
      group,
    } satisfies WorkerLease);
  }

  async clearWorkerLease(group: WorkerLeaseGroup = "active"): Promise<void> {
    const leasePath = getWorkerLeasePath(group);
    try {
      await unlink(leasePath);
    } catch (error) {
      const typedError = error as NodeJS.ErrnoException;
      if (typedError.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async clearWorkerLeaseForTask(taskId: string): Promise<boolean> {
    let cleared = false;
    for (const group of WORKER_LEASE_GROUPS) {
      const existingLease = await this.loadWorkerLease(group);
      if (!existingLease || existingLease.task_id !== taskId) {
        continue;
      }

      await this.clearWorkerLease(group);
      cleared = true;
    }

    return cleared;
  }

  async loadAccountRecord(hostname: string): Promise<AccountRecord | undefined> {
    return readJsonFile<AccountRecord>(getAccountFilePath(hostname));
  }

  async saveAccountRecord(account: AccountRecord): Promise<void> {
    await writeJsonFile(getAccountFilePath(account.hostname), account);
  }

  async loadCredentialRecord(
    credentialRef: string,
  ): Promise<CredentialVaultRecord | undefined> {
    return readJsonFile<CredentialVaultRecord>(getCredentialFilePath(credentialRef));
  }

  async saveCredentialRecord(record: CredentialVaultRecord): Promise<void> {
    await writeJsonFile(getCredentialFilePath(record.credential_ref), record);
  }

  async deleteCredentialRecord(credentialRef: string): Promise<void> {
    try {
      await rm(getCredentialFilePath(credentialRef), { force: true });
    } catch (error) {
      const typedError = error as NodeJS.ErrnoException;
      if (typedError.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async upsertTargetSite(target: TargetSiteRecord): Promise<void> {
    await writeJsonFile(path.join(DATA_DIRECTORIES.runtime, "target-sites", `${hostnameToKey(target.hostname)}.json`), target);
  }

  async listTargetSites(limit = 100): Promise<TargetSiteRecord[]> {
    const targetSiteDirectory = path.join(DATA_DIRECTORIES.runtime, "target-sites");
    await mkdir(targetSiteDirectory, { recursive: true });
    const entries = await readdir(targetSiteDirectory, { withFileTypes: true });
    const sites = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, limit)
        .map((entry) => readJsonFile<TargetSiteRecord>(path.join(targetSiteDirectory, entry.name))),
    );
    return sites.filter((site): site is TargetSiteRecord => Boolean(site));
  }
}

export function getConfiguredStoreKind(): BacklinkHelperStoreKind {
  const rawValue = process.env.BACKLINKHELPER_STORE?.trim().toLowerCase();
  if (!rawValue || rawValue === "file") {
    return "file";
  }
  if (rawValue === "d1" || rawValue === "cloudflare-d1") {
    return "d1";
  }
  throw new Error(`Unsupported BACKLINKHELPER_STORE value: ${process.env.BACKLINKHELPER_STORE}`);
}

export function createConfiguredDataStore(): DataStoreBackend {
  const kind = getConfiguredStoreKind();
  if (kind === "file") {
    return new FileDataStore();
  }

  const databaseName = process.env.BACKLINKHELPER_D1_DATABASE_NAME?.trim();
  if (!databaseName) {
    throw new Error("BACKLINKHELPER_STORE=d1 requires BACKLINKHELPER_D1_DATABASE_NAME.");
  }
  const remote = process.env.BACKLINKHELPER_D1_LOCAL === "1" ? false : true;
  return createWranglerD1DataStore({ databaseName, remote, cwd: REPO_ROOT });
}

let activeDataStore: DataStoreBackend | undefined;

export function getActiveDataStore(): DataStoreBackend {
  activeDataStore ??= createConfiguredDataStore();
  return activeDataStore;
}

export function __setActiveDataStoreForTest(store: DataStoreBackend | undefined): void {
  activeDataStore = store;
}

export async function ensureDataDirectories(): Promise<void> {
  await getActiveDataStore().ensureDataDirectories();
}

export async function loadTask(taskId: string): Promise<TaskRecord | undefined> {
  return getActiveDataStore().loadTask(taskId);
}

export async function saveTask(task: TaskRecord): Promise<void> {
  await getActiveDataStore().saveTask(task);
}

export async function listTasks(): Promise<TaskRecord[]> {
  return getActiveDataStore().listTasks();
}

export async function loadWorkerLease(group: WorkerLeaseGroup = "active"): Promise<WorkerLease | undefined> {
  return getActiveDataStore().loadWorkerLease(group);
}

export async function loadAllWorkerLeases(): Promise<Record<WorkerLeaseGroup, WorkerLease | undefined>> {
  return getActiveDataStore().loadAllWorkerLeases();
}

export async function saveWorkerLease(
  lease: WorkerLease,
  group: WorkerLeaseGroup = lease.group ?? "active",
): Promise<void> {
  await getActiveDataStore().saveWorkerLease(lease, group);
}

export async function clearWorkerLease(group: WorkerLeaseGroup = "active"): Promise<void> {
  await getActiveDataStore().clearWorkerLease(group);
}

export async function clearWorkerLeaseForTask(taskId: string): Promise<boolean> {
  return getActiveDataStore().clearWorkerLeaseForTask(taskId);
}

export async function clearPendingFinalize(taskId: string): Promise<void> {
  try {
    await rm(getPendingFinalizePath(taskId), { force: true });
  } catch (error) {
    const typedError = error as NodeJS.ErrnoException;
    if (typedError.code !== "ENOENT") {
      throw error;
    }
  }
}

export async function loadAccountRecord(hostname: string): Promise<AccountRecord | undefined> {
  return getActiveDataStore().loadAccountRecord(hostname);
}

export async function saveAccountRecord(account: AccountRecord): Promise<void> {
  await getActiveDataStore().saveAccountRecord(account);
}

export async function loadCredentialRecord(
  credentialRef: string,
): Promise<CredentialVaultRecord | undefined> {
  return getActiveDataStore().loadCredentialRecord(credentialRef);
}

export async function saveCredentialRecord(record: CredentialVaultRecord): Promise<void> {
  await getActiveDataStore().saveCredentialRecord(record);
}

export async function deleteCredentialRecord(credentialRef: string): Promise<void> {
  await getActiveDataStore().deleteCredentialRecord(credentialRef);
}

export async function upsertTargetSite(target: TargetSiteRecord): Promise<void> {
  await getActiveDataStore().upsertTargetSite(target);
}

export async function listTargetSites(limit?: number): Promise<TargetSiteRecord[]> {
  return getActiveDataStore().listTargetSites(limit);
}

export type { DataStoreBackend, TargetSiteRecord } from "./sql-data-store.js";
