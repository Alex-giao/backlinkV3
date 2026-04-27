import { DatabaseSync } from "node:sqlite";

import { SqlDataStore, type SqlExecutor } from "./sql-data-store.js";

class SqliteExecutor implements SqlExecutor {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
  }

  async run(statement: string, params: unknown[] = []): Promise<void> {
    this.db.prepare(statement).run(...(params as never[]));
  }

  async all<T extends Record<string, unknown>>(statement: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(statement).all(...(params as never[])) as T[];
  }
}

export function createSqliteDataStore(databasePath: string): SqlDataStore {
  return new SqlDataStore(new SqliteExecutor(databasePath), "sqlite");
}
