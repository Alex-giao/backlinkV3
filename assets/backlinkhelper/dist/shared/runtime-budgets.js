export const BOUNDED_WORKER_RUNTIME_BUDGET_MS = 10 * 60 * 1_000;
export const BOUNDED_WORKER_LEASE_GRACE_MS = 2 * 60 * 1_000;
export const BOUNDED_WORKER_LEASE_TTL_MS = BOUNDED_WORKER_RUNTIME_BUDGET_MS + BOUNDED_WORKER_LEASE_GRACE_MS;
// Reserve time inside the bounded worker budget for preflight, scout, trace recording,
// and Playwright finalization. The interactive agent loop should stop before the lease window.
export const AGENT_LOOP_RUNTIME_BUDGET_MS = 8 * 60 * 1_000;
