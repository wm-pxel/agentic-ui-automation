# Agent Notes

## Data Safety

Use synthetic/demo data only. Do not put real patient data or PHI into OpenMRS,
fixtures, logs, screenshots, audit artifacts, or generated test inputs.

## OpenMRS Demo Environment

OpenMRS publishes demo links at `https://openmrs.org/demo/`. This repo's
OpenMRS profile is executed by the generic AI web runner against the OpenMRS 2
Reference Application demo flow because the current OpenMRS 3 public demo can
render a blank SPA home page before login.

- Default app URL: `https://o2.openmrs.org/openmrs/login.htm`
- Default username: `admin`
- Default password: `Admin123`
- Default location: `Registration Desk`
- Default OpenMRS record concurrency: `1`

If the OpenMRS demo is broken, stale, or returns unexpected UI/database errors during
automation testing, verify the current links and credentials on
`https://openmrs.org/demo/` before assuming the profile or runner is broken.

Do not reset shared OpenMRS demo state by deleting patients. Patient deletion is
gated behind a global admin setting and mutates shared demo configuration. For
repeatable OpenMRS smoke runs, use `--synthetic-suffix auto` so each run creates
fresh synthetic patient names and identifiers.

OpenMRS data entry is bounded-concurrent. Keep `OPENMRS_CONCURRENCY` and
`--openmrs-concurrency` low for shared public demos so runs remain auditable and
do not overload the demo environment.

Destination demos may not expose every normalized intake field. Extra intake
fields that are not available in the target UI are acceptable and should be
recorded as `no_matching_destination_field` audit mappings, not target
exceptions. If a wizard step only contains controls for unsupported optional
data, continue to the next/save action when the observed controls make that
safe.

When OpenMRS selectors, profile field guidance, planner behavior, or navigation
behavior change, update the current generic target coverage in
`tests/targets/profiles.test.ts`, `tests/targets/aiWebTargetRunner.test.ts`,
`tests/targets/aiWebPlanner.test.ts`, `tests/targets/browserActions.test.ts`,
and `tests/targets/pageObservation.test.ts`, and keep report field mappings
useful for manual audit review.

## Audit Contract

Audit artifacts are part of the workflow contract. Preserve these outputs unless
the README and tests are updated in the same change:

- `run.json`
- `summary.md`
- `report.json`
- `events.jsonl`
- `input/normalized-records.json`
- `exceptions/`
- `screenshots/`

## Documentation

Keep `README.md` and `docs/demo.md` current when CLI behavior, target behavior,
audit artifacts, OpenMRS reset strategy, or manual validation steps change. When
workflow architecture or data flow changes, also update the `README.md`
Architecture and Data Flow sections so they reflect the current parser,
orchestrator, agent, target profile, generic AI web runner, audit artifact, and
technology boundaries.

## Verification

Before claiming a repo change is complete, run:

```sh
npm run typecheck
npm test
git diff --check
```

For changes that affect demo workflow behavior, watcher handoff, Electron
intake export, target profiles, AI web target navigation, or viewer demo
readiness, also verify the full E2E path with both live destination targets:

1. Start the full watcher/Electron/viewer stack in watcher mode:

   ```sh
   set -a
   . ./.env
   set +a
   npm run dev:all -- --targets openmrs,openkairo --intake-trigger watcher --confidence-threshold .97
   ```

2. In the Electron intake app, create one synthetic/demo patient, export only
   that patient, and let the watcher trigger the run from the exported handoff
   file. Do not replace this with a direct `run --input ...` smoke when the
   request is demo-readiness or E2E verification.
3. Inspect the generated `run.json`, `exceptions/`, `events.jsonl`,
   `summary.md`, and `executive-summary.md`. Both OpenMRS and OpenKairo target
   counts should show `succeeded: 1`, `exception: 0`, and the viewer should
   render the completed run cleanly.

If the requested demo path is target-by-target, run the same watcher/Electron
flow separately for OpenMRS first and OpenKairo second:

```sh
npm run dev:all -- --targets openmrs --intake-trigger watcher --confidence-threshold .97
npm run dev:all -- --targets openkairo --intake-trigger watcher --confidence-threshold .97
```

Do not treat a simultaneous `openmrs,openkairo` run as a substitute for an
explicit sequential verification request.
