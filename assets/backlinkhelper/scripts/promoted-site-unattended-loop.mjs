// Generic promoted-site watchdog loop.
// Reuses the legacy suika loop implementation, which is now parameterized by
// BACKLINKHELPER_PROMOTED_URL / BACKLINKHELPER_WATCHDOG_NAME.
process.env.BACKLINKHELPER_WATCHDOG_NAME ??= 'promoted-site-unattended-loop';
await import('./suika-unattended-loop.mjs');
