import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { classifyImportedTargetFlowFamily, runImportBacklinkCsvCommand } from "./import-backlink-csv.js";
import { __setActiveDataStoreForTest, listTargetSites, listTasks } from "../memory/data-store.js";
import { createSqliteDataStore } from "../memory/sqlite-data-store.js";

async function withSqliteStore<T>(fn: () => Promise<T>): Promise<T> {
  const store = createSqliteDataStore(":memory:");
  __setActiveDataStoreForTest(store);
  try {
    await store.ensureDataDirectories();
    return await fn();
  } finally {
    __setActiveDataStoreForTest(undefined);
  }
}

async function withSilencedConsole<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = () => undefined;
  try {
    return await fn();
  } finally {
    console.log = original;
  }
}

async function withCsv<T>(content: string, fn: (csvPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "bh-import-csv-"));
  try {
    const csvPath = path.join(root, "targets.csv");
    await writeFile(csvPath, content, "utf8");
    return await fn(csvPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("classifyImportedTargetFlowFamily corrects imported forum threads away from wp_comment hints", () => {
  const classified = classifyImportedTargetFlowFamily({
    targetUrl: "https://cyberlord.at/forum/?id=1&thread=6857",
    requestedFlowFamily: "wp_comment",
  });

  assert.equal(classified.flowFamily, "forum_post");
  assert.equal(classified.source, "corrected");
  assert.equal(classified.correctedFromFamily, "wp_comment");
  assert.match(classified.reason, /forum\/thread/i);
});

test("classifyImportedTargetFlowFamily leaves ambiguous unhinted CSV rows without a family hint", () => {
  const classified = classifyImportedTargetFlowFamily({
    targetUrl: "https://ambiguous.example/resources",
  });

  assert.equal(classified.flowFamily, undefined);
  assert.equal(classified.source, "unknown");
  assert.match(classified.reason, /needs classification/i);
});

test("runImportBacklinkCsvCommand does not persist inferred family as an explicit target-site hint", async () => {
  await withSqliteStore(async () => {
    await withCsv("source_url\nhttps://faithfulprovisions.com/8-ways-to-drink-more-water-every-day/\n", async (csvPath) => {
      await withSilencedConsole(() =>
        runImportBacklinkCsvCommand({
          csvPath,
          source: "unit-test-csv",
        }),
      );
    });

    const sites = await listTargetSites(10);
    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.submit_status, "candidate");
    assert.equal(sites[0]?.flow_family_hint, undefined);
    assert.equal(sites[0]?.payload?.flow_family_source, "inferred");
  });
});

test("runImportBacklinkCsvCommand does not assign phantom task ids to needs_classification rows", async () => {
  await withSqliteStore(async () => {
    await withCsv("source_url\nhttps://ambiguous.example/resources\n", async (csvPath) => {
      await withSilencedConsole(() =>
        runImportBacklinkCsvCommand({
          csvPath,
          enqueue: true,
          promotedUrl: "https://promo.example/",
          taskIdPrefix: "review",
        }),
      );
    });

    const sites = await listTargetSites(10);
    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.submit_status, "needs_classification");
    assert.equal(sites[0]?.last_task_id, undefined);
    assert.equal((await listTasks()).length, 0);
  });
});
