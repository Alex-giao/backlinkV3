import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecFileException } from "node:child_process";

import { SqlDataStore, type SqlExecutor } from "./sql-data-store.js";

const execFileAsync = promisify(execFile);

function sqlLiteral(value: unknown): string {
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

function interpolateParams(statement: string, params: unknown[] = []): string {
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

function parseWranglerJson(stdout: string): Record<string, unknown>[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  const parsed = JSON.parse(trimmed) as unknown;
  const envelopes = Array.isArray(parsed) ? parsed : [parsed];
  const rows: Record<string, unknown>[] = [];
  for (const envelope of envelopes) {
    if (!envelope || typeof envelope !== "object") {
      continue;
    }
    const record = envelope as Record<string, unknown>;
    const maybeResults = record.results;
    if (Array.isArray(maybeResults)) {
      rows.push(...(maybeResults as Record<string, unknown>[]));
      continue;
    }
    const nestedResult = record.result;
    if (Array.isArray(nestedResult)) {
      for (const item of nestedResult) {
        if (item && typeof item === "object" && Array.isArray((item as Record<string, unknown>).results)) {
          rows.push(...((item as Record<string, unknown>).results as Record<string, unknown>[]));
        }
      }
    }
  }
  return rows;
}

export function __testSqlLiteral(value: unknown): string {
  return sqlLiteral(value);
}

export function __testInterpolateParams(statement: string, params: unknown[] = []): string {
  return interpolateParams(statement, params);
}

export function __testParseWranglerJson(stdout: string): Record<string, unknown>[] {
  return parseWranglerJson(stdout);
}

export class WranglerD1Executor implements SqlExecutor {
  constructor(
    private readonly databaseName: string,
    private readonly options: { remote?: boolean; cwd?: string } = {},
  ) {}

  private async execute(statement: string): Promise<Record<string, unknown>[]> {
    const args = ["d1", "execute", this.databaseName, "--json", "--command", statement];
    if (this.options.remote !== false) {
      args.splice(3, 0, "--remote");
    } else {
      args.splice(3, 0, "--local");
    }

    let lastError: Error | undefined;
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
      } catch (error) {
        const typed = error as ExecFileException & { stdout?: string; stderr?: string };
        lastError = new Error(
          [
            typed.message,
            typed.stdout ? `stdout:\n${typed.stdout}` : undefined,
            typed.stderr ? `stderr:\n${typed.stderr}` : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
        );
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        }
      }
    }
    throw lastError ?? new Error("wrangler d1 execute failed.");
  }

  async run(statement: string, params: unknown[] = []): Promise<void> {
    await this.execute(interpolateParams(statement, params));
  }

  async all<T extends Record<string, unknown>>(statement: string, params: unknown[] = []): Promise<T[]> {
    return (await this.execute(interpolateParams(statement, params))) as T[];
  }
}

export function createWranglerD1DataStore(args: {
  databaseName: string;
  remote?: boolean;
  cwd?: string;
}): SqlDataStore {
  return new SqlDataStore(new WranglerD1Executor(args.databaseName, { remote: args.remote, cwd: args.cwd }), "d1");
}
