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
npm run dev -- run \
  --input data/demo/intake-records.json \
  --targets openemr \
  --runs-dir runs \
  --synthetic-suffix auto
```

The public demo URL, credentials, and UI can change. If login, navigation,
selectors, or save behavior drift, the run should stop with auditable environment
or UI-state exceptions rather than silently claiming success.

OpenEMR supports patient deletion only when administrator patient deletion is
enabled in global feature configuration. The public demo has that setting off, so
the smoke run uses `--synthetic-suffix auto` to avoid duplicate patients instead
of trying to reset shared demo state.

### OpenEMR Success Criteria

For each valid normalized record, the target should:

1. Log in to OpenEMR.
2. Take a `before-navigation` screenshot.
3. Open `Patient` -> `New/Search`.
4. Fill the Search or Add Patient form with demographics and contact fields.
5. Take an `after-fill` screenshot.
6. Click `Create New Patient`.
7. Click `Confirm Create New Patient` when OpenEMR reports no matches.
8. Take an `after-save` screenshot after OpenEMR leaves the create form.

For `data/demo/intake-records.json`, the expected clean OpenEMR target result is:

- `preflightExceptions` is `3`.
- `targetCounts.openemr.succeeded` is `3`.
- `targetCounts.openemr.exception` is `0`.
- `exceptions/` only contains the intentional validation exceptions.
- Each valid record has three OpenEMR screenshots:
  `before-navigation.png`, `after-fill.png`, and `after-save.png`.

The public OpenEMR demo keeps submitted patients for a while. If you rerun the
same input without `--synthetic-suffix`, duplicate patient detection can make the
run fail correctly. Use `runs/<run-id>/input/normalized-records.json` to see the
generated names and identifiers to search for during manual validation.

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

### Excel Success Criteria

The Excel target uses Microsoft Excel as the desktop intake system. For each
valid source record, it should:

1. Create or reuse the workbook at `--excel-workbook-path`.
2. Create or reuse the `Intake` worksheet with the fixed intake columns.
3. Open the workbook in Excel.
4. Capture a `before-entry.png` screenshot.
5. Ask the agent to approve the `paste-row` action.
6. Paste one normalized tab-separated row into the first empty row.
7. Capture an `after-entry.png` screenshot.
8. Save the workbook when the target closes.

A clean Excel smoke run with `data/demo/intake-records.json` means:

- `preflightExceptions` is `3`.
- `targetCounts.excel.succeeded` is `3`.
- `targetCounts.excel.exception` is `0`.
- `exceptions/` only contains the intentional validation exceptions.
- A fresh workbook has an `Intake` sheet with the header row and `demo-001`,
  `demo-002`, and `demo-003` in rows 2 through 4.
- Each valid record has two Excel screenshots: `before-entry.png` and
  `after-entry.png`.
- `events.jsonl` has one `paste` event per valid record, including the row
  number used in Excel.

Open the workbook directly, or inspect it from the command line:

```sh
node --input-type=module -e "import ExcelJS from 'exceljs'; const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile('runs/intake-workbook.xlsx'); const sheet = workbook.getWorksheet('Intake'); const rows = []; sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => rows.push({ rowNumber, values: row.values.slice(1, 4) })); console.log(JSON.stringify(rows, null, 2));"
```

The Excel target appends to an existing workbook. Use a fresh workbook path when
you want rows 2 through 4 to map exactly to the three demo records.

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
  --excel-workbook-path runs/intake-workbook.xlsx \
  --synthetic-suffix auto
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
