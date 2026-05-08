# OpenEMR Flexibility Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenEMR as a second real EMR UI target and make run summaries/viewer labels clearly show which destination target ran.

**Architecture:** Keep the existing parser, validation, orchestrator, audit store, and viewer artifact contract intact. Add OpenEMR behind the existing `TargetAdapter` interface, extend target schemas/configuration, and derive readable target labels from run metadata/counts for summary headings and viewer sidebar titles.

**Tech Stack:** TypeScript, Node.js, Commander, Zod, Playwright, Vitest, local Markdown/audit viewer.

---

### Task 1: Target Identity In Reports And Viewer

**Files:**
- Modify: `src/audit/summary.ts`
- Modify: `src/viewer/artifactService.ts`
- Modify: `src/viewer/server.ts`
- Test: `tests/audit/auditStore.test.ts`
- Test: `tests/viewer/artifactService.test.ts`
- Test: `tests/viewer/server.test.ts`

- [ ] **Step 1: Write failing tests**

Add assertions that `renderSummary` and `renderExecutiveSummary` include a visible destination label such as `Destination target: OpenMRS (openmrs)`. Add artifact service assertions that a run with `targets: ["openmrs"]` returns a display name containing `OpenMRS`. Add server script assertions that the sidebar renders `run.displayName`.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```sh
npm test tests/audit/auditStore.test.ts tests/viewer/artifactService.test.ts tests/viewer/server.test.ts
```

Expected: tests fail because destination labels and `displayName` do not exist yet.

- [ ] **Step 3: Implement target label helpers**

Add a target label map for `openmrs`, `openemr`, and `fake`. Use it in summary headings, outcome metadata, target counts, record-review headings, and viewer run display names. Keep fallback behavior for unknown target strings in old artifacts.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```sh
npm test tests/audit/auditStore.test.ts tests/viewer/artifactService.test.ts tests/viewer/server.test.ts
```

Expected: selected tests pass.

### Task 2: OpenEMR Configuration And CLI Wiring

**Files:**
- Modify: `src/domain/schema.ts`
- Modify: `src/config.ts`
- Modify: `src/cli.ts`
- Test: `tests/config.test.ts`
- Test: `tests/cli.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests that `parseTargets("openemr")` succeeds, OpenEMR default config is populated, OpenEMR environment overrides are read, and the CLI can run against `--targets openemr` with mocked dependencies or a lightweight adapter path.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```sh
npm test tests/config.test.ts tests/cli.test.ts
```

Expected: tests fail because `openemr` is not in `TargetNameSchema` and no config exists.

- [ ] **Step 3: Implement config and CLI wiring**

Extend `TargetNameSchema`, add OpenEMR config defaults and environment parsing, import `OpenEmrAdapter`, and instantiate it from `buildAdapters`.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```sh
npm test tests/config.test.ts tests/cli.test.ts
```

Expected: selected tests pass.

### Task 3: OpenEMR Adapter

**Files:**
- Create: `src/targets/openemr/selectors.ts`
- Create: `src/targets/openemr/openEmrAdapter.ts`
- Test: `tests/targets/openEmrAdapter.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Add tests for successful patient creation, environment prepare failure, agent navigation rejection, missing required field selectors, duplicate/save error detection, screenshot evidence, and field mapping evidence.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```sh
npm test tests/targets/openEmrAdapter.test.ts
```

Expected: tests fail because the OpenEMR adapter files do not exist.

- [ ] **Step 3: Implement the adapter**

Implement a Playwright-backed adapter with low default concurrency. Use deterministic field mappings from `NormalizedIntakeRecord`, bounded agent approval for navigation, ordered screenshots, field mapping evidence, target evidence, and target exceptions for changed UI or duplicate/save errors.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```sh
npm test tests/targets/openEmrAdapter.test.ts
```

Expected: selected tests pass.

### Task 4: Documentation And Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/demo.md`
- Modify: `docs/superpowers/specs/2026-05-08-openemr-flexibility-demo-design.md`

- [ ] **Step 1: Update docs**

Document the two-command OpenMRS/OpenEMR demo with the same intake file and
neutral destination-flexibility wording. Remove external comparison language
from the design spec because that positioning is an internal goal, not a
documentation claim.

- [ ] **Step 2: Run required verification**

Run:

```sh
npm run typecheck
npm test
git diff --check
```

Expected: all commands pass.
