# Output Markdown Viewer And Computer Use Patient Flow Design

## Purpose

Add two related operator conveniences around the existing Electron-to-OpenMRS
workflow:

- A black-box desktop patient creation command that uses Codex Computer Use to
  drive the already-open Electron intake app like a third-party app.
- A local web viewer for persisted run artifacts, especially
  `executive-summary.md` and `summary.md`.

The workflow must remain synthetic/demo-data only. The durable source of truth
after a run is still the exported handoff file and the audit package under
`runs/<run-id>/`; the viewer reads those artifacts without modifying them.

## Approved Commands

The front-and-center E2E flow remains three commands:

```sh
npm run watch:intake
npm run desktop:dev
npm run desktop:patient-flow
```

`npm run desktop:patient-flow` changes from launching its own Electron instance
to driving the visible `Intake Queue` desktop app through Computer Use. The app
must already be running from `npm run desktop:dev`.

The artifact viewer is a separate command:

```sh
npm run viewer
```

It starts a local read-only web app for browsing run outputs under `runs/`.

## Scope

In scope:

- Replace the public `desktop:patient-flow` implementation with a black-box
  Computer Use flow against the existing visible app window.
- Keep the patient-flow command UI-only: no Electron IPC, preload API,
  `window.intakeApp`, Playwright/Electron attach, or private Electron launch.
- Generate synthetic patient data, enter it through the visible New Patient
  form, export only that patient, and print JSON containing the patient fields
  and exported `readyPath`.
- Leave the Electron app running after the Computer Use flow completes.
- Add a separate local viewer command, exposed through `npm run viewer`.
- Serve a browser UI from a localhost-only Node/TypeScript HTTP server.
- Default the viewer to reading the existing `runs/` directory, with a
  configurable `--runs-dir`.
- List discovered runs newest-first.
- Render `executive-summary.md` and `summary.md` for a selected run.
- Expose `report.json`, `events.jsonl`, normalized records, exceptions, and
  screenshots as read-only artifacts when present.

Out of scope:

- Persisting the transient Electron intake queue across app launches.
- Mutating run artifacts from the viewer.
- Editing, deleting, rerunning, or approving workflow runs from the viewer.
- General-purpose third-party desktop automation beyond this patient creation
  flow.
- A hosted audit portal, authentication model, or multi-user deployment.

## Computer Use Patient Flow

`npm run desktop:patient-flow` should run a tightly scoped Codex/Computer Use
task. It treats `Intake Queue` as a third-party app and uses only desktop-level
actions and observations.

Flow:

1. Confirm the `Intake Queue` app/window is already running.
2. Focus the visible window.
3. Generate synthetic patient data for this run.
4. Click `New Patient`.
5. Fill all required patient form fields through UI interactions.
6. Click `Add Patient`.
7. Confirm the created patient appears in the queue or detail view.
8. Ensure only the created patient is selected for export.
9. Click `Export Selected`.
10. Watch `~/Downloads/agentic-ui-intake` for a new `*.ready.csv`.
11. Print JSON with `status`, `patient`, and `readyPath`.

The command must fail with a clear message if the app is not running, the
expected window cannot be focused, a required control cannot be found, or no new
handoff file appears. It must not fall back to app internals.

Because Computer Use is a Codex capability rather than a normal Node library,
the implementation can be an npm wrapper around `codex exec` with a narrow prompt
and a small local harness for generating patient data and detecting handoff
files. The command should be explicit that it requires Codex Computer Use
availability.

## Artifact Viewer Architecture

The viewer is a separate local web app. It should not be part of the Electron
intake app and should not run workflows. It only reads completed run artifacts.

The server owns all filesystem access. It validates the configured runs
directory, discovers run folders, reads known artifact files, and serves static
viewer assets. It binds to localhost by default and prints the URL on startup.

The browser UI is a compact operational dashboard:

- Left pane: run list, newest first.
- Right pane: selected run review.
- Tabs: `Executive Summary`, `Summary`, and raw artifact views/links.
- Artifact strip: links to `report.json`, `events.jsonl`,
  `input/normalized-records.json`, `exceptions/`, and `screenshots/` when those
  paths exist.
- Screenshot links and images from Markdown should resolve in the browser.

The UI is read-only. Empty `runs/` directories should render an empty state
instead of an error.

## Viewer CLI

`npm run viewer` starts the server. The underlying CLI should accept:

- `--runs-dir <path>`: directory containing run folders. Defaults to `runs`.
- `--port <number>`: preferred local port. Defaults to `4173`.

If the requested port is unavailable, startup should fail with a clear message
asking the user to pass `--port`. The printed URL is the source of truth for
users and for browser automation.

Invalid configuration should fail fast: missing runs directory, non-directory
runs path, invalid port, or bind failure.

## Artifact Service

For each run, the service should return:

- Run ID.
- Status and counts from `run.json` or `report.json` when available.
- Timestamp from metadata when available, with folder-name fallback.
- Available Markdown files.
- Available raw artifact files and directories.

Artifact serving must reject path traversal and must only serve files inside the
configured runs directory. Directory views should be constrained to artifact
directories and should not become a general filesystem browser.

## Markdown Rendering

The viewer should render the Markdown patterns generated by this repository:

- Headings.
- Paragraphs.
- Bulleted and numbered lists.
- Tables.
- Fenced code blocks.
- Inline code.
- Links.
- Images.

Raw HTML should be escaped by default. Relative links and image paths should be
rewritten through viewer routes so run-relative paths such as
`screenshots/<record-id>/openmrs/after-save.png` render correctly.

Use the repository's dependency-free Markdown renderer scoped to generated
summary patterns so local artifact URL rewriting stays under repository control
without adding runtime dependencies.

## Data Flow

Patient flow:

1. User starts watcher.
2. User starts Electron intake app.
3. User runs `npm run desktop:patient-flow`.
4. Computer Use drives the existing app UI.
5. The app exports a new handoff file.
6. The watcher processes the handoff and writes `runs/<run-id>/`.

Viewer flow:

1. User runs `npm run viewer`.
2. Server validates `runsDir`, binds locally, serves browser assets, and prints
   the URL.
3. Browser requests the run list.
4. User selects a run and Markdown tab.
5. Browser requests Markdown and artifact data for that run.
6. Markdown is rendered with local artifact links and images.

## Error Handling

Computer Use patient-flow errors:

- App not running: explain that `npm run desktop:dev` must be started first.
- Window or controls unavailable: fail without fallback to internals.
- Handoff file missing after export: report the watched inbox path.
- Computer Use unavailable: explain that the command requires Codex Computer Use.

Viewer errors:

- Missing `executive-summary.md` or `summary.md`: keep the run visible and show
  a tab-level "not available" state.
- Malformed `run.json` or `report.json`: fall back to folder-derived metadata.
- Missing artifact file: return `404`.
- Invalid artifact path or traversal attempt: return `400` or `404` without
  disclosing files outside `runsDir`.

## Testing

Unit tests should cover the code we own:

- Viewer run discovery and newest-first sorting.
- Metadata fallback for missing or malformed JSON.
- Markdown/report/artifact loading.
- Artifact path containment.
- Markdown rendering for generated summary patterns.
- Viewer CLI option parsing and startup failures where practical.
- Any local harness logic for generating patient data and detecting new handoff
  files.

Computer Use itself should be verified by a local E2E run rather than unit tests:

```sh
npm run watch:intake
npm run desktop:dev
npm run desktop:patient-flow
```

Then confirm a new `.ready.csv` is processed, a new `runs/<run-id>/summary.md`
exists, and that run renders in the viewer.

Before claiming implementation complete, run:

```sh
npm run typecheck
npm test
git diff --check
```

## Documentation

Update `README.md` when implementing:

- Keep the three E2E commands front and center.
- State that `desktop:patient-flow` requires the visible Electron app to already
  be running and requires Codex Computer Use.
- Make clear that `desktop:patient-flow` does not launch Electron or use app
  internals.
- Document `npm run viewer`, default port, `--runs-dir`, local-only
  behavior, and read-only artifact access.

Update `docs/demo.md` if the viewer becomes part of the manual demo validation
flow.
