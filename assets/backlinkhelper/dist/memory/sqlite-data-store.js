import { DatabaseSync } from "node:sqlite";
import { SqlDataStore } from "./sql-data-store.js";
class SqliteExecutor {
    db;
    constructor(databasePath) {
        this.db = new DatabaseSync(databasePath);
    }
    async run(statement, params = []) {
        this.db.prepare(statement).run(...params);
    }
    async all(statement, params = []) {
        return this.db.prepare(statement).all(...params);
    }
}
export function createSqliteDataStore(databasePath) {
    return new SqlDataStore(new SqliteExecutor(databasePath), "sqlite");
}
