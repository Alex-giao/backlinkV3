import { BACKLINKHELPER_D1_SCHEMA_SQL, splitSqlStatements } from "./sql-schema.js";
export const SQL_WORKER_LEASE_GROUPS = ["active", "follow_up"];
function stringifyPayload(value) {
    return JSON.stringify(value);
}
function parsePayload(value) {
    if (typeof value !== "string") {
        throw new Error("Expected SQL payload_json column to be a string.");
    }
    return JSON.parse(value);
}
function maybeNumber(value) {
    if (value === null || value === undefined) {
        return undefined;
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
}
export class SqlDataStore {
    executor;
    kind;
    schemaEnsured = false;
    constructor(executor, kind) {
        this.executor = executor;
        this.kind = kind;
    }
    async ensureDataDirectories() {
        if (this.schemaEnsured) {
            return;
        }
        for (const statement of splitSqlStatements(BACKLINKHELPER_D1_SCHEMA_SQL)) {
            await this.executor.run(statement);
        }
        this.schemaEnsured = true;
    }
    async loadTask(taskId) {
        await this.ensureDataDirectories();
        const rows = await this.executor.all("SELECT payload_json FROM backlink_tasks WHERE id = ? LIMIT 1", [taskId]);
        return rows[0] ? parsePayload(rows[0].payload_json) : undefined;
    }
    async saveTask(task) {
        await this.ensureDataDirectories();
        await this.executor.run(`INSERT INTO backlink_tasks (
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
        payload_json = excluded.payload_json`, [
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
        ]);
    }
    async listTasks() {
        await this.ensureDataDirectories();
        const rows = await this.executor.all("SELECT payload_json FROM backlink_tasks ORDER BY created_at ASC, id ASC");
        return rows.map((row) => parsePayload(row.payload_json));
    }
    async loadWorkerLease(group = "active") {
        await this.ensureDataDirectories();
        const rows = await this.executor.all("SELECT payload_json FROM worker_leases WHERE group_name = ? LIMIT 1", [group]);
        return rows[0] ? parsePayload(rows[0].payload_json) : undefined;
    }
    async loadAllWorkerLeases() {
        const leases = await Promise.all(SQL_WORKER_LEASE_GROUPS.map(async (group) => [group, await this.loadWorkerLease(group)]));
        return Object.fromEntries(leases);
    }
    async saveWorkerLease(lease, group = lease.group ?? "active") {
        await this.ensureDataDirectories();
        const normalized = { ...lease, group };
        await this.executor.run(`INSERT INTO worker_leases (group_name, task_id, owner, acquired_at, expires_at, lane, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(group_name) DO UPDATE SET
         task_id = excluded.task_id,
         owner = excluded.owner,
         acquired_at = excluded.acquired_at,
         expires_at = excluded.expires_at,
         lane = excluded.lane,
         payload_json = excluded.payload_json`, [group, normalized.task_id, normalized.owner, normalized.acquired_at, normalized.expires_at, normalized.lane ?? null, stringifyPayload(normalized)]);
    }
    async clearWorkerLease(group = "active") {
        await this.ensureDataDirectories();
        await this.executor.run("DELETE FROM worker_leases WHERE group_name = ?", [group]);
    }
    async clearWorkerLeaseForTask(taskId) {
        await this.ensureDataDirectories();
        const rows = await this.executor.all("SELECT group_name FROM worker_leases WHERE task_id = ?", [taskId]);
        for (const row of rows) {
            await this.clearWorkerLease(row.group_name);
        }
        return rows.length > 0;
    }
    async loadAccountRecord(hostname) {
        await this.ensureDataDirectories();
        const rows = await this.executor.all("SELECT payload_json FROM account_records WHERE hostname = ? LIMIT 1", [hostname]);
        return rows[0] ? parsePayload(rows[0].payload_json) : undefined;
    }
    async saveAccountRecord(account) {
        await this.ensureDataDirectories();
        await this.executor.run(`INSERT INTO account_records (hostname, email, email_alias, auth_mode, verified, last_used_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hostname) DO UPDATE SET
         email = excluded.email,
         email_alias = excluded.email_alias,
         auth_mode = excluded.auth_mode,
         verified = excluded.verified,
         last_used_at = excluded.last_used_at,
         payload_json = excluded.payload_json`, [account.hostname, account.email, account.email_alias, account.auth_mode, account.verified ? 1 : 0, account.last_used_at, stringifyPayload(account)]);
    }
    async loadCredentialRecord(credentialRef) {
        await this.ensureDataDirectories();
        const rows = await this.executor.all("SELECT payload_json FROM credential_vault_records WHERE credential_ref = ? LIMIT 1", [credentialRef]);
        return rows[0] ? parsePayload(rows[0].payload_json) : undefined;
    }
    async saveCredentialRecord(record) {
        await this.ensureDataDirectories();
        await this.executor.run(`INSERT INTO credential_vault_records (credential_ref, updated_at, payload_json)
       VALUES (?, ?, ?)
       ON CONFLICT(credential_ref) DO UPDATE SET
         updated_at = excluded.updated_at,
         payload_json = excluded.payload_json`, [record.credential_ref, record.updated_at, stringifyPayload(record)]);
    }
    async deleteCredentialRecord(credentialRef) {
        await this.ensureDataDirectories();
        await this.executor.run("DELETE FROM credential_vault_records WHERE credential_ref = ?", [credentialRef]);
    }
    async upsertTargetSite(target) {
        await this.ensureDataDirectories();
        await this.executor.run(`INSERT INTO target_sites (
        target_url, hostname, source, flow_family_hint, submit_status, imported_at, last_task_id, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_url) DO UPDATE SET
        hostname = excluded.hostname,
        source = excluded.source,
        flow_family_hint = excluded.flow_family_hint,
        submit_status = excluded.submit_status,
        last_task_id = COALESCE(excluded.last_task_id, target_sites.last_task_id),
        payload_json = excluded.payload_json`, [
            target.target_url,
            target.hostname,
            target.source,
            target.flow_family_hint ?? null,
            target.submit_status,
            target.imported_at,
            target.last_task_id ?? null,
            stringifyPayload(target),
        ]);
    }
    async listTargetSites(limit = 100) {
        await this.ensureDataDirectories();
        const rows = await this.executor.all("SELECT payload_json FROM target_sites ORDER BY imported_at ASC, target_url ASC LIMIT ?", [limit]);
        return rows.map((row) => parsePayload(row.payload_json));
    }
}
