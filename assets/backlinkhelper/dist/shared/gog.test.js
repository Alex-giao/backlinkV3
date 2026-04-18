import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { detectMailProvider, parseGwsGetPayload, parseGwsSearchPayload, } from "./gog.js";
function commandResult(args = {}) {
    return {
        stdout: args.stdout ?? "",
        stderr: args.stderr ?? "",
        exit_code: args.exit_code ?? 0,
    };
}
test("detectMailProvider falls back to gws when gog is unavailable but google-workspace is authenticated", async () => {
    const hermesHome = path.join(os.tmpdir(), `backlinkhelper-gws-${Date.now()}`);
    const setupScript = path.join(hermesHome, "skills", "productivity", "google-workspace", "scripts", "setup.py");
    await mkdir(path.dirname(setupScript), { recursive: true });
    await writeFile(setupScript, "#!/usr/bin/env python3\n");
    const calls = [];
    const runner = async (command, args) => {
        calls.push({ command, args });
        if (command === "which" && args[0] === "gog") {
            return commandResult({ exit_code: 1, stderr: "not found" });
        }
        if (command === "which" && args[0] === "gws") {
            return commandResult({ stdout: "/usr/local/bin/gws\n" });
        }
        if (command === "python3" && args.at(-1) === "--check") {
            return commandResult({ stdout: "AUTHENTICATED: Token valid\n" });
        }
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    };
    const provider = await detectMailProvider({
        hermesHome,
        pythonBin: "python3",
        runner,
    });
    assert.equal(provider.ok, true);
    assert.equal(provider.provider, "gws");
    assert.match(provider.detail, /gws fallback/i);
    assert.equal(calls.some((call) => call.command === "python3" && call.args.includes(setupScript)), true);
});
test("parseGwsSearchPayload converts wrapper gmail search output into message summaries", () => {
    const messages = parseGwsSearchPayload(JSON.stringify({
        messages: [
            {
                id: "abc123",
                subject: "Your magic link",
                from: "Login <noreply@example.com>",
                date: "Fri, 11 Apr 2026 01:02:03 +0000",
            },
        ],
    }));
    assert.deepEqual(messages, [
        {
            id: "abc123",
            subject: "Your magic link",
            from: "Login <noreply@example.com>",
            date: "Fri, 11 Apr 2026 01:02:03 +0000",
        },
    ]);
});
test("parseGwsGetPayload converts wrapper gmail get output into normalized body fields", () => {
    const payload = parseGwsGetPayload(JSON.stringify({
        subject: "Sign in link",
        date: "Fri, 11 Apr 2026 01:02:03 +0000",
        body_text: "Use this magic link https://example.com/auth/confirm?token=abc",
        from: { name: "Auth Bot", email: "noreply@example.com" },
        to: [{ email: "user+site@example.com" }],
    }));
    assert.deepEqual(payload, {
        subject: "Sign in link",
        from: "Auth Bot <noreply@example.com>",
        to: "user+site@example.com",
        body: "Use this magic link https://example.com/auth/confirm?token=abc",
    });
});
