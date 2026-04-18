import { chromium } from "playwright";
class PlaywrightSessionTimeoutError extends Error {
    label;
    timeoutMs;
    constructor(label, timeoutMs) {
        super(`${label} timed out after ${timeoutMs}ms`);
        this.name = "PlaywrightSessionTimeoutError";
        this.label = label;
        this.timeoutMs = timeoutMs;
    }
}
function isEphemeralRegularPage(url) {
    if (!url) {
        return false;
    }
    const normalized = url.toLowerCase();
    return (normalized.startsWith("http://") ||
        normalized.startsWith("https://") ||
        normalized.startsWith("file://"));
}
function pickPreferredPage(contexts, preferredUrl) {
    const pages = contexts.flatMap((context) => context.pages());
    if (preferredUrl) {
        const exactMatch = pages.find((page) => page.url() === preferredUrl);
        if (exactMatch) {
            return exactMatch;
        }
        const prefixMatch = pages.find((page) => preferredUrl.startsWith(page.url()) || page.url().startsWith(preferredUrl));
        if (prefixMatch) {
            return prefixMatch;
        }
    }
    const lastNonBlankPage = [...pages]
        .reverse()
        .find((page) => page.url() && page.url() !== "about:blank");
    if (lastNonBlankPage) {
        return lastNonBlankPage;
    }
    return pages.at(-1);
}
function getConnectionCloser(browser) {
    const maybeBrowser = browser;
    return maybeBrowser._connection?.close?.bind(maybeBrowser._connection);
}
async function withTimeout(label, promise, timeoutMs) {
    if (!timeoutMs || timeoutMs <= 0) {
        return promise;
    }
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    reject(new PlaywrightSessionTimeoutError(label, timeoutMs));
                }, timeoutMs);
                timer.unref?.();
            }),
        ]);
    }
    finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}
async function closePageBestEffort(page, timeoutMs) {
    try {
        await withTimeout(`page.close(${page.url() || "about:blank"})`, page.close({ runBeforeUnload: false }), timeoutMs);
        return true;
    }
    catch {
        return false;
    }
}
export async function withConnectedPage(cdpUrl, run, options = {}) {
    const browser = await withTimeout(`chromium.connectOverCDP(${cdpUrl})`, chromium.connectOverCDP(cdpUrl), options.connectTimeoutMs ?? 15_000);
    const forceDisconnect = getConnectionCloser(browser);
    let selectedPage;
    let operationTimedOut = false;
    try {
        const context = browser.contexts()[0] ?? (await browser.newContext({ ignoreHTTPSErrors: true }));
        const page = options.freshPage
            ? await context.newPage()
            : pickPreferredPage(browser.contexts(), options.preferredUrl) ??
                context.pages()[0] ??
                (await context.newPage());
        selectedPage = page;
        return await withTimeout(`withConnectedPage(${page.url() || options.preferredUrl || cdpUrl})`, run(page), options.operationTimeoutMs);
    }
    catch (error) {
        if (error instanceof PlaywrightSessionTimeoutError) {
            operationTimedOut = true;
        }
        throw error;
    }
    finally {
        if (operationTimedOut) {
            forceDisconnect?.();
        }
        else {
            let cleanupFailed = false;
            if (options.cleanupRegularPages) {
                const pages = browser.contexts().flatMap((context) => context.pages());
                for (const page of pages) {
                    const url = page.url();
                    if (!isEphemeralRegularPage(url)) {
                        continue;
                    }
                    const closed = await closePageBestEffort(page, options.pageCloseTimeoutMs ?? 2_000);
                    if (!closed) {
                        cleanupFailed = true;
                    }
                }
            }
            else if (selectedPage && isEphemeralRegularPage(selectedPage.url())) {
                const closed = await closePageBestEffort(selectedPage, options.pageCloseTimeoutMs ?? 2_000);
                if (!closed) {
                    cleanupFailed = true;
                }
            }
            try {
                await withTimeout("browser.close", browser.close(), options.browserCloseTimeoutMs ?? 2_000);
            }
            catch {
                cleanupFailed = true;
            }
            if (cleanupFailed) {
                forceDisconnect?.();
            }
        }
    }
}
export { PlaywrightSessionTimeoutError };
