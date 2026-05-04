# OpenMRS Interactive Field Confirmation Design

## Summary

Add optional interactive confirmation for low-confidence AI field-entry decisions
during OpenMRS registration. The feature applies after a record has been
created or exported from the Electron intake app and is being entered into the
OpenMRS EMR by the target adapter.

Before each OpenMRS field is filled or selected, the adapter asks the UI agent
to approve the specific source-to-target field action. If the agent confidence
is below a configurable threshold, defaulting to `0.8`, the adapter pauses and
injects an operator confirmation modal into the active OpenMRS browser page.
The operator can confirm the proposed value, edit it, skip optional fields, or
stop the record. Confirmed and edited values are written to OpenMRS and recorded
in the audit artifacts.

## Goals

- Prevent low-confidence AI field-entry decisions from silently writing data to
  OpenMRS.
- Keep the operator in the live EMR context at the moment of uncertainty.
- Preserve the current deterministic OpenMRS selector mapping and audit
  contract.
- Make the threshold configurable, with `0.8` as the default.
- Force OpenMRS target concurrency to `1` when interactive confirmation is
  enabled, so human prompts remain unambiguous.

## Non-Goals

- Do not change the Electron intake app review and export flow.
- Do not block records during intake parsing solely because extraction metadata
  has low confidence.
- Do not implement an automatic AI retry loop before prompting the operator.
- Do not create or delete patients in the shared OpenMRS demo to reset state.

## Architecture

The feature belongs in the OpenMRS target adapter. The existing
`openMrsFieldMappings(record)` function remains the deterministic source of
target fields, values, selector candidates, and static mapping confidence.
`fillMappedField` gains a pre-fill approval step:

1. Reveal the target field as today.
2. Capture a field-review screenshot after the field is visible.
3. Call `context.agent.decide` for this specific field write.
4. Compare the returned confidence with the configured threshold.
5. Either fill/select directly or show the browser confirmation prompt.

The agent decision input includes the target, record ID, step name, visible
text, screenshot path, allowed actions, and structured field context.
The field context includes:

- `sourceField`
- `targetField`
- proposed normalized value
- selector candidates
- whether the field is required
- static mapping confidence from the selector mapping

The existing generic `AgentDecisionInput` can be extended with optional
structured metadata rather than introducing a separate agent interface. This
keeps the scripted and OpenAI agents compatible while making the new behavior
testable.

## Configuration

Add OpenMRS configuration for:

- interactive field confirmation enabled or disabled;
- field confidence threshold, defaulting to `0.8`.

The CLI exposes these through explicit options:

- `--openmrs-interactive-field-confirmation`
- `--openmrs-field-confidence-threshold <number>`

Matching environment variables are:

- `OPENMRS_INTERACTIVE_FIELD_CONFIRMATION`
- `OPENMRS_FIELD_CONFIDENCE_THRESHOLD`

Boolean parsing accepts `1`, `true`, `yes`, and `on` as enabled values.
Threshold values must be finite numbers from `0` through `1`, inclusive.

When interactive field confirmation is enabled, the effective OpenMRS
concurrency is `1`, regardless of `OPENMRS_CONCURRENCY` or
`--openmrs-concurrency`. This is represented in configuration behavior and
documentation. Non-interactive runs keep the current OpenMRS concurrency
behavior.

## Operator Prompt

The prompt is injected into the active OpenMRS page before the uncertain field
is written. It is a small modal overlay that clearly shows:

- target field name;
- source field name;
- proposed value;
- agent confidence;
- configured threshold;
- agent rationale;
- whether the field is required.

Available actions:

- Confirm: use the proposed value.
- Edit: use the operator-edited value.
- Skip: only available for optional fields.
- Stop: stop the current record as a target exception.

Required fields cannot be skipped. The modal disables or omits skip for
required mappings and validates that edited required values are not blank.

The modal is implemented as a bounded browser-side prompt with a clear timeout
or failure path. If the page closes, script injection fails, or the
prompt cannot return a decision, the adapter records a target exception instead
of proceeding.

## Data Flow

For each valid normalized record:

1. The orchestrator runs validation and passes the normalized record to the
   OpenMRS target adapter.
2. The adapter logs in, opens the registration form, and captures the
   `before-navigation` screenshot as today.
3. For each OpenMRS field mapping, the adapter reveals the field and asks the
   agent to approve the proposed write.
4. If `confidence >= threshold`, the adapter fills or selects the value.
5. If `confidence < threshold`, the adapter shows the in-browser operator
   prompt before writing anything.
6. The operator confirms, edits, skips an optional field, or stops the record.
7. The adapter writes field mapping audit details, including agent and operator
   intervention metadata.
8. After all fields are handled, the existing save, duplicate detection,
   dashboard verification, screenshot, and report flows continue.

## Audit Contract

The existing audit artifacts remain in place:

- `run.json`
- `summary.md`
- `report.json`
- `events.jsonl`
- `input/normalized-records.json`
- `exceptions/`
- `screenshots/`

Field mapping audit entries are extended with optional metadata for this
feature:

- agent decision confidence;
- confidence threshold;
- agent rationale;
- approval source: `agent`, `operator_confirmed`, `operator_edited`,
  `operator_skipped`, or `operator_stopped`;
- original proposed value when the operator edits;
- final value used for the OpenMRS write.

The field mapping status enum is extended from `succeeded` and `failed` to also
allow `skipped`. Optional fields skipped by the operator use
`status: "skipped"` and keep the existing selector/value context for audit
review.

Low-confidence decisions are not exceptions by themselves. They are audited
intervention points. Exceptions are written only when the operator stops the
record, the prompt fails, a required field cannot be confirmed, or later target
verification fails.

## Error Handling

If the operator confirms or edits a low-confidence field, the run continues and
the field mapping is recorded as succeeded with intervention metadata.

If the operator skips an optional field, the adapter records the mapping with
`status: "skipped"` and a clear skip reason, then continues the record.

If the operator stops the prompt, closes the page, the injected prompt fails,
or a required value cannot be supplied, the current record becomes a target
exception with `ui_state_unexpected`. The exception includes the field name,
proposed value, agent confidence, threshold, rationale, and latest screenshot
path when available.

Target save, duplicate, and verification handling remain unchanged after the
field-entry phase.

## Testing

Add focused tests around the OpenMRS adapter and configuration:

- high-confidence per-field agent approval fills normally without prompting;
- low-confidence required field prompts and fills the operator-confirmed value;
- low-confidence required field prompts and fills an operator-edited value;
- low-confidence optional field can be skipped and records audit metadata;
- prompt stop, timeout, or injection failure becomes a target exception;
- interactive confirmation forces effective OpenMRS concurrency to `1`;
- threshold config accepts values from `0` through `1` and rejects invalid
  values.

Update report or summary tests if the field mapping audit shape changes.
Update README and `docs/demo.md` because this changes OpenMRS target behavior
and manual validation steps.

Before claiming implementation complete, run:

```sh
npm run typecheck
npm test
git diff --check
```
