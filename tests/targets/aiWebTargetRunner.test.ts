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

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openemr-demo-001" });
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
        target: "openemr",
        status: "succeeded",
        targetRecordId: "ai-openemr-demo-001",
      }),
    );
    expect(details.fieldMappings).toContainEqual(
      expect.objectContaining({
        recordId: "demo-001",
        target: "openemr",
        sourceField: "firstName",
        targetField: "firstName",
        normalizedValue: "Ava",
        finalValue: "Ava",
        action: "fill",
        status: "succeeded",
        confidenceThreshold: 0.99,
        approvalSource: "agent",
        selectedSelector: "#first-name",
        selectorCandidates: ["#first-name"],
        fieldScreenshotPath: "screenshots/demo-001/openemr/0002-ai-field-firstName.png",
      }),
    );
    expect(await readEvents(audit)).toEqual([
      expect.objectContaining({ actionType: "ai-fill", result: "succeeded" }),
      expect.objectContaining({ actionType: "ai-click", result: "succeeded" }),
      expect.objectContaining({ actionType: "ai-verify", result: "succeeded" }),
    ]);
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
        screenshotPath: "screenshots/demo-001/openemr/0001-ai-step-1.png",
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
        fakeElement("input", { id: "username", value: "" }),
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

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openemr-demo-001" });
    expect(page.actions).toEqual([["click", "button.login"]]);
    expect(await readEvents(audit)).toEqual([
      expect.objectContaining({ actionType: "ai-click", result: "succeeded" }),
      expect.objectContaining({ actionType: "ai-verify", result: "succeeded" }),
    ]);
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
        message: "AI verification did not find a saved patient state in the observed page.",
        screenshotPath: "screenshots/demo-001/openemr/0001-ai-step-1.png",
      }),
    });
    expect(browser.closed).toBe(true);
    expect(await readEvents(audit)).toEqual([
      expect.objectContaining({
        actionType: "ai-verify",
        result: "failed: saved patient state not visible",
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
        screenshotPath: "screenshots/demo-001/openemr/0001-ai-step-1.png",
      }),
    });
    expect(browser.closed).toBe(true);
    expect(audit.getReportDetails().targetEvidence).toContainEqual(
      expect.objectContaining({
        status: "exception",
        screenshotPath: "screenshots/demo-001/openemr/0001-ai-step-1.png",
      }),
    );
  });

  it("rejects verification when the observed page does not show the synthetic patient", async () => {
    const page = new FakeRunnerPage({ bodyText: "OpenEMR dashboard Patient Search" });
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
        screenshotPath: "screenshots/demo-001/openemr/0001-ai-step-1.png",
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
        screenshotPath: "screenshots/demo-001/openemr/0001-ai-step-1.png",
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

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openemr-demo-001" });
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
        screenshotPath: "screenshots/demo-001/openemr/0002-ai-step-2.png",
      }),
    });
    expect(browser.closed).toBe(true);
    expect(audit.getReportDetails().targetEvidence).toContainEqual(
      expect.objectContaining({
        status: "exception",
        screenshotPath: "screenshots/demo-001/openemr/0002-ai-step-2.png",
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
    name: "openemr",
    displayName: "OpenEMR",
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
  readonly document: FakeDocument;

  constructor(
    private readonly options: {
      bodyText?: string;
      title?: string;
      elements?: FakeElement[];
      bodyTextAfterWait?: string;
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
          ? (this.actions.some((action) => Array.isArray(action) && action[0] === "wait") && this.options.bodyTextAfterWait
            ? this.options.bodyTextAfterWait
            : this.options.bodyText ??
            (this.actions.some((action) => Array.isArray(action) && (action[0] === "click" || action[0] === "wait"))
              ? "Patient Details Ava Nguyen saved"
              : "First Name Save"))
          : "",
      fill: async (value: string) => {
        this.actions.push(["fill", selector, value]);
      },
      selectOption: async (option: { label: string }) => {
        this.actions.push(["select", selector, option.label]);
      },
      click: async () => {
        this.actions.push(["click", selector]);
      },
    };
  }

  async goto(url: string, _options: { waitUntil: "domcontentloaded" }): Promise<void> {
    this.gotoUrls.push(url);
  }

  async screenshot(_options: { fullPage: boolean }): Promise<Buffer> {
    return Buffer.from("fake-png");
  }

  async waitForTimeout(timeoutMs: number): Promise<void> {
    this.actions.push(["wait", timeoutMs]);
  }

  async evaluate<T>(pageFunction: () => T): Promise<T> {
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
