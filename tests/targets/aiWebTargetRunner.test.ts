import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAuditStore } from "../../src/audit/auditStore.js";
import type { NormalizedIntakeRecord } from "../../src/domain/schema.js";
import type { AiWebPlan, AiWebPlanInput, AiWebPlanner } from "../../src/targets/aiWebPlanner.js";
import { StaticAiWebPlanner } from "../../src/targets/aiWebPlanner.js";
import { AiWebTargetRunner } from "../../src/targets/aiWebTargetRunner.js";
import type { TargetProfile } from "../../src/targets/profiles.js";

describe("AiWebTargetRunner", () => {
  it("runs generic AI-planned browser actions and writes audit evidence", async () => {
    const page = new FakeRunnerPage();
    const browser = new FakeRunnerBrowser(page);
    const audit = await FileAuditStore.create({
      runsDir: await mkdtemp(join(tmpdir(), "ai-web-runner-")),
      runId: "run-test",
      now: () => "2026-05-08T12:00:00.000Z",
    });
    const planner = new StaticAiWebPlanner([
      {
        action: {
          type: "fill",
          elementId: "control-1",
          field: "firstName",
          value: "Ava",
          rationale: "The first-name textbox label matches the intake field.",
        },
        confidence: 0.91,
      },
      {
        action: {
          type: "click",
          elementId: "control-2",
          purpose: "save",
          rationale: "The visible button saves the synthetic patient.",
        },
        confidence: 0.86,
      },
      {
        action: {
          type: "verify",
          criteria: "The page shows the synthetic patient name.",
          rationale: "Ava Nguyen appears in the success page text.",
        },
        confidence: 0.94,
      },
    ]);
    const runner = new AiWebTargetRunner({
      planner,
      launchBrowser: async () => browser,
      maxSteps: 5,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), confidenceThreshold: 0.99 },
      record: record(),
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openkairo-demo-001" });
    expect(page.gotoUrls).toEqual(["https://example.test/emr"]);
    expect(page.actions).toEqual([
      ["fill", "#first-name", "Ava"],
      ["click", "button.save"],
    ]);
    expect(browser.closed).toBe(true);

    const details = audit.getReportDetails();
    expect(details.targetEvidence).toContainEqual(
      expect.objectContaining({
        recordId: "demo-001",
        target: "openkairo",
        status: "succeeded",
        targetRecordId: "ai-openkairo-demo-001",
      }),
    );
    expect(details.fieldMappings).toContainEqual(
      expect.objectContaining({
        recordId: "demo-001",
        target: "openkairo",
        sourceField: "firstName",
        targetField: "First Name",
        normalizedValue: "Ava",
        finalValue: "Ava",
        action: "fill",
        status: "succeeded",
        confidenceThreshold: 0.99,
        approvalSource: "agent",
        selectedSelector: "#first-name",
        selectorCandidates: ["#first-name"],
        fieldScreenshotPath: "screenshots/demo-001/openkairo/0002-ai-field-firstName.png",
      }),
    );
    expect(details.fieldMappings).toContainEqual(
      expect.objectContaining({
        recordId: "demo-001",
        target: "openkairo",
        sourceField: "lastName",
        targetField: "",
        normalizedValue: "Nguyen",
        status: "no_matching_destination_field",
        skipReason: "No matching destination field was filled before verification.",
      }),
    );
    expect(details.fieldMappings).not.toContainEqual(
      expect.objectContaining({
        sourceField: "firstName",
        status: "no_matching_destination_field",
      }),
    );
    expect(await readEvents(audit)).toEqual([
      expect.objectContaining({ actionType: "ai-fill", result: "succeeded" }),
      expect.objectContaining({ actionType: "ai-click", result: "succeeded" }),
      expect.objectContaining({ actionType: "ai-verify", result: "succeeded" }),
    ]);
  });

  it("retries an aborted initial navigation before planning actions", async () => {
    const page = new FakeRunnerPage({
      gotoErrors: [new Error("page.goto: net::ERR_ABORTED at https://example.test/emr")],
      bodyText: "Patient Details Ava Nguyen saved",
      title: "Patient Details",
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-goto-retry-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient name.",
            rationale: "Ava Nguyen appears after navigation retry.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 1,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: profile(),
      record: record(),
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openkairo-demo-001" });
    expect(page.gotoUrls).toEqual(["https://example.test/emr", "https://example.test/emr"]);
    expect(page.actions).toEqual([["wait", 1000]]);
  });

  it("passes recent action history to the planner so it can avoid loops", async () => {
    const page = new FakeRunnerPage();
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-history-");
    const planner = new CapturingPlanner([
      {
        action: {
          type: "click",
          elementId: "control-2",
          purpose: "search",
          rationale: "Search once before creating the patient.",
        },
        confidence: 0.81,
      },
      {
        action: {
          type: "stop",
          code: "ui_state_unexpected",
          message: "Stop after inspecting action history.",
        },
        confidence: 1,
      },
    ]);
    const runner = new AiWebTargetRunner({
      planner,
      launchBrowser: async () => browser,
      maxSteps: 2,
    });

    await runner.runRecord({
      runId: "run-test",
      profile: profile(),
      record: record(),
      audit,
    });

    expect(planner.inputs).toHaveLength(2);
    expect(planner.inputs[0]?.recentActions).toEqual([]);
    expect(planner.inputs[1]?.recentActions).toEqual([
      {
        actionType: "click",
        target: "search",
        result: "succeeded",
      },
    ]);
  });

  it("records the observed target UI field label separately from the normalized source field", async () => {
    const page = new FakeRunnerPage({
      elements: [
        fakeElement("label", { for: "birthdateYear-field" }, "Year (required)"),
        fakeElement("input", { id: "birthdateYear-field", value: "" }),
        fakeElement("button", { class: "save" }, "Save"),
      ],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-target-field-label-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "fill",
            elementId: "control-1",
            field: "dateOfBirth",
            value: "1990",
            rationale: "The year textbox is the visible target control for the normalized date of birth.",
          },
          confidence: 0.95,
        },
        {
          action: {
            type: "click",
            elementId: "control-2",
            purpose: "save",
            rationale: "The visible button saves the synthetic patient.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient name.",
            rationale: "Ava Nguyen appears in the success page text.",
          },
          confidence: 0.94,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 5,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: profile(),
      record: record(),
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openkairo-demo-001" });
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "dateOfBirth",
        targetField: "Year (required)",
        normalizedValue: "1990",
        selectedSelector: "#birthdateYear-field",
      }),
    );
  });

  it("waits instead of stopping when a SPA observation has no controls yet", async () => {
    const page = new FakeRunnerPage({ bodyText: "", bodyTextAfterWait: "Patient Details Ava Nguyen saved", elements: [] });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-empty-spa-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "stop",
            code: "ui_state_unexpected",
            message: "No observed controls are available yet.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient name.",
            rationale: "Ava Nguyen appears after the SPA finishes loading.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 2,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: profile(),
      record: record(),
      audit,
    });

    expect(result.status).toBe("succeeded");
    expect(page.actions).toEqual([["wait", 1000]]);
    expect(await readEvents(audit)).toEqual([
      expect.objectContaining({ actionType: "ai-wait", result: "succeeded" }),
      expect.objectContaining({ actionType: "ai-verify", result: "succeeded" }),
    ]);
  });

  it("waits instead of stopping when only sparse shell controls are visible", async () => {
    const page = new FakeRunnerPage({
      bodyText: "OpenMRS Home Super User",
      bodyTextAfterWait: "Patient Details Ava Nguyen saved",
      elements: [fakeElement("button", { "aria-label": "Help" }, ""), fakeElement("button", { "aria-label": "Implementer tools" }, "")],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-shell-spa-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "stop",
            code: "ui_state_unexpected",
            message: "Only help controls are visible and no safe patient-registration action is available.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient name.",
            rationale: "Ava Nguyen appears after the SPA shell finishes loading.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 2,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: profile(),
      record: record(),
      audit,
    });

    expect(result.status).toBe("succeeded");
    expect(page.actions).toEqual([["wait", 1000]]);
  });

  it("clicks visible option controls when the planner selects a non-select element", async () => {
    const page = new FakeRunnerPage({
      elements: [fakeElement("li", { id: "registration-desk", onclick: "chooseLocation()" }, "Registration Desk")],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-select-click-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "select",
            elementId: "control-1",
            field: "sessionLocation",
            value: "Registration Desk",
            rationale: "The visible location option matches the workflow hint.",
          },
          confidence: 0.88,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient name.",
            rationale: "Ava Nguyen appears in the saved patient state.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: profile(),
      record: record(),
      audit,
    });

    expect(result.status).toBe("succeeded");
    expect(page.actions).toEqual([["click", "#registration-desk"]]);
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "sessionLocation",
        action: "select",
        status: "succeeded",
        selectedSelector: "#registration-desk",
      }),
    );
  });

  it("executes credential fills without reporting them as intake field mappings", async () => {
    const page = new FakeRunnerPage({
      bodyTextAfterClick: "Patient Record MRN-M0XPCLB0 New Encounter Ava Nguyen DOB Mar 14 1987 Gender Female",
      elements: [
        fakeElement("label", { for: "email" }, "Email"),
        fakeElement("input", { id: "email", value: "" }),
        fakeElement("label", { for: "password" }, "Password"),
        fakeElement("input", { id: "password", value: "", type: "password" }),
        fakeElement("button", { class: "login" }, "Sign in"),
      ],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-credentials-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "fill",
            elementId: "control-1",
            field: "email",
            value: "reception@demo.com",
            rationale: "Fill the visible login email credential field.",
          },
          confidence: 0.99,
        },
        {
          action: {
            type: "fill",
            elementId: "control-2",
            field: "password",
            value: "Demo123!",
            rationale: "Fill the visible login password credential field.",
          },
          confidence: 0.99,
        },
        {
          action: {
            type: "click",
            elementId: "control-3",
            purpose: "sign in",
            rationale: "Sign in before patient registration.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient record.",
            rationale: "Ava Nguyen is visible on the patient record page.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 4,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: {
        ...profile(),
        name: "openkairo",
        displayName: "OpenKairo",
        credentials: { username: "reception@demo.com", password: "Demo123!" },
      },
      record: record(),
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openkairo-demo-001" });
    expect(page.actions).toEqual([
      ["fill", "#email", "reception@demo.com"],
      ["fill", "#password", "Demo123!"],
      ["click", "button.login"],
    ]);
    expect(audit.getReportDetails().fieldMappings).not.toContainEqual(
      expect.objectContaining({
        sourceField: "email",
        normalizedValue: "reception@demo.com",
      }),
    );
    expect(audit.getReportDetails().fieldMappings).not.toContainEqual(
      expect.objectContaining({
        sourceField: "password",
      }),
    );
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "email",
        targetField: "",
        normalizedValue: "ava.nguyen@example.test",
        status: "no_matching_destination_field",
      }),
    );
  });

  it("waits instead of closing OpenKairo New Patient while fields are still loading", async () => {
    const page = new FakeRunnerPage({
      bodyText: "New Patient Loading fields... Close",
      bodyTextAfterWait: "Patient Record MRN-M0XPCLB0 New Encounter Ava Nguyen DOB Mar 14 1987 Gender Female",
      elements: [fakeElement("button", { "aria-label": "Close" }, "Close")],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-openkairo-loading-dialog-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "click",
            elementId: "control-1",
            purpose: "close blocking dialog",
            rationale: "The dialog currently blocks the form and only the Close control is visible.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient record.",
            rationale: "Ava Nguyen is visible on the patient record page.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 2,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openkairo", displayName: "OpenKairo" },
      record: record(),
      audit,
    });

    expect(result.status).toBe("succeeded");
    expect(page.actions).toEqual([["wait", 1000]]);
    expect(await readEvents(audit)).toEqual([
      expect.objectContaining({ actionType: "ai-wait", result: "succeeded" }),
      expect.objectContaining({ actionType: "ai-verify", result: "succeeded" }),
    ]);
  });

  it("waits instead of stopping when OpenKairo New Patient fields are still loading", async () => {
    const page = new FakeRunnerPage({
      bodyText: "New Patient Loading fields...",
      bodyTextAfterWait: "Patient Record MRN-M0XPCLB0 New Encounter Ava Nguyen DOB Mar 14 1987 Gender Female",
      elements: [fakeElement("button", { "aria-label": "Close" }, "Close")],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-openkairo-loading-stop-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "stop",
            code: "ui_state_unexpected",
            message: "The New Patient dialog is still loading and no patient form controls are visible yet.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient record.",
            rationale: "Ava Nguyen is visible on the patient record page.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 2,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openkairo", displayName: "OpenKairo" },
      record: record(),
      audit,
    });

    expect(result.status).toBe("succeeded");
    expect(page.actions).toEqual([["wait", 1000]]);
    expect(await readEvents(audit)).toEqual([
      expect.objectContaining({ actionType: "ai-wait", result: "succeeded" }),
      expect.objectContaining({ actionType: "ai-verify", result: "succeeded" }),
    ]);
  });

  it("dismisses the OpenKairo zoom hint instead of treating it as the New Patient loading dialog", async () => {
    const page = new FakeRunnerPage({
      bodyText: "Patients New Patient Better with 150% zoom This app is designed for higher zoom Got it Close",
      bodyTextAfterClick: "Patient Details Ava Nguyen saved",
      elements: [fakeElement("button", { "aria-label": "Close" }, "Close")],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-openkairo-zoom-dialog-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "click",
            elementId: "control-1",
            purpose: "close zoom hint",
            rationale: "Dismiss the Better with 150% zoom dialog before creating a new patient.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient name.",
            rationale: "Ava Nguyen appears in the saved patient state.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 2,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openkairo", displayName: "OpenKairo" },
      record: record(),
      audit,
    });

    expect(result.status).toBe("succeeded");
    expect(page.actions).toEqual([["click", "body > button"]]);
    expect(await readEvents(audit)).toEqual([
      expect.objectContaining({ actionType: "ai-click", result: "succeeded" }),
      expect.objectContaining({ actionType: "ai-verify", result: "succeeded" }),
    ]);
  });

  it("reopens OpenKairo New Patient when the dialog disappears after an interrupted form fill", async () => {
    const page = new FakeRunnerPage({
      bodyText: "Patients Search by name, MRN, or phone New Patient",
      bodyTextAfterClick: "Patient Record MRN-M0XPCLB0 New Encounter Ava Nguyen DOB Mar 14 1987 Gender Female",
      elements: [fakeElement("button", { id: "new-patient" }, "New Patient")],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-openkairo-reopen-dialog-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "stop",
            code: "ui_state_unexpected",
            message: "The New Patient dialog is not currently visible in the observed controls.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient record.",
            rationale: "Ava Nguyen is visible on the patient record page.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 2,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openkairo", displayName: "OpenKairo" },
      record: record(),
      audit,
    });

    expect(result.status).toBe("succeeded");
    expect(page.actions).toEqual([["click", "#new-patient"]]);
    expect(await readEvents(audit)).toEqual([
      expect.objectContaining({ actionType: "ai-click", result: "succeeded" }),
      expect.objectContaining({ actionType: "ai-verify", result: "succeeded" }),
    ]);
  });

  it("prompts in the browser before low-confidence field entry and records operator confirmation", async () => {
    const page = new FakeRunnerPage({ promptResults: [{ type: "confirm" }] });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-field-confirmed-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "fill",
            elementId: "control-1",
            field: "firstName",
            value: "Ava",
            rationale: "The first-name textbox label likely matches.",
          },
          confidence: 0.91,
        },
        {
          action: {
            type: "click",
            elementId: "control-2",
            purpose: "save",
            rationale: "Save the synthetic patient.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient name.",
            rationale: "Ava Nguyen appears in the saved patient state.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), confidenceThreshold: 0.99, fieldConfirmation: "prompt-on-low-confidence" },
      record: record(),
      audit,
    });

    expect(result.status).toBe("succeeded");
    expect(page.actions).toContainEqual(["fill", "#first-name", "Ava"]);
    expect(page.evaluationScripts[0]).toContain('document.createElement("div")');
    expect(page.evaluationScripts[0]).toContain("findFieldConfirmationHost");
    expect(page.evaluationScripts[0]).toContain("event.stopPropagation()");
    expect(page.evaluationScripts[0]).not.toContain("showModal");
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "firstName",
        status: "succeeded",
        approvalSource: "operator_confirmed",
        confidenceThreshold: 0.99,
        finalValue: "Ava",
      }),
    );
  });

  it("uses an operator-edited low-confidence value before filling the browser field", async () => {
    const page = new FakeRunnerPage({ promptResults: [{ type: "edit", value: "Avery" }] });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-field-edited-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "fill",
            elementId: "control-1",
            field: "firstName",
            value: "Ava",
            rationale: "The first-name textbox label likely matches.",
          },
          confidence: 0.91,
        },
        {
          action: {
            type: "click",
            elementId: "control-2",
            purpose: "save",
            rationale: "Save the synthetic patient.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient name.",
            rationale: "Avery Nguyen appears in the saved patient state.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), confidenceThreshold: 0.99, fieldConfirmation: "prompt-on-low-confidence" },
      record: record(),
      audit,
    });

    expect(result.status).toBe("succeeded");
    expect(page.actions).toContainEqual(["fill", "#first-name", "Avery"]);
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "firstName",
        status: "succeeded",
        approvalSource: "operator_edited",
        originalProposedValue: "Ava",
        finalValue: "Avery",
      }),
    );
  });

  it("re-prompts when an operator-edited select value cannot be confidently mapped", async () => {
    const page = new FakeRunnerPage({
      elements: [
        fakeElement("label", { for: "gender" }, "Gender"),
        fakeElement("button", { id: "gender", role: "combobox" }, "Gender"),
        fakeElement("button", { class: "save" }, "Save"),
      ],
      failSelectOptions: true,
      promptResults: [
        { type: "edit", value: "not sure" },
        { type: "edit", value: "m" },
      ],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-field-reprompted-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "select",
            elementId: "control-1",
            field: "sexOrGender",
            value: "Female",
            rationale: "The gender select likely matches the intake sex field.",
          },
          confidence: 0.91,
        },
        {
          action: {
            type: "click",
            elementId: "control-2",
            purpose: "save",
            rationale: "Save the synthetic patient.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient name.",
            rationale: "Ava Nguyen appears in the saved patient state.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), confidenceThreshold: 0.99, fieldConfirmation: "prompt-on-low-confidence" },
      record: record(),
      audit,
    });

    const promptInputs = page.evaluationScripts
      .map((script) => promptInputFromEvaluationScript(script))
      .filter((input): input is Record<string, unknown> => input !== undefined);

    expect(result.status).toBe("succeeded");
    expect(page.actions).toContainEqual(["click", "#gender"]);
    expect(page.actions).toContainEqual(["click", '[role="option"]:has-text("Male")']);
    expect(promptInputs).toHaveLength(2);
    expect(page.evaluationScripts[0]).toContain("AI is interpreting this value");
    expect(promptInputs[1]?.feedbackMessage).toContain("could not confidently map");
    expect(promptInputs[1]?.currentValue).toBe("not sure");
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "sexOrGender",
        status: "succeeded",
        approvalSource: "operator_edited",
        originalProposedValue: "Female",
        finalValue: "Male",
      }),
    );
  });

  it("uses the observed forward-next control when the planner intends to advance a wizard", async () => {
    const page = new FakeRunnerPage({
      elements: [
        fakeElement("button", { id: "prev-button", class: "confirm" }, ""),
        fakeElement("button", { id: "next-button", class: "confirm right" }, ""),
      ],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-forward-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "click",
            elementId: "control-1",
            purpose: "continue to the next step",
            rationale: "The required fields are complete; use the forward/next control.",
          },
          confidence: 0.84,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient name.",
            rationale: "Ava Nguyen appears on the saved patient state.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 2,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: profile(),
      record: record(),
      audit,
    });

    expect(result.status).toBe("succeeded");
    expect(page.actions).toEqual([["click", "#next-button"]]);
  });

  it("continues a wizard instead of stopping when only unsupported intake fields remain", async () => {
    const page = new FakeRunnerPage({
      bodyText: "1 similar patient(s) found Who is the patient related to? Review patient(s)",
      bodyTextAfterClick: "Patient Details Ava Nguyen Patient ID 100HXG General Actions Show Contact Info",
      elements: [
        fakeElement("select", { id: "relationship-type" }, "Select Relationship Type"),
        fakeElement("input", { id: "person-name", value: "" }),
        fakeElement("button", { id: "next-button", "aria-label": "Forward Next" }, ""),
      ],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-openmrs-similar-patient-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "stop",
            code: "ui_state_unexpected",
            message: "The flow is on a relationship step and no remaining intake fields have matching controls.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the saved patient dashboard.",
            rationale: "Ava Nguyen appears on the patient dashboard.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 2,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openmrs", displayName: "OpenMRS" },
      record: record(),
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openmrs-demo-001" });
    expect(page.actions).toEqual([["click", "#next-button"]]);
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "email",
        targetField: "",
        status: "no_matching_destination_field",
      }),
    );
  });

  it("continues past relationship controls when pending intake fields are unsupported by the destination", async () => {
    const page = new FakeRunnerPage({
      bodyText: "Relationship Person Name Relationship Type",
      bodyTextAfterClick: "Patient Details Ava Nguyen Patient ID 100HXG General Actions Show Contact Info",
      elements: [
        fakeElement("label", { for: "person-name" }, "Person Name"),
        fakeElement("input", { id: "person-name", value: "" }),
        fakeElement("label", { for: "relationship-type" }, "Relationship Type"),
        fakeElement("select", { id: "relationship-type" }, "Select Relationship Type"),
        fakeElement("button", { id: "next-button", "aria-label": "Forward Next" }, ""),
      ],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-openmrs-unsupported-relationship-fields-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "stop",
            code: "ui_state_unexpected",
            message:
              "The form is currently on a relationship step (Person Name / Relationship Type) that does not match the remaining pending intake fields, so I cannot safely continue patient registration from the observed controls.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the saved patient dashboard.",
            rationale: "Ava Nguyen appears on the patient dashboard.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 2,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openmrs", displayName: "OpenMRS" },
      record: record(),
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openmrs-demo-001" });
    expect(page.actions).toEqual([["click", "#next-button"]]);
    expect(audit.getReportDetails().targetEvidence).toContainEqual(
      expect.objectContaining({
        target: "openmrs",
        status: "succeeded",
      }),
    );
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "email",
        status: "no_matching_destination_field",
      }),
    );
  });

  it("continues an OpenMRS relationship step when pending fields are unsupported", async () => {
    const page = new FakeRunnerPage({
      bodyText: "9 similar patient(s) found Who is the patient related to? Review patient(s)",
      bodyTextAfterClick: "Patient Details Taylor Morgan Patient ID 100HXG General Actions Show Contact Info",
      elements: [
        fakeElement("select", { id: "relationship-type" }, "Select Relationship Type"),
        fakeElement("input", { id: "person-name", value: "" }),
        fakeElement("button", { id: "next-button", "aria-label": "Forward Next" }, ""),
      ],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-openmrs-relationship-unsupported-fields-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "stop",
            code: "ui_state_unexpected",
            message:
              "The current screen shows a patient relationship step, and no observed controls safely match the pending registration fields (email, insurance, reason for visit, preferred contact, notes).",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the saved patient dashboard.",
            rationale: "Taylor Morgan appears on the patient dashboard.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 2,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openmrs", displayName: "OpenMRS" },
      record: {
        ...record(),
        firstName: "Taylor",
        lastName: "Morgan",
      },
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openmrs-demo-001" });
    expect(page.actions).toEqual([["click", "#next-button"]]);
  });

  it("continues the OpenMRS relationship step from the failed run message", async () => {
    const page = new FakeRunnerPage({
      bodyText: "9 similar patient(s) found Who is the patient related to? Review patient(s)",
      bodyTextAfterClick: "Patient Details Taylor Morgan Patient ID 100HXG General Actions Show Contact Info",
      elements: [
        fakeElement("select", { id: "relationship-type" }, "Select Relationship Type"),
        fakeElement("input", { id: "person-name", placeholder: "Person Name", value: "" }),
        fakeElement("button", { id: "next-button", class: "right", "aria-label": ">" }, ""),
      ],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-openmrs-failed-run-relationship-step-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "stop",
            code: "ui_state_unexpected",
            message:
              "Observed page is on a relationship step with only Person Name and relationship selector, but there is no visible control to directly enter the current patient or continue patient registration safely from this state.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the saved patient dashboard.",
            rationale: "Taylor Morgan appears on the patient dashboard.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 2,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openmrs", displayName: "OpenMRS" },
      record: {
        ...record(),
        firstName: "Taylor",
        lastName: "Morgan",
      },
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openmrs-demo-001" });
    expect(page.actions).toEqual([["click", "#next-button"]]);
  });

  it("continues the OpenMRS relationship step when the planner says the next action may safely advance", async () => {
    const page = new FakeRunnerPage({
      bodyText: "Who is the patient related to? Person Name Relationship Type Review patient(s)",
      bodyTextAfterClick: "Patient Details Taylor Morgan Patient ID 100HXG General Actions Show Contact Info",
      elements: [
        fakeElement("select", { id: "relationship-type" }, "Select Relationship Type"),
        fakeElement("input", { id: "person-name", placeholder: "Person Name", value: "" }),
        fakeElement("button", { id: "next-button", class: "right", "aria-label": ">" }, ""),
      ],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-openmrs-relationship-safe-advance-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "stop",
            code: "ui_state_unexpected",
            message:
              "Current registration step shows relationship controls only, with no visible fields for the remaining mapped intake data or a safe save/confirm control yet. Continue only if the next action advances to a step with relevant patient fields.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the saved patient dashboard.",
            rationale: "Taylor Morgan appears on the patient dashboard.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 2,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openmrs", displayName: "OpenMRS" },
      record: {
        ...record(),
        firstName: "Taylor",
        lastName: "Morgan",
      },
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openmrs-demo-001" });
    expect(page.actions).toEqual([["click", "#next-button"]]);
  });

  it("continues the OpenMRS relationship entry screen when remaining fields have no visible controls", async () => {
    const page = new FakeRunnerPage({
      bodyText: "Relationship entry screen Person Name Relationship Type Review patient(s)",
      bodyTextAfterClick: "Patient Details Taylor Morgan Patient ID 100HXG General Actions Show Contact Info",
      elements: [
        fakeElement("select", { id: "relationship-type" }, "Select Relationship Type"),
        fakeElement("input", { id: "person-name", placeholder: "Person Name", value: "" }),
        fakeElement("button", { id: "next-button", class: "right", "aria-label": ">" }, ""),
      ],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-openmrs-relationship-no-visible-controls-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "stop",
            code: "ui_state_unexpected",
            message:
              "The current step is a relationship entry screen with no visible controls for the remaining required intake fields or a clear safe path to complete patient registration.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the saved patient dashboard.",
            rationale: "Taylor Morgan appears on the patient dashboard.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 2,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openmrs", displayName: "OpenMRS" },
      record: {
        ...record(),
        firstName: "Taylor",
        lastName: "Morgan",
      },
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openmrs-demo-001" });
    expect(page.actions).toEqual([["click", "#next-button"]]);
  });

  it("continues the OpenMRS relationship step when only optional relationship controls are visible", async () => {
    const page = new FakeRunnerPage({
      bodyText: "Relationship Person Name Relationship Type Review patient(s)",
      bodyTextAfterClick: "Patient Details Taylor Morgan Patient ID 100HXG General Actions Show Contact Info",
      elements: [
        fakeElement("select", { id: "relationship-type" }, "Select Relationship Type"),
        fakeElement("input", { id: "person-name", placeholder: "Person Name", value: "" }),
        fakeElement("button", { id: "next-button", class: "right", "aria-label": ">" }, ""),
      ],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-openmrs-optional-relationship-controls-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "stop",
            code: "ui_state_unexpected",
            message:
              "The flow is on a relationship step with only optional relationship controls visible, and no safe observed control to continue patient registration or enter pending intake fields.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the saved patient dashboard.",
            rationale: "Taylor Morgan appears on the patient dashboard.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 2,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openmrs", displayName: "OpenMRS" },
      record: {
        ...record(),
        firstName: "Taylor",
        lastName: "Morgan",
      },
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openmrs-demo-001" });
    expect(page.actions).toEqual([["click", "#next-button"]]);
  });

  it("continues the OpenMRS relationship page when the planner cannot see a patient-creation action", async () => {
    const page = new FakeRunnerPage({
      bodyText: "Who is the patient related to? Person Name Relationship Type Review patient(s)",
      bodyTextAfterClick: "Patient Details Taylor Morgan Patient ID 100HXG General Actions Show Contact Info",
      elements: [
        fakeElement("select", { id: "relationship-type" }, "Select Relationship Type"),
        fakeElement("input", { id: "person-name", placeholder: "Person Name", value: "" }),
        fakeElement("button", { id: "next-button", class: "right", "aria-label": ">" }, ""),
      ],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-openmrs-relationship-no-patient-creation-action-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "stop",
            code: "ui_state_unexpected",
            message:
              "The current step appears to be the relationship page, but no safe patient-creation action is visible without additional context or a confirmed patient identity selection.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the saved patient dashboard.",
            rationale: "Taylor Morgan appears on the patient dashboard.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 2,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openmrs", displayName: "OpenMRS" },
      record: {
        ...record(),
        firstName: "Taylor",
        lastName: "Morgan",
      },
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openmrs-demo-001" });
    expect(page.actions).toEqual([["click", "#next-button"]]);
  });

  it("does not continue a generic required-control stop just because a forward button is visible", async () => {
    const page = new FakeRunnerPage({
      bodyText: "Insurance Information Forward",
      elements: [
        fakeElement("input", { id: "insurance-id", value: "" }),
        fakeElement("button", { id: "next-button", class: "right", "aria-label": ">" }, ""),
      ],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-generic-no-visible-control-stop-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "stop",
            code: "ui_state_unexpected",
            message: "There is no visible control for the required insurance information, so I cannot safely continue.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 1,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openmrs", displayName: "OpenMRS" },
      record: record(),
      audit,
    });

    expect(result).toEqual({
      status: "exception",
      exception: expect.objectContaining({
        code: "ui_state_unexpected",
      }),
    });
    expect(page.actions).toEqual([]);
  });

  it("selects a missing birthdate day when the target exposes day as a dropdown", async () => {
    const page = new FakeRunnerPage({
      bodyText: "New Patient First Name Taylor Last Name Morgan Date of Birth Day Month Year Gender Create Patient",
      bodyTextAfterClick: "Patient Record Taylor Morgan DOB Apr 18, 1990 Gender Female",
      elements: [
        fakeElement("label", { for: "day" }, "Day"),
        fakeElement("select", { id: "day", value: "" }, "Day"),
        fakeElement("label", { for: "month" }, "Month"),
        fakeElement("select", { id: "month", value: "04" }, "April"),
        fakeElement("label", { for: "year" }, "Year"),
        fakeElement("select", { id: "year", value: "1990" }, "1990"),
        fakeElement("button", { id: "create-patient" }, "Create Patient"),
      ],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-openkairo-birthdate-day-select-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "click",
            elementId: "control-4",
            purpose: "create patient",
            rationale: "The visible fields are complete and the Create Patient button submits the dialog.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "click",
            elementId: "control-4",
            purpose: "create patient",
            rationale: "The missing birthdate day has been selected and the Create Patient button submits the dialog.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the saved patient record.",
            rationale: "Taylor Morgan appears on the saved patient record.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 3,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openkairo", displayName: "OpenKairo" },
      record: {
        ...record(),
        firstName: "Taylor",
        lastName: "Morgan",
        dateOfBirth: "1990-04-18",
      },
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openkairo-demo-001" });
    expect(page.actions).toEqual([
      ["select", "#day", "label", "18"],
      ["click", "#create-patient"],
    ]);
  });

  it("fills missing birthdate controls before continuing an OpenMRS birthdate step", async () => {
    const page = new FakeRunnerPage({
      bodyText: "What's the patient's birth date? You need to inform a valid date Day Month Year",
      bodyTextAfterClick: "Patient Details Marcus Lee Patient ID 100HXG General Actions Show Contact Info",
      elements: [
        fakeElement("label", { for: "birthdateDay-field" }, "Day (required)"),
        fakeElement("input", { id: "birthdateDay-field", value: "2" }),
        fakeElement("label", { for: "birthdateMonth-field" }, "Month (required)"),
        fakeElement("select", { id: "birthdateMonth-field", value: "" }, "Select"),
        fakeElement("label", { for: "birthdateYear-field" }, "Year (required)"),
        fakeElement("input", { id: "birthdateYear-field", value: "" }),
        fakeElement("button", { id: "next-button", "aria-label": "Forward Next" }, ""),
      ],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-openmrs-birthdate-guard-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "stop",
            code: "ui_state_unexpected",
            message:
              "Birthdate step is still shown but the date of birth appears already entered; advancing further risks repeating a non-progress action without new observed controls for pending fields.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "stop",
            code: "ui_state_unexpected",
            message:
              "Birthdate step is still shown but the date of birth appears already entered; advancing further risks repeating a non-progress action without new observed controls for pending fields.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "click",
            elementId: "control-4",
            purpose: "continue birthdate step",
            rationale: "The birthdate controls are complete.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the saved patient dashboard.",
            rationale: "Marcus Lee appears on the patient dashboard.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 4,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openmrs", displayName: "OpenMRS" },
      record: {
        ...record(),
        firstName: "Marcus",
        lastName: "Lee",
        dateOfBirth: "1979-11-02",
      },
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openmrs-demo-001" });
    expect(page.actions).toEqual([
      ["select", "#birthdateMonth-field", "label", "November"],
      ["fill", "#birthdateYear-field", "1979"],
      ["click", "#next-button"],
    ]);
  });

  it("creates a patient instead of stopping when only unsupported fields remain in the new-patient dialog", async () => {
    const page = new FakeRunnerPage({
      bodyText:
        "New Patient First Name Ava Last Name Nguyen Date of Birth 1987 Gender Female Cancel Create Patient",
      bodyTextAfterClick: "Patient Record MRN-M0XPCLB0 New Encounter Ava Nguyen DOB 1987 Gender Female",
      elements: [
        fakeElement("label", { for: "first-name" }, "First Name"),
        fakeElement("input", { id: "first-name", value: "Ava" }),
        fakeElement("label", { for: "last-name" }, "Last Name"),
        fakeElement("input", { id: "last-name", value: "Nguyen" }),
        fakeElement("select", { id: "year" }, "1987"),
        fakeElement("select", { id: "gender" }, "Female"),
        fakeElement("button", { id: "cancel" }, "Cancel"),
        fakeElement("button", { id: "create-patient" }, "Create Patient"),
      ],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-openkairo-create-with-extra-fields-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "stop",
            code: "ui_state_unexpected",
            message:
              "The visible new-patient dialog only exposes first name, last name, date of birth, and gender controls; no safe observed controls are available for the remaining intake fields before creating the patient.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient record.",
            rationale: "Ava Nguyen is visible on the patient record page.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 2,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openkairo", displayName: "OpenKairo" },
      record: record(),
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openkairo-demo-001" });
    expect(page.actions).toEqual([["click", "#create-patient"]]);
  });

  it("skips implausibly low-confidence autonomous field actions instead of overwriting completed fields", async () => {
    const page = new FakeRunnerPage({
      bodyTextAfterClick: "Patient Record MRN-M0XPCLB0 New Encounter Ava Nguyen DOB 1987 Gender Female",
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-low-confidence-skip-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "fill",
            elementId: "control-1",
            field: "firstName",
            value: "Ava",
            rationale: "The first-name textbox matches the intake first name.",
          },
          confidence: 0.98,
        },
        {
          action: {
            type: "fill",
            elementId: "control-1",
            field: "phone",
            value: "+13125550198",
            rationale: "The same textbox may be a remaining phone field.",
          },
          confidence: 0.12,
        },
        {
          action: {
            type: "click",
            elementId: "control-2",
            purpose: "create patient",
            rationale: "Save the patient after entering supported fields.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient record.",
            rationale: "Ava Nguyen is visible on the patient record page.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 4,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openkairo", displayName: "OpenKairo", confidenceThreshold: 0.99 },
      record: record(),
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openkairo-demo-001" });
    expect(page.actions).toEqual([
      ["fill", "#first-name", "Ava"],
      ["click", "button.save"],
    ]);
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "phone",
        targetField: "First Name",
        status: "skipped",
        approvalSource: "agent",
        skipReason: "AI confidence was too low to safely fill this field without operator input.",
      }),
    );
  });

  it("blocks forbidden destructive clicks before browser execution", async () => {
    const page = new FakeRunnerPage({
      elements: [
        fakeElement("label", { for: "first-name" }, "First Name"),
        fakeElement("input", { id: "first-name", value: "" }),
        fakeElement("button", { class: "delete" }, "Delete Patient"),
      ],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-forbidden-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "click",
            elementId: "control-2",
            purpose: "delete patient",
            rationale: "The delete button is visible.",
          },
          confidence: 0.8,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 1,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: profile(),
      record: record(),
      audit,
    });

    expect(result).toEqual({
      status: "exception",
      exception: expect.objectContaining({
        code: "ui_state_unexpected",
        message: "AI action matched a forbidden target operation: Delete Patient.",
        screenshotPath: "screenshots/demo-001/openkairo/0001-ai-step-1.png",
      }),
    });
    expect(page.actions).toEqual([]);
    expect(browser.closed).toBe(true);
    expect(await readEvents(audit)).toEqual([
      expect.objectContaining({
        actionType: "ai-click",
        result: "failed: forbidden target operation",
        exceptionCode: "ui_state_unexpected",
      }),
    ]);
  });

  it("allows ordinary login clicks even when the rationale mentions admin credentials", async () => {
    const page = new FakeRunnerPage({
      bodyText: "Login Ava Nguyen saved",
      title: "Patient Details",
      elements: [
        fakeElement("label", { for: "username" }, "Username"),
        fakeElement("input", { id: "username", value: "admin" }),
        fakeElement("button", { class: "login" }, "Login"),
      ],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-login-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "click",
            elementId: "control-2",
            purpose: "login",
            rationale: "Log in with the provided admin credentials.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient name.",
            rationale: "Ava Nguyen is visible on the patient details page.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: profile(),
      record: record(),
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openkairo-demo-001" });
    expect(page.actions).toEqual([["click", "button.login"]]);
    expect(await readEvents(audit)).toEqual([
      expect.objectContaining({ actionType: "ai-click", result: "succeeded" }),
      expect.objectContaining({ actionType: "ai-verify", result: "succeeded" }),
    ]);
  });

  it("fills missing credentials before executing a planned login click", async () => {
    const page = new FakeRunnerPage({
      elements: [
        fakeElement("label", { for: "username" }, "Username"),
        fakeElement("input", { id: "username", value: "" }),
        fakeElement("label", { for: "password" }, "Password"),
        fakeElement("input", { id: "password", value: "", type: "password" }),
        fakeElement("button", { class: "login" }, "Log In"),
      ],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-login-guard-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "click",
            elementId: "control-3",
            purpose: "log in",
            rationale: "Log in is the next progress action.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "click",
            elementId: "control-3",
            purpose: "log in",
            rationale: "Log in is the next progress action.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "click",
            elementId: "control-3",
            purpose: "log in",
            rationale: "Credentials are now entered.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient name.",
            rationale: "Ava Nguyen is visible after login.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 4,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: profile(),
      record: record(),
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openkairo-demo-001" });
    expect(page.actions).toEqual([
      ["fill", "#username", "admin"],
      ["fill", "#password", "pass"],
      ["click", "button.login"],
    ]);
    expect(audit.getReportDetails().fieldMappings).not.toContainEqual(
      expect.objectContaining({
        sourceField: "username",
      }),
    );
    expect(audit.getReportDetails().fieldMappings).not.toContainEqual(
      expect.objectContaining({
        sourceField: "password",
      }),
    );
  });

  it("submits the OpenMRS login form when the planner stops after location selection", async () => {
    const page = new FakeRunnerPage({
      bodyText: "LOGIN Username Password Location for this session Registration Desk Log In",
      bodyTextAfterClick: "Patient Details Taylor Morgan Patient ID 100HXG General Actions",
      elements: [
        fakeElement("label", { for: "username" }, "Username"),
        fakeElement("input", { id: "username", value: "admin" }),
        fakeElement("label", { for: "password" }, "Password"),
        fakeElement("input", { id: "password", value: "pass", type: "password" }),
        fakeElement("li", { id: "registration-desk", onclick: "chooseLocation()", class: "selected" }, "Registration Desk"),
        fakeElement("button", { id: "login-button" }, "Log In"),
      ],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-openmrs-login-stop-submit-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "stop",
            code: "ui_state_unexpected",
            message:
              "Login/session transition appears incomplete or the observed page is still the login screen despite prior successful login actions. Need a fresh page observation before choosing the next registration control.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the saved patient dashboard.",
            rationale: "Taylor Morgan appears on the patient dashboard.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 2,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openmrs", displayName: "OpenMRS" },
      record: {
        ...record(),
        firstName: "Taylor",
        lastName: "Morgan",
      },
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openmrs-demo-001" });
    expect(page.actions).toEqual([["click", "#login-button"]]);
  });

  it("rejects verification on an unsaved patient form even when the patient name is visible", async () => {
    const page = new FakeRunnerPage({
      bodyText: "New Patient First Name Ava Last Name Nguyen Save",
      title: "New Patient",
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-unsaved-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient name.",
            rationale: "Ava Nguyen is visible on the form.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 1,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: profile(),
      record: record(),
      audit,
    });

    expect(result).toEqual({
      status: "exception",
      exception: expect.objectContaining({
        code: "verification_failed",
        message: "AI verification found an unsaved patient entry form instead of a saved patient state.",
        screenshotPath: "screenshots/demo-001/openkairo/0001-ai-step-1.png",
      }),
    });
    expect(browser.closed).toBe(true);
    expect(await readEvents(audit)).toEqual([
      expect.objectContaining({
        actionType: "ai-verify",
        result: "failed: unsaved patient entry form visible",
        exceptionCode: "verification_failed",
      }),
    ]);
  });

  it("rejects OpenKairo verification while the create patient modal is still visible", async () => {
    const page = new FakeRunnerPage({
      bodyText:
        "Patients PATIENT MRN AGE / GENDER DOB REGISTERED Taylor Morgan 174029 Run-20260511174033-7a9f9 New Patient First Name Taylor Last Name Morgan 174029 Run-20260511174033-7a9f9 Date of Birth 1990 Gender Female Cancel Create Patient",
      title: "OpenKairo",
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-openkairo-unsaved-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient record.",
            rationale: "The synthetic patient name is visible.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 1,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openkairo", displayName: "OpenKairo" },
      record: {
        ...record(),
        firstName: "Taylor",
        lastName: "Morgan 174029 Run-20260511174033-7a9f9",
        dateOfBirth: "1990-04-18",
      },
      audit,
    });

    expect(result).toEqual({
      status: "exception",
      exception: expect.objectContaining({
        code: "verification_failed",
        message: "AI verification found an unsaved patient entry form instead of a saved patient state.",
        screenshotPath: "screenshots/demo-001/openkairo/0001-ai-step-1.png",
      }),
    });
    expect(await readEvents(audit)).toEqual([
      expect.objectContaining({
        actionType: "ai-verify",
        result: "failed: unsaved patient entry form visible",
        exceptionCode: "verification_failed",
      }),
    ]);
  });

  it("accepts OpenKairo patient record pages as saved patient states", async () => {
    const page = new FakeRunnerPage({
      bodyText: "Patient Record MRN-M0XPCLB0 New Encounter Ava Nguyen DOB Mar 14 1987 Gender Female",
      title: "OpenKairo",
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-openkairo-verify-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient record.",
            rationale: "Ava Nguyen is visible on the patient record page.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 1,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openkairo", displayName: "OpenKairo" },
      record: record(),
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openkairo-demo-001" });
    expect(await readEvents(audit)).toEqual([expect.objectContaining({ actionType: "ai-verify", result: "succeeded" })]);
  });

  it("accepts OpenMRS 3 localized patient charts as saved patient states", async () => {
    const page = new FakeRunnerPage({
      bodyText: "Priya Shah Run-20260509022520-3c144 Resumen del paciente Visitas Condiciones Alergias Medicamentos",
      title: "OpenMRS",
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-openmrs3-verify-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient chart.",
            rationale: "The localized OpenMRS chart page shows the saved patient.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 1,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openmrs", displayName: "OpenMRS" },
      record: {
        ...record(),
        firstName: "Priya",
        lastName: "Shah Run-20260509022520-3c144",
      },
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openmrs-demo-001" });
  });

  it("accepts OpenMRS 2 patient dashboards as saved patient states", async () => {
    const page = new FakeRunnerPage({
      bodyText:
        "Ava Nguyen Run-20260511021216-87e0c Patient ID 100HXG Diagnoses Recent Visits General Actions Start Visit",
      title: "OpenMRS",
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-openmrs2-verify-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient dashboard.",
            rationale: "The OpenMRS dashboard shows the saved patient.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 1,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openmrs", displayName: "OpenMRS" },
      record: {
        ...record(),
        lastName: "Nguyen Run-20260511021216-87e0c",
      },
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openmrs-demo-001" });
  });

  it("expands OpenMRS contact information before recording the final verification screenshot", async () => {
    const page = new FakeRunnerPage({
      bodyText: "Ava Nguyen Female 36 year(s) Patient ID 100ABC Diagnoses Recent Visits General Actions Show Contact Info",
      title: "OpenMRS",
      elements: [
        fakeElement("button", { id: "contact-toggle" }, "Show Contact Info"),
      ],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-openmrs-contact-proof-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "verify",
            criteria: "The OpenMRS dashboard shows the saved patient.",
            rationale: "The OpenMRS dashboard shows the saved patient.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 1,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openmrs", displayName: "OpenMRS" },
      record: record(),
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openmrs-demo-001" });
    expect(page.actions).toEqual([["click", "#contact-toggle"]]);
    expect(audit.getReportDetails().targetEvidence).toContainEqual(
      expect.objectContaining({
        status: "succeeded",
        screenshotPath: "screenshots/demo-001/openmrs/0002-ai-openmrs-contact-info.png",
      }),
    );
    expect(await readEvents(audit)).toEqual([
      expect.objectContaining({ actionType: "ai-click", result: "succeeded" }),
      expect.objectContaining({ actionType: "ai-verify", result: "succeeded" }),
    ]);
  });

  it("returns an exception and closes the browser when the planner stops", async () => {
    const page = new FakeRunnerPage();
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-stop-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "stop",
            code: "verification_failed",
            message: "Planner could not verify the target state.",
          },
          confidence: 1,
        },
      ]),
      launchBrowser: async () => browser,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: profile(),
      record: record(),
      audit,
    });

    expect(result).toEqual({
      status: "exception",
      exception: expect.objectContaining({
        code: "verification_failed",
        message: "Planner could not verify the target state.",
        screenshotPath: "screenshots/demo-001/openkairo/0001-ai-step-1.png",
      }),
    });
    expect(browser.closed).toBe(true);
    expect(audit.getReportDetails().targetEvidence).toContainEqual(
      expect.objectContaining({
        status: "exception",
        screenshotPath: "screenshots/demo-001/openkairo/0001-ai-step-1.png",
      }),
    );
  });

  it("succeeds instead of stopping when the observed page already proves the patient was saved", async () => {
    const page = new FakeRunnerPage({
      bodyText: "Patient Record MRN-M0XPCLB0 New Encounter Ava Nguyen DOB Mar 14 1987 Gender Female",
      title: "OpenKairo",
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-stop-after-save-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "stop",
            code: "ui_state_unexpected",
            message: "No safe progress action is needed from the observed controls.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 1,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openkairo", displayName: "OpenKairo" },
      record: record(),
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openkairo-demo-001" });
    expect(await readEvents(audit)).toEqual([
      expect.objectContaining({
        actionType: "ai-verify",
        result: "succeeded",
      }),
    ]);
    expect(audit.getReportDetails().targetEvidence).toContainEqual(
      expect.objectContaining({
        status: "succeeded",
        screenshotPath: "screenshots/demo-001/openkairo/0001-ai-step-1.png",
        message: "Saved patient record is visible for Ava Nguyen.",
      }),
    );
  });

  it("succeeds when the AI stop identifies a saved patient page despite partial visible name text", async () => {
    const page = new FakeRunnerPage({
      bodyText:
        "Patient Record MRN-MP1NC2CF New Encounter +13125550198 Nguyen Run-20260511201845 Age 36 Gender Female DOB 1990",
      title: "OpenKairo",
      elements: [],
    });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-stop-partial-saved-patient-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "stop",
            code: "ui_state_unexpected",
            message:
              "The visible page is already a saved patient detail page for Ava Nguyen, and no safe control is available to complete the remaining intake fields from this state.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 1,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: { ...profile(), name: "openkairo", displayName: "OpenKairo" },
      record: record(),
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openkairo-demo-001" });
    expect(await readEvents(audit)).toEqual([
      expect.objectContaining({
        actionType: "ai-verify",
        result: "succeeded",
      }),
    ]);
  });

  it("rejects verification when the observed page does not show the synthetic patient", async () => {
    const page = new FakeRunnerPage({ bodyText: "OpenKairo dashboard Patient Search" });
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-verify-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient name.",
            rationale: "The dashboard is visible.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 1,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: profile(),
      record: record(),
      audit,
    });

    expect(result).toEqual({
      status: "exception",
      exception: expect.objectContaining({
        code: "verification_failed",
        message: "AI verification did not find the synthetic patient name in the observed page.",
        screenshotPath: "screenshots/demo-001/openkairo/0001-ai-step-1.png",
      }),
    });
    expect(browser.closed).toBe(true);
    expect(await readEvents(audit)).toEqual([
      expect.objectContaining({
        actionType: "ai-verify",
        result: "failed: synthetic patient name not visible",
        exceptionCode: "verification_failed",
      }),
    ]);
    expect(audit.getReportDetails().targetEvidence).toContainEqual(
      expect.objectContaining({
        status: "exception",
        screenshotPath: "screenshots/demo-001/openkairo/0001-ai-step-1.png",
        message: "AI verification did not find the synthetic patient name in the observed page.",
      }),
    );
  });

  it("continues planning with fresh observations after a failed executable browser action", async () => {
    const page = new FakeRunnerPage();
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-failure-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        {
          action: {
            type: "click",
            elementId: "control-99",
            purpose: "save",
            rationale: "The planner selected a stale save button.",
          },
          confidence: 0.8,
        },
        {
          action: {
            type: "click",
            elementId: "control-2",
            purpose: "save",
            rationale: "Retry with the currently observed save button.",
          },
          confidence: 0.9,
        },
        {
          action: {
            type: "verify",
            criteria: "The page shows the synthetic patient name.",
            rationale: "Ava Nguyen appears in the saved patient page.",
          },
          confidence: 0.9,
        },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 3,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: profile(),
      record: record(),
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openkairo-demo-001" });
    expect(browser.closed).toBe(true);
    expect(await readEvents(audit)).toEqual([
      expect.objectContaining({
        actionType: "ai-click",
        result: "failed: stale element id: control-99",
        exceptionCode: "ui_state_unexpected",
      }),
      expect.objectContaining({
        actionType: "ai-click",
        result: "succeeded",
      }),
      expect.objectContaining({
        actionType: "ai-verify",
        result: "succeeded",
      }),
    ]);
  });

  it("returns a ui_state_unexpected exception and closes the browser when max steps are exhausted", async () => {
    const page = new FakeRunnerPage();
    const browser = new FakeRunnerBrowser(page);
    const audit = await createAudit("ai-web-runner-max-");
    const runner = new AiWebTargetRunner({
      planner: new StaticAiWebPlanner([
        { action: { type: "wait", reason: "Need more page changes." }, confidence: 0.7 },
        { action: { type: "wait", reason: "Still waiting." }, confidence: 0.7 },
      ]),
      launchBrowser: async () => browser,
      maxSteps: 2,
    });

    const result = await runner.runRecord({
      runId: "run-test",
      profile: profile(),
      record: record(),
      audit,
    });

    expect(result).toEqual({
      status: "exception",
      exception: expect.objectContaining({
        code: "ui_state_unexpected",
        message: "AI web target runner exceeded 2 steps without verification.",
        screenshotPath: "screenshots/demo-001/openkairo/0002-ai-step-2.png",
      }),
    });
    expect(browser.closed).toBe(true);
    expect(audit.getReportDetails().targetEvidence).toContainEqual(
      expect.objectContaining({
        status: "exception",
        screenshotPath: "screenshots/demo-001/openkairo/0002-ai-step-2.png",
      }),
    );
  });
});

async function createAudit(prefix = "ai-web-runner-"): Promise<FileAuditStore> {
  return FileAuditStore.create({
    runsDir: await mkdtemp(join(tmpdir(), prefix)),
    runId: "run-test",
    now: () => "2026-05-08T12:00:00.000Z",
  });
}

async function readEvents(audit: FileAuditStore): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(join(audit.runDir, "events.jsonl"), "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function profile(): TargetProfile {
  return {
    name: "openkairo",
    displayName: "OpenKairo",
    baseUrl: "https://example.test/emr",
    credentials: { username: "admin", password: "pass" },
    task: "Create one synthetic patient.",
    workflowHints: [],
    successCriteria: ["The page shows the synthetic patient name."],
    forbiddenActions: ["Do not delete patients."],
    concurrency: 1,
  };
}

class CapturingPlanner implements AiWebPlanner {
  readonly inputs: AiWebPlanInput[] = [];
  private readonly queuedPlans: AiWebPlan[];

  constructor(plans: AiWebPlan[]) {
    this.queuedPlans = [...plans];
  }

  async plan(input: AiWebPlanInput): Promise<AiWebPlan> {
    this.inputs.push(input);
    return this.queuedPlans.shift() ?? {
      action: {
        type: "stop",
        code: "ui_state_unexpected",
        message: "No queued plan.",
      },
      confidence: 1,
    };
  }
}

function record(): NormalizedIntakeRecord {
  return {
    sourceRecordId: "demo-001",
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
    reasonForVisit: "Annual wellness visit",
    preferredContactMethod: "phone",
    sourceFormat: "json",
    rawSourceExcerpt: "Ava Nguyen intake",
  };
}

class FakeRunnerBrowser {
  closed = false;

  constructor(private readonly page: FakeRunnerPage) {}

  async newPage(_options: { viewport: { width: number; height: number } }): Promise<FakeRunnerPage> {
    return this.page;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeRunnerPage {
  readonly actions: unknown[] = [];
  readonly gotoUrls: string[] = [];
  readonly evaluationScripts: string[] = [];
  readonly document: FakeDocument;

  constructor(
    private readonly options: {
      bodyText?: string;
      title?: string;
      elements?: FakeElement[];
      bodyTextAfterWait?: string;
      bodyTextAfterClick?: string;
      promptResults?: unknown[];
      failSelectOptions?: boolean;
      gotoErrors?: Error[];
    } = {},
  ) {
    this.document = new FakeDocument(
      options.elements ?? [
        fakeElement("label", { for: "first-name" }, "First Name"),
        fakeElement("input", { id: "first-name", value: "" }),
        fakeElement("button", { class: "save" }, "Save"),
      ],
    );
  }

  url(): string {
    return this.gotoUrls.at(-1) ?? "about:blank";
  }

  async title(): Promise<string> {
    return this.options.title ?? (this.actions.some((action) => Array.isArray(action) && action[0] === "click") ? "Patient Details" : "New Patient");
  }

  locator(selector: string) {
    return {
      innerText: async () =>
        selector === "body"
          ? (this.actions.some((action) => Array.isArray(action) && action[0] === "click") && this.options.bodyTextAfterClick
            ? this.options.bodyTextAfterClick
            : this.actions.some((action) => Array.isArray(action) && action[0] === "wait") && this.options.bodyTextAfterWait
            ? this.options.bodyTextAfterWait
            : this.options.bodyText ??
            (this.actions.some((action) => Array.isArray(action) && (action[0] === "click" || action[0] === "wait"))
              ? "Patient Details Ava Nguyen saved"
              : "First Name Save"))
          : "",
      fill: async (value: string) => {
        const element = this.document.querySelectorAll(selector)[0];
        if (element) {
          element.value = value;
        }
        this.actions.push(["fill", selector, value]);
      },
      selectOption: async (option: { label?: string; value?: string }) => {
        const element = this.document.querySelectorAll(selector)[0];
        if (element) {
          element.value = option.label ?? option.value ?? "";
        }
        this.actions.push(["select", selector, option.label ? "label" : "value", option.label ?? option.value]);
        if (this.options.failSelectOptions) {
          throw new Error(`selectOption unavailable: ${selector}`);
        }
      },
      click: async () => {
        this.actions.push(["click", selector]);
      },
    };
  }

  async goto(url: string, _options: { waitUntil: "domcontentloaded" }): Promise<void> {
    this.gotoUrls.push(url);
    const error = this.options.gotoErrors?.shift();
    if (error) {
      throw error;
    }
  }

  async screenshot(_options: { fullPage: boolean }): Promise<Buffer> {
    return Buffer.from("fake-png");
  }

  async waitForTimeout(timeoutMs: number): Promise<void> {
    this.actions.push(["wait", timeoutMs]);
  }

  async evaluate<T>(pageFunction: (() => T) | string): Promise<T> {
    if (typeof pageFunction === "string") {
      this.evaluationScripts.push(pageFunction);
      if (!pageFunction.includes("agentic-field-confirmation-input")) {
        return undefined as T;
      }
      const result = this.options.promptResults?.shift();
      if (result instanceof Error) {
        throw result;
      }
      return result as T;
    }

    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const previousNode = globalThis.Node;
    const previousCss = globalThis.CSS;

    Object.assign(globalThis, {
      document: this.document,
      window: {
        getComputedStyle: () => ({
          display: "block",
          visibility: "visible",
        }),
      },
      Node: { ELEMENT_NODE: 1 },
      CSS: { escape: cssEscape },
    });

    try {
      return pageFunction();
    } finally {
      Object.assign(globalThis, {
        document: previousDocument,
        window: previousWindow,
        Node: previousNode,
        CSS: previousCss,
      });
    }
  }
}

class FakeDocument {
  readonly body = fakeElement("body");

  constructor(readonly elements: FakeElement[]) {
    this.body.children = elements;
    for (const element of elements) {
      element.parentElement = this.body;
      element.ownerDocument = this;
    }
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector.includes(",")) {
      const selectors = selector.split(",").map((part) => part.trim());
      return this.elements.filter((element) =>
        selectors.some((part) => {
          if (part.startsWith("[")) {
            const attributeName = part.match(/^\[([^=\]]+)/)?.[1];
            return attributeName ? element.getAttribute(attributeName) !== null : false;
          }
          return element.tagName === part.toUpperCase();
        }),
      );
    }

    const id = selector.match(/^#(.+)$/)?.[1];
    if (id) {
      return this.elements.filter((element) => element.id === unescapeCssValue(id));
    }

    const classSelector = selector.match(/^([a-z]+)((?:\.[^.\s]+)+)$/);
    if (classSelector) {
      const [, tag, classParts] = classSelector;
      const classes = classParts
        .split(".")
        .filter(Boolean)
        .map(unescapeCssValue);
      return this.elements.filter((element) => {
        const elementClasses = (element.getAttribute("class") ?? "").split(/\s+/);
        return element.tagName === tag.toUpperCase() && classes.every((className) => elementClasses.includes(className));
      });
    }

    return this.elements.filter((element) => element.tagName === selector.toUpperCase());
  }

  querySelector(selector: string): FakeElement | undefined {
    const labelFor = selector.match(/^label\[for="(.+)"\]$/)?.[1];
    if (labelFor) {
      return this.elements.find((element) => element.tagName === "LABEL" && element.getAttribute("for") === labelFor);
    }

    return undefined;
  }
}

class FakeElement {
  readonly nodeType = 1;
  readonly tagName: string;
  ownerDocument: FakeDocument | null = null;
  parentElement: FakeElement | null = null;
  children: FakeElement[] = [];
  innerText: string;
  textContent: string;
  value: string;

  constructor(
    tag: string,
    private readonly attributes: Record<string, string>,
    text = "",
  ) {
    this.tagName = tag.toUpperCase();
    this.innerText = text;
    this.textContent = text;
    this.value = attributes.value ?? "";
  }

  get id(): string {
    return this.attributes.id ?? "";
  }

  get type(): string {
    return this.attributes.type ?? "";
  }

  get labels(): FakeElement[] {
    if (!this.id || !this.ownerDocument) {
      return [];
    }
    return this.ownerDocument.elements.filter((element) => element.tagName === "LABEL" && element.getAttribute("for") === this.id);
  }

  getBoundingClientRect(): { width: number; height: number } {
    return { width: 100, height: 20 };
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  closest(selector: string): FakeElement | null {
    return selector === "label" && this.tagName === "LABEL" ? this : null;
  }
}

function fakeElement(tag: string, attributes: Record<string, string> = {}, text = ""): FakeElement {
  return new FakeElement(tag, attributes, text);
}

function cssEscape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character.codePointAt(0)?.toString(16)} `);
}

function unescapeCssValue(value: string): string {
  return value.replace(/\\([0-9a-f]+) /gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

function promptInputFromEvaluationScript(script: string): Record<string, unknown> | undefined {
  const match = script.match(/agentic-field-confirmation-input:([^\s*]+)/);
  if (!match) return undefined;
  return JSON.parse(decodeURIComponent(match[1] ?? "")) as Record<string, unknown>;
}
