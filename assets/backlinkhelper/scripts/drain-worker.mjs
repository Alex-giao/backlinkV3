#!/usr/bin/env node

console.error([
  "drain-worker is disabled for live site execution.",
  "Reason: the old implementation delegated claimed tasks into tmp-hermes-batch-rerun.mjs, which hardcoded site-flow decisions and violated the V3 operator philosophy.",
  "Use the operator path instead:",
  "claim-next-task -> task-prepare -> operator reasoning -> task-record-agent-trace -> task-finalize.",
].join("\n"));
process.exit(1);
