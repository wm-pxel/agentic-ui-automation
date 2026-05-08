# OpenEMR Flexibility Demo Design

## Summary

Add a second real EMR web target, OpenEMR, so the demo can run the same
synthetic intake file through OpenMRS first and OpenEMR second with only the
destination target changed.

The goal is to prove that the workflow is not tightly coupled to one EMR screen
flow. Parsing, deterministic validation, normalized records, orchestration,
agent decision boundaries, audit artifacts, and the local viewer remain the
same. Only the destination web app adapter changes.

## Goals

- Demonstrate destination flexibility with two sequential commands.
- Use the same synthetic intake source file for both runs.
- Keep the process identical except for `--targets openmrs` versus
  `--targets openemr`.
- Preserve the existing target adapter contract and audit artifact contract.
- Record OpenEMR screenshots, target evidence, field mappings, exceptions, and
  target counts in the same run artifact structure used by OpenMRS.
- Position the demo as a concrete destination-flexibility proof: the workflow
  contract stays fixed while one target adapter changes.

## Non-Goals

- Do not build a generic EMR abstraction layer beyond the existing target
  adapter contract.
- Do not use OpenEMR APIs or FHIR endpoints for patient creation; the demo must
  remain last-mile UI automation.
- Do not change the intake parser, validation schema, orchestrator, audit store,
  Electron intake app, handoff watcher, or viewer behavior unless a target name
  allowlist or documentation update requires it.
- Do not enter real patient data or PHI into OpenMRS, OpenEMR, fixtures, logs,
  screenshots, or audit artifacts.
- Do not delete patients or mutate shared demo configuration to reset either
  public demo environment.

## Demo Commands

The demo uses the same input and run settings for both targets:

```sh
npm run dev -- run \
  --input data/demo/intake-records.json \
  --targets openmrs \
  --runs-dir runs \
  --synthetic-suffix auto
```

Then:

```sh
npm run dev -- run \
  --input data/demo/intake-records.json \
  --targets openemr \
  --runs-dir runs \
  --synthetic-suffix auto
```

The command pair is the demo centerpiece. If the OpenAI parser or UI agent is
enabled for one command, it should be enabled for both commands. If the
deterministic parser is used for a no-API-key smoke run, it should be used for
both commands. The only intentional difference is the target web app.

## Approaches Considered

### Recommended: Add A Real OpenEMR Target Adapter

Add `openemr` as another `TargetAdapter`, parallel to `openmrs`. This keeps the
existing architecture honest: the orchestration and audit layers do not know
which EMR screen flow is running beyond the target name.

This approach gives the strongest demo because OpenEMR has a different UI,
different navigation model, and different field layout from OpenMRS. It also
uses an official hosted demo with listed credentials and nightly reset behavior,
which makes repeatable synthetic demos practical.

### Alternative: Re-Skin Or Perturb OpenMRS

Create a modified local or test OpenMRS flow to simulate UI drift. This would be
faster to control but weaker as a sales or technical proof because it still
looks like one destination product. It demonstrates selector resilience more
than destination flexibility.

### Alternative: Use The Existing Fake Target

Run OpenMRS and `fake` from the same input file. This already proves
orchestration separation, but it does not address the user's concern about a
destination EMR UI changing because the fake target is not a real clinical web
application.

## Architecture

Add a new target package:

```text
src/targets/openemr/
  openEmrAdapter.ts
  selectors.ts
```

The new adapter implements the existing contract:

```ts
interface TargetAdapter {
  readonly name: TargetName;
  readonly maxConcurrency?: number;
  prepare(context?: TargetPrepareContext): Promise<void>;
  runRecord(context: TargetRunContext): Promise<TargetAdapterResult>;
  close(): Promise<void>;
}
```

No orchestrator contract changes are needed. The existing workflow already:

- prepares each target;
- validates raw source records once;
- writes normalized records once;
- runs each ready target adapter;
- counts target results by target name;
- writes exceptions and target evidence through the shared audit store;
- finalizes `run.json`, `summary.md`, `report.json`, `events.jsonl`, and
  screenshot artifacts.

The code changes should stay mostly in target wiring:

- extend `TargetNameSchema` to include `openemr`;
- add OpenEMR configuration to CLI config;
- add `--openemr-*` options only where OpenEMR-specific settings are required;
- instantiate `OpenEmrAdapter` from `buildAdapters`;
- add tests for config parsing, CLI target selection, and adapter behavior.

## OpenEMR Configuration

Default OpenEMR demo values should follow the current official OpenEMR demo
page:

- Default app URL: `https://demo.openemr.io/openemr`
- Default username: `admin`
- Default password: `pass`

The OpenEMR project also publishes alternate demo URLs. Documentation should
tell operators to check `https://www.open-emr.org/demo/` before assuming the
adapter is broken, because public demo credentials, versions, and availability
can change.

Recommended environment variables:

- `OPENEMR_BASE_URL`
- `OPENEMR_USERNAME`
- `OPENEMR_PASSWORD`
- `OPENEMR_CONCURRENCY`

OpenEMR concurrency should default low for public demos. A default of `1` is the
safest initial behavior until the adapter proves that concurrent browser
sessions do not interfere with each other in the shared demo.

## OpenEMR Adapter Behavior

For each valid normalized record, the OpenEMR adapter should:

1. Open a browser session and log in to OpenEMR.
2. Capture a `before-navigation` screenshot.
3. Navigate to the patient creation workflow.
4. Fill demographic and contact fields that OpenEMR exposes in the selected
   registration flow.
5. Capture an `after-fill` screenshot.
6. Save the patient through the UI.
7. Detect duplicate, validation, or save errors as target exceptions.
8. Navigate to or verify the newly created patient record when practical.
9. Capture an `after-save` proof screenshot.
10. Write field mapping evidence using the same report shape as OpenMRS.

OpenEMR field mappings should be deterministic TypeScript mappings from the
existing `NormalizedIntakeRecord` fields to OpenEMR labels, inputs, selectors,
and transform functions. The OpenAI UI agent may approve bounded navigation or
field-entry steps in the same style as OpenMRS, but the adapter should not rely
on unconstrained prompt output to decide arbitrary browser actions.

If OpenEMR has no visible field for part of the normalized record, such as an
insurance field in the selected first-pass registration screen, the adapter
should mark that mapping as unavailable or skipped in target evidence without
failing the record, unless the field is required for the demo's stated success
criteria.

## Data Flow

Both demo commands follow the same data path:

1. Load `data/demo/intake-records.json`.
2. Parse source records with the selected parser.
3. Apply `--synthetic-suffix auto` to valid synthetic records.
4. Validate and normalize records deterministically.
5. Write `input/normalized-records.json`.
6. Run exactly one target adapter, either OpenMRS or OpenEMR.
7. Ask the configured UI agent only for bounded target decisions.
8. Write screenshots, events, target evidence, exceptions, and summaries.
9. Review both runs in the same local viewer.

This makes the demo comparison concrete: the second run is not a different
pipeline. It is the same pipeline pointed at a different destination web app.

## Audit Contract

The OpenEMR target must preserve the existing audit artifact contract:

- `run.json`
- `summary.md`
- `report.json`
- `events.jsonl`
- `input/normalized-records.json`
- `exceptions/`
- `screenshots/`

Target-specific evidence should use `target: "openemr"` and the same field
mapping concepts used by OpenMRS where possible:

- source field;
- target field;
- value written or attempted;
- selected selector or target locator detail;
- mapping confidence;
- mapping status;
- screenshot path when relevant;
- exception code and remediation when a field or save step fails.

The viewer should not need OpenEMR-specific behavior to show the run. If useful
summary wording changes are needed, they should remain generic enough for all
targets.

## Error Handling

OpenEMR public demo failures should be contained to target-level exceptions:

- login failure becomes `environment_not_ready` during `prepare`;
- changed navigation, missing controls, modal interruptions, or unexpected
  page states become `ui_state_unexpected`;
- duplicate patient prompts become `possible_duplicate`;
- inability to verify saved patient details becomes `verification_failed`.

The workflow should still write a complete audit package even when OpenEMR is
unavailable or the UI changes. This is part of the demo story: failures are
auditable and bounded rather than silent.

## Documentation

Update `README.md` and `docs/demo.md` with a dedicated flexibility demo
section:

- state the two-command script;
- state that both commands use the same synthetic input file;
- list the only intentional difference as `--targets openmrs` versus
  `--targets openemr`;
- include the OpenMRS and OpenEMR demo links and credentials;
- warn that public demo URLs and credentials can change;
- tell operators not to reset shared demo state by deleting patients;
- tell operators to use `--synthetic-suffix auto`.

The docs should describe the comparison as destination flexibility, not as a
claim that every EMR can be supported with zero work. The accurate claim is
that the stable workflow and audit contract isolate the change to a target
adapter.

## Testing

Add unit tests and adapter tests before relying on live smoke:

- `TargetNameSchema` accepts `openemr`.
- CLI config parses `--targets openemr`.
- `buildAdapters` creates an OpenEMR adapter for `openemr`.
- OpenEMR config reads defaults and environment overrides.
- OpenEMR login/navigation failures become environment or target exceptions.
- OpenEMR field mappings transform normalized records correctly.
- Successful OpenEMR record creation writes ordered screenshots and target
  evidence.
- OpenEMR duplicate or save-error states become target exceptions with
  remediation text.
- Summary/report tests include OpenEMR target counts without target-specific
  viewer changes.

Live smoke testing should use the public OpenEMR demo only with synthetic data.
If the public demo is down, modified, or using changed credentials, verify the
current OpenEMR demo page before treating the adapter as broken.

Before claiming implementation complete, run:

```sh
npm run typecheck
npm test
git diff --check
```

## Acceptance Criteria

- The OpenMRS command and OpenEMR command use the same intake file and same
  non-target options.
- The OpenEMR implementation is isolated behind the existing target adapter
  contract.
- Both runs write the existing audit artifact set under `runs/<run-id>/`.
- The local viewer can display both runs without OpenEMR-specific routes.
- Documentation gives a concise demo script and a defensible
  destination-flexibility explanation.
- No real patient data or PHI is introduced anywhere in the repository,
  generated artifacts, logs, screenshots, or demo instructions.
