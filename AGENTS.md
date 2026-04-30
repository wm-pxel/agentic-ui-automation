# Agent Notes

## Data Safety

Use synthetic/demo data only. Do not put real patient data or PHI into OpenEMR,
fixtures, logs, screenshots, audit artifacts, or generated test inputs.

## OpenEMR Demo Environments

OpenEMR publishes three demo environments. If one environment is broken, stale, or returns unexpected UI/database errors during automation testing, try the next one before assuming the adapter is broken:

- OpenEMR 8.0.0 Main Demo: `https://demo.openemr.io/openemr`
- Alternate Demo: `https://demo.openemr.io/a/openemr`
- Another Alternate Demo: `https://demo.openemr.io/b/openemr`

Do not reset shared OpenEMR demo state by deleting patients. Patient deletion is
gated behind a global admin setting and mutates shared demo configuration. For
repeatable OpenEMR smoke runs, use `--synthetic-suffix auto` so each run creates
fresh synthetic patient names and identifiers.

When OpenEMR selectors, field mappings, or navigation behavior change, update
`tests/targets/openEmrAdapter.test.ts` and keep report field mappings useful for
manual audit review.

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
audit artifacts, OpenEMR reset strategy, or manual validation steps change. When
workflow architecture or data flow changes, also update the `README.md`
Architecture and Data Flow sections so they reflect the current parser,
orchestrator, agent, target adapter, audit artifact, and technology boundaries.

## Verification

Before claiming a repo change is complete, run:

```sh
npm run typecheck
npm test
git diff --check
```
