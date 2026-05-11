# Agentic UI Automation Demo

Use only synthetic data for demos and smoke runs. The checked-in demo records
under `data/demo/` are intentionally synthetic; do not run this workflow with
real patient, customer, or production data.

## Local Deterministic Demo

Run the fake target first. It does not open a browser or desktop app, so it is
the fastest way to verify deterministic parsing, validation, orchestration, and
audit artifact writes. Production runs default to AI source parsing; this
fixture uses `--parser deterministic` so it does not require an API key.

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

## Destination Flexibility Demo

Run OpenMRS first:

```sh
set -a
. ./.env
set +a
npm run dev -- run \
  --input data/demo/intake-records-normalized.json \
  --targets openmrs \
  --runs-dir runs \
  --parser deterministic \
  --synthetic-suffix auto
```

Then run OpenKairo with the same intake file and the same non-target workflow
options. OpenKairo is the recommended second live-demo target because the public
OpenEMR demo has been too brittle for repeatable patient creation.

```sh
set -a
. ./.env
set +a
npm run dev -- run \
  --input data/demo/intake-records-normalized.json \
  --targets openkairo \
  --runs-dir runs \
  --parser deterministic \
  --synthetic-suffix auto
```

The parser, validation, normalized input artifact, orchestrator, audit contract,
and viewer are the same for both commands. The only intentional change is the
destination web app selected by `--targets`.

Run `npm run viewer` and compare the two runs. The viewer sidebar, each
`executive-summary.md`, and each `summary.md` identify the destination target so
the OpenMRS and OpenKairo runs are easy to distinguish.

## Desktop Intake Export Demo

The Electron intake app opens with `data/demo/intake-seed-records.json`. The
seeded queue includes valid synthetic records plus records that need review for
missing DOB, malformed phone, ambiguous payer, address variation, and low
extraction confidence. Import remains available for synthetic JSON, CSV, TXT,
PDF, or DOCX sources, and `New Patient` creates a synthetic intake record
directly in the queue.

```sh
npm run desktop:dev
```

For the full Electron-to-OpenMRS path, start the handoff watcher, Electron
intake app, and local audit viewer together:

```sh
npm run dev:all
```

The bundled watcher, desktop app, and viewer share one terminal with prefixed
logs. Non-fake targets use the generic AI web target runner, and `fake` targets
use the deterministic dry-run path.

For the full desktop E2E, click `New Patient`, review or edit the generated
synthetic intake fields, add the patient to the queue, keep that created record
selected, and export it. The handoff is a CSV file so it can be opened directly
in a spreadsheet app:

```text
~/Downloads/agentic-ui-intake/*.ready.csv
```

With `npm run dev:all` or `npm run desktop:dev` already running and the app
visible, the patient creation and export steps can also be automated through
Codex Computer Use:

```sh
npm run desktop:patient-flow
```

This command clicks and types through the visible Intake Queue UI like a
third-party desktop app. It creates one synthetic patient, exports only that
record, prints the generated patient data and handoff path, and leaves the app
running. It resolves the installed Codex Computer Use MCP helper from the local
Codex plugin cache and passes that helper to `codex exec` explicitly, so the
script can run from a terminal without the Codex Desktop app. It does not launch
a private Electron instance and does not use Playwright, IPC, preload APIs,
`window.intakeApp`, or app internals. Set `COMPUTER_USE_MCP_COMMAND` if the
helper is installed somewhere other than the default Codex plugin cache. The
helper must be able to approve/control the visible Electron app; if the MCP host
denies app access, the command fails with the nested Computer Use transcript
instead of waiting for a handoff file.

The desktop app only exports. Start the watcher separately when ready files
should run through the EMR workflow:

```sh
set -a
. ./.env
set +a
npm run dev -- watch \
  --inbox ~/Downloads/agentic-ui-intake \
  --targets openmrs \
  --runs-dir runs \
  --synthetic-suffix auto
```

To demo operator-in-the-loop review, add
`--confidence-threshold .99 --field-confirmation prompt-on-low-confidence`.
The destination browser pauses before writing below-threshold fields and lets
the operator confirm, edit, skip, or stop that field entry. Edited values keep
the prompt open with a spinner while they are interpreted, and unclear values
re-prompt the operator with feedback.

Use `--targets openmrs,openkairo` to drive both EMR destinations from the same
handoff. The orchestrator runs the OpenMRS and OpenKairo target groups in
parallel while preserving each target's own concurrency limit.

For a local dry run that does not open OpenMRS:

```sh
npm run dev -- watch --once --inbox ~/Downloads/agentic-ui-intake --targets fake --runs-dir runs
```

The watcher accepts `.ready.csv` and `.ready.json`, moves files through
`processing/`, then to `processed/<runId>.csv` or `processed/<runId>.json` based
on the source format, or to `failed/`, and writes the same audit package as
direct CLI runs.

## OpenMRS Smoke Demo

The OpenMRS smoke run drives the public or configured OpenMRS UI through the
same generic AI web target runner used for OpenKairo. Public/demo OpenMRS screens
can drift and credentials can rotate. If the environment is unavailable or the
UI state changes, the run should stop that target with an environment or
UI-state exception and still write audit artifacts for review.

Prerequisites:

- Playwright Chromium is installed.
- The default OpenMRS demo settings are acceptable, or `OPENMRS_BASE_URL`,
  `OPENMRS_USERNAME`, and `OPENMRS_PASSWORD` are set for another synthetic demo
  OpenMRS environment.
- `.env` contains `OPENAI_API_KEY` when using the default OpenAI parser or a
  non-fake target profile.

OpenMRS publishes current demo links at `https://openmrs.org/demo/`. The
OpenMRS target profile points at the OpenMRS 2 Reference Application demo
because the current OpenMRS 3 public demo can render a blank SPA home page
before login.

- Demo page: `https://openmrs.org/demo/`
- Default app URL: `https://o2.openmrs.org/openmrs/login.htm`
- Default username: `admin`
- Default password: `Admin123`
- Default location: `Registration Desk`
- Default OpenMRS record concurrency: `1`

```sh
npx playwright install chromium
set -a
. ./.env
set +a
npm run dev -- run \
  --input data/demo/intake-records.json \
  --targets openmrs \
  --runs-dir runs \
  --synthetic-suffix auto \
  --openmrs-concurrency 1
```

`data/demo/intake-records.json` intentionally uses varied source shapes and
field labels so the demo exercises AI source parsing before deterministic EMR
entry.

For local smoke checks that should not call OpenAI, use
`data/demo/intake-records-normalized.json` and add `--parser deterministic`.

The public demo URL, credentials, and UI can change. If login, navigation, page
structure, or save behavior drift, the run should stop with auditable
environment or UI-state exceptions rather than silently claiming success.

OpenMRS supports patient deletion only when administrator patient deletion is
enabled in global feature configuration. The public demo has that setting off,
so the smoke run uses `--synthetic-suffix auto` to avoid duplicate patients
instead of trying to reset shared demo state.

### OpenMRS Success Criteria

For each valid normalized record, the generic AI web target runner uses the
OpenMRS target profile to:

1. Open the configured OpenMRS environment.
2. Observe the current page, visible text, URL, title, and available controls.
3. Ask the schema-bound AI planner for one bounded browser action at a time.
4. Execute only supported browser actions: fill, select, click, wait,
   screenshot, verify, or stop.
5. Capture ordered `ai-step-*` observations, `ai-field-*` proof images for
   completed fields, target evidence, events, and field mappings.
6. Treat possible duplicates, unexpected UI state, and verification failures as
   auditable target exceptions for manual review.
7. Mark the record successful only when the planner verifies the configured
   success criteria for the synthetic patient.

For `data/demo/intake-records-normalized.json`, the expected clean OpenMRS
target result is:

- `preflightExceptions` is `3`.
- `targetCounts.openmrs.succeeded` is `3`.
- `targetCounts.openmrs.exception` is `0`.
- `exceptions/` only contains the intentional validation exceptions.
- Each valid record has OpenMRS screenshot evidence captured by the generic
  runner, including ordered `ai-step-*` observations and `ai-field-*` proof
  images for completed fields when fields are entered.
- `summary.md` includes an OpenMRS record review with raw intake input,
  runner screenshots, AI action evidence, planner rationale and confidence for
  field actions, and source-to-target comparisons. Optional fields that are
  unavailable in a public demo layout may be reported as failed mappings without
  failing the target record. Issue tables categorize exceptions by severity and
  include remediation steps for manual review.

The public OpenMRS demo keeps submitted patients for a while. If you rerun the
same input without `--synthetic-suffix`, duplicate patient detection can make
the run fail correctly. Use `runs/<run-id>/input/normalized-records.json` to see
the generated names and identifiers to search for during manual validation.

## OpenKairo Smoke Demo

The OpenKairo target drives the public or configured OpenKairo UI through the
same generic AI web target runner used for OpenMRS. It is the recommended
second live-demo target when the public OpenEMR demo is not stable enough for
repeatable patient creation.

OpenKairo publishes the current demo link and credentials at
`https://www.openkairo.com/`.

- Demo page: `https://www.openkairo.com/`
- Default app URL: `https://ehr-app-five.vercel.app`
- Default username: `reception@demo.com`
- Default password: `Demo123!`
- Default OpenKairo record concurrency: `1`

```sh
npx playwright install chromium
set -a
. ./.env
set +a
npm run dev -- run \
  --input data/demo/intake-records.json \
  --targets openkairo \
  --runs-dir runs \
  --synthetic-suffix auto \
  --openkairo-concurrency 1
```

For local smoke checks that should not call OpenAI, use
`data/demo/intake-records-normalized.json` and add `--parser deterministic`.

For each valid normalized record, the OpenKairo target profile uses the same
generic AI web target runner behavior as OpenMRS: observe the page, request one
schema-bound planner action at a time, execute only bounded browser actions,
capture ordered `ai-step-*` and `ai-field-*` screenshot evidence, and verify the
configured success criteria before marking the record successful. The OpenMRS
and OpenKairo profiles provide URL, credentials, target name, goal, and proof
criteria; there are no destination-specific UI automation classes.

`summary.md` includes an OpenKairo record review with raw intake input, proof
screenshots, AI action evidence, planner rationale and confidence for field
actions, and
source-to-target comparisons. Optional fields that are unavailable in the public
demo layout may be reported as failed mappings without changing the shared
audit artifact structure.

## Audit Review Commands

Use the audit artifacts to confirm what happened before trusting a smoke run
result. Copy the `runId` from the CLI JSON output and inspect that exact run
directory. A controlled target failure can still exit cleanly with
`completed_with_exceptions`; do not treat a target smoke as passed unless that
target has the expected success count and no environment or target exceptions in
`run.json`. For browser-based review, run `npm run viewer` and select the
generated run from the left pane. The viewer color-codes issue rows by severity
and keeps remediation steps visible beside each exception.

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
