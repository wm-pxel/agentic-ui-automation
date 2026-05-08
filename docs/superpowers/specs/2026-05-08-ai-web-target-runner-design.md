# AI Web Target Runner Design

## Summary

Replace destination-specific UI adapters with one generic AI-driven web target
runner. OpenMRS and OpenEMR become target profiles instead of screen-scripted
adapters. The workflow still starts from synthetic intake data, validates into
the normalized patient schema, runs a destination web app, and writes the same
audit package, but live UI interaction is discovered and planned by AI at
runtime.

This change is specifically meant to demonstrate flexibility when the
destination EMR UI differs or changes. The demo should run OpenMRS first, then
OpenEMR second, using the same intake file and the same workflow path. The
destination profile changes; the web runner does not.

## Goals

- Delete destination-specific UI adapters for OpenMRS and OpenEMR.
- Replace selector maps and fixed page-flow scripts with a generic AI web
  operator.
- Keep target naming clear in viewer sidebar titles, `executive-summary.md`,
  `summary.md`, `run.json`, and `report.json`.
- Preserve synthetic/demo-data-only safety.
- Preserve deterministic validation and normalized input artifacts.
- Preserve the audit contract:
  - `run.json`
  - `summary.md`
  - `report.json`
  - `events.jsonl`
  - `input/normalized-records.json`
  - `exceptions/`
  - `screenshots/`
- Keep all browser actions bounded, observable, and auditable.
- Make OpenMRS and OpenEMR differ only by target profile and runtime page
  observations, not separate adapter code.

## Non-Goals

- Do not use OpenMRS or OpenEMR backend APIs for patient creation.
- Do not require stable selectors, known section buttons, or hard-coded form
  flows for OpenMRS or OpenEMR.
- Do not store real patient data or PHI in fixtures, logs, screenshots, prompts,
  or generated artifacts.
- Do not promise perfect support for arbitrary web apps without credentials,
  reachable UI, and enough visible semantics for AI to operate safely.
- Do not let AI perform unbounded actions such as deleting records, changing
  admin configuration, exporting data, or modifying shared demo settings.

## Architecture

Remove the current adapter concept as the execution boundary:

```text
src/adapters/contract.ts
src/adapters/fakeAdapter.ts
src/targets/openmrs/openMrsAdapter.ts
src/targets/openmrs/selectors.ts
src/targets/openemr/openEmrAdapter.ts
src/targets/openemr/selectors.ts
```

Replace it with:

```text
src/targets/profiles.ts
src/targets/aiWebTargetRunner.ts
src/targets/aiWebPlanner.ts
src/targets/browserActions.ts
src/targets/pageObservation.ts
```

The orchestrator no longer receives `TargetAdapter[]`. It receives
`TargetProfile[]` plus a generic target runner. A profile is data, not code that
knows a UI flow.

```ts
interface TargetProfile {
  name: TargetName;
  displayName: string;
  baseUrl: string;
  credentials: {
    username: string;
    password: string;
  };
  task: string;
  successCriteria: string[];
  forbiddenActions: string[];
  concurrency: number;
}
```

Example OpenMRS profile:

```ts
{
  name: "openmrs",
  displayName: "OpenMRS",
  baseUrl: "https://o2.openmrs.org/openmrs",
  credentials: { username: "admin", password: "Admin123" },
  task: "Create or register one synthetic patient from the normalized intake record.",
  successCriteria: [
    "A saved patient detail page or dashboard is visible.",
    "The page shows the synthetic patient name.",
    "A proof screenshot can be captured after save."
  ],
  forbiddenActions: [
    "Do not delete patients.",
    "Do not change admin settings.",
    "Do not use real patient data."
  ],
  concurrency: 1
}
```

OpenEMR has the same shape with OpenEMR URL, credentials, and display name.

## AI Web Runner

`AiWebTargetRunner` is the only live web target implementation. For each valid
normalized record, it:

1. Launches a browser.
2. Navigates to the target profile URL.
3. Observes the page with screenshots, visible text, URLs, forms, buttons,
   links, labels, inputs, selects, and accessibility-like metadata.
4. Asks the AI planner for the next bounded action.
5. Executes only actions from an allowlist.
6. Captures event logs and screenshots.
7. Repeats observe -> plan -> act until success, controlled exception, or step
   budget exhaustion.
8. Verifies the saved patient using target profile success criteria.
9. Writes target evidence and field mapping evidence.

The runner does not know OpenMRS selectors, OpenEMR selectors, hidden section
names, or save button labels in advance.

## Bounded Action Model

The AI planner may choose only from structured actions:

```ts
type AiWebAction =
  | { type: "fill"; elementId: string; field: string; value: string; rationale: string }
  | { type: "select"; elementId: string; field: string; value: string; rationale: string }
  | { type: "click"; elementId: string; purpose: string; rationale: string }
  | { type: "wait"; reason: string }
  | { type: "screenshot"; label: string }
  | { type: "verify"; criteria: string; rationale: string }
  | { type: "stop"; code: "ui_state_unexpected" | "possible_duplicate" | "verification_failed"; message: string };
```

The planner never returns raw Playwright code or arbitrary JavaScript. Browser
execution resolves `elementId` values from the current observation snapshot.
When the page changes, old element IDs expire.

## Page Observation

Each step produces an observation snapshot:

- current URL;
- page title;
- visible text excerpt;
- screenshot path;
- discovered forms and controls;
- visible buttons, links, tabs, and section controls;
- labels and nearby text for inputs/selects/textareas;
- values already filled;
- modal/dialog state;
- validation or duplicate-warning text.

The observation layer may use DOM and accessibility metadata, but it should
return semantic descriptions, not hard-coded target selectors. The planner sees
stable temporary element IDs like `control-17`, not selector recipes.

## Field Matching

The runner gives the planner the normalized intake record and a field inventory:

- `firstName`
- `lastName`
- `dateOfBirth`
- `sexOrGender`
- `phone`
- `email`
- `streetAddress`
- `city`
- `state`
- `zip`
- `insurancePayer`
- `insuranceMemberId`
- `insuranceGroupId`
- `reasonForVisit`
- `preferredContactMethod`
- `notes`

The planner decides which visible or discoverable controls correspond to those
fields. If a field is hidden behind a section, tab, accordion, menu, or wizard
step, the planner should choose a bounded click action to reveal the likely
section before filling the field.

Required patient-creation fields are filled first. Optional fields are filled
when reasonably discoverable. Missing optional fields become audited skipped
field mappings, not target failures. Missing required fields, duplicate prompts,
or inability to verify save become target exceptions.

## Audit And Reports

The run artifacts remain the external contract. The report details change from
selector-centric mapping evidence to AI action and field-resolution evidence:

- source field;
- normalized value;
- target display field inferred by AI;
- action type;
- element description at the time of action;
- AI confidence;
- AI rationale;
- status: `succeeded`, `skipped`, or `failed`;
- screenshot path;
- verification evidence.

`summary.md` and `executive-summary.md` must show the destination target in the
heading and outcome table. The viewer sidebar must show target-aware run names,
for example:

- `OpenMRS - run-...`
- `OpenEMR - run-...`

## CLI

The demo commands remain intentionally similar:

```sh
npm run dev -- run \
  --input data/demo/intake-records.json \
  --targets openmrs \
  --runs-dir runs \
  --synthetic-suffix auto
```

```sh
npm run dev -- run \
  --input data/demo/intake-records.json \
  --targets openemr \
  --runs-dir runs \
  --synthetic-suffix auto
```

The CLI still accepts target names so run artifacts and profiles stay clear, but
`--targets openmrs` and `--targets openemr` both use the same
`AiWebTargetRunner`.

The fake target should be replaced by a non-EMR dry-run mode or a local profile
that exercises orchestration and audit without pretending to be a destination
adapter. The important architectural rule is that no target-specific UI
automation class remains.

## Error Handling

The runner stops a record with an audited target exception when:

- login fails;
- AI cannot identify a safe next action;
- the page asks for destructive or out-of-policy action;
- a required field cannot be found or filled within the step budget;
- a duplicate or possible-duplicate prompt appears;
- save fails or validation blocks the form;
- success criteria cannot be verified.

Each exception includes:

- target name;
- record ID;
- current URL;
- latest screenshot;
- AI rationale;
- step count;
- suggested remediation.

## Testing

Use test doubles for the AI planner and browser page snapshots. Do not depend
on live OpenMRS or OpenEMR for unit tests.

Required tests:

- profile parsing loads OpenMRS and OpenEMR defaults.
- CLI maps `openmrs` and `openemr` to profiles, not adapters.
- orchestrator runs target profiles through the generic runner.
- generic runner executes bounded fill/select/click/wait/verify actions.
- stale element IDs are rejected after a page observation changes.
- forbidden action requests become target exceptions.
- optional missing fields become skipped mappings.
- required missing fields become target exceptions.
- duplicate prompts become `possible_duplicate`.
- successful run writes target-aware executive summary, summary, report JSON,
  events, screenshots, and normalized input.
- OpenMRS and OpenEMR smoke commands use the same runner code path.

Live smoke remains a manual verification step after unit tests pass because
public demo EMR sites can change or be unavailable.

## Migration Plan

1. Add target profiles and the generic AI web runner behind tests.
2. Update orchestrator inputs from `TargetAdapter[]` to `TargetProfile[]` plus
   runner dependency.
3. Update CLI target construction to return profiles.
4. Replace fake adapter tests with runner/profile tests.
5. Delete destination-specific adapter and selector files.
6. Update docs and demo instructions.
7. Run the two-command OpenMRS/OpenEMR smoke and compare artifacts in the
   viewer.

Before claiming implementation complete, run:

```sh
npm run typecheck
npm test
git diff --check
```
