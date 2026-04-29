# Agentic UI Automation

Pilot for repeatable, audited UI data entry across web and desktop applications.

The workflow takes synthetic intake records, parses and validates them, asks an
agent driver to approve bounded UI actions, runs one or more target adapters, and
writes a traceable audit package for each run.

## What It Demonstrates

- Last-mile UI automation when an API is unavailable or incomplete.
- Deterministic orchestration around agentic screen interpretation.
- Structured exception handling instead of silent target failures.
- Audit evidence for every run: screenshots, event logs, normalized input,
  exception JSON, run metadata, and a Markdown summary.
- Two target styles:
  - Web app: OpenEMR through Playwright.
  - Desktop app: Microsoft Excel on macOS.

Use only synthetic data with this repository. The checked-in records under
`data/demo/` are intentionally synthetic.

## Current Status

- Core workflow: implemented and covered by tests.
- Fake target: deterministic local smoke target for orchestration and audit.
- Excel desktop target: smoke-tested on macOS after Accessibility and Screen
  Recording permissions were granted.
- OpenEMR web target: adapter and tests are implemented; live smoke requires a
  reachable synthetic/demo OpenEMR instance and current credentials.

## Quick Start

Install dependencies:

```sh
npm install
```

Run the no-UI demo first:

```sh
npm run dev -- run --input data/demo/intake-records.json --targets fake --runs-dir runs
```

Expected result:

- `status` is `completed_with_exceptions`.
- `preflightExceptions` is `3`.
- `targetCounts.fake.succeeded` is `3`.

The status includes exceptions because the demo file contains three intentionally
invalid records that should stop during validation.

## Excel Desktop Smoke

Prerequisites:

- Microsoft Excel is installed and licensed.
- The terminal or runner app has macOS Accessibility permission.
- The terminal or runner app has macOS Screen Recording permission.
- Existing dirty Excel workbooks are closed, or a fresh workbook path is used.

Run:

```sh
npm run dev -- run \
  --input data/demo/intake-records.json \
  --targets excel \
  --runs-dir runs \
  --excel-workbook-path runs/intake-workbook.xlsx
```

Expected target result:

- `targetCounts.excel.succeeded` is `3`.
- `targetCounts.excel.exception` is `0`.
- The workbook contains rows for `demo-001`, `demo-002`, and `demo-003`.
- Six screenshots are written: before and after each valid record.

## OpenEMR Smoke

Prerequisites:

- Playwright Chromium is installed.
- `OPENEMR_BASE_URL`, `OPENEMR_USERNAME`, and `OPENEMR_PASSWORD` point to a
  synthetic/demo OpenEMR environment.

Install Chromium if needed:

```sh
npx playwright install chromium
```

Run against the current OpenEMR public demo environment:

```sh
OPENEMR_BASE_URL="https://demo.openemr.io/b/openemr" \
OPENEMR_USERNAME="admin" \
OPENEMR_PASSWORD="pass" \
npm run dev -- run \
  --input data/demo/intake-records.json \
  --targets openemr \
  --runs-dir runs
```

Public demo credentials and screens can change. If login, navigation, selectors,
or save behavior drift, the run should finish with auditable environment or
UI-state exceptions rather than silently claiming success.

## Combined Smoke

Run targets together only after each target has passed individually in the
current environment:

```sh
OPENEMR_BASE_URL="https://demo.openemr.io/b/openemr" \
OPENEMR_USERNAME="admin" \
OPENEMR_PASSWORD="pass" \
npm run dev -- run \
  --input data/demo/intake-records.json \
  --targets openemr,excel \
  --runs-dir runs \
  --excel-workbook-path runs/openemr-excel-demo.xlsx
```

## Audit Artifacts

Each run writes to `runs/<run-id>/`:

```text
run.json
summary.md
events.jsonl
input/normalized-records.json
exceptions/*.json
screenshots/<record-id>/<target>/<step>.png
```

Use the `runId` from CLI output to inspect a specific run:

```sh
RUN_ID="<run-id-from-cli-output>"
cat "runs/$RUN_ID/summary.md"
cat "runs/$RUN_ID/run.json"
tail -n 40 "runs/$RUN_ID/events.jsonl"
find "runs/$RUN_ID/exceptions" -maxdepth 1 -type f -print -exec cat {} \;
find "runs/$RUN_ID/screenshots" -type f | sort
```

The screenshot tree is nested by record, target, and step so the audit trail can
answer what the workflow saw for a specific record in a specific app.

## CLI

```sh
npm run dev -- run \
  --input <path-to-json-csv-or-text-records> \
  --targets fake,excel,openemr \
  --runs-dir runs \
  --excel-workbook-path runs/intake-workbook.xlsx \
  --agent scripted
```

Options:

- `--input`: required source record file.
- `--targets`: comma-separated targets: `fake`, `excel`, `openemr`.
- `--runs-dir`: audit output directory. Defaults to `runs`.
- `--excel-workbook-path`: workbook path for the Excel target.
- `--agent`: `scripted` or `openai`. Defaults to `scripted`.

Environment variables:

- `OPENEMR_BASE_URL`
- `OPENEMR_USERNAME`
- `OPENEMR_PASSWORD`
- `EXCEL_WORKBOOK_PATH`
- `RUNS_DIR`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`

See `.env.example` for the full list.

## Development

Run verification:

```sh
npm run typecheck
npm test
```

Build:

```sh
npm run build
```

Packaging dry run:

```sh
npm pack --dry-run
```

## Project Layout

```text
src/domain/        Intake schemas and validation
src/parsing/       JSON, CSV, and text source loading
src/orchestrator/  Workflow coordination and exception handling
src/audit/         Run metadata, events, summaries, screenshots, exceptions
src/agent/         Scripted and OpenAI-backed agent drivers
src/adapters/      Shared target adapter contract and fake adapter
src/targets/       OpenEMR and Excel implementations
tests/             Unit and integration-style coverage
docs/demo.md       Longer smoke-demo walkthrough
```

## Keeping This Current

When behavior, commands, targets, audit paths, or prerequisites change, update this
README and `docs/demo.md` in the same change. After edits, run `npm run typecheck`
and `npm test` before treating the repo as current.
