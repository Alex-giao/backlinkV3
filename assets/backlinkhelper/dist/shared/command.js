import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
export async function runCommand(command, args, timeoutMs = 30_000) {
    try {
        const result = await execFileAsync(command, args, {
            timeout: timeoutMs,
            maxBuffer: 5 * 1024 * 1024,
            env: process.env,
        });
        return {
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            exit_code: 0,
        };
    }
    catch (error) {
        const typedError = error;
        return {
            stdout: typedError.stdout ?? "",
            stderr: typedError.stderr ?? typedError.message,
            exit_code: typeof typedError.code === "number" ? typedError.code : 1,
        };
    }
}
