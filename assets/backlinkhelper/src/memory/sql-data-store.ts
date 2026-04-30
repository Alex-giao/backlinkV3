import type { AccountRecord, CredentialVaultRecord, TaskRecord, WorkerLease, WorkerLeaseGroup } from "../shared/types.js";
import { BACKLINKHELPER_D1_SCHEMA_SQL, splitSqlStatements } from "./sql-schema.js";

export interface TargetSiteRecord {
  target_url: string;
  hostname: string;
  source: string;
  flow_family_hint?: TaskRecord["flow_family"];
  submit_status: "candidate" | "needs_classification" | "enqueued" | "submitted" | "failed" | "skipped";
  imported_at: string;
  last_task_id?: string;
  payload?: Record<string, unknown>;
}

export interface SqlExecutor {
  run(statement: string, params?: unknown[]): Promise<void>;
  all<T extends Record<string, unknown>>(statement: string, params?: unknown[]): Promise<T[]>;
}

export interface DataStoreBackend {
  readonly kind: "file" | "d1" | "sqlite";
  ensureDataDirectories(): Promise<void>;
  loadTask(taskId: string): Promise<TaskRecord | undefined>;
  saveTask(task: TaskRecord): Promise<void>;
  listTasks(): Promise<TaskRecord[]>;
  loadWorkerLease(group?: WorkerLeaseGroup): Promise<WorkerLease | undefined>;
  loadAllWorkerLeases(): Promise<Record<WorkerLeaseGroup, WorkerLease | undefined>>;
  saveWorkerLease(lease: WorkerLease, group?: WorkerLeaseGroup): Promise<void>;
  clearWorkerLease(group?: WorkerLeaseGroup): Promise<void>;
  clearWorkerLeaseForTask(taskId: string): Promise<boolean>;
  loadAccountRecord(hostname: string): Promise<AccountRecord | undefined>;
  saveAccountRecord(account: AccountRecord): Promise<void>;
  loadCredentialRecord(credentialRef: string): Promise<CredentialVaultRecord | undefined>;
  saveCredentialRecord(record: CredentialVaultRecord): Promise<void>;
  deleteCredentialRecord(credentialRef: string): Promise<void>;
  upsertTargetSite(target: TargetSiteRecord): Promise<void>;
  listTargetSites(limit?: number): Promise<TargetSiteRecord[]>;
}

export const SQL_WORKER_LEASE_GROUPS: WorkerLeaseGroup[] = ["active", "follow_up"];

function stringifyPayload(value: unknown): string {
  return JSON.stringify(value);
}

function parsePayload<T>(value: unknown): T {
  if (typeof value !== "string") {
    throw new Error("Expected SQL payload_json column to be a string.");
  }
  return JSON.parse(value) as T;
}

function isCompleteTargetSitePayload(payload: Partial<TargetSiteRecord> | Record<string, unknown>): payload is TargetSiteRecord {
  return (
    typeof payload.target_url === "string" &&
    typeof payload.hostname === "string" &&
    typeof payload.source === "string" &&
    typeof payload.submit_status === "string" &&
    typeof payload.imported_at === "string"
  );
}

function maybeNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

export class SqlDataStore implements DataStoreBackend {
  readonly kind: "d1" | "sqlite";
  private schemaEnsured = false;

  constructor(private readonly executor: SqlExecutor, kind: "d1" | "sqlite") {
    this.kind = kind;
  }

  async ensureDataDirectories(): Promise<void> {
    if (this.schemaEnsured) {
      return;
    }
    for (const statement of splitSqlStatements(BACKLINKHELPER_D1_SCHEMA_SQL)) {
      await this.executor.run(statement);
    }
    this.schemaEnsured = true;
  }

  async loadTask(taskId: string): Promise<TaskRecord | undefined> {
    await this.ensureDataDirectories();
    const rows = await this.executor.all<{ payload_json: string }>(
      "SELECT payload_json FROM backlink_tasks WHERE id = ? LIMIT 1",
      [taskId],
    );
    return rows[0] ? parsePayload<TaskRecord>(rows[0].payload_json) : undefined;
  }

  async saveTask(task: TaskRecord): Promise<void> {
    await this.ensureDataDirectories();
    await this.executor.run(
      `INSERT INTO backlink_tasks (
        id, target_url, hostname, flow_family, promoted_hostname, promoted_url,
        status, queue_priority_score, created_at, updated_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        target_url = excluded.target_url,
        hostname = excluded.hostname,
        flow_family = excluded.flow_family,
        promoted_hostname = excluded.promoted_hostname,
        promoted_url = excluded.promoted_url,
        status = excluded.status,
        queue_priority_score = excluded.queue_priority_score,
        updated_at = excluded.updated_at,
        payload_json = excluded.payload_json`,
      [
        task.id,
        task.target_url,
        task.hostname,
        task.flow_family ?? null,
        task.submission.promoted_profile.hostname,
        task.submission.promoted_profile.url,
        task.status,
        task.queue_priority_score ?? null,
        task.created_at,
        task.updated_at,
        stringifyPayload(task),
      ],
    );
  }

  async listTasks(): Promise<TaskRecord[]> {
    await this.ensureDataDirectories();
    const rows = await this.executor.all<{ payload_json: string }>(
      "SELECT payload_json FROM backlink_tasks ORDER BY created_at ASC, id ASC",
    );
    return rows.map((row) => parsePayload<TaskRecord>(row.payload_json));
  }

  async loadWorkerLease(group: WorkerLeaseGroup = "active"): Promise<WorkerLease | undefined> {
    await this.ensureDataDirectories();
    const rows = await this.executor.all<{ payload_json: string }>(
      "SELECT payload_json FROM worker_leases WHERE group_name = ? LIMIT 1",
      [group],
    );
    return rows[0] ? parsePayload<WorkerLease>(rows[0].payload_json) : undefined;
  }

  async loadAllWorkerLeases(): Promise<Record<WorkerLeaseGroup, WorkerLease | undefined>> {
    const leases = await Promise.all(
      SQL_WORKER_LEASE_GROUPS.map(async (group) => [group, await this.loadWorkerLease(group)] as const),
    );
    return Object.fromEntries(leases) as Record<WorkerLeaseGroup, WorkerLease | undefined>;
  }

  async saveWorkerLease(lease: WorkerLease, group: WorkerLeaseGroup = lease.group ?? "active"): Promise<void> {
    await this.ensureDataDirectories();
    const normalized = { ...lease, group } satisfies WorkerLease;
    await this.executor.run(
      `INSERT INTO worker_leases (group_name, task_id, owner, acquired_at, expires_at, lane, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(group_name) DO UPDATE SET
         task_id = excluded.task_id,
         owner = excluded.owner,
         acquired_at = excluded.acquired_at,
         expires_at = excluded.expires_at,
         lane = excluded.lane,
         payload_json = excluded.payload_json`,
      [group, normalized.task_id, normalized.owner, normalized.acquired_at, normalized.expires_at, normalized.lane ?? null, stringifyPayload(normalized)],
    );
  }

  async clearWorkerLease(group: WorkerLeaseGroup = "active"): Promise<void> {
    await this.ensureDataDirectories();
    await this.executor.run("DELETE FROM worker_leases WHERE group_name = ?", [group]);
  }

  async clearWorkerLeaseForTask(taskId: string): Promise<boolean> {
    await this.ensureDataDirectories();
    const rows = await this.executor.all<{ group_name: string }>(
      "SELECT group_name FROM worker_leases WHERE task_id = ?",
      [taskId],
    );
    for (const row of rows) {
      await this.clearWorkerLease(row.group_name as WorkerLeaseGroup);
    }
    return rows.length > 0;
  }

  async loadAccountRecord(hostname: string): Promise<AccountRecord | undefined> {
    await this.ensureDataDirectories();
    const rows = await this.executor.all<{ payload_json: string }>(
      "SELECT payload_json FROM account_records WHERE hostname = ? LIMIT 1",
      [hostname],
    );
    return rows[0] ? parsePayload<AccountRecord>(rows[0].payload_json) : undefined;
  }

  async saveAccountRecord(account: AccountRecord): Promise<void> {
    await this.ensureDataDirectories();
    await this.executor.run(
      `INSERT INTO account_records (hostname, email, email_alias, auth_mode, verified, last_used_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hostname) DO UPDATE SET
         email = excluded.email,
         email_alias = excluded.email_alias,
         auth_mode = excluded.auth_mode,
         verified = excluded.verified,
         last_used_at = excluded.last_used_at,
         payload_json = excluded.payload_json`,
      [account.hostname, account.email, account.email_alias, account.auth_mode, account.verified ? 1 : 0, account.last_used_at, stringifyPayload(account)],
    );
  }

  async loadCredentialRecord(credentialRef: string): Promise<CredentialVaultRecord | undefined> {
    await this.ensureDataDirectories();
    const rows = await this.executor.all<{ payload_json: string }>(
      "SELECT payload_json FROM credential_vault_records WHERE credential_ref = ? LIMIT 1",
      [credentialRef],
    );
    return rows[0] ? parsePayload<CredentialVaultRecord>(rows[0].payload_json) : undefined;
  }

  async saveCredentialRecord(record: CredentialVaultRecord): Promise<void> {
    await this.ensureDataDirectories();
    await this.executor.run(
      `INSERT INTO credential_vault_records (credential_ref, updated_at, payload_json)
       VALUES (?, ?, ?)
       ON CONFLICT(credential_ref) DO UPDATE SET
         updated_at = excluded.updated_at,
         payload_json = excluded.payload_json`,
      [record.credential_ref, record.updated_at, stringifyPayload(record)],
    );
  }

  async deleteCredentialRecord(credentialRef: string): Promise<void> {
    await this.ensureDataDirectories();
    await this.executor.run("DELETE FROM credential_vault_records WHERE credential_ref = ?", [credentialRef]);
  }

  async upsertTargetSite(target: TargetSiteRecord): Promise<void> {
    await this.ensureDataDirectories();
    await this.executor.run(
      `INSERT INTO target_sites (
        target_url, hostname, source, flow_family_hint, submit_status, imported_at, last_task_id, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_url) DO UPDATE SET
        hostname = excluded.hostname,
        source = excluded.source,
        flow_family_hint = excluded.flow_family_hint,
        submit_status = excluded.submit_status,
        last_task_id = COALESCE(excluded.last_task_id, target_sites.last_task_id),
        payload_json = excluded.payload_json`,
      [
        target.target_url,
        target.hostname,
        target.source,
        target.flow_family_hint ?? null,
        target.submit_status,
        target.imported_at,
        target.last_task_id ?? null,
        stringifyPayload(target),
      ],
    );
  }

  async listTargetSites(limit = 100): Promise<TargetSiteRecord[]> {
    await this.ensureDataDirectories();
    const rows = await this.executor.all<{
      target_url: string;
      hostname: string;
      source: string;
      flow_family_hint: TaskRecord["flow_family"] | null;
      submit_status: TargetSiteRecord["submit_status"];
      imported_at: string;
      last_task_id: string | null;
      payload_json: string;
    }>(
      `SELECT target_url, hostname, source, flow_family_hint, submit_status, imported_at, last_task_id, payload_json
       FROM target_sites
       ORDER BY imported_at ASC, target_url ASC
       LIMIT ?`,
      [limit],
    );
    return rows.map((row) => {
      const payload = parsePayload<Partial<TargetSiteRecord> | Record<string, unknown>>(row.payload_json);
      if (isCompleteTargetSitePayload(payload)) {
        return payload;
      }
      return {
        target_url: row.target_url,
        hostname: row.hostname,
        source: row.source,
        flow_family_hint: row.flow_family_hint ?? undefined,
        submit_status: row.submit_status,
        imported_at: row.imported_at,
        last_task_id: row.last_task_id ?? undefined,
        payload,
      } satisfies TargetSiteRecord;
    });
  }
}
