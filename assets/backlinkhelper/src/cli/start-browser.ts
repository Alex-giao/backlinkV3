import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

import { DATA_DIRECTORIES, ensureDataDirectories, writeJsonFile } from "../memory/data-store.js";

async function waitForCdp(port: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/json/version`;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1_000),
      });

      if (response.ok) {
        return true;
      }
    } catch {
      // Ignore and retry.
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return false;
}

export async function runStartBrowserCommand(args: {
  port?: number;
  headed?: boolean;
}): Promise<void> {
  const port = args.port ?? 9333;
  const cdpUrl = `http://127.0.0.1:${port}`;

  await ensureDataDirectories();
  if (await waitForCdp(port, 1_000)) {
    console.log(JSON.stringify({ ok: true, cdp_url: cdpUrl, already_running: true }, null, 2));
    return;
  }

  const profileDir = path.join(DATA_DIRECTORIES.runtime, `chromium-profile-${port}`);
  await mkdir(profileDir, { recursive: true });

  const browserArgs = [
    ...(args.headed ? [] : ["--headless=new"]),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--ignore-certificate-errors",
    "about:blank",
  ];

  const child = spawn(chromium.executablePath(), browserArgs, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const ready = await waitForCdp(port);
  if (!ready) {
    throw new Error(`Managed browser did not expose CDP on ${cdpUrl} within timeout.`);
  }

  const metadata = {
    ok: true,
    cdp_url: cdpUrl,
    pid: child.pid,
    executable_path: chromium.executablePath(),
    started_at: new Date().toISOString(),
    headed: !!args.headed,
  };

  await writeJsonFile(path.join(DATA_DIRECTORIES.runtime, "managed-browser.json"), metadata);
  console.log(JSON.stringify(metadata, null, 2));
}
