# Agentic UI Automation Pilot Design

Date: 2026-04-28

## Summary

This pilot demonstrates a reusable agentic UI automation capability for last-mile intake workflows where APIs are unavailable, incomplete, or impractical. The first workflow takes synthetic patient intake records, parses and validates them, and attempts data entry into both a web application and a desktop application while producing structured audit artifacts.

The pilot uses OpenEMR as the web target and Microsoft Excel desktop as the desktop target. OpenEMR stands in for an EHR-style workflow such as Athena, and Excel represents a common end-user desktop intake tracker. The system proves the architecture against two real UI surfaces without claiming broad "any app" coverage in the first slice.

## Goals

- Demonstrate context-aware UI interaction where the agent interprets screens and UI state inside deterministic workflow boundaries.
- Support repeatable workflow runs seeded by source records.
- Produce traceable audit evidence for every record, action, screenshot, outcome, and exception.
- Treat validation and UI exceptions as first-class outcomes rather than incidental failures.
- Establish an adapter model that can later support additional web or desktop targets.

## Non-Goals

- Build a custom intake application.
- Automate authenticated production healthcare systems.
- Claim robust support for arbitrary applications in the first implementation.
- Perform destructive actions or submit real patient data.
- Replace human review for ambiguous, high-impact, or hard-to-reverse cases.

## Targets

### OpenEMR Web Target

The web target is the public OpenEMR demo. The workflow will create or update patient/intake-style records using synthetic data, capture screenshots at meaningful steps, verify saved outcomes when possible, and surface validation or UI exceptions.

OpenEMR was selected because it is a real third-party EHR-like system with a moderately complex UI and public demo environments. It is a closer stand-in for Athena-style last-mile automation than a generic sample form.

### Microsoft Excel Desktop Target

The desktop target is Microsoft Excel desktop. The workflow will enter the same normalized patient intake records into a structured workbook/table that acts as an intake tracker. The demo assumes Excel desktop is already installed and licensed on the local machine.

Excel was selected because it is a familiar end-user application and makes the desktop portion of the pilot understandable to business stakeholders.

## Architecture

The system has five main parts.

### Workflow Orchestrator

The orchestrator starts a run, loads source records, assigns run and record IDs, calls the parser and target adapters, enforces retry limits, and writes final status. It owns workflow boundaries, not individual UI details.

### Record Parser And Validator

The parser accepts source records in two forms:

- Structured JSON or CSV for deterministic tests and a stable oracle.
- Semi-structured intake text for the realistic agentic parsing path.

It emits a normalized patient intake object plus validation findings. Clean records continue to target adapters. Invalid or ambiguous records become controlled exceptions.

### Target Adapters

OpenEMR and Excel implement the same adapter contract:

- Prepare the target.
- Inspect current UI state.
- Decide the next UI action.
- Execute the action.
- Verify the outcome.
- Emit evidence.

The OpenEMR adapter uses Playwright for browser control, screenshots, and DOM context. The Excel adapter uses desktop automation and computer-use-style screen interaction.

### Agent Decision Layer

The agent interprets screenshots and UI context to decide how to navigate and fill fields inside guardrailed steps. Deterministic code owns target allowlists, workflow phase transitions, the normalized schema, exception taxonomy, retry policy, and stopping conditions.

This follows current OpenAI computer-use guidance: a model can inspect screenshots, return UI actions, and work through a harness that executes those actions and returns updated screenshots. The OpenAI docs also recommend Playwright or Selenium for browser prototypes, isolated environments, allowlists, and human oversight for high-impact actions.

References:

- OpenAI Computer use: https://developers.openai.com/api/docs/guides/tools-computer-use
- OpenAI Models and tools: https://developers.openai.com/api/docs/models

### Audit And Evidence Store

Every workflow run writes structured event logs, screenshots, normalized inputs, validation results, target outcomes, and exception summaries. Artifacts are organized by run ID and record ID so a reviewer can reconstruct what the automation saw, decided, did, and verified.

## Data Flow

1. Load source records.
2. Parse each record into the normalized patient intake schema.
3. Validate required fields and domain rules.
4. Create one target task per valid record and target.
5. Adapter navigates the UI, captures screenshots, fills fields, verifies the result, and logs each meaningful action.
6. Exceptions are written as first-class outcomes with reason, severity, screenshots, raw input, normalized data, and suggested remediation.
7. Generate a final run summary with counts by target and status.

## Minimum Normalized Intake Schema

The first implementation will support this minimum patient intake shape:

- Patient identity: first name, last name, date of birth, sex or gender marker.
- Contact information: phone, email, street address, city, state, ZIP.
- Insurance summary: payer name, member ID, group ID when provided.
- Visit context: reason for visit, preferred contact method, notes.
- Source metadata: source record ID, source format, raw source excerpt.

Fields outside this schema are preserved in raw input artifacts but are not entered into OpenEMR or Excel during the first implementation.

## Artifact Layout

```text
runs/<run-id>/
  run.json
  input/
    raw-records.*
    normalized-records.json
  events.jsonl
  screenshots/
    <record-id>/<target>/<step>.png
  exceptions/
    <record-id>.json
  summary.md
```

## Audit Event Model

Audit events are append-only JSON lines. Each event includes:

- Timestamp.
- Run ID.
- Record ID.
- Target.
- Workflow phase.
- Action type.
- Agent rationale summary.
- Screenshot path, when available.
- Result.
- Exception code, when applicable.

The audit trail must be sufficient to answer four questions:

- What did the automation see?
- What did it decide?
- What did it do?
- How was the outcome verified?

## Exception Handling

The first demo includes controlled exceptions alongside happy-path records.

Initial exception taxonomy:

- `missing_required_field`: required intake data is absent, such as DOB or last name.
- `invalid_format`: phone, email, date, or ZIP cannot be normalized confidently.
- `ambiguous_value`: insurance, gender, contact preference, or address has multiple plausible mappings.
- `possible_duplicate`: target UI suggests the patient or record may already exist.
- `ui_state_unexpected`: the target screen differs from the expected workflow state.
- `verification_failed`: the adapter entered data but could not confirm the saved result.

Each exception stops that record for the affected target, captures the current screen, writes an exception file, and continues with other records when safe. Destructive retries are not allowed. Retries are allowed only for transient UI state issues, with a small cap.

## Feedback Loop

The first feedback loop is lightweight and review-driven. A reviewer can inspect exception files, edit a correction file for failed records, and rerun only those records. Later iterations can promote recurring corrections into parser rules or adapter hints.

## Testing Strategy

### Parser And Validator Unit Tests

Cover clean records and controlled bad records:

- Missing DOB.
- Invalid phone.
- Ambiguous insurance.
- Malformed address.
- Duplicate-like identity.

### Audit Event Tests

Verify that every record produces stable run IDs, record IDs, status transitions, screenshot references, and summary counts.

### Adapter Contract Tests

Use fake adapters to prove the orchestrator handles success, validation exception, UI exception, retry, and verification failure consistently.

### Target Smoke Tests

Run a small dataset against OpenEMR and Excel when those environments are available. These tests are opt-in because third-party demo environments and local Excel state can vary.

## Demo Dataset

The demo dataset includes:

- Three clean synthetic patient intake records.
- One record with a missing required field.
- One record with ambiguous insurance or contact preference.
- One record with an invalid phone number or date.
- One optional duplicate-like record if OpenEMR makes duplicate detection visible.

## Demo Narrative

1. Kick off one workflow run.
2. Show normalized records and validation results.
3. Show OpenEMR screenshots and saved or exception outcomes.
4. Show Excel screenshots and row-entry outcomes.
5. Show `summary.md` and `events.jsonl` as the audit trail.

## Safety And Guardrails

- Use only synthetic data.
- Restrict web automation to the OpenEMR demo domain.
- Restrict desktop automation to Excel and the target workbook.
- Keep human review in the loop for ambiguous, duplicate, high-impact, or unexpected states.
- Avoid destructive actions.
- Stop a record when confidence is insufficient instead of guessing.
- Store screenshots and logs under run-specific folders for traceability.

## Implementation Planning Boundaries

- OpenEMR will use an official public demo instance and a demo role that can create patient records. If the preferred demo instance is unavailable, the run fails with an environment-readiness exception instead of switching to an unknown site.
- Excel will use a local workbook with a single structured `Intake` table whose columns match the minimum normalized intake schema.
- The implementation plan may choose the exact model and harness integration, but it must preserve the split between deterministic workflow boundaries and agentic UI interpretation.
- The first CLI surface should support starting a run, selecting targets, pointing at a dataset, and rerunning corrected exception records.
- Environment-dependent target smoke tests remain opt-in; parser, audit, and adapter contract tests must run without OpenEMR or Excel.
