import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { resolveBrowserUseBin } from "../shared/browser-use-bin.js";
const execFile = promisify(execFileCallback);
const BROWSER_USE_CDP_URL_CACHE = new Map();
function normalizeComparableUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        parsed.hash = "";
        if (parsed.pathname.endsWith("/") && parsed.pathname !== "/") {
            parsed.pathname = parsed.pathname.slice(0, -1);
        }
        return parsed.toString();
    }
    catch {
        return rawUrl.replace(/#.*$/, "").replace(/\/$/, "");
    }
}
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
function normalizeTabUrl(rawUrl) {
    return rawUrl.trim();
}
function parseBrowserUseTabList(rawText) {
    const lines = rawText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const entries = [];
    for (const line of lines) {
        if (/^TAB\s+URL$/i.test(line)) {
            continue;
        }
        const match = line.match(/^(\d+)\s+(.+)$/);
        if (!match) {
            continue;
        }
        entries.push({
            index: Number(match[1]),
            url: normalizeTabUrl(match[2]),
        });
    }
    return entries;
}
function isBrowserUseViewportHealthy(metrics) {
    const values = [metrics.outerWidth, metrics.outerHeight, metrics.innerWidth, metrics.innerHeight];
    if (values.some((value) => !Number.isFinite(value))) {
        return false;
    }
    if (metrics.outerWidth <= 0 || metrics.outerHeight <= 0) {
        return false;
    }
    if (metrics.innerWidth < 800 || metrics.innerHeight < 400) {
        return false;
    }
    if (metrics.innerWidth > 20_000 || metrics.innerHeight > 20_000) {
        return false;
    }
    return true;
}
function toHttpCdpBase(cdpUrl) {
    try {
        const parsed = new URL(cdpUrl);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            return parsed.origin;
        }
        if (parsed.protocol === "ws:" || parsed.protocol === "wss:") {
            const httpProtocol = parsed.protocol === "wss:" ? "https:" : "http:";
            return `${httpProtocol}//${parsed.host}`;
        }
        return undefined;
    }
    catch {
        return undefined;
    }
}
function serializeUrlPreservingBareOrigin(parsed) {
    const serialized = parsed.toString();
    if (!parsed.search && !parsed.hash && parsed.pathname === "/") {
        return serialized.replace(/\/$/, "");
    }
    return serialized;
}
function normalizeLoopbackCdpUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
            return rawUrl;
        }
        if (parsed.hostname !== "localhost") {
            return rawUrl;
        }
        parsed.hostname = "127.0.0.1";
        return serializeUrlPreservingBareOrigin(parsed);
    }
    catch {
        return rawUrl;
    }
}
function deriveShadowElementText(descriptor) {
    const placeholder = descriptor.match(/placeholder=([^\s>]+)/i)?.[1];
    const ariaLabel = descriptor.match(/aria-label=([^\s>]+)/i)?.[1];
    const name = descriptor.match(/name=([^\s>]+)/i)?.[1];
    const type = descriptor.match(/type=([^\s>]+)/i)?.[1];
    return [placeholder, ariaLabel, name, type]
        .filter((value) => Boolean(value))
        .map((value) => value.replace(/^['\"]|['\"]$/g, ""))
        .join(" ")
        .trim();
}
export function extractShadowElementsFromText(rawText) {
    const shadowMatches = rawText.matchAll(/\[(\d+)\](<(?:input|button|select|textarea)[^>]*>)/gi);
    const elements = [];
    for (const match of shadowMatches) {
        const descriptor = match[2].trim();
        elements.push({
            index: Number(match[1]),
            descriptor,
            text: deriveShadowElementText(descriptor),
        });
    }
    return elements;
}
function parseStateElements(rawText) {
    const lines = rawText.split(/\r?\n/);
    const elements = [];
    let current;
    for (const line of lines) {
        const trimmed = line.trim();
        const elementMatch = trimmed.match(/^\[(\d+)\](.+)$/);
        if (elementMatch) {
            if (current) {
                current.text = current.text.trim();
                elements.push(current);
            }
            current = {
                index: Number(elementMatch[1]),
                descriptor: elementMatch[2].trim(),
                text: "",
            };
            continue;
        }
        if (!current) {
            continue;
        }
        if (!trimmed ||
            trimmed === "Open Shadow" ||
            trimmed === "Shadow End" ||
            trimmed.startsWith("viewport:") ||
            trimmed.startsWith("page:") ||
            trimmed.startsWith("scroll:")) {
            continue;
        }
        current.text = `${current.text} ${trimmed}`.trim();
    }
    if (current) {
        current.text = current.text.trim();
        elements.push(current);
    }
    const seen = new Set(elements.map((element) => element.index));
    for (const shadowElement of extractShadowElementsFromText(rawText)) {
        if (!seen.has(shadowElement.index)) {
            elements.push(shadowElement);
            seen.add(shadowElement.index);
        }
    }
    return elements;
}
async function runBrowserUseCommand(args) {
    const browserUseBin = resolveBrowserUseBin();
    const canonicalCdpUrl = await resolveBrowserUseCdpUrl(args.cdpUrl);
    const { stdout, stderr } = await execFile(browserUseBin, [
        "--cdp-url",
        canonicalCdpUrl,
        "--session",
        args.session,
        "--json",
        args.command,
        ...(args.commandArgs ?? []),
    ], {
        timeout: args.timeoutMs ?? 20_000,
        maxBuffer: 10 * 1024 * 1024,
    });
    const trimmed = stdout.trim();
    if (!trimmed) {
        throw new Error(`browser-use ${args.command} returned no output. ${stderr.trim()}`.trim());
    }
    const envelope = JSON.parse(trimmed);
    if (!envelope.success || !envelope.data) {
        throw new Error(`browser-use ${args.command} failed: ${envelope.error ?? stderr.trim() ?? "Unknown error."}`);
    }
    return envelope.data;
}
export async function resolveBrowserUseCdpUrl(cdpUrl) {
    const normalizedInput = normalizeLoopbackCdpUrl(cdpUrl);
    if (!normalizedInput.startsWith("http://") && !normalizedInput.startsWith("https://")) {
        return normalizedInput;
    }
    const cached = BROWSER_USE_CDP_URL_CACHE.get(normalizedInput);
    if (cached) {
        return cached;
    }
    try {
        const response = await fetch(new URL("/json/version", normalizedInput), {
            signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) {
            return normalizedInput;
        }
        const payload = (await response.json());
        const resolved = normalizeLoopbackCdpUrl(payload.webSocketDebuggerUrl?.trim() || normalizedInput);
        BROWSER_USE_CDP_URL_CACHE.set(normalizedInput, resolved);
        return resolved;
    }
    catch {
        return normalizedInput;
    }
}
async function runBrowserUseSideEffect(args) {
    await runBrowserUseCommand(args);
}
async function listBrowserUseTabs(args) {
    const data = await runBrowserUseCommand({
        cdpUrl: args.cdpUrl,
        session: args.session,
        command: "tab",
        commandArgs: ["list"],
        timeoutMs: 20_000,
    });
    return parseBrowserUseTabList(data._raw_text);
}
async function switchBrowserUseTab(args) {
    await runBrowserUseSideEffect({
        cdpUrl: args.cdpUrl,
        session: args.session,
        command: "tab",
        commandArgs: ["switch", String(args.index)],
        timeoutMs: 20_000,
    });
}
async function getBrowserUseViewportMetrics(args) {
    const data = await runBrowserUseCommand({
        cdpUrl: args.cdpUrl,
        session: args.session,
        command: "eval",
        commandArgs: [
            '[window.outerWidth, window.outerHeight, window.innerWidth, window.innerHeight, location.href, document.title]',
        ],
        timeoutMs: 20_000,
    });
    const result = Array.isArray(data.result) ? data.result : [];
    return {
        outerWidth: Number(result[0] ?? 0),
        outerHeight: Number(result[1] ?? 0),
        innerWidth: Number(result[2] ?? 0),
        innerHeight: Number(result[3] ?? 0),
        url: String(result[4] ?? ""),
        title: String(result[5] ?? ""),
    };
}
async function createVisibleBrowserTab(args) {
    const base = toHttpCdpBase(args.cdpUrl);
    if (!base) {
        return;
    }
    const response = await fetch(`${base}/json/new?${encodeURIComponent(args.url)}`, {
        method: "PUT",
        signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
        throw new Error(`Failed to create visible Chrome tab for ${args.url}: HTTP ${response.status}`);
    }
    await response.text();
}
async function ensureBrowserUseHealthyTab(args) {
    const preferred = args.preferredUrl ? normalizeComparableUrl(args.preferredUrl) : undefined;
    const currentMetrics = await getBrowserUseViewportMetrics(args).catch(() => undefined);
    if (currentMetrics &&
        isBrowserUseViewportHealthy(currentMetrics) &&
        (!preferred || normalizeComparableUrl(currentMetrics.url) === preferred)) {
        return currentMetrics;
    }
    const tabs = await listBrowserUseTabs(args).catch(() => []);
    const preferredTabs = preferred
        ? tabs.filter((tab) => normalizeComparableUrl(tab.url) === preferred)
        : [];
    const fallbackTabs = tabs.filter((tab) => !tab.url.startsWith("chrome://") && normalizeComparableUrl(tab.url) !== preferred);
    for (const tab of [...preferredTabs, ...fallbackTabs]) {
        await switchBrowserUseTab({
            cdpUrl: args.cdpUrl,
            session: args.session,
            index: tab.index,
        }).catch(() => undefined);
        const metrics = await getBrowserUseViewportMetrics(args).catch(() => undefined);
        if (!metrics || !isBrowserUseViewportHealthy(metrics)) {
            continue;
        }
        if (!preferred || normalizeComparableUrl(metrics.url) === preferred) {
            return metrics;
        }
    }
    if (preferred && args.allowCreateVisibleTab !== false) {
        await createVisibleBrowserTab({ cdpUrl: args.cdpUrl, url: args.preferredUrl }).catch(() => undefined);
        await sleep(1_000);
        return ensureBrowserUseHealthyTab({
            cdpUrl: args.cdpUrl,
            session: args.session,
            preferredUrl: args.preferredUrl,
            allowCreateVisibleTab: false,
        });
    }
    return currentMetrics;
}
export async function getBrowserUseSnapshot(args) {
    await ensureBrowserUseHealthyTab({
        cdpUrl: args.cdpUrl,
        session: args.session,
        allowCreateVisibleTab: false,
    }).catch(() => undefined);
    const stateData = await runBrowserUseCommand({
        cdpUrl: args.cdpUrl,
        session: args.session,
        command: "state",
        timeoutMs: 20_000,
    });
    const urlData = await runBrowserUseCommand({
        cdpUrl: args.cdpUrl,
        session: args.session,
        command: "eval",
        commandArgs: ["location.href"],
        timeoutMs: 20_000,
    });
    const titleData = await runBrowserUseCommand({
        cdpUrl: args.cdpUrl,
        session: args.session,
        command: "get",
        commandArgs: ["title"],
        timeoutMs: 20_000,
    });
    return {
        raw_text: stateData._raw_text,
        url: urlData.result,
        title: titleData.title,
        elements: parseStateElements(stateData._raw_text),
    };
}
export async function openBrowserUseUrl(args) {
    try {
        const data = await runBrowserUseCommand({
            cdpUrl: args.cdpUrl,
            session: args.session,
            command: "open",
            commandArgs: [args.url],
            timeoutMs: 30_000,
        });
        const recovered = await ensureBrowserUseHealthyTab({
            cdpUrl: args.cdpUrl,
            session: args.session,
            preferredUrl: args.url,
        }).catch(() => undefined);
        return recovered?.url || data.url;
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : "browser-use open failed.";
        const currentUrl = await runBrowserUseCommand({
            cdpUrl: args.cdpUrl,
            session: args.session,
            command: "eval",
            commandArgs: ["location.href"],
            timeoutMs: 5_000,
        }).then((data) => data.result).catch(() => undefined);
        if (currentUrl &&
            normalizeComparableUrl(currentUrl) === normalizeComparableUrl(args.url) &&
            /timeout|aborted/i.test(detail)) {
            return currentUrl;
        }
        throw error;
    }
}
export async function clickBrowserUseElement(args) {
    await runBrowserUseSideEffect({
        cdpUrl: args.cdpUrl,
        session: args.session,
        command: "click",
        commandArgs: [String(args.index)],
        timeoutMs: 20_000,
    });
}
export async function inputBrowserUseElement(args) {
    await runBrowserUseSideEffect({
        cdpUrl: args.cdpUrl,
        session: args.session,
        command: "input",
        commandArgs: [String(args.index), args.text],
        timeoutMs: 20_000,
    });
}
export async function selectBrowserUseElement(args) {
    await runBrowserUseSideEffect({
        cdpUrl: args.cdpUrl,
        session: args.session,
        command: "select",
        commandArgs: [String(args.index), args.value],
        timeoutMs: 20_000,
    });
}
export async function sendBrowserUseKeys(args) {
    await runBrowserUseSideEffect({
        cdpUrl: args.cdpUrl,
        session: args.session,
        command: "keys",
        commandArgs: [args.keys],
        timeoutMs: 20_000,
    });
}
export async function waitForBrowserUseText(args) {
    await runBrowserUseSideEffect({
        cdpUrl: args.cdpUrl,
        session: args.session,
        command: "wait",
        commandArgs: ["text", ...(args.timeoutMs ? ["--timeout", String(args.timeoutMs)] : []), args.text],
        timeoutMs: (args.timeoutMs ?? 10_000) + 5_000,
    });
}
export async function waitForBrowserUseSelector(args) {
    await runBrowserUseSideEffect({
        cdpUrl: args.cdpUrl,
        session: args.session,
        command: "wait",
        commandArgs: [
            "selector",
            ...(args.timeoutMs ? ["--timeout", String(args.timeoutMs)] : []),
            ...(args.state ? ["--state", args.state] : []),
            args.selector,
        ],
        timeoutMs: (args.timeoutMs ?? 10_000) + 5_000,
    });
}
export async function evaluateBrowserUse(args) {
    const data = await runBrowserUseCommand({
        cdpUrl: args.cdpUrl,
        session: args.session,
        command: "eval",
        commandArgs: [args.script],
        timeoutMs: 20_000,
    });
    return data.result;
}
export async function getBrowserUseElementText(args) {
    const data = await runBrowserUseCommand({
        cdpUrl: args.cdpUrl,
        session: args.session,
        command: "get",
        commandArgs: ["text", String(args.index)],
        timeoutMs: 20_000,
    });
    return data.text;
}
export async function getBrowserUseElementValue(args) {
    const data = await runBrowserUseCommand({
        cdpUrl: args.cdpUrl,
        session: args.session,
        command: "get",
        commandArgs: ["value", String(args.index)],
        timeoutMs: 20_000,
    });
    return data.value;
}
export async function saveBrowserUseScreenshot(args) {
    await runBrowserUseSideEffect({
        cdpUrl: args.cdpUrl,
        session: args.session,
        command: "screenshot",
        commandArgs: [args.filePath],
        timeoutMs: 30_000,
    });
}
export async function closeBrowserUseSession(args) {
    const canonicalCdpUrl = await resolveBrowserUseCdpUrl(args.cdpUrl);
    const browserUseBin = resolveBrowserUseBin();
    await execFile(browserUseBin, ["--session", args.session, "--cdp-url", canonicalCdpUrl, "close"], {
        timeout: args.timeoutMs ?? 15_000,
        maxBuffer: 4 * 1024 * 1024,
    });
}
export async function settleBrowserUsePage(ms = 1_500) {
    await sleep(ms);
}
