import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SqlDataStore } from "./sql-data-store.js";
const execFileAsync = promisify(execFile);
function sqlLiteral(value) {
    if (value === null || value === undefined) {
        return "NULL";
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new Error(`Cannot bind non-finite SQL number: ${value}`);
        }
        return String(value);
    }
    if (typeof value === "boolean") {
        return value ? "1" : "0";
    }
    return `'${String(value).replace(/'/g, "''")}'`;
}
function interpolateParams(statement, params = []) {
    let index = 0;
    const sql = statement.replace(/\?/g, () => {
        if (index >= params.length) {
            throw new Error("SQL statement has more placeholders than params.");
        }
        return sqlLiteral(params[index++]);
    });
    if (index !== params.length) {
        throw new Error("SQL statement has more params than placeholders.");
    }
    return sql;
}
function parseWranglerJson(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed) {
        return [];
    }
    const parsed = JSON.parse(trimmed);
    const envelopes = Array.isArray(parsed) ? parsed : [parsed];
    const rows = [];
    for (const envelope of envelopes) {
        if (!envelope || typeof envelope !== "object") {
            continue;
        }
        const record = envelope;
        const maybeResults = record.results;
        if (Array.isArray(maybeResults)) {
            rows.push(...maybeResults);
            continue;
        }
        const nestedResult = record.result;
        if (Array.isArray(nestedResult)) {
            for (const item of nestedResult) {
                if (item && typeof item === "object" && Array.isArray(item.results)) {
                    rows.push(...item.results);
                }
            }
        }
    }
    return rows;
}
export function __testSqlLiteral(value) {
    return sqlLiteral(value);
}
export function __testInterpolateParams(statement, params = []) {
    return interpolateParams(statement, params);
}
export function __testParseWranglerJson(stdout) {
    return parseWranglerJson(stdout);
}
export class WranglerD1Executor {
    databaseName;
    options;
    constructor(databaseName, options = {}) {
        this.databaseName = databaseName;
        this.options = options;
    }
    async execute(statement) {
        const args = ["d1", "execute", this.databaseName, "--json", "--command", statement];
        if (this.options.remote !== false) {
            args.splice(3, 0, "--remote");
        }
        else {
            args.splice(3, 0, "--local");
        }
        let lastError;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            let stdout = "";
            let stderr = "";
            try {
                const result = await execFileAsync("wrangler", args, {
                    cwd: this.options.cwd,
                    maxBuffer: 10 * 1024 * 1024,
                });
                stdout = result.stdout;
                stderr = result.stderr;
                if (stderr.trim() && process.env.BACKLINKHELPER_D1_DEBUG === "1") {
                    console.error(stderr.trim());
                }
                return parseWranglerJson(stdout);
            }
            catch (error) {
                const typed = error;
                lastError = new Error([
                    typed.message,
                    typed.stdout ? `stdout:\n${typed.stdout}` : undefined,
                    typed.stderr ? `stderr:\n${typed.stderr}` : undefined,
                ]
                    .filter(Boolean)
                    .join("\n"));
                if (attempt < 3) {
                    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
                }
            }
        }
        throw lastError ?? new Error("wrangler d1 execute failed.");
    }
    async run(statement, params = []) {
        await this.execute(interpolateParams(statement, params));
    }
    async all(statement, params = []) {
        return (await this.execute(interpolateParams(statement, params)));
    }
}
export function createWranglerD1DataStore(args) {
    return new SqlDataStore(new WranglerD1Executor(args.databaseName, { remote: args.remote, cwd: args.cwd }), "d1");
}
