# Task 2: V3 从目录站扩展到多网站类型 Implementation Plan

> For Hermes: 按 TDD 执行；每个任务先补 failing test，再做最小实现，再跑回归。

Goal: 在不破坏现有 directory 路径的前提下，把 V3 从“目录站默认语义”进一步泛化为“多 family 共用内核 + family config 驱动”的执行底座。

Architecture: 第一件事已经完成了 prompt / decider / visual 层的 family-aware 收口。第二件事不再碰这层，而是继续清理剩余的 directory 偏置：先收 completeness/init-gate/task-progress 的命名与语义，再收 CLI/README 的输入面与示例面。策略是“兼容优先、增量泛化”——先增加 neutral 字段/别名，再让调用方逐步切到新语义，避免一次性硬断裂。

Tech Stack: TypeScript, Node test runner (`node --test`), repo-native CLI (`corepack pnpm ...`), existing family config under `src/families/`.

---

## Scope / Non-Goals

In scope:
- 清理 remaining directory 偏置
- 让 readiness / preflight / execution-state / docs 与多 family 语义一致
- 保持 `saas_directory`、`forum_profile`、`wp_comment`、`dev_blog` 都可被同一套内核承载

Out of scope:
- 新增更多 family
- 重写已完成的 decider / visual prompt family-aware 工作
- 改动 queue / lease / finalize 主生命周期

---

## Task 1: Neutralize completeness / readiness semantics

Objective: 把 `directory_ready*` 这一套命名改造成 family-neutral / flow-neutral 语义，避免第二件事继续建立在目录站词汇上。

Files:
- Modify: `src/families/types.ts`
- Modify: `src/families/saas-directory.ts`
- Modify: `src/families/non-directory.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/shared/missing-inputs.ts`
- Modify: `src/control-plane/init-gate.ts`
- Test: `src/shared/missing-inputs.test.ts`
- Test: `src/control-plane/init-gate.test.ts`
- Test: `src/families/index.test.ts`

Step 1: Write failing tests
- Add tests asserting new neutral readiness fields exist and are used preferentially.
- Add tests asserting non-directory families no longer report readiness via a `directory_*` mental model.
- Keep one compatibility test proving old field names still deserialize / still work during transition if you choose additive migration.

Suggested test targets:
- `summarizeMissingInputPreflight uses family/flow readiness naming instead of directory naming`
- `evaluateInitGate summary does not mention directory when current family is forum_profile`
- `saas_directory can still require extra flow-specific fields without forcing other families into directory wording`

Step 2: Run targeted tests to verify RED
Run:
- `corepack pnpm test -- --test-name-pattern "summarizeMissingInputPreflight|evaluateInitGate|resolveFlowFamily|forum_profile family config"`
Expected: FAIL because the implementation still centers `directory_ready`, `missing_directory_fields`, and directory-specific summaries.

Step 3: Implement minimal migration
Recommended implementation pattern:
- In `src/families/types.ts`, rename the conceptual slot from `directory_ready_fields` to a neutral name such as `flow_ready_fields` or `family_ready_fields`.
- In `src/shared/types.ts`, add neutral readiness fields to `MissingInputCompleteness`.
- In `src/shared/missing-inputs.ts`, compute the neutral fields first; if backward compatibility is needed, mirror them into legacy `directory_*` aliases for one transition window.
- In `src/control-plane/init-gate.ts`, replace hardcoded summary text `core and directory readiness checks` with family/flow-neutral wording.

Step 4: Run targeted tests to verify GREEN
Run:
- `corepack pnpm test -- --test-name-pattern "summarizeMissingInputPreflight|evaluateInitGate|resolveFlowFamily|forum_profile family config"`
Expected: PASS.

Step 5: Run broader regression
Run:
- `corepack pnpm test -- --test-name-pattern "missing-input|init-gate|family|forum_profile"`
Expected: PASS with no breakage in existing directory behavior.

---

## Task 2: Neutralize execution-state fragment naming and next-action semantics

Objective: 把 `execution_state` / `reusable_fragments` 中残留的 listing/directory 心智收成 neutral naming，避免多 family 共享状态层时被目录站词汇污染。

Files:
- Modify: `src/shared/task-progress.ts`
- Possibly modify: `src/shared/types.ts`
- Test: `src/shared/task-progress.test.ts`

Step 1: Write failing tests
- Add tests asserting non-directory flows produce neutral fragment IDs / summaries.
- Add tests asserting forum_profile or wp_comment does not inherit `listing_form` naming.

Suggested test targets:
- `task progress emits neutral form fragment id for forum_profile`
- `task progress keeps submit surface semantics but not listing-specific fragment names`

Step 2: Run tests to verify RED
Run:
- `corepack pnpm test -- --test-name-pattern "task progress|trace update|forum_profile"`
Expected: FAIL because `frag_listing_form_v1` is still emitted.

Step 3: Implement minimal rename
Recommended implementation:
- Replace `frag_listing_form_v1` with a neutral fragment name such as `frag_primary_form_surface_v1`.
- Audit any string summaries / `recommended_next_actions` that still imply directory-only listing behavior.
- Keep `frag_submit_surface_v1` only if it truly remains family-neutral; otherwise split into neutral/family-aware IDs.

Step 4: Run tests to verify GREEN
Run:
- `corepack pnpm test -- --test-name-pattern "task progress|trace update|forum_profile"`
Expected: PASS.

Step 5: Verify no hidden consumers broke
Run:
- `corepack pnpm test -- --test-name-pattern "task progress|business outcome|finalization|retry decision"`
Expected: PASS.

---

## Task 3: Generalize CLI input surface with backward compatibility

Objective: 让 CLI 不再只暴露 directory 语义，但不破坏现有用法和队列入口。

Files:
- Modify: `src/cli/index.ts`
- Modify: `src/cli/enqueue-site.ts`
- Possibly modify: `src/control-plane/task-queue.ts`
- Possibly modify: `src/control-plane/task-prepare.ts`
- Test: add/update CLI parsing tests if present; otherwise add focused tests near the command entrypoints

Step 1: Write failing tests
- Add tests asserting a neutral alias (for example `--target-url` / `--site-url`) is accepted and mapped identically.
- Add tests asserting `--directory-url` remains supported for compatibility.
- Add tests asserting `--flow-family forum_profile|wp_comment|dev_blog` is reflected in the created task record.

Step 2: Run tests to verify RED
Run:
- `corepack pnpm test -- --test-name-pattern "enqueue-site|task-queue|task-prepare"`
Expected: FAIL for any new neutral alias behavior you add.

Step 3: Implement minimal compatibility layer
Recommended implementation:
- Keep `--directory-url` as a legacy alias.
- Promote a neutral canonical parameter name at the parser layer.
- Avoid renaming persisted task fields unless necessary; normalize at the edge first.

Step 4: Run targeted tests to verify GREEN
Run:
- `corepack pnpm test -- --test-name-pattern "enqueue-site|task-queue|task-prepare"`
Expected: PASS.

---

## Task 4: Update README and operator-facing examples

Objective: 让文档与实际能力一致，避免 skill/runtime 已经支持多 family，但 README 仍把心智锁死在目录站。

Files:
- Modify: `README.md`
- Possibly add: `docs/ops-runbook-zh.md` or a new example doc if README becomes too crowded

Step 1: Update entry examples
At minimum:
- Keep one `saas_directory` example
- Add one `forum_profile` example
- Add one `wp_comment` or `dev_blog` example
- Explicitly show `--flow-family`

Step 2: Update wording
Replace “directory submission only” style wording with:
- bounded single-site backlink task
- family-specific flow chosen by `--flow-family`
- compatibility note for legacy `--directory-url`

Step 3: Verification
Run:
- `search_files` or manual review to ensure README examples cover all currently supported families without overstating unsupported ones.

---

## Task 5: Full regression and acceptance gate

Objective: 证明第二件事完成后，V3 真正从“目录站默认心智”升级为“多 family 共用内核”。

Files:
- No primary code file; this is the final verification pass.

Step 1: Run full suite
Run:
- `corepack pnpm test`
Expected: all tests pass.

Step 2: Spot-check remaining bias
Search for remaining problematic wording in non-test code:
- `directory_ready`
- `missing_directory_fields`
- `listing_form`
- README examples without `--flow-family`

Step 3: Acceptance checklist
Task 2 is complete only if:
- readiness/preflight naming is neutral or compatibility-wrapped
- execution-state fragments are not directory-only by default
- CLI has a neutral input surface without breaking old callers
- README clearly documents multiple supported families
- full test suite passes

---

## Suggested execution order

1. Task 1 — readiness/completeness naming
2. Task 2 — execution_state fragment naming
3. Task 3 — CLI compatibility layer
4. Task 4 — README/examples
5. Task 5 — full regression + bias scan

This order minimizes rework because:
- readiness semantics are the deepest remaining shared substrate
- execution-state naming sits above that shared substrate
- CLI/docs should reflect the final stabilized semantics, not a mid-refactor vocabulary

---

## Commands cheat sheet

Targeted tests during implementation:
- `corepack pnpm test -- --test-name-pattern "summarizeMissingInputPreflight|evaluateInitGate|resolveFlowFamily|forum_profile family config"`
- `corepack pnpm test -- --test-name-pattern "task progress|trace update|forum_profile"`
- `corepack pnpm test -- --test-name-pattern "enqueue-site|task-queue|task-prepare"`

Final verification:
- `corepack pnpm test`

---

## Risk notes

- Do not break existing `saas_directory` behavior while generalizing naming.
- Prefer additive migration for persisted/reporting types if external consumers may still read old fields.
- Do not over-generalize by removing the concept of family-specific required fields; only remove directory-specific wording from shared abstractions.
- Do not claim support for new families in README until tests and runtime semantics really cover them.
