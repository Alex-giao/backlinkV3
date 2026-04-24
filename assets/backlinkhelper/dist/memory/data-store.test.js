import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
async function importFreshDataStore() {
    const url = new URL("./data-store.js", import.meta.url);
    url.search = `case=${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return import(url.href);
}
test("DATA_ROOT defaults outside the repo under Hermes state", async () => {
    const previousDataRoot = process.env.BACKLINER_DATA_ROOT;
    const previousStateDir = process.env.BACKLINKHELPER_STATE_DIR;
    const previousHermesHome = process.env.HERMES_HOME;
    try {
        delete process.env.BACKLINER_DATA_ROOT;
        delete process.env.BACKLINKHELPER_STATE_DIR;
        process.env.HERMES_HOME = "/tmp/hermes-home-for-backlinkhelper-test";
        const store = await importFreshDataStore();
        assert.equal(store.DATA_ROOT, "/tmp/hermes-home-for-backlinkhelper-test/state/backlinkhelper-v3");
        assert.ok(!store.DATA_ROOT.includes(`${path.sep}assets${path.sep}backlinkhelper${path.sep}data`));
    }
    finally {
        if (previousDataRoot === undefined)
            delete process.env.BACKLINER_DATA_ROOT;
        else
            process.env.BACKLINER_DATA_ROOT = previousDataRoot;
        if (previousStateDir === undefined)
            delete process.env.BACKLINKHELPER_STATE_DIR;
        else
            process.env.BACKLINKHELPER_STATE_DIR = previousStateDir;
        if (previousHermesHome === undefined)
            delete process.env.HERMES_HOME;
        else
            process.env.HERMES_HOME = previousHermesHome;
    }
});
test("BACKLINKHELPER_STATE_DIR overrides the default state root", async () => {
    const previousDataRoot = process.env.BACKLINER_DATA_ROOT;
    const previousStateDir = process.env.BACKLINKHELPER_STATE_DIR;
    try {
        delete process.env.BACKLINER_DATA_ROOT;
        process.env.BACKLINKHELPER_STATE_DIR = path.join(os.tmpdir(), "bh-state-root");
        const store = await importFreshDataStore();
        assert.equal(store.DATA_ROOT, path.join(os.tmpdir(), "bh-state-root"));
    }
    finally {
        if (previousDataRoot === undefined)
            delete process.env.BACKLINER_DATA_ROOT;
        else
            process.env.BACKLINER_DATA_ROOT = previousDataRoot;
        if (previousStateDir === undefined)
            delete process.env.BACKLINKHELPER_STATE_DIR;
        else
            process.env.BACKLINKHELPER_STATE_DIR = previousStateDir;
    }
});
test("legacy BACKLINER_DATA_ROOT remains the highest-priority override", async () => {
    const previousDataRoot = process.env.BACKLINER_DATA_ROOT;
    const previousStateDir = process.env.BACKLINKHELPER_STATE_DIR;
    try {
        process.env.BACKLINER_DATA_ROOT = path.join(os.tmpdir(), "bh-legacy-data-root");
        process.env.BACKLINKHELPER_STATE_DIR = path.join(os.tmpdir(), "bh-state-root");
        const store = await importFreshDataStore();
        assert.equal(store.DATA_ROOT, path.join(os.tmpdir(), "bh-legacy-data-root"));
    }
    finally {
        if (previousDataRoot === undefined)
            delete process.env.BACKLINER_DATA_ROOT;
        else
            process.env.BACKLINER_DATA_ROOT = previousDataRoot;
        if (previousStateDir === undefined)
            delete process.env.BACKLINKHELPER_STATE_DIR;
        else
            process.env.BACKLINKHELPER_STATE_DIR = previousStateDir;
    }
});
