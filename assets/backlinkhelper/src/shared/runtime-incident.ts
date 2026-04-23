import { rm } from "node:fs/promises";

import { getRuntimeIncidentPath, readJsonFile, writeJsonFile } from "../memory/data-store.js";

export type RuntimeIncidentKind =
  | "CDP_RUNTIME_UNAVAILABLE"
  | "PLAYWRIGHT_CDP_UNAVAILABLE"
  | "RUNTIME_PREFLIGHT_FAILED";

export interface RuntimeIncident {
  kind: RuntimeIncidentKind;
  source: string;
  detail: string;
  opened_at: string;
  updated_at: string;
  evidence_ref?: string;
  cdp_url?: string;
}

export async function loadRuntimeIncident(): Promise<RuntimeIncident | undefined> {
  return readJsonFile<RuntimeIncident>(getRuntimeIncidentPath());
}

export async function openRuntimeIncident(args: {
  kind: RuntimeIncidentKind;
  source: string;
  detail: string;
  evidence_ref?: string;
  cdp_url?: string;
}): Promise<RuntimeIncident> {
  const now = new Date().toISOString();
  const existing = await loadRuntimeIncident();
  const incident: RuntimeIncident = {
    kind: args.kind,
    source: args.source,
    detail: args.detail,
    opened_at: existing?.opened_at ?? now,
    updated_at: now,
    evidence_ref: args.evidence_ref,
    cdp_url: args.cdp_url,
  };
  await writeJsonFile(getRuntimeIncidentPath(), incident);
  return incident;
}

export async function clearRuntimeIncident(): Promise<void> {
  await rm(getRuntimeIncidentPath(), { force: true });
}
