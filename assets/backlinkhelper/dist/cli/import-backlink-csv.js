import { readFile } from "node:fs/promises";
import { enqueueSiteTask } from "../control-plane/task-queue.js";
import { classifyTargetSurfaceForIntake } from "../families/classifier.js";
import { ensureDataDirectories, hostnameToKey, upsertTargetSite } from "../memory/data-store.js";
function parseCsvLine(line) {
    const values = [];
    let current = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        const next = line[index + 1];
        if (char === '"' && quoted && next === '"') {
            current += '"';
            index += 1;
            continue;
        }
        if (char === '"') {
            quoted = !quoted;
            continue;
        }
        if (char === "," && !quoted) {
            values.push(current);
            current = "";
            continue;
        }
        current += char;
    }
    values.push(current);
    return values.map((value) => value.trim());
}
function readCsvRows(content) {
    const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
    if (lines.length === 0) {
        return [];
    }
    const headers = parseCsvLine(lines[0]);
    return lines.slice(1).map((line) => {
        const values = parseCsvLine(line);
        return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
    });
}
function normalizeUrl(value) {
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    try {
        const url = new URL(trimmed);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return undefined;
        }
        url.hash = "";
        return url.toString();
    }
    catch {
        return undefined;
    }
}
function buildTaskId(args) {
    const hostname = hostnameToKey(new URL(args.targetUrl).hostname).replace(/\./g, "-");
    return `${args.prefix}-${String(args.index).padStart(4, "0")}-${hostname}`.slice(0, 120);
}
export function classifyImportedTargetFlowFamily(args) {
    return classifyTargetSurfaceForIntake({
        targetUrl: args.targetUrl,
        requestedFlowFamily: args.requestedFlowFamily,
    });
}
function targetSiteFlowFamilyHintForImport(classification) {
    // `flow_family_hint` means explicit/operator-provided routing evidence for
    // future intake. Do not persist auto-inferred families as hints, otherwise a
    // later unattended tick will treat the row as explicit and lose provenance.
    if (classification.source === "inferred" || classification.state === "needs_classification") {
        return undefined;
    }
    return classification.flowFamily;
}
export async function runImportBacklinkCsvCommand(args) {
    await ensureDataDirectories();
    const csv = await readFile(args.csvPath, "utf8");
    const rows = readCsvRows(csv);
    const urlColumn = args.urlColumn ?? "source_url";
    const offset = args.offset ?? 0;
    const limit = args.limit ?? rows.length;
    const selected = rows.slice(offset, offset + limit);
    const seenUrls = new Set();
    let imported = 0;
    let enqueued = 0;
    let skipped = 0;
    let failed = 0;
    const taskIds = [];
    if (args.enqueue && !args.promotedUrl) {
        throw new Error("--enqueue requires --promoted-url.");
    }
    for (const [index, row] of selected.entries()) {
        const targetUrl = normalizeUrl(row[urlColumn] ?? "");
        if (!targetUrl || seenUrls.has(targetUrl)) {
            skipped += 1;
            continue;
        }
        seenUrls.add(targetUrl);
        const hostname = new URL(targetUrl).hostname;
        const flowFamilyClassification = classifyImportedTargetFlowFamily({
            targetUrl,
            requestedFlowFamily: args.flowFamily,
        });
        const taskId = args.enqueue && args.promotedUrl
            ? buildTaskId({ prefix: args.taskIdPrefix ?? "csv-import", index: offset + index + 1, targetUrl })
            : undefined;
        let lastTaskId;
        let submitStatus = flowFamilyClassification.state === "needs_classification"
            ? "needs_classification"
            : taskId
                ? "enqueued"
                : "candidate";
        let enqueueOutcome;
        let enqueueError;
        if (taskId && args.promotedUrl && flowFamilyClassification.state === "ready") {
            try {
                const result = await enqueueSiteTask({
                    taskId,
                    targetUrl,
                    promotedUrl: args.promotedUrl,
                    promotedName: args.promotedName,
                    promotedDescription: args.promotedDescription,
                    submitterEmailBase: args.submitterEmailBase,
                    confirmSubmit: false,
                    flowFamily: flowFamilyClassification.source === "inferred" ? undefined : args.flowFamily,
                    enqueuedBy: "import-backlink-csv",
                });
                enqueueOutcome = result.outcome;
                lastTaskId = result.task.id;
                taskIds.push(result.task.id);
                if (result.outcome === "accept_new_task" ||
                    result.outcome === "reactivated_existing_task" ||
                    result.outcome === "reused_existing_task") {
                    enqueued += 1;
                    submitStatus = "enqueued";
                }
                else {
                    skipped += 1;
                    submitStatus = "skipped";
                }
            }
            catch (error) {
                failed += 1;
                submitStatus = "failed";
                enqueueError = error instanceof Error ? error.message : String(error);
            }
        }
        await upsertTargetSite({
            target_url: targetUrl,
            hostname,
            source: args.source ?? "csv-import",
            flow_family_hint: targetSiteFlowFamilyHintForImport(flowFamilyClassification),
            submit_status: submitStatus,
            imported_at: new Date().toISOString(),
            last_task_id: lastTaskId,
            payload: {
                row_index: offset + index + 1,
                row,
                enqueue_outcome: enqueueOutcome,
                enqueue_error: enqueueError,
                requested_flow_family: args.flowFamily,
                flow_family_source: flowFamilyClassification.source,
                flow_family_reason: flowFamilyClassification.reason,
                corrected_from_family: flowFamilyClassification.correctedFromFamily,
            },
        });
        imported += 1;
    }
    console.log(JSON.stringify({
        csv_path: args.csvPath,
        url_column: urlColumn,
        rows_seen: selected.length,
        imported,
        enqueued,
        skipped,
        failed,
        task_ids_sample: taskIds.slice(0, 10),
    }, null, 2));
}
