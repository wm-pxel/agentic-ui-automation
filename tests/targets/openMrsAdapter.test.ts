import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileAuditStore } from "../../src/audit/auditStore.js";
import type { AgentDecision, AgentDecisionInput, AgentDriver } from "../../src/agent/types.js";
import type { NormalizedIntakeRecord } from "../../src/domain/schema.js";
import { OpenMrsAdapter } from "../../src/targets/openmrs/openMrsAdapter.js";
import {
  OPENMRS_LOGIN_SELECTORS,
  OPENMRS_NEXT_CANDIDATES,
  OPENMRS_SAVE_CANDIDATES,
  openMrsFieldMappings,
} from "../../src/targets/openmrs/selectors.js";

describe("OpenMRS selectors", () => {
  it("maps normalized intake fields to OpenMRS registration selector candidates", () => {
    const mappings = openMrsFieldMappings(record("demo-001"));

    expect(mappings.map((mapping) => mapping.value)).toEqual([
      "Ava",
      "Nguyen",
      "Female",
      "14",
      "March",
      "1987",
      "1200 West Lake Street",
      "Chicago",
      "Illinois",
      "60607",
      "+13125550198",
    ]);
    expect(mappings.map((mapping) => [mapping.sourceField, mapping.targetField])).toEqual([
      ["firstName", "Given Name"],
      ["lastName", "Family Name"],
      ["sexOrGender", "Gender"],
      ["dateOfBirth", "Birthdate Day"],
      ["dateOfBirth", "Birthdate Month"],
      ["dateOfBirth", "Birthdate Year"],
      ["streetAddress", "Address Line 1"],
      ["city", "City/Village"],
      ["state", "State/Province"],
      ["zip", "Postal Code"],
      ["phone", "Phone Number"],
    ]);
    expect(mappings[0].selectors).toEqual(['input[name="givenName"]']);
    expect(mappings[2].selectors).toEqual(['select[name="gender"]', "#gender-field"]);
    expect(OPENMRS_LOGIN_SELECTORS).toEqual({
      username: ['input[name="username"]', "#username"],
      password: ['input[name="password"]', "#password"],
      location: ['#Registration\\ Desk', '#sessionLocation li:has-text("Registration Desk")', "#sessionLocation li"],
      submit: ["#loginButton", 'input[value="Log In"]', 'button:has-text("Log In")'],
    });
    expect(OPENMRS_NEXT_CANDIDATES).toEqual(["#next-button", 'button:has-text("Next")']);
    expect(OPENMRS_SAVE_CANDIDATES).toEqual(["#submit", 'input[value="Confirm"]']);
  });
});

describe("OpenMrsAdapter", () => {
  it("defaults to two concurrent OpenMRS sessions", () => {
    expect(new OpenMrsAdapter({}).maxConcurrency).toBe(2);
  });

  it("caps eager OpenMRS sessions to the planned record count", async () => {
    const launches: unknown[] = [];
    const adapter = new OpenMrsAdapter({ concurrency: 2 }, {
      launchBrowser: async (options: unknown) => {
        launches.push(options);
        return new FakeOpenMrsBrowser(new FakeOpenMrsPage({ availableSelectors: loginSelectors() }));
      },
    });
    await adapter.prepare({ plannedRecords: 1 });
    await adapter.close();

    expect(launches).toHaveLength(1);
  });

  it("uses the official OpenMRS O2 demo defaults and submits the login form", async () => {
    const page = new FakeOpenMrsPage({ availableSelectors: loginSelectors() });
    const browser = new FakeOpenMrsBrowser(page);
    const launchOptions: unknown[] = [];
    const adapter = new OpenMrsAdapter({ concurrency: 1 }, {
      launchBrowser: async (options: unknown) => {
        launchOptions.push(options);
        return browser;
      },
    });

    await adapter.prepare();
    await adapter.close();

    expect(launchOptions[0]).toMatchObject({
      headless: false,
      chromiumSandbox: true,
      env: {},
    });
    expect(page.gotos).toEqual([{ url: "https://o2.openmrs.org/openmrs/login.htm", options: { waitUntil: "domcontentloaded" } }]);
    expect(page.filled).toEqual([
      { selector: 'input[name="username"]', value: "admin" },
      { selector: 'input[name="password"]', value: "Admin123" },
    ]);
    expect(page.clicked).toEqual(['#Registration\\ Desk', "#loginButton"]);
    expect(browser.closed).toBe(true);
  });

  it("maps the official demo landing page URL to the O2 demo app", async () => {
    const page = new FakeOpenMrsPage({ availableSelectors: loginSelectors() });
    const adapter = new OpenMrsAdapter({ baseUrl: "https://openmrs.org/demo/", concurrency: 1 }, {
      launchBrowser: async () => new FakeOpenMrsBrowser(page),
    });

    await adapter.prepare();
    await adapter.close();

    expect(page.gotos[0]).toEqual({ url: "https://o2.openmrs.org/openmrs/login.htm", options: { waitUntil: "domcontentloaded" } });
  });

  it("returns a UI-state exception when the agent rejects new-patient navigation", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-nav-rejected-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = new FakeOpenMrsPage({
      availableSelectors: loginSelectors(),
      bodyTexts: ["OpenMRS dashboard"],
    });
    const adapter = new OpenMrsAdapter(openMrsConfig(), {
      launchBrowser: async () => new FakeOpenMrsBrowser(page),
    });
    const agent = new QueuedAgent([
      {
        actionId: "navigate-new-patient",
        confidence: 0.49,
        rationale: "The OpenMRS dashboard was not ready.",
      },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toEqual({
      status: "exception",
      exception: {
        code: "ui_state_unexpected",
        severity: "error",
        message: "Agent did not approve OpenMRS navigation.",
        suggestedRemediation: "The OpenMRS dashboard was not ready.",
      },
    });
    expect(agent.inputs[0].screenshotPath).toBe("screenshots/demo-001/openmrs/before-navigation.png");
    await expect(readFile(join(root, "run-openmrs", agent.inputs[0].screenshotPath!), "utf8")).resolves.toBe("screenshot-1");
  });

  it("fills the OpenMRS registration wizard and records success evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-success-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage();
    const adapter = new OpenMrsAdapter(openMrsConfig(), {
      launchBrowser: async () => new FakeOpenMrsBrowser(page),
    });
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      { actionId: "save-patient", confidence: 0.88, rationale: "The registration fields are filled." },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "openmrs-demo-001" });
    expect(page.clicked).toContain('a:has-text("Register a patient")');
    expect(page.clicked).toContain("#next-button");
    expect(page.clicked).toContain("#submit");
    expect(page.clicked).toContain("#patient-header-contactInfo");
    expect(page.filled).toEqual(
      expect.arrayContaining([
        { selector: 'input[name="givenName"]', value: "Ava" },
        { selector: 'input[name="familyName"]', value: "Nguyen" },
        { selector: 'input[name="birthdateDay"]', value: "14" },
        { selector: 'input[name="birthdateYear"]', value: "1987" },
        { selector: 'input[name="address1"]', value: "1200 West Lake Street" },
        { selector: 'input[name="phoneNumber"]', value: "+13125550198" },
      ]),
    );
    expect(page.selected).toContainEqual({ selector: 'select[name="gender"]', option: { label: "Female" } });
    expect(page.selected).toContainEqual({ selector: 'select[name="birthdateMonth"]', option: { label: "March" } });
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        recordId: "demo-001",
        target: "openmrs",
        sourceField: "sexOrGender",
        targetField: "Gender",
        normalizedValue: "Female",
        mappingConfidence: 0.97,
        selectedSelector: 'select[name="gender"]',
        action: "select",
        status: "succeeded",
      }),
    );
    expect(audit.getReportDetails().targetEvidence).toContainEqual(
      expect.objectContaining({
        recordId: "demo-001",
        target: "openmrs",
        status: "succeeded",
        screenshotPath: "screenshots/demo-001/openmrs/after-save.png",
        fieldScreenshotPath: "screenshots/demo-001/openmrs/after-fill.png",
        targetRecordId: "openmrs-demo-001",
        message: "submitted OpenMRS patient form and opened the patient dashboard",
      }),
    );
  });

  it("approves OpenMRS fields without prompting when mapping confidence meets the threshold", async () => {
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
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      { actionId: "save-patient", confidence: 0.88, rationale: "The registration fields are filled." },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "openmrs-demo-001" });
    expect(agent.inputs.some((input) => input.step.startsWith("fill-openmrs-field:"))).toBe(false);
    const mapping = audit.getReportDetails().fieldMappings.find((fieldMapping) => fieldMapping.targetField === "Given Name");
    expect(mapping).toEqual(
      expect.objectContaining({
        sourceField: "firstName",
        targetField: "Given Name",
        status: "succeeded",
        confidenceThreshold: 0.8,
        approvalSource: "agent",
        finalValue: "Ava",
      }),
    );
    expect(mapping?.agentConfidence).toBeUndefined();
  });

  it("prompts to confirm a low-confidence required OpenMRS mapping", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-field-confirmed-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      promptResults: confirmLowMappingPromptResults(),
    });
    const adapter = new OpenMrsAdapter(
      {
        ...openMrsConfig(),
        interactiveFieldConfirmation: true,
        fieldConfidenceThreshold: 0.99,
      },
      {
        launchBrowser: async () => new FakeOpenMrsBrowser(page),
      },
    );
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      { actionId: "save-patient", confidence: 0.88, rationale: "The registration fields are filled." },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "openmrs-demo-001" });
    expect(page.evaluations[0]).toMatchObject({
      targetField: "Gender",
      proposedValue: "Female",
      required: true,
      confidence: 0.97,
      threshold: 0.99,
    });
    expect(page.selected).toContainEqual({ selector: 'select[name="gender"]', option: { label: "Female" } });
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "sexOrGender",
        targetField: "Gender",
        status: "succeeded",
        mappingConfidence: 0.97,
        approvalSource: "operator_confirmed",
        confidenceThreshold: 0.99,
        finalValue: "Female",
      }),
    );
  });

  it("uses the operator-edited value for a low-confidence required OpenMRS mapping", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-field-edited-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      promptResults: [{ action: "edit", value: "Unknown" }, ...confirmLowMappingPromptResults().slice(1)],
    });
    const adapter = new OpenMrsAdapter(
      {
        ...openMrsConfig(),
        interactiveFieldConfirmation: true,
        fieldConfidenceThreshold: 0.99,
      },
      {
        launchBrowser: async () => new FakeOpenMrsBrowser(page),
      },
    );
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      { actionId: "save-patient", confidence: 0.88, rationale: "The registration fields are filled." },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "openmrs-demo-001" });
    expect(page.selected).toContainEqual({ selector: 'select[name="gender"]', option: { label: "Unknown" } });
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "sexOrGender",
        targetField: "Gender",
        status: "succeeded",
        approvalSource: "operator_edited",
        originalProposedValue: "Female",
        finalValue: "Unknown",
      }),
    );
  });

  it("normalizes an operator-edited OpenMRS gender value before selecting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-field-edited-gender-normalized-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      promptResults: [{ action: "edit", value: "male" }, ...confirmLowMappingPromptResults().slice(1)],
    });
    const adapter = new OpenMrsAdapter(
      {
        ...openMrsConfig(),
        interactiveFieldConfirmation: true,
        fieldConfidenceThreshold: 0.99,
      },
      {
        launchBrowser: async () => new FakeOpenMrsBrowser(page),
      },
    );
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      { actionId: "save-patient", confidence: 0.88, rationale: "The registration fields are filled." },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "openmrs-demo-001" });
    expect(page.selected).toContainEqual({ selector: 'select[name="gender"]', option: { label: "Male" } });
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "sexOrGender",
        targetField: "Gender",
        status: "succeeded",
        approvalSource: "operator_edited",
        originalProposedValue: "Female",
        finalValue: "Male",
      }),
    );
  });

  it("normalizes an abbreviated operator-edited OpenMRS gender value before selecting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-field-edited-gender-abbreviation-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      promptResults: [{ action: "edit", value: "m" }, ...confirmLowMappingPromptResults().slice(1)],
    });
    const adapter = new OpenMrsAdapter(
      {
        ...openMrsConfig(),
        interactiveFieldConfirmation: true,
        fieldConfidenceThreshold: 0.99,
      },
      {
        launchBrowser: async () => new FakeOpenMrsBrowser(page),
      },
    );
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      { actionId: "save-patient", confidence: 0.88, rationale: "The registration fields are filled." },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "openmrs-demo-001" });
    expect(agent.inputs.filter((input) => input.step === "interpret-openmrs-field-value:Gender")).toHaveLength(0);
    expect(page.selected).toContainEqual({ selector: 'select[name="gender"]', option: { label: "Male" } });
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "sexOrGender",
        targetField: "Gender",
        status: "succeeded",
        approvalSource: "operator_edited",
        originalProposedValue: "Female",
        finalValue: "Male",
      }),
    );
  });

  it("does not let the agent override an unambiguous OpenMRS gender abbreviation", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-field-edited-gender-abbreviation-agent-override-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      promptResults: [{ action: "edit", value: "m" }, ...confirmLowMappingPromptResults().slice(1)],
    });
    const adapter = new OpenMrsAdapter(
      {
        ...openMrsConfig(),
        interactiveFieldConfirmation: true,
        fieldConfidenceThreshold: 0.99,
      },
      {
        launchBrowser: async () => new FakeOpenMrsBrowser(page),
      },
    );
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      { actionId: "save-patient", confidence: 0.88, rationale: "The registration fields are filled." },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "openmrs-demo-001" });
    expect(page.selected).toContainEqual({ selector: 'select[name="gender"]', option: { label: "Male" } });
    expect(agent.inputs.filter((input) => input.step === "interpret-openmrs-field-value:Gender")).toHaveLength(0);
  });

  it("treats a changed OpenMRS prompt value as an edit when the operator clicks confirm", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-field-confirm-changed-gender-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      promptResults: [{ action: "confirm", value: "Male" }, ...confirmLowMappingPromptResults().slice(1)],
    });
    const adapter = new OpenMrsAdapter(
      {
        ...openMrsConfig(),
        interactiveFieldConfirmation: true,
        fieldConfidenceThreshold: 0.99,
      },
      {
        launchBrowser: async () => new FakeOpenMrsBrowser(page),
      },
    );
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      { actionId: "save-patient", confidence: 0.88, rationale: "The registration fields are filled." },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "openmrs-demo-001" });
    expect(page.selected).toContainEqual({ selector: 'select[name="gender"]', option: { label: "Male" } });
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "sexOrGender",
        targetField: "Gender",
        status: "succeeded",
        approvalSource: "operator_edited",
        originalProposedValue: "Female",
        finalValue: "Male",
      }),
    );
  });

  it("normalizes an operator-edited OpenMRS state value before filling it", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-field-edited-state-normalized-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      promptResults: [
        ...confirmLowMappingPromptResults().slice(0, 6),
        { action: "edit", value: "florida" },
        ...confirmLowMappingPromptResults().slice(7),
      ],
    });
    const adapter = new OpenMrsAdapter(
      {
        ...openMrsConfig(),
        interactiveFieldConfirmation: true,
        fieldConfidenceThreshold: 0.99,
      },
      {
        launchBrowser: async () => new FakeOpenMrsBrowser(page),
      },
    );
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      { actionId: "save-patient", confidence: 0.88, rationale: "The registration fields are filled." },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "openmrs-demo-001" });
    expect(page.filled).toContainEqual({ selector: 'input[name="stateProvince"]', value: "Florida" });
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "state",
        targetField: "State/Province",
        status: "succeeded",
        approvalSource: "operator_edited",
        originalProposedValue: "Illinois",
        finalValue: "Florida",
      }),
    );
  });

  it("uses the agent to interpret free-form OpenMRS state edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-field-edited-state-agent-interpreted-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      promptResults: [
        ...confirmLowMappingPromptResults().slice(0, 6),
        { action: "edit", value: "sunshine state" },
        ...confirmLowMappingPromptResults().slice(7),
      ],
    });
    const adapter = new OpenMrsAdapter(
      {
        ...openMrsConfig(),
        interactiveFieldConfirmation: true,
        fieldConfidenceThreshold: 0.99,
      },
      {
        launchBrowser: async () => new FakeOpenMrsBrowser(page),
      },
    );
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      { actionId: "use-openmrs-operator-value:9", confidence: 0.87, rationale: "Sunshine state refers to Florida." },
      { actionId: "save-patient", confidence: 0.88, rationale: "The registration fields are filled." },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "openmrs-demo-001" });
    expect(agent.inputs.find((input) => input.step === "interpret-openmrs-field-value:State/Province")).toMatchObject({
      metadata: {
        targetField: "State/Province",
        instruction: "Interpret only operatorInput. Ignore the original AI-mapped value from the field confirmation prompt.",
        operatorInput: "sunshine state",
        candidateValues: expect.arrayContaining(["sunshine state", "Florida"]),
      },
    });
    expect(page.filled).toContainEqual({ selector: 'input[name="stateProvince"]', value: "Florida" });
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "state",
        targetField: "State/Province",
        status: "succeeded",
        approvalSource: "operator_edited",
        originalProposedValue: "Illinois",
        finalValue: "Florida",
      }),
    );
  });

  it("re-prompts when the agent has low confidence interpreting an OpenMRS state edit", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-field-edited-state-low-confidence-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      promptResults: [
        ...confirmLowMappingPromptResults().slice(0, 6),
        { action: "edit", value: "sunshine state" },
        { action: "edit", value: "FL" },
        ...confirmLowMappingPromptResults().slice(7),
      ],
    });
    const adapter = new OpenMrsAdapter(
      {
        ...openMrsConfig(),
        interactiveFieldConfirmation: true,
        fieldConfidenceThreshold: 0.99,
      },
      {
        launchBrowser: async () => new FakeOpenMrsBrowser(page),
      },
    );
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      { actionId: "use-openmrs-operator-value:9", confidence: 0.49, rationale: "Sunshine state might refer to Florida." },
      { actionId: "save-patient", confidence: 0.88, rationale: "The registration fields are filled." },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "openmrs-demo-001" });
    expect(agent.inputs.filter((input) => input.step === "interpret-openmrs-field-value:State/Province")).toHaveLength(1);
    const statePromptInputs = page.evaluations.filter(
      (input): input is { targetField: string; value?: string; feedbackMessage?: string } =>
        typeof input === "object" && input !== null && (input as { targetField?: string }).targetField === "State/Province",
    );
    expect(statePromptInputs[0]).toMatchObject({ value: "Illinois" });
    expect(statePromptInputs[0]).not.toHaveProperty("feedbackMessage");
    expect(statePromptInputs[1]).toEqual(
      expect.objectContaining({
        value: "sunshine state",
        feedbackMessage: expect.stringContaining("AI was not confident"),
      }),
    );
    expect(page.filled).toContainEqual({ selector: 'input[name="stateProvince"]', value: "Florida" });
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "state",
        targetField: "State/Province",
        status: "succeeded",
        approvalSource: "operator_edited",
        originalProposedValue: "Illinois",
        finalValue: "Florida",
      }),
    );
  });

  it("re-prompts when the agent maps invalid OpenMRS state input back to the original value", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-field-edited-state-original-value-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      promptResults: [
        ...confirmLowMappingPromptResults().slice(0, 6),
        { action: "edit", value: "adsf" },
        { action: "edit", value: "FL" },
        ...confirmLowMappingPromptResults().slice(7),
      ],
    });
    const adapter = new OpenMrsAdapter(
      {
        ...openMrsConfig(),
        interactiveFieldConfirmation: true,
        fieldConfidenceThreshold: 0.99,
      },
      {
        launchBrowser: async () => new FakeOpenMrsBrowser(page),
      },
    );
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      { actionId: "use-openmrs-operator-value:13", confidence: 0.99, rationale: "Incorrectly reused the original Illinois value." },
      { actionId: "save-patient", confidence: 0.88, rationale: "The registration fields are filled." },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "openmrs-demo-001" });
    expect(page.filled).toContainEqual({ selector: 'input[name="stateProvince"]', value: "Florida" });
    expect(agent.inputs.filter((input) => input.step === "interpret-openmrs-field-value:State/Province")).toHaveLength(1);
    expect(agent.inputs.find((input) => input.step === "interpret-openmrs-field-value:State/Province")?.metadata).not.toHaveProperty("proposedValue");
    const statePromptInputs = page.evaluations.filter(
      (input): input is { targetField: string; value?: string; feedbackMessage?: string } =>
        typeof input === "object" && input !== null && (input as { targetField?: string }).targetField === "State/Province",
    );
    expect(statePromptInputs[1]).toEqual(
      expect.objectContaining({
        value: "adsf",
        feedbackMessage: expect.stringContaining("AI could not confidently map"),
      }),
    );
  });

  it("injects the OpenMRS field prompt without TS runtime helper references or ambiguous button labels", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-field-prompt-serializable-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      promptResults: confirmLowMappingPromptResults(),
      rejectedPageFunctionPattern: /__name|addButton\("Confirm"|Use Edited Value|Use Shown Value|use AI-mapped value/,
    });
    const adapter = new OpenMrsAdapter(
      {
        ...openMrsConfig(),
        interactiveFieldConfirmation: true,
        fieldConfidenceThreshold: 0.99,
      },
      {
        launchBrowser: async () => new FakeOpenMrsBrowser(page),
      },
    );
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      { actionId: "save-patient", confidence: 0.88, rationale: "The registration fields are filled." },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "openmrs-demo-001" });
    expect(page.evaluationScripts.some((script) => script.includes("AI is interpreting this value..."))).toBe(true);
    expect(page.evaluationScripts.some((script) => script.includes("aria-busy"))).toBe(true);
  });

  it("retries the OpenMRS field prompt when the browser context changes during injection", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-field-prompt-retry-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      promptResults: [
        new Error("Execution context was destroyed, most likely because of a navigation."),
        ...confirmLowMappingPromptResults(),
      ],
    });
    const adapter = new OpenMrsAdapter(
      {
        ...openMrsConfig(),
        interactiveFieldConfirmation: true,
        fieldConfidenceThreshold: 0.99,
      },
      {
        launchBrowser: async () => new FakeOpenMrsBrowser(page),
      },
    );
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      { actionId: "save-patient", confidence: 0.88, rationale: "The registration fields are filled." },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "openmrs-demo-001" });
    expect(page.evaluations.slice(0, 2)).toEqual([
      expect.objectContaining({ targetField: "Gender" }),
      expect.objectContaining({ targetField: "Gender" }),
    ]);
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "sexOrGender",
        targetField: "Gender",
        status: "succeeded",
        approvalSource: "operator_confirmed",
      }),
    );
  });

  it("skips an optional low-confidence OpenMRS field when the operator skips it", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-field-skipped-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      promptResults: [
        ...confirmLowMappingPromptResults().slice(0, 4),
        { action: "skip", value: "" },
        ...confirmLowMappingPromptResults().slice(5),
      ],
    });
    const adapter = new OpenMrsAdapter(
      {
        ...openMrsConfig(),
        interactiveFieldConfirmation: true,
        fieldConfidenceThreshold: 0.99,
      },
      {
        launchBrowser: async () => new FakeOpenMrsBrowser(page),
      },
    );
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      { actionId: "save-patient", confidence: 0.88, rationale: "The registration fields are filled." },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "openmrs-demo-001" });
    expect(page.filled).not.toContainEqual({ selector: 'input[name="address1"]', value: "1200 West Lake Street" });
    const skippedMapping = audit.getReportDetails().fieldMappings.find((mapping) => mapping.sourceField === "streetAddress");
    expect(skippedMapping).toMatchObject({
      sourceField: "streetAddress",
      targetField: "Address Line 1",
      status: "skipped",
      approvalSource: "operator_skipped",
      originalProposedValue: "1200 West Lake Street",
      skipReason: "Operator skipped optional OpenMRS field.",
    });
    expect(skippedMapping).not.toHaveProperty("finalValue");
  });

  it("returns an exception when the operator stops optional low-confidence OpenMRS field confirmation", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-optional-field-stopped-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      promptResults: [...confirmLowMappingPromptResults().slice(0, 4), { action: "stop", value: "" }],
    });
    const adapter = new OpenMrsAdapter(
      {
        ...openMrsConfig(),
        interactiveFieldConfirmation: true,
        fieldConfidenceThreshold: 0.99,
      },
      {
        launchBrowser: async () => new FakeOpenMrsBrowser(page),
      },
    );
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toMatchObject({
      status: "exception",
      exception: {
        code: "ui_state_unexpected",
        field: "streetAddress",
        targetField: "Address Line 1",
        message: "Operator stopped OpenMRS field confirmation.",
        proposedValue: "1200 West Lake Street",
        confidenceThreshold: 0.99,
      },
    });
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "streetAddress",
        targetField: "Address Line 1",
        status: "failed",
        approvalSource: "operator_stopped",
      }),
    );
  });

  it("returns an exception when optional low-confidence OpenMRS field confirmation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-optional-field-prompt-failed-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      promptResults: [...confirmLowMappingPromptResults().slice(0, 4), new Error("Prompt script failed")],
    });
    const adapter = new OpenMrsAdapter(
      {
        ...openMrsConfig(),
        interactiveFieldConfirmation: true,
        fieldConfidenceThreshold: 0.99,
      },
      {
        launchBrowser: async () => new FakeOpenMrsBrowser(page),
      },
    );
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toMatchObject({
      status: "exception",
      exception: {
        code: "ui_state_unexpected",
        field: "streetAddress",
        targetField: "Address Line 1",
        message: "OpenMRS field confirmation prompt failed: Prompt script failed",
        proposedValue: "1200 West Lake Street",
        confidenceThreshold: 0.99,
      },
    });
  });

  it("returns a timeout exception and cleans up the browser prompt overlay when field confirmation times out", async () => {
    vi.useFakeTimers();
    try {
      const root = await mkdtemp(join(tmpdir(), "openmrs-field-prompt-timeout-"));
      const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
      const page = successfulCreatePage({
        promptResults: [new Promise(() => undefined)],
      });
      const adapter = new OpenMrsAdapter(
        {
          ...openMrsConfig(),
          interactiveFieldConfirmation: true,
          fieldConfidenceThreshold: 0.99,
        },
        {
          launchBrowser: async () => new FakeOpenMrsBrowser(page),
        },
      );
      const agent = new QueuedAgent([
        { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      ]);

      await adapter.prepare();
      const run = adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });
      await vi.waitFor(() => expect(page.evaluations).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      const result = await run;

      expect(result).toMatchObject({
        status: "exception",
        exception: {
          code: "ui_state_unexpected",
          field: "sexOrGender",
          message: "OpenMRS field confirmation prompt timed out.",
          proposedValue: "Female",
          confidenceThreshold: 0.99,
        },
      });
      expect(page.evaluations).toHaveLength(2);
      expect(page.evaluations[1]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns an exception when the operator stops low-confidence OpenMRS field confirmation", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-field-stopped-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      promptResults: [{ action: "stop", value: "" }],
    });
    const adapter = new OpenMrsAdapter(
      {
        ...openMrsConfig(),
        interactiveFieldConfirmation: true,
        fieldConfidenceThreshold: 0.99,
      },
      {
        launchBrowser: async () => new FakeOpenMrsBrowser(page),
      },
    );
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toMatchObject({
      status: "exception",
      exception: {
        code: "ui_state_unexpected",
        field: "sexOrGender",
        proposedValue: "Female",
        confidenceThreshold: 0.99,
      },
    });
  });

  it("returns an exception when the OpenMRS field confirmation prompt fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-field-prompt-failed-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      promptResults: [new Error("Prompt script failed")],
    });
    const adapter = new OpenMrsAdapter(
      {
        ...openMrsConfig(),
        interactiveFieldConfirmation: true,
        fieldConfidenceThreshold: 0.99,
      },
      {
        launchBrowser: async () => new FakeOpenMrsBrowser(page),
      },
    );
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toMatchObject({
      status: "exception",
      exception: {
        code: "ui_state_unexpected",
        field: "sexOrGender",
        message: "OpenMRS field confirmation prompt failed: Prompt script failed",
        proposedValue: "Female",
        confidenceThreshold: 0.99,
      },
    });
  });

  it("records low-confidence OpenMRS field approval failures with auditable metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-field-approval-low-confidence-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      promptResults: [{ action: "stop", value: "" }],
    });
    const adapter = new OpenMrsAdapter(
      {
        ...openMrsConfig(),
        interactiveFieldConfirmation: true,
        fieldConfidenceThreshold: 0.99,
      },
      {
        launchBrowser: async () => new FakeOpenMrsBrowser(page),
      },
    );
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toMatchObject({
      status: "exception",
      exception: {
        code: "ui_state_unexpected",
        severity: "error",
        field: "sexOrGender",
        message: "Operator stopped OpenMRS field confirmation.",
        suggestedRemediation: "OpenMRS mapping confidence 0.97 is below threshold 0.99.",
        screenshotPath: "screenshots/demo-001/openmrs/field-review-gender.png",
        proposedValue: "Female",
        confidenceThreshold: 0.99,
      },
    });
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "sexOrGender",
        targetField: "Gender",
        status: "failed",
        errorMessage: "Operator stopped OpenMRS field confirmation.",
        confidenceThreshold: 0.99,
        agentRationale: "OpenMRS mapping confidence 0.97 is below threshold 0.99.",
        approvalSource: "operator_stopped",
        originalProposedValue: "Female",
        finalValue: "Female",
      }),
    );
  });

  it("caps OpenMRS fill and select actions at five seconds", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-action-timeouts-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage();
    const adapter = new OpenMrsAdapter(openMrsConfig(), {
      launchBrowser: async () => new FakeOpenMrsBrowser(page),
    });
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      { actionId: "save-patient", confidence: 0.88, rationale: "The registration fields are filled." },
    ]);

    await adapter.prepare();
    await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(page.actionOptions).toContainEqual({
      action: "select",
      selector: 'select[name="gender"]',
      options: { timeout: 5000 },
    });
    expect(page.actionOptions).toContainEqual({
      action: "fill",
      selector: 'input[name="givenName"]',
      options: { timeout: 5000 },
    });
    expect(page.actionOptions.every((entry) => entry.options?.timeout === 5000)).toBe(true);
  });

  it("returns a possible-duplicate exception when OpenMRS reports similar patients", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-duplicate-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      availableSelectors: ["#reviewSimilarPatientsButton"],
      visibleSelectors: ["#reviewSimilarPatientsButton"],
      bodyTexts: ["OpenMRS dashboard", "Register a patient", "Similar patients were found"],
    });
    const adapter = new OpenMrsAdapter(openMrsConfig(), {
      launchBrowser: async () => new FakeOpenMrsBrowser(page),
    });
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
      { actionId: "save-patient", confidence: 0.88, rationale: "The registration fields are filled." },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent });

    expect(result).toEqual({
      status: "exception",
      exception: {
        code: "possible_duplicate",
        severity: "error",
        message: "OpenMRS indicated a possible duplicate patient.",
        suggestedRemediation: "Review the patient match screen and decide whether to merge, update, or skip.",
        screenshotPath: "screenshots/demo-001/openmrs/after-save.png",
      },
    });
    expect(audit.getReportDetails().issues).toContainEqual(
      expect.objectContaining({
        recordId: "demo-001",
        target: "openmrs",
        phase: "target",
        exceptionCode: "possible_duplicate",
      }),
    );
  });

  it("records a failed OpenMRS field mapping before throwing for a missing required selector", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmrs-missing-selector-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openmrs" });
    const page = successfulCreatePage({
      omittedSelectors: ['input[name="familyName"]'],
    });
    const adapter = new OpenMrsAdapter(openMrsConfig(), {
      launchBrowser: async () => new FakeOpenMrsBrowser(page),
    });
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "The registration app is visible." },
    ]);

    await adapter.prepare();
    await expect(adapter.runRecord({ runId: "run-openmrs", record: record("demo-001"), audit, agent })).rejects.toThrow(
      "Timed out waiting for visible OpenMRS Family Name",
    );

    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        recordId: "demo-001",
        target: "openmrs",
        sourceField: "lastName",
        targetField: "Family Name",
        normalizedValue: "Nguyen",
        status: "failed",
        errorMessage: expect.stringContaining("Timed out waiting for visible OpenMRS Family Name"),
      }),
    );
  }, 10000);
});

function openMrsConfig() {
  return {
    baseUrl: "https://openmrs.example.test/openmrs",
    username: "admin",
    password: "secret",
    concurrency: 1,
  };
}

function loginSelectors(): string[] {
  return ['input[name="username"]', 'input[name="password"]', '#Registration\\ Desk', "#loginButton"];
}

function confirmLowMappingPromptResults() {
  return openMrsFieldMappings(record("demo-001"))
    .filter((mapping) => mapping.mappingConfidence < 0.99)
    .map((mapping) => ({ action: "confirm", value: mapping.value }));
}

function successfulCreatePage(options: {
  availableSelectors?: string[];
  visibleSelectors?: string[];
  omittedSelectors?: string[];
  bodyTexts?: string[];
  promptResults?: unknown[];
  rejectedPageFunctionPattern?: RegExp;
} = {}): FakeOpenMrsPage {
  const omitted = new Set(options.omittedSelectors ?? []);
  const registrationSelectors = [
    'a:has-text("Register a patient")',
    'input[name="givenName"]',
    'input[name="familyName"]',
    'select[name="gender"]',
    'input[name="birthdateDay"]',
    'select[name="birthdateMonth"]',
    'input[name="birthdateYear"]',
    'input[name="address1"]',
    'input[name="cityVillage"]',
    'input[name="stateProvince"]',
    'input[name="postalCode"]',
    'input[name="phoneNumber"]',
    "#next-button",
    "#submit",
    "#patient-header-contactInfo",
    ...(options.availableSelectors ?? []),
  ].filter((selector) => !omitted.has(selector));
  const initiallyVisible = [
    ...loginSelectors(),
    'a:has-text("Register a patient")',
    'input[name="givenName"]',
    'input[name="familyName"]',
    "#next-button",
    "#patient-header-contactInfo",
    ...(options.visibleSelectors ?? []),
  ].filter((selector) => !omitted.has(selector));

  return new FakeOpenMrsPage({
    availableSelectors: [...loginSelectors(), ...registrationSelectors],
    visibleSelectors: initiallyVisible,
    clickReveals: {
      "#next-button": [
        'select[name="gender"]',
        'input[name="birthdateDay"]',
        'select[name="birthdateMonth"]',
        'input[name="birthdateYear"]',
        'input[name="address1"]',
        'input[name="cityVillage"]',
        'input[name="stateProvince"]',
        'input[name="postalCode"]',
        'input[name="phoneNumber"]',
        "#submit",
      ].filter((selector) => !omitted.has(selector)),
    },
    clickHides: {
      "#submit": ["#submit"],
    },
    bodyTexts: options.bodyTexts ?? ["OpenMRS dashboard", "Register a patient", "Ava Nguyen Patient Dashboard\nVisits\nVitals"],
    tagNames: [
      ['select[name="gender"]', "select"],
      ['select[name="birthdateMonth"]', "select"],
    ],
    selectOptions: [
      ['select[name="gender"]', ["Female", "Male", "Unknown"]],
      [
        'select[name="birthdateMonth"]',
        ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
      ],
    ],
    promptResults: options.promptResults,
    rejectedPageFunctionPattern: options.rejectedPageFunctionPattern,
  });
}

class QueuedAgent implements AgentDriver {
  readonly inputs: AgentDecisionInput[] = [];

  constructor(private readonly decisions: AgentDecision[]) {}

  async decide(input: AgentDecisionInput): Promise<AgentDecision> {
    this.inputs.push(input);
    const decision = this.decisions.shift();
    if (!decision) {
      throw new Error(`No queued decision for ${input.step}.`);
    }
    return decision;
  }
}

class FakeOpenMrsBrowser {
  readonly newPageOptions: unknown[] = [];
  closed = false;

  constructor(private readonly page: FakeOpenMrsPage) {}

  async newPage(options: unknown): Promise<FakeOpenMrsPage> {
    this.newPageOptions.push(options);
    return this.page;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeOpenMrsPage {
  readonly availableSelectors: Set<string>;
  readonly visibleSelectors?: Set<string>;
  readonly clickReveals: Map<string, string[]>;
  readonly clickHides: Map<string, string[]>;
  readonly tagNames: Map<string, string>;
  readonly selectOptions: Map<string, string[]>;
  readonly gotos: Array<{ url: string; options?: unknown }> = [];
  readonly waitStates: string[] = [];
  readonly filled: Array<{ selector: string; value: string }> = [];
  readonly selected: Array<{ selector: string; option: unknown }> = [];
  readonly actionOptions: Array<{ action: "fill" | "select"; selector: string; options: { timeout?: number } | undefined }> = [];
  readonly clicked: string[] = [];
  readonly evaluations: unknown[] = [];
  readonly evaluationScripts: string[] = [];
  promptResults: unknown[] = [];
  private readonly bodyTexts: string[];
  private readonly rejectedPageFunctionPattern?: RegExp;
  private screenshotCount = 0;
  private lastBodyText = "";

  constructor(options: {
    availableSelectors: string[];
    visibleSelectors?: string[];
    clickReveals?: Record<string, string[]>;
    clickHides?: Record<string, string[]>;
    bodyTexts?: string[];
    tagNames?: Array<[string, string]>;
    selectOptions?: Array<[string, string[]]>;
    promptResults?: unknown[];
    rejectedPageFunctionPattern?: RegExp;
  }) {
    this.availableSelectors = new Set(options.availableSelectors);
    this.visibleSelectors = options.visibleSelectors ? new Set(options.visibleSelectors) : undefined;
    this.clickReveals = new Map(Object.entries(options.clickReveals ?? {}));
    this.clickHides = new Map(Object.entries(options.clickHides ?? {}));
    this.bodyTexts = [...(options.bodyTexts ?? [])];
    this.tagNames = new Map(options.tagNames ?? []);
    this.selectOptions = new Map(options.selectOptions ?? []);
    this.promptResults = [...(options.promptResults ?? [])];
    this.rejectedPageFunctionPattern = options.rejectedPageFunctionPattern;
  }

  async goto(url: string, options?: unknown): Promise<void> {
    this.gotos.push({ url, options });
  }

  async waitForLoadState(state: string): Promise<void> {
    this.waitStates.push(state);
  }

  async screenshot(_options?: unknown): Promise<Buffer> {
    this.screenshotCount += 1;
    return Buffer.from(`screenshot-${this.screenshotCount}`);
  }

  locator(selector: string): FakeOpenMrsLocator {
    return new FakeOpenMrsLocator(this, selector);
  }

  async evaluate<T, Arg>(_pageFunction: string | ((input: Arg) => Promise<T> | T), input: Arg): Promise<T> {
    if (typeof _pageFunction !== "string") {
      this.evaluations.push(input);
      return undefined as T;
    }
    if (typeof _pageFunction === "string") {
      this.evaluationScripts.push(_pageFunction);
    }
    this.evaluations.push(promptInputFromEvaluationScript(_pageFunction));
    if (this.rejectedPageFunctionPattern?.test(String(_pageFunction))) {
      throw new Error(`Rejected page function matched ${String(this.rejectedPageFunctionPattern)}`);
    }
    const result = this.promptResults.shift();
    if (result instanceof Error) {
      throw result;
    }
    return result as T;
  }

  hasSelector(selector: string): boolean {
    return selector === "body" || this.availableSelectors.has(selector);
  }

  isVisible(selector: string): boolean {
    if (selector === "body") return true;
    return this.hasSelector(selector) && (!this.visibleSelectors || this.visibleSelectors.has(selector));
  }

  revealFromClick(selector: string): void {
    for (const revealedSelector of this.clickReveals.get(selector) ?? []) {
      this.visibleSelectors?.add(revealedSelector);
    }
    for (const hiddenSelector of this.clickHides.get(selector) ?? []) {
      this.visibleSelectors?.delete(hiddenSelector);
    }
  }

  tagName(selector: string): string {
    return this.tagNames.get(selector) ?? "input";
  }

  nextBodyText(): string {
    const nextText = this.bodyTexts.shift();
    if (nextText !== undefined) {
      this.lastBodyText = nextText;
    }
    return this.lastBodyText;
  }
}

function promptInputFromEvaluationScript(script: string): unknown {
  const match = script.match(/agentic-openmrs-field-confirmation-input:([^\s*]+)/);
  if (!match) return undefined;
  return JSON.parse(decodeURIComponent(match[1] ?? ""));
}

class FakeOpenMrsLocator {
  constructor(
    private readonly page: FakeOpenMrsPage,
    private readonly selector: string,
  ) {}

  first(): FakeOpenMrsLocator {
    return this;
  }

  async count(): Promise<number> {
    return this.page.hasSelector(this.selector) ? 1 : 0;
  }

  async evaluate<T>(_pageFunction: (element: Element) => T | Promise<T>): Promise<T> {
    return this.page.tagName(this.selector) as T;
  }

  async fill(value: string, options?: { timeout?: number }): Promise<void> {
    this.page.filled.push({ selector: this.selector, value });
    this.page.actionOptions.push({ action: "fill", selector: this.selector, options });
  }

  async selectOption(option: unknown, options?: { timeout?: number }): Promise<string[]> {
    const allowedOptions = this.page.selectOptions.get(this.selector);
    const requestedLabel = typeof option === "object" && option !== null && "label" in option ? String((option as { label: unknown }).label) : String(option);
    if (allowedOptions && !allowedOptions.includes(requestedLabel)) {
      throw new Error(`did not find option ${requestedLabel} for ${this.selector}`);
    }
    this.page.selected.push({ selector: this.selector, option });
    this.page.actionOptions.push({ action: "select", selector: this.selector, options });
    return [];
  }

  async click(): Promise<void> {
    if (!this.page.isVisible(this.selector)) {
      throw new Error(`${this.selector} is not visible`);
    }
    this.page.clicked.push(this.selector);
    this.page.revealFromClick(this.selector);
  }

  async isVisible(): Promise<boolean> {
    return this.page.isVisible(this.selector);
  }

  async innerText(_options?: unknown): Promise<string> {
    return this.page.nextBodyText();
  }
}

function record(sourceRecordId: string): NormalizedIntakeRecord {
  return {
    sourceRecordId,
    firstName: "Ava",
    lastName: "Nguyen",
    dateOfBirth: "1987-03-14",
    sexOrGender: "female",
    phone: "+13125550198",
    email: "ava.nguyen@example.test",
    streetAddress: "1200 West Lake Street",
    city: "Chicago",
    state: "IL",
    zip: "60607",
    insurancePayer: "Aetna",
    insuranceMemberId: "AET123456",
    insuranceGroupId: "GRP9",
    reasonForVisit: "Annual wellness visit",
    preferredContactMethod: "phone",
    notes: "Prefers morning appointments.",
    sourceFormat: "json",
    rawSourceExcerpt: "Ava Nguyen intake",
  };
}
