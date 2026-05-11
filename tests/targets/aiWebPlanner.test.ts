import { describe, expect, it } from "vitest";
import type { AiWebAction, AiWebPlanInput, OpenAiAiWebPlannerClient } from "../../src/targets/aiWebPlanner.js";
import {
  OPENAI_AI_WEB_PLANNER_API_KEY_REQUIRED_ERROR,
  OpenAiAiWebPlanner,
  StaticAiWebPlanner,
  validateAiWebPlan,
} from "../../src/targets/aiWebPlanner.js";

const runnerPlanInput = {
  profile: {
    name: "openkairo",
    displayName: "OpenKairo",
    baseUrl: "https://openkairo.example.test/openkairo",
    credentials: { username: "admin", password: "pass" },
    task: "Create one synthetic patient.",
    workflowHints: ["If Patient Finder reports no matching records, click Add New Patient."],
    successCriteria: ["A saved patient detail page is visible."],
    forbiddenActions: ["Do not delete patients."],
    concurrency: 1,
  },
  record: {
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
  },
  observation: {
    currentUrl: "https://openkairo.example.test/openkairo",
    title: "OpenKairo",
    visibleText: "Patient Finder Add New Patient",
    screenshotPath: "screenshots/demo/openkairo/0001-ai-step-1.png",
    controls: [],
    elementSelectors: new Map(),
  },
  completedFields: ["firstName"],
  skippedFields: ["insuranceGroupId"],
  recentActions: [],
  stepCount: 3,
} satisfies AiWebPlanInput;

void runnerPlanInput;

const plannerActionContract = [
  { type: "wait", reason: "OpenMRS is processing the save request." },
  { type: "screenshot", label: "post-save-proof" },
  { type: "verify", criteria: "Synthetic patient detail page is visible.", rationale: "success criteria" },
  { type: "stop", code: "verification_failed", message: "The patient detail page did not appear." },
] satisfies AiWebAction[];

void plannerActionContract;

describe("validateAiWebPlan", () => {
  it("accepts every bounded action variant", () => {
    const actions: AiWebAction[] = [
      { type: "fill", elementId: "control-1", field: "firstName", value: "Ava", rationale: "label match" },
      { type: "select", elementId: "control-2", field: "sexOrGender", value: "Female", rationale: "label match" },
      { type: "click", elementId: "control-3", purpose: "save", rationale: "button label" },
      { type: "wait", reason: "page transition" },
      { type: "screenshot", label: "post-save-proof" },
      { type: "verify", criteria: "Synthetic patient detail page is visible.", rationale: "success criteria" },
      { type: "stop", code: "verification_failed", message: "The patient detail page did not appear." },
    ];

    for (const action of actions) {
      expect(validateAiWebPlan({ action, confidence: 1 })).toEqual({ action, confidence: 1 });
    }
  });

  it("accepts a bounded action with confidence and rationale", () => {
    expect(
      validateAiWebPlan({
        action: { type: "fill", elementId: "control-1", field: "firstName", value: "Ava", rationale: "label match" },
        confidence: 0.91,
      }),
    ).toEqual({
      action: { type: "fill", elementId: "control-1", field: "firstName", value: "Ava", rationale: "label match" },
      confidence: 0.91,
    });
  });

  it("rejects arbitrary code actions", () => {
    expect(() => validateAiWebPlan({ action: { type: "javascript", code: "alert(1)" }, confidence: 1 })).toThrow();
  });
});

describe("StaticAiWebPlanner", () => {
  it("returns queued actions for deterministic runner tests", async () => {
    const planner = new StaticAiWebPlanner([
      { action: { type: "click", elementId: "control-1", purpose: "open contact", rationale: "button label" }, confidence: 0.8 },
    ]);

    await expect(planner.plan({} as never)).resolves.toMatchObject({
      action: { type: "click", elementId: "control-1" },
      confidence: 0.8,
    });
  });

  it("returns a stop action when no queued action is available", async () => {
    const planner = new StaticAiWebPlanner([]);

    await expect(planner.plan({} as never)).resolves.toEqual({
      action: {
        type: "stop",
        code: "ui_state_unexpected",
        message: "No queued AI web action was available.",
      },
      confidence: 1,
    });
  });
});

describe("OpenAiAiWebPlanner", () => {
  it("requires an API key when a client is not injected", () => {
    expect(() => new OpenAiAiWebPlanner({ model: "gpt-5.4-mini" })).toThrow(
      OPENAI_AI_WEB_PLANNER_API_KEY_REQUIRED_ERROR,
    );
  });

  it("calls the Responses API with target context and validates the structured plan", async () => {
    const calls: unknown[] = [];
    const client: OpenAiAiWebPlannerClient = {
      responses: {
        create: async (body) => {
          calls.push(body);
          return {
            output_text: JSON.stringify({
              action: {
                type: "fill",
                elementId: "control-1",
                field: "firstName",
                value: "Ava",
                rationale: "The input label matches first name.",
              },
              confidence: 0.88,
            }),
          };
        },
      },
    };
    const planner = new OpenAiAiWebPlanner({ model: "gpt-5.4-mini", client });

    const plan = await planner.plan({
      profile: {
        name: "openmrs",
        displayName: "OpenMRS",
        baseUrl: "https://openmrs.example.test/openmrs",
        credentials: { username: "admin", password: "secret" },
        task: "Create one synthetic patient.",
        workflowHints: ["If a session location is required, choose Registration Desk before submitting login."],
        successCriteria: ["A saved patient detail page is visible."],
        forbiddenActions: ["Do not delete patients."],
        concurrency: 1,
      },
      record: {
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
      },
      observation: {
        currentUrl: "https://openmrs.example.test/openmrs/login.htm",
        title: "Login",
        visibleText: "Username Password Login",
        screenshotPath: "screenshots/demo-001/openmrs/0001-ai-step-1.png",
        controls: [
          {
            elementId: "control-1",
            tag: "input",
            role: "textbox",
            label: "Given Name",
            value: "",
            visibleText: "Given Name",
          },
        ],
        elementSelectors: new Map([["control-1", "#givenName"]]),
      },
      completedFields: ["lastName"],
      skippedFields: ["insuranceGroupId"],
      recentActions: [
        {
          actionType: "click",
          target: "Search",
          result: "succeeded",
        },
      ],
      stepCount: 4,
    });

    expect(plan).toEqual({
      action: {
        type: "fill",
        elementId: "control-1",
        field: "firstName",
        value: "Ava",
        rationale: "The input label matches first name.",
      },
      confidence: 0.88,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: "gpt-5.4-mini",
      text: {
        format: {
          type: "json_schema",
          name: "ai_web_plan",
          strict: true,
        },
      },
      store: false,
      stream: false,
    });
    const call = calls[0] as {
      instructions: string;
      input: Array<{ content: Array<{ type: string; text: string }> }>;
      text: { format: { schema: { properties: Record<string, unknown> } } };
    };
    const prompt = JSON.parse(call.input[0]?.content[0]?.text ?? "{}") as Record<string, unknown>;
    expect(call.instructions).toContain(
      "For every visible destination control, semantically compare its label, role, visible text, name, and surrounding context against all pending intake fields.",
    );
    expect(call.instructions).toContain(
      "Before advancing, submitting, saving, or verifying, fill or select visible controls that match pending intake fields, even when destination labels differ from normalized field names.",
    );
    expect(call.instructions).toContain(
      "Extra intake fields that are not available in the target UI are acceptable; do not stop solely because remaining intake fields have no observed destination controls.",
    );
    expect(call.instructions).toContain(
      "If a wizard step only contains controls for unsupported optional data, continue to the next, save, submit, create, or verify action when the observed controls make that safe.",
    );
    expect(prompt).toMatchObject({
      targetProfile: {
        name: "openmrs",
        displayName: "OpenMRS",
        task: "Create one synthetic patient.",
        workflowHints: ["If a session location is required, choose Registration Desk before submitting login."],
        successCriteria: ["A saved patient detail page is visible."],
        forbiddenActions: ["Do not delete patients."],
      },
      normalizedRecord: {
        sourceRecordId: "demo-001",
        firstName: "Ava",
      },
      pageObservation: {
        currentUrl: "https://openmrs.example.test/openmrs/login.htm",
        title: "Login",
        visibleText: "Username Password Login",
        controls: [
          {
            elementId: "control-1",
            label: "Given Name",
          },
        ],
      },
      completedFields: ["lastName"],
      skippedFields: ["insuranceGroupId"],
      recentActions: [
        {
          actionType: "click",
          target: "Search",
          result: "succeeded",
        },
      ],
      stepCount: 4,
    });
    expect(prompt.intakeFieldCoverage).toEqual([
      { field: "firstName", value: "Ava", status: "pending" },
      { field: "lastName", value: "Nguyen", status: "mapped" },
      { field: "dateOfBirth", value: "1987-03-14", status: "pending" },
      { field: "sexOrGender", value: "female", status: "pending" },
      { field: "phone", value: "+13125550198", status: "pending" },
      { field: "email", value: "ava.nguyen@example.test", status: "pending" },
      { field: "streetAddress", value: "1200 West Lake Street", status: "pending" },
      { field: "city", value: "Chicago", status: "pending" },
      { field: "state", value: "IL", status: "pending" },
      { field: "zip", value: "60607", status: "pending" },
      { field: "insurancePayer", value: "Aetna", status: "pending" },
      { field: "insuranceMemberId", value: "AET123456", status: "pending" },
      { field: "reasonForVisit", value: "Annual wellness visit", status: "pending" },
      { field: "preferredContactMethod", value: "phone", status: "pending" },
    ]);
    expect(call.text.format.schema.properties).toHaveProperty("action");
    expect(call.text.format.schema.properties).toHaveProperty("confidence");
  });

  it("rejects malformed model plans", async () => {
    const planner = new OpenAiAiWebPlanner({
      model: "gpt-5.4-mini",
      client: {
        responses: {
          create: async () => ({ output_text: JSON.stringify({ action: { type: "javascript" }, confidence: 1 }) }),
        },
      },
    });

    await expect(planner.plan({} as never)).rejects.toThrow();
  });

  it("parses the first JSON plan when model output contains trailing text", async () => {
    const validPlan = {
      action: {
        type: "click",
        elementId: "control-1",
        purpose: "choose Registration Desk",
        rationale: "The visible location link matches the target workflow hint.",
      },
      confidence: 0.87,
    };
    const planner = new OpenAiAiWebPlanner({
      model: "gpt-5.4-mini",
      client: {
        responses: {
          create: async () => ({
            output_text: `${JSON.stringify(validPlan)}\n${JSON.stringify({ ignored: true })}`,
          }),
        },
      },
    });

    await expect(planner.plan(runnerPlanInput)).resolves.toEqual(validPlan);
  });
});
