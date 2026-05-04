# OpenMRS Interactive Field Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional in-browser operator confirmation when the AI agent has low confidence in an OpenMRS field-entry decision.

**Architecture:** Keep deterministic OpenMRS field mappings, but gate each fill/select with a per-field `AgentDriver` decision when interactive confirmation is enabled. Below-threshold decisions inject a modal into the active OpenMRS page, use the operator-confirmed value, and write intervention metadata into existing audit artifacts.

**Tech Stack:** TypeScript, Zod, Commander, Playwright, Vitest, Electron-adjacent desktop handoff docs.

---

## File Structure

- Modify `src/config.ts`: add OpenMRS interactive confirmation config, threshold parsing, boolean env parsing, and effective concurrency forcing.
- Modify `src/cli.ts`: add run/watch CLI options and pass them into `buildRunConfig`.
- Modify `src/agent/types.ts`: add optional structured `metadata` on `AgentDecisionInput`.
- Modify `src/agent/openAiUiAgent.ts`: include `metadata` in the JSON sent to the Responses API.
- Modify `src/audit/auditStore.ts`: extend `ReportFieldMapping` with `skipped` status and intervention metadata.
- Modify `src/audit/summary.ts`: include intervention details in OpenMRS record review rows without changing the audit artifact contract.
- Modify `src/targets/openmrs/openMrsAdapter.ts`: add per-field agent approval, prompt injection, low-confidence handling, effective concurrency, and target exceptions for prompt failure.
- Modify `tests/config.test.ts`: cover new config defaults, env values, explicit options, threshold rejection, and concurrency forcing.
- Modify `tests/cli.test.ts`: cover CLI validation for threshold.
- Modify `tests/agent/openAiUiAgent.test.ts`: verify agent metadata is forwarded.
- Modify `tests/audit/auditStore.test.ts`: verify skipped/intervention field mapping metadata survives report output.
- Modify `tests/targets/openMrsAdapter.test.ts`: cover high-confidence, prompt confirm/edit/skip/stop, and concurrency forcing.
- Modify `README.md` and `docs/demo.md`: document the interactive OpenMRS target mode and manual validation expectations.

## Task 1: Config And CLI Options

**Files:**
- Modify: `src/config.ts`
- Modify: `src/cli.ts`
- Test: `tests/config.test.ts`
- Test: `tests/cli.test.ts`

- [ ] **Step 1: Write failing config tests**

Add the new env keys to `ENV_KEYS` in `tests/config.test.ts`:

```ts
const ENV_KEYS = [
  "RUNS_DIR",
  "OPENMRS_BASE_URL",
  "OPENMRS_USERNAME",
  "OPENMRS_PASSWORD",
  "OPENMRS_CONCURRENCY",
  "OPENMRS_INTERACTIVE_FIELD_CONFIRMATION",
  "OPENMRS_FIELD_CONFIDENCE_THRESHOLD",
] as const;
```

Add these tests inside the existing `describe("buildRunConfig", () => { })` block:

```ts
  it("defaults OpenMRS interactive field confirmation off with a 0.8 threshold", () => {
    const config = buildRunConfig({
      input: "data/demo/intake-records.json",
      targets: "openmrs",
    });

    expect(config.openMrs.interactiveFieldConfirmation).toBe(false);
    expect(config.openMrs.fieldConfidenceThreshold).toBe(0.8);
    expect(config.openMrs.concurrency).toBe(2);
  });

  it("uses OpenMRS interactive field confirmation environment defaults", () => {
    process.env.OPENMRS_INTERACTIVE_FIELD_CONFIRMATION = "yes";
    process.env.OPENMRS_FIELD_CONFIDENCE_THRESHOLD = "0.72";
    process.env.OPENMRS_CONCURRENCY = "4";

    const config = buildRunConfig({
      input: "data/demo/intake-records.json",
      targets: "openmrs",
    });

    expect(config.openMrs).toMatchObject({
      interactiveFieldConfirmation: true,
      fieldConfidenceThreshold: 0.72,
      concurrency: 1,
    });
  });

  it("uses explicit OpenMRS interactive options before environment defaults", () => {
    process.env.OPENMRS_INTERACTIVE_FIELD_CONFIRMATION = "false";
    process.env.OPENMRS_FIELD_CONFIDENCE_THRESHOLD = "0.95";

    const config = buildRunConfig({
      input: "data/demo/intake-records.json",
      targets: "openmrs",
      openMrsInteractiveFieldConfirmation: true,
      openMrsFieldConfidenceThreshold: 0.6,
      openMrsConcurrency: 3,
    });

    expect(config.openMrs.interactiveFieldConfirmation).toBe(true);
    expect(config.openMrs.fieldConfidenceThreshold).toBe(0.6);
    expect(config.openMrs.concurrency).toBe(1);
  });

  it("rejects OpenMRS field confidence thresholds outside 0 through 1", () => {
    expect(() =>
      buildRunConfig({
        input: "data/demo/intake-records.json",
        targets: "openmrs",
        openMrsFieldConfidenceThreshold: 1.01,
      }),
    ).toThrow();

    expect(() =>
      buildRunConfig({
        input: "data/demo/intake-records.json",
        targets: "openmrs",
        openMrsFieldConfidenceThreshold: -0.01,
      }),
    ).toThrow();
  });
```

Add this CLI test to `tests/cli.test.ts`:

```ts
  it("rejects invalid OpenMRS field confidence thresholds", async () => {
    const io = captureIo();

    const exitCode = await runCli(
      [
        "node",
        "agentic-ui",
        "run",
        "--input",
        "data/demo/intake-records-normalized.json",
        "--targets",
        "fake",
        "--parser",
        "deterministic",
        "--openmrs-field-confidence-threshold",
        "1.5",
      ],
      io,
    );

    expect(exitCode).toBe(1);
    expect(io.stdoutText()).toBe("");
    expect(io.stderrText()).toContain("--openmrs-field-confidence-threshold must be a number from 0 through 1.");
  });
```

- [ ] **Step 2: Run config and CLI tests to verify failure**

Run:

```sh
npm test -- tests/config.test.ts tests/cli.test.ts
```

Expected: failures for missing `interactiveFieldConfirmation`, `fieldConfidenceThreshold`, and unknown CLI option/parser.

- [ ] **Step 3: Implement config shape and parsing**

In `src/config.ts`, extend `CliRunConfigSchema.openMrs`:

```ts
  openMrs: z.object({
    baseUrl: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    concurrency: z.number().int().min(1).default(2),
    interactiveFieldConfirmation: z.boolean().default(false),
    fieldConfidenceThreshold: z.number().finite().min(0).max(1).default(0.8),
  }),
```

Extend `BuildRunConfigOptions`:

```ts
  openMrsInteractiveFieldConfirmation?: boolean;
  openMrsFieldConfidenceThreshold?: number;
```

Use these values inside `buildRunConfig`:

```ts
  const interactiveFieldConfirmation =
    options.openMrsInteractiveFieldConfirmation ?? booleanFromEnv(process.env.OPENMRS_INTERACTIVE_FIELD_CONFIRMATION) ?? false;
  const requestedOpenMrsConcurrency = options.openMrsConcurrency ?? numberFromEnv(process.env.OPENMRS_CONCURRENCY);

  return CliRunConfigSchema.parse({
    input: options.input,
    targets: parseTargets(options.targets),
    runsDir: options.runsDir ?? process.env.RUNS_DIR,
    agent: options.agent,
    parser: options.parser,
    parserModel: options.parserModel ?? process.env.OPENAI_PARSER_MODEL ?? process.env.OPENAI_MODEL,
    syntheticSuffix: options.syntheticSuffix,
    openMrs: {
      baseUrl: process.env.OPENMRS_BASE_URL ?? "https://o2.openmrs.org/openmrs",
      username: process.env.OPENMRS_USERNAME ?? "admin",
      password: process.env.OPENMRS_PASSWORD ?? "Admin123",
      concurrency: interactiveFieldConfirmation ? 1 : requestedOpenMrsConcurrency,
      interactiveFieldConfirmation,
      fieldConfidenceThreshold:
        options.openMrsFieldConfidenceThreshold ?? numberFromEnv(process.env.OPENMRS_FIELD_CONFIDENCE_THRESHOLD),
    },
  });
```

Add this helper below `numberFromEnv`:

```ts
function booleanFromEnv(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
```

- [ ] **Step 4: Implement CLI options**

In `src/cli.ts`, extend `RunCommandOptions` and `WatchCommandOptions`:

```ts
  openmrsInteractiveFieldConfirmation?: boolean;
  openmrsFieldConfidenceThreshold?: number;
```

Add both options to the `run` command and the `watch` command:

```ts
    .option("--openmrs-interactive-field-confirmation", "Prompt in the OpenMRS browser before low-confidence field entry.")
    .option(
      "--openmrs-field-confidence-threshold <threshold>",
      "Minimum AI confidence for OpenMRS field entry before prompting.",
      parseConfidenceThreshold,
    )
```

Pass them into `buildRunConfig` in `runCommand` and `watchCommand`:

```ts
    openMrsInteractiveFieldConfirmation: options.openmrsInteractiveFieldConfirmation,
    openMrsFieldConfidenceThreshold: options.openmrsFieldConfidenceThreshold,
```

Add this parser near `parsePositiveInteger`:

```ts
function parseConfidenceThreshold(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("--openmrs-field-confidence-threshold must be a number from 0 through 1.");
  }
  return parsed;
}
```

- [ ] **Step 5: Run focused tests**

Run:

```sh
npm test -- tests/config.test.ts tests/cli.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```sh
git add src/config.ts src/cli.ts tests/config.test.ts tests/cli.test.ts
git commit -m "feat: add OpenMRS field confirmation config"
```

## Task 2: Agent Metadata

**Files:**
- Modify: `src/agent/types.ts`
- Modify: `src/agent/openAiUiAgent.ts`
- Test: `tests/agent/openAiUiAgent.test.ts`

- [ ] **Step 1: Write failing metadata test**

Update `createInput` in `tests/agent/openAiUiAgent.test.ts` so it includes metadata:

```ts
function createInput(screenshotPath?: string, screenshotRootDir?: string) {
  return {
    target: "fake" as const,
    recordId: "demo-001",
    step: "save",
    visibleText: "Save patient",
    screenshotPath,
    screenshotRootDir,
    allowedActions: [
      { id: "click-save", description: "Click Save" },
      { id: "click-cancel", description: "Click Cancel" },
    ],
    metadata: {
      sourceField: "firstName",
      targetField: "Given Name",
      proposedValue: "Ava",
      required: true,
    },
  };
}
```

Update the expected JSON in the first test:

```ts
      metadata: {
        sourceField: "firstName",
        targetField: "Given Name",
        proposedValue: "Ava",
        required: true,
      },
```

- [ ] **Step 2: Run agent test to verify failure**

Run:

```sh
npm test -- tests/agent/openAiUiAgent.test.ts
```

Expected: the request JSON does not include `metadata`.

- [ ] **Step 3: Implement metadata support**

In `src/agent/types.ts`, add metadata to `AgentDecisionInput`:

```ts
  metadata?: Record<string, unknown>;
```

In `src/agent/openAiUiAgent.ts`, include it in `buildUserContent`:

```ts
    metadata: input.metadata ?? null,
```

- [ ] **Step 4: Run focused test**

Run:

```sh
npm test -- tests/agent/openAiUiAgent.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```sh
git add src/agent/types.ts src/agent/openAiUiAgent.ts tests/agent/openAiUiAgent.test.ts
git commit -m "feat: pass structured agent decision metadata"
```

## Task 3: Audit Field Mapping Metadata

**Files:**
- Modify: `src/audit/auditStore.ts`
- Modify: `src/audit/summary.ts`
- Test: `tests/audit/auditStore.test.ts`

- [ ] **Step 1: Write failing audit test**

Add this test in `tests/audit/auditStore.test.ts` near the existing field mapping report tests:

```ts
  it("preserves OpenMRS field confirmation metadata in reports", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-field-confirmation-"));
    const store = await FileAuditStore.create({ runsDir: root, runId: "run-test" });

    await store.writeFieldMapping({
      recordId: "demo-001",
      target: "openmrs",
      sourceField: "phone",
      targetField: "Phone Number",
      normalizedValue: "+13125550198",
      mappingConfidence: 0.99,
      selectorCandidates: ['input[name="phoneNumber"]'],
      selectedSelector: 'input[name="phoneNumber"]',
      action: "fill",
      status: "succeeded",
      agentConfidence: 0.62,
      confidenceThreshold: 0.8,
      agentRationale: "The visible label could refer to another contact field.",
      approvalSource: "operator_edited",
      originalProposedValue: "+13125550198",
      finalValue: "+13125550999",
    });

    await store.writeFieldMapping({
      recordId: "demo-001",
      target: "openmrs",
      sourceField: "streetAddress",
      targetField: "Address Line 1",
      normalizedValue: "1200 West Lake Street",
      mappingConfidence: 0.98,
      selectorCandidates: ['input[name="address1"]'],
      status: "skipped",
      agentConfidence: 0.55,
      confidenceThreshold: 0.8,
      agentRationale: "The optional address field was not clearly visible.",
      approvalSource: "operator_skipped",
      skipReason: "Operator skipped optional field.",
    });

    const report = store.buildReport({
      status: "completed",
      totalRecords: 1,
      preflightExceptions: 0,
      environmentExceptions: 0,
      closeExceptions: 0,
      targetCounts: { openmrs: { succeeded: 1, exception: 0, skipped: 0 } },
    });

    expect(report.details.fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "phone",
        approvalSource: "operator_edited",
        originalProposedValue: "+13125550198",
        finalValue: "+13125550999",
      }),
    );
    expect(report.details.fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "streetAddress",
        status: "skipped",
        approvalSource: "operator_skipped",
        skipReason: "Operator skipped optional field.",
      }),
    );
  });
```

- [ ] **Step 2: Run audit test to verify failure**

Run:

```sh
npm test -- tests/audit/auditStore.test.ts
```

Expected: TypeScript or test failure because `status: "skipped"` and intervention fields are not accepted.

- [ ] **Step 3: Extend audit types**

In `src/audit/auditStore.ts`, add the approval source type and extend `ReportFieldMapping`:

```ts
export type ReportFieldMappingStatus = "succeeded" | "failed" | "skipped";
export type ReportFieldApprovalSource =
  | "agent"
  | "operator_confirmed"
  | "operator_edited"
  | "operator_skipped"
  | "operator_stopped";
```

Update `ReportFieldMapping`:

```ts
  status: ReportFieldMappingStatus;
  agentConfidence?: number;
  confidenceThreshold?: number;
  agentRationale?: string;
  approvalSource?: ReportFieldApprovalSource;
  originalProposedValue?: string;
  finalValue?: string;
  skipReason?: string;
```

- [ ] **Step 4: Add summary rendering for intervention context**

In `src/audit/summary.ts`, update the OpenMRS mapping row helper to include the existing status and intervention metadata. Locate `openMrsMappingRows` and add the new fields to the rendered row. If the current table has no room, append concise text to the existing status/error column using this helper:

```ts
function mappingIntervention(mapping: ReportFieldMapping): string {
  const parts = [
    mapping.approvalSource,
    mapping.agentConfidence === undefined ? undefined : `agent ${Math.round(mapping.agentConfidence * 100)}%`,
    mapping.confidenceThreshold === undefined ? undefined : `threshold ${Math.round(mapping.confidenceThreshold * 100)}%`,
    mapping.finalValue && mapping.finalValue !== mapping.normalizedValue ? `final ${mapping.finalValue}` : undefined,
    mapping.skipReason,
  ].filter((value): value is string => Boolean(value));
  return parts.join("; ");
}
```

Use `mappingIntervention(mapping)` in the OpenMRS record review table so operator interventions are visible in `summary.md`.

- [ ] **Step 5: Run focused audit tests**

Run:

```sh
npm test -- tests/audit/auditStore.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```sh
git add src/audit/auditStore.ts src/audit/summary.ts tests/audit/auditStore.test.ts
git commit -m "feat: record OpenMRS field confirmation audit metadata"
```

## Task 4: High-Confidence OpenMRS Field Approval

**Files:**
- Modify: `src/targets/openmrs/openMrsAdapter.ts`
- Test: `tests/targets/openMrsAdapter.test.ts`

- [ ] **Step 1: Add high-confidence adapter test**

In `tests/targets/openMrsAdapter.test.ts`, add a test after the existing success test:

```ts
  it("asks the agent to approve each OpenMRS field when interactive confirmation is enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-field-approval-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage();
    const adapter = new OpenMrsAdapter(
      {
        ...openMrsConfig(),
        interactiveFieldConfirmation: true,
        fieldConfidenceThreshold: 0.8,
      },
      {
        launchBrowser: async () => new FakeOpenMrsBrowser(page),
      },
    );
    const fieldDecisions = openMrsFieldMappings(record("demo-001")).map((mapping) => ({
      actionId: `fill-openmrs-field:${mapping.targetField}`,
      confidence: 0.91,
      rationale: `The ${mapping.targetField} field is visible.`,
    }));
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      ...fieldDecisions,
      { actionId: "save-patient", confidence: 0.88, rationale: "The registration fields are filled." },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "openmrs-demo-001" });
    expect(agent.inputs.some((input) => input.step === "fill-openmrs-field:Given Name")).toBe(true);
    expect(agent.inputs.find((input) => input.step === "fill-openmrs-field:Given Name")).toMatchObject({
      target: "openmrs",
      recordId: "demo-001",
      metadata: {
        sourceField: "firstName",
        targetField: "Given Name",
        proposedValue: "Ava",
        required: true,
      },
    });
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "firstName",
        targetField: "Given Name",
        status: "succeeded",
        agentConfidence: 0.91,
        confidenceThreshold: 0.8,
        approvalSource: "agent",
        finalValue: "Ava",
      }),
    );
  });
```

- [ ] **Step 2: Run OpenMRS adapter test to verify failure**

Run:

```sh
npm test -- tests/targets/openMrsAdapter.test.ts
```

Expected: failure because interactive config and per-field agent decisions are not implemented.

- [ ] **Step 3: Extend OpenMRS config and concurrency**

In `src/targets/openmrs/openMrsAdapter.ts`, extend `OpenMrsConfig`:

```ts
  interactiveFieldConfirmation?: boolean;
  fieldConfidenceThreshold?: number;
```

Set `maxConcurrency` with an effective helper:

```ts
    this.maxConcurrency = effectiveOpenMrsConcurrency(config);
```

Add helpers:

```ts
function effectiveOpenMrsConcurrency(config: OpenMrsConfig): number {
  if (config.interactiveFieldConfirmation) return 1;
  return normalizeConcurrency(config.concurrency);
}

function fieldConfidenceThreshold(config: OpenMrsConfig): number {
  const value = config.fieldConfidenceThreshold;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.8;
}
```

Update `resolveOpenMrsConfig` to preserve the new fields:

```ts
    concurrency: effectiveOpenMrsConcurrency(config),
    interactiveFieldConfirmation: config.interactiveFieldConfirmation ?? false,
    fieldConfidenceThreshold: fieldConfidenceThreshold(config),
```

- [ ] **Step 4: Add field approval types and high-confidence path**

Add these interfaces near `FillResult`:

```ts
interface ApprovedFieldMapping {
  value: string;
  approvalSource: "agent" | "operator_confirmed" | "operator_edited" | "operator_skipped" | "operator_stopped";
  agentConfidence: number;
  confidenceThreshold: number;
  agentRationale: string;
  originalProposedValue?: string;
  skipReason?: string;
}
```

Add this helper:

```ts
async function approveMappedField(
  context: TargetRunContext,
  page: OpenMrsPage,
  mapping: FieldMapping,
  config: OpenMrsConfig,
): Promise<ApprovedFieldMapping> {
  const threshold = fieldConfidenceThreshold(config);
  if (!config.interactiveFieldConfirmation) {
    return {
      value: mapping.value,
      approvalSource: "agent",
      agentConfidence: 1,
      confidenceThreshold: threshold,
      agentRationale: "Interactive OpenMRS field confirmation is disabled.",
    };
  }

  const reviewScreenshot = await page.screenshot({ fullPage: true });
  const reviewScreenshotPath = await context.audit.writeScreenshot(
    context.record.sourceRecordId,
    "openmrs",
    `field-review-${safeStepName(mapping.targetField)}`,
    reviewScreenshot,
  );
  const decision = await context.agent.decide({
    target: "openmrs",
    recordId: context.record.sourceRecordId,
    step: `fill-openmrs-field:${mapping.targetField}`,
    screenshotPath: reviewScreenshotPath,
    visibleText: await visibleText(page),
    allowedActions: [
      {
        id: `fill-openmrs-field:${mapping.targetField}`,
        description: `Fill OpenMRS ${mapping.targetField} with ${mapping.value}.`,
      },
    ],
    metadata: {
      sourceField: mapping.sourceField,
      targetField: mapping.targetField,
      proposedValue: mapping.value,
      selectorCandidates: mapping.selectors,
      required: mapping.required === true,
      mappingConfidence: mapping.mappingConfidence,
    },
  });

  if (decision.actionId === `fill-openmrs-field:${mapping.targetField}` && decision.confidence >= threshold) {
    return {
      value: mapping.value,
      approvalSource: "agent",
      agentConfidence: decision.confidence,
      confidenceThreshold: threshold,
      agentRationale: decision.rationale,
    };
  }

  return promptForMappedField(context, page, mapping, decision, threshold, reviewScreenshotPath);
}
```

Add a safe step-name helper:

```ts
function safeStepName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "field";
}
```

For this task, add a temporary `promptForMappedField` implementation that throws. Task 5 replaces it with the real prompt:

```ts
async function promptForMappedField(
  _context: TargetRunContext,
  _page: OpenMrsPage,
  mapping: FieldMapping,
  decision: { confidence: number; rationale: string },
  threshold: number,
  screenshotPath: string,
): Promise<ApprovedFieldMapping> {
  throw {
    code: "ui_state_unexpected",
    severity: "error",
    field: String(mapping.sourceField),
    message: `OpenMRS field ${mapping.targetField} requires operator confirmation.`,
    suggestedRemediation: decision.rationale,
    screenshotPath,
    proposedValue: mapping.value,
    agentConfidence: decision.confidence,
    confidenceThreshold: threshold,
  };
}
```

- [ ] **Step 5: Use approval in `fillMappedField`**

Change the call site in `runRecord`:

```ts
      for (const mapping of openMrsFieldMappings(context.record)) {
        await fillMappedField(context, page, mapping, this.config);
      }
```

Update `fillMappedField`:

```ts
async function fillMappedField(context: TargetRunContext, page: OpenMrsPage, mapping: FieldMapping, config: OpenMrsConfig): Promise<void> {
  let approval: ApprovedFieldMapping | undefined;
  try {
    await revealField(page, mapping.selectors, mapping.targetField);
    approval = await approveMappedField(context, page, mapping, config);
    const result = await fillFirst(page, mapping.selectors, approval.value, mapping.targetField);
    await context.audit.writeFieldMapping({
      recordId: context.record.sourceRecordId,
      target: "openmrs",
      sourceField: mapping.sourceField,
      targetField: mapping.targetField,
      normalizedValue: mapping.value,
      mappingConfidence: mapping.mappingConfidence,
      selectorCandidates: mapping.selectors,
      selectedSelector: result.selectedSelector,
      action: result.action,
      status: "succeeded",
      agentConfidence: approval.agentConfidence,
      confidenceThreshold: approval.confidenceThreshold,
      agentRationale: approval.agentRationale,
      approvalSource: approval.approvalSource,
      originalProposedValue: approval.originalProposedValue,
      finalValue: approval.value,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await context.audit.writeFieldMapping({
      recordId: context.record.sourceRecordId,
      target: "openmrs",
      sourceField: mapping.sourceField,
      targetField: mapping.targetField,
      normalizedValue: mapping.value,
      mappingConfidence: mapping.mappingConfidence,
      selectorCandidates: mapping.selectors,
      status: "failed",
      errorMessage,
      agentConfidence: approval?.agentConfidence,
      confidenceThreshold: approval?.confidenceThreshold,
      agentRationale: approval?.agentRationale,
      approvalSource: approval?.approvalSource,
      originalProposedValue: approval?.originalProposedValue,
      finalValue: approval?.value,
    });
    if (!mapping.required) {
      return;
    }
    throw error;
  }
}
```

- [ ] **Step 6: Run focused OpenMRS test**

Run:

```sh
npm test -- tests/targets/openMrsAdapter.test.ts
```

Expected: existing tests and the high-confidence test pass.

- [ ] **Step 7: Commit**

```sh
git add src/targets/openmrs/openMrsAdapter.ts tests/targets/openMrsAdapter.test.ts
git commit -m "feat: approve OpenMRS field fills with agent confidence"
```

## Task 5: Browser Operator Prompt

**Files:**
- Modify: `src/targets/openmrs/openMrsAdapter.ts`
- Test: `tests/targets/openMrsAdapter.test.ts`

- [ ] **Step 1: Extend fake page support for prompt injection**

In `tests/targets/openMrsAdapter.test.ts`, extend `FakeOpenMrsPage`:

```ts
  readonly evaluations: unknown[] = [];
  promptResults: unknown[] = [];
```

Add `promptResults?: unknown[]` to the constructor options and initialize it:

```ts
    this.promptResults = [...(options.promptResults ?? [])];
```

Add this method to `FakeOpenMrsPage`:

```ts
  async evaluate<T>(_pageFunction: (input: unknown) => Promise<T> | T, input: unknown): Promise<T> {
    this.evaluations.push(input);
    const result = this.promptResults.shift();
    if (result instanceof Error) {
      throw result;
    }
    return result as T;
  }
```

Add `evaluate` to the `OpenMrsPage` interface in `src/targets/openmrs/openMrsAdapter.ts`:

```ts
  evaluate<T, Arg>(pageFunction: (input: Arg) => T | Promise<T>, arg: Arg): Promise<T>;
```

- [ ] **Step 2: Write low-confidence confirm/edit/skip/stop tests**

Add a helper in `tests/targets/openMrsAdapter.test.ts`:

```ts
function fieldDecisionsWithFirstLowConfidence() {
  return openMrsFieldMappings(record("demo-001")).map((mapping, index) => ({
    actionId: `fill-openmrs-field:${mapping.targetField}`,
    confidence: index === 0 ? 0.61 : 0.91,
    rationale: index === 0 ? "The first field needs confirmation." : `The ${mapping.targetField} field is visible.`,
  }));
}
```

Add this required confirm test:

```ts
  it("prompts and fills a confirmed low-confidence required OpenMRS field", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-field-confirmed-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      promptResults: [{ action: "confirm", value: "Ava" }],
    });
    const adapter = new OpenMrsAdapter(
      { ...openMrsConfig(), interactiveFieldConfirmation: true, fieldConfidenceThreshold: 0.8 },
      { launchBrowser: async () => new FakeOpenMrsBrowser(page) },
    );
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      ...fieldDecisionsWithFirstLowConfidence(),
      { actionId: "save-patient", confidence: 0.88, rationale: "The registration fields are filled." },
    ]);

    await adapter.prepare();
    await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(page.evaluations[0]).toMatchObject({
      targetField: "Given Name",
      proposedValue: "Ava",
      required: true,
      confidence: 0.61,
      threshold: 0.8,
    });
    expect(page.filled).toContainEqual({ selector: 'input[name="givenName"]', value: "Ava" });
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "firstName",
        approvalSource: "operator_confirmed",
        agentConfidence: 0.61,
        finalValue: "Ava",
      }),
    );
  });
```

Add this edit test:

```ts
  it("fills an operator-edited low-confidence required OpenMRS field", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-field-edited-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      promptResults: [{ action: "edit", value: "Avery" }],
    });
    const adapter = new OpenMrsAdapter(
      { ...openMrsConfig(), interactiveFieldConfirmation: true, fieldConfidenceThreshold: 0.8 },
      { launchBrowser: async () => new FakeOpenMrsBrowser(page) },
    );
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      ...fieldDecisionsWithFirstLowConfidence(),
      { actionId: "save-patient", confidence: 0.88, rationale: "The registration fields are filled." },
    ]);

    await adapter.prepare();
    await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(page.filled).toContainEqual({ selector: 'input[name="givenName"]', value: "Avery" });
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "firstName",
        approvalSource: "operator_edited",
        originalProposedValue: "Ava",
        finalValue: "Avery",
      }),
    );
  });
```

Add an optional skip test by making the first optional field low confidence. Use street address, index `6` in the current mapping list:

```ts
  it("skips a low-confidence optional OpenMRS field when the operator chooses skip", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-field-skipped-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      promptResults: [{ action: "skip", value: "" }],
    });
    const adapter = new OpenMrsAdapter(
      { ...openMrsConfig(), interactiveFieldConfirmation: true, fieldConfidenceThreshold: 0.8 },
      { launchBrowser: async () => new FakeOpenMrsBrowser(page) },
    );
    const decisions = openMrsFieldMappings(record("demo-001")).map((mapping, index) => ({
      actionId: `fill-openmrs-field:${mapping.targetField}`,
      confidence: index === 6 ? 0.61 : 0.91,
      rationale: index === 6 ? "The optional address field needs confirmation." : `The ${mapping.targetField} field is visible.`,
    }));
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      ...decisions,
      { actionId: "save-patient", confidence: 0.88, rationale: "The registration fields are filled." },
    ]);

    await adapter.prepare();
    await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(page.filled).not.toContainEqual({ selector: 'input[name="address1"]', value: "1200 West Lake Street" });
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "streetAddress",
        status: "skipped",
        approvalSource: "operator_skipped",
        skipReason: "Operator skipped optional OpenMRS field.",
      }),
    );
  });
```

Add this stop test:

```ts
  it("returns a target exception when the operator stops a low-confidence field prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-field-stopped-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      promptResults: [{ action: "stop", value: "" }],
    });
    const adapter = new OpenMrsAdapter(
      { ...openMrsConfig(), interactiveFieldConfirmation: true, fieldConfidenceThreshold: 0.8 },
      { launchBrowser: async () => new FakeOpenMrsBrowser(page) },
    );
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      ...fieldDecisionsWithFirstLowConfidence(),
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toEqual({
      status: "exception",
      exception: expect.objectContaining({
        code: "ui_state_unexpected",
        field: "firstName",
        proposedValue: "Ava",
        agentConfidence: 0.61,
        confidenceThreshold: 0.8,
      }),
    });
  });
```

Add this prompt-failure test:

```ts
  it("returns a target exception when field prompt injection fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-field-prompt-failed-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      promptResults: [new Error("Prompt script failed")],
    });
    const adapter = new OpenMrsAdapter(
      { ...openMrsConfig(), interactiveFieldConfirmation: true, fieldConfidenceThreshold: 0.8 },
      { launchBrowser: async () => new FakeOpenMrsBrowser(page) },
    );
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      ...fieldDecisionsWithFirstLowConfidence(),
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toEqual({
      status: "exception",
      exception: expect.objectContaining({
        code: "ui_state_unexpected",
        field: "firstName",
        message: "OpenMRS field confirmation prompt failed.",
        proposedValue: "Ava",
        agentConfidence: 0.61,
        confidenceThreshold: 0.8,
      }),
    });
  });
```

- [ ] **Step 3: Run OpenMRS tests to verify failure**

Run:

```sh
npm test -- tests/targets/openMrsAdapter.test.ts
```

Expected: failures for missing prompt behavior and fake page evaluate support.

- [ ] **Step 4: Add prompt result types**

In `src/targets/openmrs/openMrsAdapter.ts`, add:

```ts
type OperatorPromptAction = "confirm" | "edit" | "skip" | "stop";

interface OperatorPromptResult {
  action: OperatorPromptAction;
  value: string;
}

interface OperatorPromptInput {
  sourceField: string;
  targetField: string;
  proposedValue: string;
  required: boolean;
  confidence: number;
  threshold: number;
  rationale: string;
}

interface FieldSkippedError {
  kind: "field-skipped";
  approval: ApprovedFieldMapping;
}
```

Add this timeout constant near `OPENMRS_ACTION_TIMEOUT_MS`:

```ts
const OPENMRS_FIELD_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;
```

Add guards:

```ts
function isOperatorPromptResult(value: unknown): value is OperatorPromptResult {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Record<string, unknown>;
  return ["confirm", "edit", "skip", "stop"].includes(String(input.action)) && typeof input.value === "string";
}

function isFieldSkippedError(value: unknown): value is FieldSkippedError {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "field-skipped";
}
```

- [ ] **Step 5: Implement browser prompt**

Replace `promptForMappedField` with:

```ts
async function promptForMappedField(
  context: TargetRunContext,
  page: OpenMrsPage,
  mapping: FieldMapping,
  decision: { confidence: number; rationale: string },
  threshold: number,
  screenshotPath: string,
): Promise<ApprovedFieldMapping> {
  const input: OperatorPromptInput = {
    sourceField: String(mapping.sourceField),
    targetField: mapping.targetField,
    proposedValue: mapping.value,
    required: mapping.required === true,
    confidence: decision.confidence,
    threshold,
    rationale: decision.rationale,
  };

  let result: unknown;
  try {
    result = await withFieldPromptTimeout(page.evaluate(showOpenMrsFieldConfirmationPrompt, input));
  } catch {
    return stopFieldMapping(mapping, decision, threshold, screenshotPath, "OpenMRS field confirmation prompt failed.");
  }

  if (!isOperatorPromptResult(result)) {
    return stopFieldMapping(mapping, decision, threshold, screenshotPath, "OpenMRS field confirmation prompt returned an invalid response.");
  }

  if (result.action === "confirm") {
    return {
      value: mapping.value,
      approvalSource: "operator_confirmed",
      agentConfidence: decision.confidence,
      confidenceThreshold: threshold,
      agentRationale: decision.rationale,
    };
  }

  if (result.action === "edit") {
    const value = result.value.trim();
    if (mapping.required && value.length === 0) {
      return stopFieldMapping(mapping, decision, threshold, screenshotPath, "Required OpenMRS field confirmation returned a blank value.");
    }
    return {
      value,
      approvalSource: value === mapping.value ? "operator_confirmed" : "operator_edited",
      agentConfidence: decision.confidence,
      confidenceThreshold: threshold,
      agentRationale: decision.rationale,
      originalProposedValue: mapping.value,
    };
  }

  if (result.action === "skip" && !mapping.required) {
    throw {
      kind: "field-skipped",
      approval: {
        value: mapping.value,
        approvalSource: "operator_skipped",
        agentConfidence: decision.confidence,
        confidenceThreshold: threshold,
        agentRationale: decision.rationale,
        skipReason: "Operator skipped optional OpenMRS field.",
      },
    } satisfies FieldSkippedError;
  }

  return stopFieldMapping(mapping, decision, threshold, screenshotPath, "Operator stopped OpenMRS field confirmation.");
}
```

Add this exception helper:

```ts
function stopFieldMapping(
  mapping: FieldMapping,
  decision: { confidence: number; rationale: string },
  threshold: number,
  screenshotPath: string,
  message: string,
): ApprovedFieldMapping {
  throw {
    code: "ui_state_unexpected",
    severity: "error",
    field: String(mapping.sourceField),
    message,
    suggestedRemediation: decision.rationale,
    screenshotPath,
    proposedValue: mapping.value,
    targetField: mapping.targetField,
    agentConfidence: decision.confidence,
    confidenceThreshold: threshold,
  } satisfies ValidationException & Record<string, unknown>;
}
```

Add this timeout helper:

```ts
function withFieldPromptTimeout<T>(prompt: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("OpenMRS field confirmation prompt timed out.")), OPENMRS_FIELD_CONFIRMATION_TIMEOUT_MS);
  });
  return Promise.race([prompt, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}
```

Add the browser-side prompt function:

```ts
async function showOpenMrsFieldConfirmationPrompt(input: OperatorPromptInput): Promise<OperatorPromptResult> {
  const existing = document.getElementById("agentic-openmrs-field-confirmation");
  existing?.remove();

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.id = "agentic-openmrs-field-confirmation";
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.zIndex = "2147483647";
    overlay.style.background = "rgba(0, 0, 0, 0.45)";
    overlay.style.display = "grid";
    overlay.style.placeItems = "center";
    overlay.style.fontFamily = "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";

    const dialog = document.createElement("form");
    dialog.style.width = "min(520px, calc(100vw - 32px))";
    dialog.style.background = "#fff";
    dialog.style.color = "#111";
    dialog.style.border = "1px solid #888";
    dialog.style.borderRadius = "8px";
    dialog.style.padding = "16px";
    dialog.style.boxShadow = "0 12px 36px rgba(0, 0, 0, 0.35)";

    const title = document.createElement("h2");
    title.textContent = `Confirm ${input.targetField}`;
    title.style.margin = "0 0 12px";
    title.style.fontSize = "18px";

    const details = document.createElement("p");
    details.textContent = `${input.sourceField} -> ${input.targetField}. Confidence ${Math.round(input.confidence * 100)}%, threshold ${Math.round(input.threshold * 100)}%. ${input.rationale}`;
    details.style.margin = "0 0 12px";

    const label = document.createElement("label");
    label.textContent = "Value";
    label.style.display = "grid";
    label.style.gap = "6px";

    const inputBox = document.createElement("input");
    inputBox.name = "value";
    inputBox.value = input.proposedValue;
    inputBox.style.font = "inherit";
    inputBox.style.padding = "8px";
    inputBox.style.border = "1px solid #777";
    inputBox.style.borderRadius = "4px";
    label.append(inputBox);

    const error = document.createElement("div");
    error.style.minHeight = "20px";
    error.style.color = "#9f1239";
    error.style.marginTop = "8px";

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "8px";
    actions.style.justifyContent = "flex-end";
    actions.style.marginTop = "16px";

    const finish = (action: OperatorPromptAction) => {
      const value = inputBox.value.trim();
      if (input.required && action !== "stop" && value.length === 0) {
        error.textContent = "Required fields need a value.";
        return;
      }
      overlay.remove();
      resolve({ action, value });
    };

    for (const [action, text] of [
      ["confirm", "Confirm"],
      ["edit", "Use Edited Value"],
      ["skip", "Skip"],
      ["stop", "Stop Record"],
    ] as Array<[OperatorPromptAction, string]>) {
      if (action === "skip" && input.required) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      button.style.font = "inherit";
      button.style.padding = "8px 10px";
      button.addEventListener("click", () => finish(action));
      actions.append(button);
    }

    dialog.append(title, details, label, error, actions);
    overlay.append(dialog);
    document.body.append(overlay);
    inputBox.focus();
  });
}
```

- [ ] **Step 6: Handle skipped fields in `fillMappedField`**

At the top of the `catch` block in `fillMappedField`, add:

```ts
    if (isFieldSkippedError(error)) {
      await context.audit.writeFieldMapping({
        recordId: context.record.sourceRecordId,
        target: "openmrs",
        sourceField: mapping.sourceField,
        targetField: mapping.targetField,
        normalizedValue: mapping.value,
        mappingConfidence: mapping.mappingConfidence,
        selectorCandidates: mapping.selectors,
        status: "skipped",
        agentConfidence: error.approval.agentConfidence,
        confidenceThreshold: error.approval.confidenceThreshold,
        agentRationale: error.approval.agentRationale,
        approvalSource: error.approval.approvalSource,
        finalValue: mapping.value,
        skipReason: error.approval.skipReason,
      });
      return;
    }
```

- [ ] **Step 7: Convert prompt exceptions into target exceptions**

Wrap the field fill loop in `runRecord`:

```ts
      try {
        for (const mapping of openMrsFieldMappings(context.record)) {
          await fillMappedField(context, page, mapping, this.config);
        }
      } catch (error) {
        if (isValidationExceptionLike(error)) {
          await writeTargetIssue(context, error);
          return {
            status: "exception",
            exception: error,
          };
        }
        throw error;
      }
```

Add the guard:

```ts
function isValidationExceptionLike(value: unknown): value is ValidationException & Record<string, unknown> {
  return typeof value === "object" && value !== null && "code" in value && "message" in value;
}
```

- [ ] **Step 8: Run OpenMRS adapter tests**

Run:

```sh
npm test -- tests/targets/openMrsAdapter.test.ts
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```sh
git add src/targets/openmrs/openMrsAdapter.ts tests/targets/openMrsAdapter.test.ts
git commit -m "feat: prompt for low-confidence OpenMRS fields"
```

## Task 6: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/demo.md`

- [ ] **Step 1: Update README OpenMRS configuration**

In `README.md`, add these variables to the OpenMRS `.env` example:

```dotenv
OPENMRS_INTERACTIVE_FIELD_CONFIRMATION=false
OPENMRS_FIELD_CONFIDENCE_THRESHOLD=0.8
```

In the CLI options section, add:

```md
- `--openmrs-interactive-field-confirmation`: prompts in the active OpenMRS
  browser before writing fields whose per-field AI confidence is below the
  configured threshold. When enabled, OpenMRS concurrency is forced to `1`.
- `--openmrs-field-confidence-threshold`: minimum per-field AI confidence for
  OpenMRS field writes before prompting. Defaults to
  `OPENMRS_FIELD_CONFIDENCE_THRESHOLD`, then `0.8`.
```

- [ ] **Step 2: Update README OpenMRS target behavior**

In "What The OpenMRS Target Does", insert this step after opening the registration app:

```md
4. When interactive field confirmation is enabled, ask the UI agent to approve
   each field write and prompt the operator in the OpenMRS browser before
   writing low-confidence values.
```

Renumber the remaining list in Markdown by using `1.` for every item or by updating the numbers directly.

- [ ] **Step 3: Update demo guide**

In `docs/demo.md`, add this note near the OpenMRS success criteria:

```md
Interactive field confirmation is optional. When
`--openmrs-interactive-field-confirmation` is set, each OpenMRS browser session
can pause before low-confidence field writes. Confirm, edit, skip optional
fields, or stop the record from the in-browser prompt. This mode forces
OpenMRS concurrency to `1` so prompts remain tied to one active record.
```

- [ ] **Step 4: Run markdown diff check**

Run:

```sh
git diff --check -- README.md docs/demo.md
```

Expected: no whitespace errors.

- [ ] **Step 5: Commit**

```sh
git add README.md docs/demo.md
git commit -m "docs: describe OpenMRS field confirmation"
```

## Task 7: Full Verification

**Files:**
- No source edits expected.

- [ ] **Step 1: Run typecheck**

Run:

```sh
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 2: Run full test suite**

Run:

```sh
npm test
```

Expected: exits 0.

- [ ] **Step 3: Run diff whitespace check**

Run:

```sh
git diff --check
```

Expected: exits 0.

- [ ] **Step 4: Inspect final diff**

Run:

```sh
git status --short
git log --oneline -5
```

Expected: only intended implementation files are modified or committed for this feature. Existing unrelated local files may still be present and must remain untouched.
