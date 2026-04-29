# Agentic UI Automation Demo

Use only synthetic data for demos and smoke runs. The checked-in demo records under
`data/demo/` are intentionally synthetic; do not run this workflow with real patient,
customer, or production data.

## Local Deterministic Demo

Run the fake target first. It does not open a browser or desktop app, so it is the
fastest way to verify parsing, validation, orchestration, and audit artifact writes.

```sh
npm install
npm run dev -- run --input data/demo/intake-records.json --targets fake --runs-dir runs
find runs -maxdepth 3 -type f | sort
cat runs/*/summary.md
```

Expected fake run result:

- Overall status is `completed_with_exceptions`.
- `preflightExceptions` is `3`.
- `targetCounts.fake.succeeded` is `3`.
- Audit files are written under `runs/<run-id>/`, including `run.json`,
  `events.jsonl`, `summary.md`, normalized input, and exception JSON files.

## OpenEMR Smoke Demo

The OpenEMR smoke run drives the public or configured OpenEMR UI through Chromium.
Public/demo OpenEMR screens can drift, credentials can rotate, and target selectors
may need updates. If the environment is unavailable or the UI state changes, the run
should stop that target with an environment or UI-state exception and still write
audit artifacts for review.

Prerequisites:

- Playwright Chromium is installed.
- `OPENEMR_BASE_URL`, `OPENEMR_USERNAME`, and `OPENEMR_PASSWORD` are set for a
  synthetic demo OpenEMR environment.

```sh
npx playwright install chromium
export OPENEMR_BASE_URL="https://demo.openemr.io/b/openemr"
export OPENEMR_USERNAME="admin"
export OPENEMR_PASSWORD="pass"
npm run dev -- run --input data/demo/intake-records.json --targets openemr --runs-dir runs
```

The public demo URL, credentials, and UI can change. If login, navigation,
selectors, or save behavior drift, the run should stop with auditable environment
or UI-state exceptions rather than silently claiming success.

## Excel Desktop Smoke Demo

The Excel smoke run drives Microsoft Excel on macOS and writes synthetic records to
an intake workbook.

Prerequisites:

- Microsoft Excel is installed and licensed.
- macOS Accessibility permissions allow the terminal or runner app to control Excel
  and System Events.
- macOS Screen Recording permission allows the terminal or runner app to capture
  screenshots for audit artifacts.
- Close existing dirty workbooks before the smoke run, or use a fresh workbook path
  so the automation is not blocked by save prompts or workbook focus ambiguity.

```sh
npm run dev -- run \
  --input data/demo/intake-records.json \
  --targets excel \
  --runs-dir runs \
  --excel-workbook-path runs/intake-workbook.xlsx
```

## Combined Demo

Run OpenEMR and Excel together only after each target has passed its individual
smoke run in the current environment. The same synthetic-data-only rule applies.

```sh
export OPENEMR_BASE_URL="https://demo.openemr.io/b/openemr"
export OPENEMR_USERNAME="admin"
export OPENEMR_PASSWORD="pass"
npm run dev -- run \
  --input data/demo/intake-records.json \
  --targets openemr,excel \
  --runs-dir runs \
  --excel-workbook-path runs/intake-workbook.xlsx
```

## Audit Review Commands

Use the audit artifacts to confirm what happened before trusting a smoke run result.
Copy the `runId` from the CLI JSON output and inspect that exact run directory.
A controlled target failure can still exit cleanly with `completed_with_exceptions`;
do not treat a target smoke as passed unless that target has the expected success
count and no environment or target exceptions in `run.json`.

```sh
RUN_ID="<run-id-from-cli-output>"
find "runs/${RUN_ID}" -maxdepth 3 -type f | sort
cat "runs/${RUN_ID}/summary.md"
cat "runs/${RUN_ID}/run.json"
tail -n 40 "runs/${RUN_ID}/events.jsonl"
find "runs/${RUN_ID}" -maxdepth 3 -path "*/exceptions/*.json" -type f -print -exec cat {} \;
find "runs/${RUN_ID}" -path "*/screenshots/*.png" -type f | sort
```
