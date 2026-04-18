import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
const CANDIDATE_ENV_VARS = ["BROWSER_USE_BIN", "BROWSER_USE_PATH"];
function isExecutableCandidate(filePath) {
    return Boolean(filePath && existsSync(filePath));
}
export function resolveBrowserUseBin() {
    for (const envVar of CANDIDATE_ENV_VARS) {
        const value = process.env[envVar]?.trim();
        if (isExecutableCandidate(value)) {
            return value;
        }
    }
    const home = homedir();
    const fallbackCandidates = [
        path.join(home, ".browser-use-env", "bin", "browser-use"),
        path.join(home, ".local", "bin", "browser-use"),
        "browser-use",
    ];
    for (const candidate of fallbackCandidates) {
        if (candidate === "browser-use") {
            return candidate;
        }
        if (isExecutableCandidate(candidate)) {
            return candidate;
        }
    }
    return "browser-use";
}
export function describeBrowserUseLookup() {
    const resolved = resolveBrowserUseBin();
    if (resolved === "browser-use") {
        return "browser-use CLI was not found in configured env vars or common host paths; falling back to PATH lookup.";
    }
    return `browser-use CLI resolved to ${resolved}.`;
}
