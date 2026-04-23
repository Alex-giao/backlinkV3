import { rm } from "node:fs/promises";
import { getRuntimeIncidentPath, readJsonFile, writeJsonFile } from "../memory/data-store.js";
export async function loadRuntimeIncident() {
    return readJsonFile(getRuntimeIncidentPath());
}
export async function openRuntimeIncident(args) {
    const now = new Date().toISOString();
    const existing = await loadRuntimeIncident();
    const incident = {
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
export async function clearRuntimeIncident() {
    await rm(getRuntimeIncidentPath(), { force: true });
}
