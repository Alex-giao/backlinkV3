export const BACKLINKHELPER_D1_SCHEMA_VERSION = 1;

export const BACKLINKHELPER_D1_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backlink_tasks (
  id TEXT PRIMARY KEY,
  target_url TEXT NOT NULL,
  hostname TEXT NOT NULL,
  flow_family TEXT,
  promoted_hostname TEXT,
  promoted_url TEXT,
  status TEXT NOT NULL,
  queue_priority_score REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backlink_tasks_status_priority
  ON backlink_tasks(status, queue_priority_score DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_backlink_tasks_hostname
  ON backlink_tasks(hostname);
CREATE INDEX IF NOT EXISTS idx_backlink_tasks_promoted_hostname
  ON backlink_tasks(promoted_hostname);

CREATE TABLE IF NOT EXISTS target_sites (
  target_url TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  source TEXT NOT NULL,
  flow_family_hint TEXT,
  submit_status TEXT NOT NULL DEFAULT 'candidate',
  imported_at TEXT NOT NULL,
  last_task_id TEXT,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_target_sites_hostname ON target_sites(hostname);
CREATE INDEX IF NOT EXISTS idx_target_sites_submit_status ON target_sites(submit_status);

CREATE TABLE IF NOT EXISTS task_events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES backlink_tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_events_task_created ON task_events(task_id, created_at);

CREATE TABLE IF NOT EXISTS worker_leases (
  group_name TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  lane TEXT,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS promoted_profiles (
  hostname TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  name TEXT,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS site_playbooks (
  hostname TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_records (
  hostname TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_alias TEXT NOT NULL,
  auth_mode TEXT NOT NULL,
  verified INTEGER NOT NULL,
  last_used_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credential_vault_records (
  credential_ref TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifact_refs (
  artifact_id TEXT PRIMARY KEY,
  task_id TEXT,
  artifact_type TEXT NOT NULL,
  path TEXT,
  sha256 TEXT,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifact_refs_task_id ON artifact_refs(task_id);

CREATE TABLE IF NOT EXISTS runtime_kv (
  key TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (${BACKLINKHELPER_D1_SCHEMA_VERSION}, datetime('now'));
`;

export function splitSqlStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\n|$)/g)
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => `${statement};`);
}
