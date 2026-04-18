import { getProfileFilePath, readJsonFile } from "../memory/data-store.js";
import { buildMissingInputPreflightReport } from "./missing-input-preflight.js";
export function evaluateInitGate(args) {
    const ready = args.report.completeness.core_ready && args.report.completeness.flow_ready;
    if (ready) {
        return {
            mode: args.mode,
            status: "ready_to_execute",
            blocking: false,
            summary: "Promoted dossier passed core and flow readiness checks.",
            report: args.report,
        };
    }
    const missing = [
        ...args.report.completeness.missing_core_fields,
        ...args.report.completeness.missing_flow_fields,
    ];
    const askPrompt = args.report.user_prompt?.trim();
    const summary = askPrompt || `Promoted dossier is incomplete before execution: ${missing.join(", ")}.`;
    return {
        mode: args.mode,
        status: args.mode === "interactive" ? "needs_user_input" : "blocked_unattended",
        blocking: true,
        summary,
        report: args.report,
    };
}
export async function runInitGate(args) {
    const report = await buildMissingInputPreflightReport({
        promotedUrl: args.promotedUrl,
        promotedHostname: args.promotedHostname,
    });
    return evaluateInitGate({ mode: args.mode, report });
}
export async function loadPromotedProfileByScope(args) {
    const hostname = args.promotedUrl ? new URL(args.promotedUrl).hostname : args.promotedHostname;
    if (!hostname) {
        return undefined;
    }
    return readJsonFile(getProfileFilePath(hostname));
}
