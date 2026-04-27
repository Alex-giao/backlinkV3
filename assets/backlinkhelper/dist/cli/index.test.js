import test from "node:test";
import assert from "node:assert/strict";
import { buildUnknownCommandMessage, resolveTargetUrlFlag, SUPPORTED_COMMANDS } from "./index.js";
test("resolveTargetUrlFlag prefers canonical --target-url while keeping --directory-url as legacy alias", () => {
    assert.equal(resolveTargetUrlFlag(["--directory-url", "https://legacy.example/"]), "https://legacy.example/");
    assert.equal(resolveTargetUrlFlag(["--target-url", "https://target.example/"]), "https://target.example/");
    assert.equal(resolveTargetUrlFlag([
        "--directory-url",
        "https://legacy.example/",
        "--target-url",
        "https://target.example/",
    ]), "https://target.example/");
    assert.equal(resolveTargetUrlFlag([]), undefined);
});
test("buildUnknownCommandMessage stays aligned with the supported command list", () => {
    const message = buildUnknownCommandMessage();
    assert.deepEqual(SUPPORTED_COMMANDS, [
        "start-browser",
        "preflight",
        "enqueue-site",
        "db-smoke",
        "import-backlink-csv",
        "guarded-drain-status",
        "mailbox-triage",
        "follow-up-tick",
        "unattended-campaign",
        "unattended-scope-tick",
        "missing-input-preflight",
        "init-gate",
        "update-promoted-dossier",
        "claim-next-task",
        "task-prepare",
        "task-record-agent-trace",
        "task-finalize",
        "run-next",
        "repartition-retry-decisions",
    ]);
    assert.match(message, /guarded-drain-status/);
    assert.match(message, /task-finalize/);
});
