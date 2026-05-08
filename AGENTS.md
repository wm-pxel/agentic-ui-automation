# Agent Notes

## Data Safety

Use synthetic/demo data only. Do not put real patient data or PHI into OpenMRS,
fixtures, logs, screenshots, audit artifacts, or generated test inputs.

## OpenMRS Demo Environment

OpenMRS publishes demo links at `https://openmrs.org/demo/`. This repo's
OpenMRS profile is executed by the generic AI web runner against the OpenMRS 2
Reference Application registration flow because the workflow creates synthetic
patient-registration audit artifacts.

- Default app URL: `https://o2.openmrs.org/openmrs`
- Default username: `admin`
- Default password: `Admin123`
- Default location: `Registration Desk`
- Default OpenMRS record concurrency: `2`

If the O2 demo is broken, stale, or returns unexpected UI/database errors during
automation testing, verify the current links and credentials on
`https://openmrs.org/demo/` before assuming the adapter is broken.

Do not reset shared OpenMRS demo state by deleting patients. Patient deletion is
gated behind a global admin setting and mutates shared demo configuration. For
repeatable OpenMRS smoke runs, use `--synthetic-suffix auto` so each run creates
fresh synthetic patient names and identifiers.

OpenMRS data entry is bounded-concurrent. Keep `OPENMRS_CONCURRENCY` and
`--openmrs-concurrency` low for shared public demos so runs remain auditable and
do not overload the demo environment.

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
