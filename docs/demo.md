# Agentic UI Automation Demo

Use only synthetic data for demos and smoke runs. The checked-in demo records under
`data/demo/` are intentionally synthetic; do not run this workflow with real patient,
customer, or production data.

## Local Deterministic Demo

Run the fake target first. It does not open a browser or desktop app, so it is the
fastest way to verify deterministic parsing, validation, orchestration, and audit
artifact writes. Production runs default to AI source parsing; this fixture uses
`--parser deterministic` so it does not require an API key.

```sh
npm install
npm run dev -- run --input data/demo/intake-records-normalized.json --targets fake --runs-dir runs --parser deterministic
find runs -maxdepth 3 -type f | sort
cat runs/*/summary.md
```

Expected fake run result:

- Overall status is `completed_with_exceptions`.
- `preflightExceptions` is `3`.
- `targetCounts.fake.succeeded` is `3`.
- Audit files are written under `runs/<run-id>/`, including `run.json`,
  `executive-summary.md`, `summary.md`, `report.json`, `events.jsonl`,
  normalized input, and exception JSON files.

## Desktop Intake Export Demo

The Electron intake app opens with `data/demo/intake-seed-records.json`. The
seeded queue includes valid synthetic records plus records that need review for
missing DOB, malformed phone, ambiguous payer, address variation, and low
extraction confidence. Import remains available for synthetic JSON, CSV, TXT,
PDF, or DOCX sources.

```sh
npm run desktop:dev
```

Use the app to select export-ready records and export them. The handoff is a CSV
file so it can be opened directly in a spreadsheet app:

```text
~/Downloads/agentic-ui-intake/*.ready.csv
```

The desktop app only exports. Start the watcher separately when ready files should
run through the EMR workflow:

```sh
set -a
. ./.env
set +a
npm run dev -- watch \
  --inbox ~/Downloads/agentic-ui-intake \
  --targets openemr \
  --runs-dir runs \
  --synthetic-suffix auto
```

For a local dry run that does not open OpenEMR:

```sh
npm run dev -- watch --once --inbox ~/Downloads/agentic-ui-intake --targets fake --runs-dir runs
```

The watcher accepts `.ready.csv` and `.ready.json`, moves files through
`processing/`, then to `processed/<runId>.csv` or `processed/<runId>.json` based
on the source format, or to `failed/`, and writes the same audit package as
direct CLI runs.

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
- `.env` contains the OpenEMR values and `OPENAI_API_KEY` when using the default
  OpenAI parser.

OpenEMR publishes multiple public demo environments. If one is stale, broken, or
returns unexpected UI/database errors, try another before treating the adapter as
broken:

- Main demo: `https://demo.openemr.io/openemr`
- Alternate demo: `https://demo.openemr.io/a/openemr`
- Another alternate demo: `https://demo.openemr.io/b/openemr`

```sh
npx playwright install chromium
set -a
. ./.env
set +a
npm run dev -- run \
  --input data/demo/intake-records.json \
  --targets openemr \
  --runs-dir runs \
  --synthetic-suffix auto
```

`data/demo/intake-records.json` intentionally uses varied source shapes and
field labels so the demo exercises AI source parsing before deterministic EMR
entry.

For local smoke checks that should not call OpenAI, use
`data/demo/intake-records-normalized.json` and add `--parser deterministic`.

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
4. Fill the Search or Add Patient form with demographics and available contact
   fields.
5. Take an `after-fill` screenshot.
6. Click `Create New Patient`.
7. Click `Confirm Create New Patient` when OpenEMR reports no matches.
8. Take an `after-save` screenshot after OpenEMR leaves the create form.

For `data/demo/intake-records.json`, the expected clean OpenEMR target result is:

- `preflightExceptions` is `3`.
- `targetCounts.openemr.succeeded` is `4`.
- `targetCounts.openemr.exception` is `0`.
- `exceptions/` only contains the intentional validation exceptions.
- Each valid record has three OpenEMR screenshots:
  `before-navigation.png`, `after-fill.png`, and `after-save.png`.
- `summary.md` includes an OpenEMR record review with raw intake input, filled
  screenshots, AI confidence, and source-to-OpenEMR comparisons. Optional contact
  fields that are unavailable in a public demo layout may be reported as failed
  mappings without failing the target record.

The public OpenEMR demo keeps submitted patients for a while. If you rerun the
same input without `--synthetic-suffix`, duplicate patient detection can make the
run fail correctly. Use `runs/<run-id>/input/normalized-records.json` to see the
generated names and identifiers to search for during manual validation.

## Audit Review Commands

Use the audit artifacts to confirm what happened before trusting a smoke run result.
Copy the `runId` from the CLI JSON output and inspect that exact run directory.
A controlled target failure can still exit cleanly with `completed_with_exceptions`;
do not treat a target smoke as passed unless that target has the expected success
count and no environment or target exceptions in `run.json`.

```sh
RUN_ID="<run-id-from-cli-output>"
find "runs/${RUN_ID}" -maxdepth 3 -type f | sort
cat "runs/${RUN_ID}/executive-summary.md"
cat "runs/${RUN_ID}/summary.md"
cat "runs/${RUN_ID}/report.json"
cat "runs/${RUN_ID}/run.json"
tail -n 40 "runs/${RUN_ID}/events.jsonl"
find "runs/${RUN_ID}" -maxdepth 3 -path "*/exceptions/*.json" -type f -print -exec cat {} \;
find "runs/${RUN_ID}" -path "*/screenshots/*.png" -type f | sort
```
