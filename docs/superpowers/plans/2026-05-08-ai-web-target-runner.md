# AI Web Target Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace destination-specific UI adapters with one generic AI-driven web target runner plus thin OpenMRS/OpenEMR target profiles.

**Architecture:** The orchestrator will run validated records through `TargetProfile` data and a single `AiWebTargetRunner`, instead of destination-specific `TargetAdapter` classes. The runner observes the live page, asks an AI planner for bounded actions, executes only allowlisted browser actions, and writes the same audit artifacts and target-aware summaries.

**Tech Stack:** TypeScript, Node.js, Commander, Zod, Playwright, OpenAI Responses API, Vitest, local file-based audit artifacts.

---

### Task 1: Target Profiles

**Files:**
- Create: `src/targets/profiles.ts`
- Modify: `src/config.ts`
- Modify: `src/domain/schema.ts`
- Test: `tests/targets/profiles.test.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write failing profile tests**

Create `tests/targets/profiles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTargetProfiles } from "../../src/targets/profiles.js";

describe("buildTargetProfiles", () => {
  it("builds OpenMRS and OpenEMR profiles from config", () => {
    const profiles = buildTargetProfiles({
      targets: ["openmrs", "openemr"],
      openMrs: {
        baseUrl: "https://openmrs.example.test/openmrs",
        username: "admin",
        password: "secret",
        concurrency: 1,
        interactiveFieldConfirmation: false,
        fieldConfidenceThreshold: 0.8,
      },
      openEmr: {
        baseUrl: "https://openemr.example.test/openemr",
        username: "operator",
        password: "pass",
        concurrency: 1,
      },
    });

    expect(profiles.map((profile) => profile.name)).toEqual(["openmrs", "openemr"]);
    expect(profiles[0]).toMatchObject({
      name: "openmrs",
      displayName: "OpenMRS",
      baseUrl: "https://openmrs.example.test/openmrs",
      credentials: { username: "admin", password: "secret" },
      concurrency: 1,
    });
    expect(profiles[1]).toMatchObject({
      name: "openemr",
      displayName: "OpenEMR",
      baseUrl: "https://openemr.example.test/openemr",
      credentials: { username: "operator", password: "pass" },
      concurrency: 1,
    });
    expect(profiles[0].task).toContain("synthetic patient");
    expect(profiles[1].task).toContain("synthetic patient");
    expect(profiles[0].forbiddenActions).toContain("Do not delete patients.");
    expect(profiles[1].successCriteria).toContain("A saved patient detail page or dashboard is visible.");
  });
});
```

Add config assertions to `tests/config.test.ts`:

```ts
it("keeps OpenMRS and OpenEMR config available for target profiles", () => {
  const config = buildRunConfig({
    input: "data/demo/intake-records.json",
    targets: "openmrs,openemr",
  });

  expect(config.targets).toEqual(["openmrs", "openemr"]);
  expect(config.openMrs.baseUrl).toBe("https://o2.openmrs.org/openmrs");
  expect(config.openEmr.baseUrl).toBe("https://demo.openemr.io/openemr");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```sh
npm test tests/targets/profiles.test.ts tests/config.test.ts
```

Expected: `profiles.test.ts` fails because `src/targets/profiles.ts` does not exist.

- [ ] **Step 3: Implement target profiles**

Create `src/targets/profiles.ts`:

```ts
import type { CliRunConfig } from "../config.js";
import type { TargetName } from "../domain/schema.js";

export interface TargetProfile {
  name: TargetName;
  displayName: string;
  baseUrl: string;
  credentials: {
    username: string;
    password: string;
  };
  task: string;
  successCriteria: string[];
  forbiddenActions: string[];
  concurrency: number;
}

type ProfileConfig = Pick<CliRunConfig, "targets" | "openMrs" | "openEmr">;

const DEFAULT_SUCCESS_CRITERIA = [
  "A saved patient detail page or dashboard is visible.",
  "The page shows the synthetic patient name.",
  "A proof screenshot can be captured after save.",
];

const DEFAULT_FORBIDDEN_ACTIONS = [
  "Do not delete patients.",
  "Do not change admin settings.",
  "Do not use real patient data.",
  "Do not export patient lists or unrelated records.",
];

export function buildTargetProfiles(config: ProfileConfig): TargetProfile[] {
  return config.targets.map((target) => {
    switch (target) {
      case "openmrs":
        return {
          name: "openmrs",
          displayName: "OpenMRS",
          baseUrl: config.openMrs.baseUrl ?? "https://o2.openmrs.org/openmrs",
          credentials: {
            username: config.openMrs.username ?? "admin",
            password: config.openMrs.password ?? "Admin123",
          },
          task: "Create or register one synthetic patient from the normalized intake record.",
          successCriteria: DEFAULT_SUCCESS_CRITERIA,
          forbiddenActions: DEFAULT_FORBIDDEN_ACTIONS,
          concurrency: Math.max(1, config.openMrs.concurrency),
        };
      case "openemr":
        return {
          name: "openemr",
          displayName: "OpenEMR",
          baseUrl: config.openEmr.baseUrl ?? "https://demo.openemr.io/openemr",
          credentials: {
            username: config.openEmr.username ?? "admin",
            password: config.openEmr.password ?? "pass",
          },
          task: "Create or register one synthetic patient from the normalized intake record.",
          successCriteria: DEFAULT_SUCCESS_CRITERIA,
          forbiddenActions: DEFAULT_FORBIDDEN_ACTIONS,
          concurrency: Math.max(1, config.openEmr.concurrency),
        };
      case "fake":
        return {
          name: "fake",
          displayName: "Local Dry Run",
          baseUrl: "local://dry-run",
          credentials: { username: "", password: "" },
          task: "Validate orchestration and audit output without entering an EMR.",
          successCriteria: ["The normalized record is accepted by the dry-run target."],
          forbiddenActions: DEFAULT_FORBIDDEN_ACTIONS,
          concurrency: 1,
        };
    }
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```sh
npm test tests/targets/profiles.test.ts tests/config.test.ts
```

Expected: profile and config tests pass.

### Task 2: Page Observation And Bounded Actions

**Files:**
- Create: `src/targets/pageObservation.ts`
- Create: `src/targets/browserActions.ts`
- Test: `tests/targets/pageObservation.test.ts`
- Test: `tests/targets/browserActions.test.ts`

- [ ] **Step 1: Write failing observation and action tests**

Create `tests/targets/pageObservation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createObservationSnapshot } from "../../src/targets/pageObservation.js";

describe("createObservationSnapshot", () => {
  it("returns temporary element ids with semantic control descriptions", async () => {
    const page = new FakeObservationPage({
      url: "https://example.test/new",
      title: "New Patient",
      text: "Contact First Name Save",
      controls: [
        { selector: "input[name=fname]", tag: "input", label: "First Name", role: "textbox", value: "" },
        { selector: "button.contact", tag: "button", label: "Contact", role: "button", value: "" },
      ],
    });

    const observation = await createObservationSnapshot({
      page,
      screenshotPath: "screenshots/demo/openemr/0001-observe.png",
    });

    expect(observation.currentUrl).toBe("https://example.test/new");
    expect(observation.controls).toEqual([
      { elementId: "control-1", tag: "input", role: "textbox", label: "First Name", value: "", visibleText: "First Name" },
      { elementId: "control-2", tag: "button", role: "button", label: "Contact", value: "", visibleText: "Contact" },
    ]);
  });
});

class FakeObservationPage {
  constructor(
    private readonly state: {
      url: string;
      title: string;
      text: string;
      controls: Array<{ selector: string; tag: string; label: string; role: string; value: string }>;
    },
  ) {}

  url(): string {
    return this.state.url;
  }

  async title(): Promise<string> {
    return this.state.title;
  }

  locator(selector: string) {
    return {
      innerText: async () => (selector === "body" ? this.state.text : ""),
    };
  }

  async evaluate() {
    return this.state.controls;
  }
}
```

Create `tests/targets/browserActions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { executeBrowserAction } from "../../src/targets/browserActions.js";

describe("executeBrowserAction", () => {
  it("executes fill, select, and click actions by element id", async () => {
    const page = new FakeActionPage();
    const elements = new Map([
      ["control-1", "input[name=fname]"],
      ["control-2", "select[name=sex]"],
      ["control-3", "button.save"],
    ]);

    await executeBrowserAction(page, elements, { type: "fill", elementId: "control-1", field: "firstName", value: "Ava", rationale: "label match" });
    await executeBrowserAction(page, elements, { type: "select", elementId: "control-2", field: "sexOrGender", value: "Female", rationale: "label match" });
    await executeBrowserAction(page, elements, { type: "click", elementId: "control-3", purpose: "save", rationale: "button says save" });

    expect(page.actions).toEqual([
      ["fill", "input[name=fname]", "Ava"],
      ["select", "select[name=sex]", "Female"],
      ["click", "button.save"],
    ]);
  });

  it("rejects stale element ids", async () => {
    await expect(
      executeBrowserAction(new FakeActionPage(), new Map(), {
        type: "click",
        elementId: "control-99",
        purpose: "save",
        rationale: "stale",
      }),
    ).rejects.toThrow("stale element id");
  });
});

class FakeActionPage {
  readonly actions: unknown[] = [];

  locator(selector: string) {
    return {
      fill: async (value: string) => this.actions.push(["fill", selector, value]),
      selectOption: async (option: { label: string }) => this.actions.push(["select", selector, option.label]),
      click: async () => this.actions.push(["click", selector]),
    };
  }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```sh
npm test tests/targets/pageObservation.test.ts tests/targets/browserActions.test.ts
```

Expected: both fail because the modules do not exist.

- [ ] **Step 3: Implement observation and bounded actions**

Create `src/targets/pageObservation.ts`:

```ts
export interface PageObservationControl {
  elementId: string;
  tag: string;
  role: string;
  label: string;
  value: string;
  visibleText: string;
}

export interface PageObservation {
  currentUrl: string;
  title: string;
  visibleText: string;
  screenshotPath: string;
  controls: PageObservationControl[];
  elementSelectors: Map<string, string>;
}

interface ObservationPage {
  url(): string;
  title(): Promise<string>;
  locator(selector: string): { innerText(options?: { timeout?: number }): Promise<string> };
  evaluate<T>(pageFunction: () => T): Promise<T>;
}

export async function createObservationSnapshot(input: {
  page: ObservationPage;
  screenshotPath: string;
}): Promise<PageObservation> {
  const rawControls = await input.page.evaluate(() =>
    Array.from(document.querySelectorAll("input, select, textarea, button, a"))
      .filter((element) => Boolean(element.getClientRects().length))
      .map((element, index) => {
        if (!element.id && !element.getAttribute("data-ai-web-control")) {
          element.setAttribute("data-ai-web-control", String(index + 1));
        }
        return {
        selector: element.id ? `#${CSS.escape(element.id)}` : `[data-ai-web-control="${index + 1}"]`,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || (element instanceof HTMLButtonElement ? "button" : element.tagName.toLowerCase()),
        label:
          element.getAttribute("aria-label") ||
          element.getAttribute("placeholder") ||
          element.getAttribute("name") ||
          element.textContent?.trim() ||
          "",
        value: "value" in element ? String((element as HTMLInputElement).value ?? "") : "",
      };
      }),
  );
  const controls = rawControls.map((control, index) => ({
    elementId: `control-${index + 1}`,
    tag: control.tag,
    role: control.role,
    label: control.label,
    value: control.value,
    visibleText: control.label,
  }));
  return {
    currentUrl: input.page.url(),
    title: await input.page.title(),
    visibleText: await input.page.locator("body").innerText({ timeout: 5000 }).catch(() => ""),
    screenshotPath: input.screenshotPath,
    controls,
    elementSelectors: new Map(controls.map((control, index) => [control.elementId, rawControls[index]?.selector ?? ""])),
  };
}
```

Create `src/targets/browserActions.ts`:

```ts
export type AiWebAction =
  | { type: "fill"; elementId: string; field: string; value: string; rationale: string }
  | { type: "select"; elementId: string; field: string; value: string; rationale: string }
  | { type: "click"; elementId: string; purpose: string; rationale: string }
  | { type: "wait"; reason: string }
  | { type: "screenshot"; label: string }
  | { type: "verify"; criteria: string; rationale: string }
  | { type: "stop"; code: "ui_state_unexpected" | "possible_duplicate" | "verification_failed"; message: string };

interface ActionPage {
  locator(selector: string): {
    fill(value: string, options?: { timeout: number }): Promise<unknown>;
    selectOption(option: { label: string }, options?: { timeout: number }): Promise<unknown>;
    click(options?: { timeout: number }): Promise<unknown>;
  };
  waitForTimeout?(milliseconds: number): Promise<unknown>;
}

const ACTION_TIMEOUT_MS = 5000;

export async function executeBrowserAction(
  page: ActionPage,
  elementSelectors: Map<string, string>,
  action: AiWebAction,
): Promise<void> {
  if (action.type === "wait") {
    await page.waitForTimeout?.(1000);
    return;
  }
  if (action.type === "screenshot" || action.type === "verify" || action.type === "stop") {
    return;
  }

  const selector = elementSelectors.get(action.elementId);
  if (!selector) {
    throw new Error(`Cannot execute ${action.type}: stale element id ${action.elementId}.`);
  }
  const locator = page.locator(selector);
  if (action.type === "fill") {
    await locator.fill(action.value, { timeout: ACTION_TIMEOUT_MS });
    return;
  }
  if (action.type === "select") {
    await locator.selectOption({ label: action.value }, { timeout: ACTION_TIMEOUT_MS });
    return;
  }
  await locator.click({ timeout: ACTION_TIMEOUT_MS });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```sh
npm test tests/targets/pageObservation.test.ts tests/targets/browserActions.test.ts
```

Expected: tests pass.

### Task 3: AI Planner Contract

**Files:**
- Create: `src/targets/aiWebPlanner.ts`
- Test: `tests/targets/aiWebPlanner.test.ts`

- [ ] **Step 1: Write failing planner tests**

Create `tests/targets/aiWebPlanner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { StaticAiWebPlanner, validateAiWebPlan } from "../../src/targets/aiWebPlanner.js";

describe("validateAiWebPlan", () => {
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```sh
npm test tests/targets/aiWebPlanner.test.ts
```

Expected: fails because planner module does not exist.

- [ ] **Step 3: Implement planner schema and deterministic planner**

Create `src/targets/aiWebPlanner.ts`:

```ts
import { z } from "zod";
import type { NormalizedIntakeRecord } from "../domain/schema.js";
import type { TargetProfile } from "./profiles.js";
import type { AiWebAction } from "./browserActions.js";
import type { PageObservation } from "./pageObservation.js";

const AiWebActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fill"), elementId: z.string(), field: z.string(), value: z.string(), rationale: z.string() }),
  z.object({ type: z.literal("select"), elementId: z.string(), field: z.string(), value: z.string(), rationale: z.string() }),
  z.object({ type: z.literal("click"), elementId: z.string(), purpose: z.string(), rationale: z.string() }),
  z.object({ type: z.literal("wait"), reason: z.string() }),
  z.object({ type: z.literal("screenshot"), label: z.string() }),
  z.object({ type: z.literal("verify"), criteria: z.string(), rationale: z.string() }),
  z.object({
    type: z.literal("stop"),
    code: z.enum(["ui_state_unexpected", "possible_duplicate", "verification_failed"]),
    message: z.string(),
  }),
]);

const AiWebPlanSchema = z.object({
  action: AiWebActionSchema,
  confidence: z.number().min(0).max(1),
});

export type AiWebPlan = z.infer<typeof AiWebPlanSchema>;

export interface AiWebPlanInput {
  profile: TargetProfile;
  record: NormalizedIntakeRecord;
  observation: PageObservation;
  completedFields: string[];
  skippedFields: string[];
  stepCount: number;
}

export interface AiWebPlanner {
  plan(input: AiWebPlanInput): Promise<AiWebPlan>;
}

export function validateAiWebPlan(value: unknown): AiWebPlan {
  return AiWebPlanSchema.parse(value);
}

export class StaticAiWebPlanner implements AiWebPlanner {
  constructor(private readonly plans: AiWebPlan[]) {}

  async plan(): Promise<AiWebPlan> {
    const plan = this.plans.shift();
    if (!plan) {
      return {
        action: {
          type: "stop",
          code: "ui_state_unexpected",
          message: "No queued AI web action was available.",
        },
        confidence: 1,
      };
    }
    return validateAiWebPlan(plan);
  }
}

export type { AiWebAction };
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```sh
npm test tests/targets/aiWebPlanner.test.ts
```

Expected: planner tests pass.

### Task 4: Generic AI Web Target Runner

**Files:**
- Create: `src/targets/aiWebTargetRunner.ts`
- Test: `tests/targets/aiWebTargetRunner.test.ts`

- [ ] **Step 1: Write failing runner tests**

Create `tests/targets/aiWebTargetRunner.test.ts` with fake browser/page objects and `StaticAiWebPlanner`:

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAuditStore } from "../../src/audit/auditStore.js";
import { StaticAiWebPlanner } from "../../src/targets/aiWebPlanner.js";
import { AiWebTargetRunner } from "../../src/targets/aiWebTargetRunner.js";
import type { TargetProfile } from "../../src/targets/profiles.js";
import type { NormalizedIntakeRecord } from "../../src/domain/schema.js";

describe("AiWebTargetRunner", () => {
  it("runs a record with bounded AI actions and writes target evidence", async () => {
    const audit = await FileAuditStore.create({
      runsDir: await mkdtemp(join(tmpdir(), "ai-web-runner-")),
      runId: "run-ai-web",
      now: () => "2026-05-08T12:00:00.000Z",
    });
    const page = new FakeRunnerPage();
    const runner = new AiWebTargetRunner({
      launchBrowser: async () => new FakeRunnerBrowser(page),
      planner: new StaticAiWebPlanner([
        { action: { type: "fill", elementId: "control-1", field: "firstName", value: "Ava", rationale: "label match" }, confidence: 0.9 },
        { action: { type: "click", elementId: "control-2", purpose: "save", rationale: "save button" }, confidence: 0.9 },
        { action: { type: "verify", criteria: "The page shows the synthetic patient name.", rationale: "Ava Nguyen visible" }, confidence: 0.95 },
      ]),
    });

    const result = await runner.runRecord({
      runId: "run-ai-web",
      profile: profile(),
      record: record(),
      audit,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "ai-openemr-demo-001" });
    expect(page.actions).toEqual([
      ["goto", "https://example.test/emr"],
      ["fill", "input[name=fname]", "Ava"],
      ["click", "button.save"],
    ]);
    expect(audit.getReportDetails().targetEvidence).toEqual([
      expect.objectContaining({
        target: "openemr",
        status: "succeeded",
        targetRecordId: "ai-openemr-demo-001",
      }),
    ]);
    expect(audit.getReportDetails().fieldMappings).toEqual([
      expect.objectContaining({
        target: "openemr",
        sourceField: "firstName",
        normalizedValue: "Ava",
        status: "succeeded",
        approvalSource: "agent",
      }),
    ]);
  });
});

function profile(): TargetProfile {
  return {
    name: "openemr",
    displayName: "OpenEMR",
    baseUrl: "https://example.test/emr",
    credentials: { username: "admin", password: "pass" },
    task: "Create one synthetic patient.",
    successCriteria: ["The page shows the synthetic patient name."],
    forbiddenActions: ["Do not delete patients."],
    concurrency: 1,
  };
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
  constructor(private readonly page: FakeRunnerPage) {}
  async newPage() { return this.page; }
  async close() {}
}

class FakeRunnerPage {
  readonly actions: unknown[] = [];
  async goto(url: string) { this.actions.push(["goto", url]); }
  async screenshot() { return Buffer.from("png"); }
  url() { return "https://example.test/emr/patient/demo-001"; }
  async title() { return "Patient created"; }
  locator(selector: string) {
    return {
      innerText: async () => "Ava Nguyen Patient created",
      fill: async (value: string) => this.actions.push(["fill", selector, value]),
      selectOption: async (option: { label: string }) => this.actions.push(["select", selector, option.label]),
      click: async () => this.actions.push(["click", selector]),
    };
  }
  async evaluate() {
    return [
      { selector: "input[name=fname]", tag: "input", role: "textbox", label: "First Name", value: "" },
      { selector: "button.save", tag: "button", role: "button", label: "Save", value: "" },
    ];
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```sh
npm test tests/targets/aiWebTargetRunner.test.ts
```

Expected: fails because `AiWebTargetRunner` does not exist.

- [ ] **Step 3: Implement runner**

Create `src/targets/aiWebTargetRunner.ts`:

```ts
import { chromium } from "@playwright/test";
import type { FileAuditStore, ReportFieldMapping } from "../audit/auditStore.js";
import type { NormalizedIntakeRecord, ValidationException } from "../domain/schema.js";
import { executeBrowserAction } from "./browserActions.js";
import type { AiWebPlanner } from "./aiWebPlanner.js";
import { createObservationSnapshot } from "./pageObservation.js";
import type { TargetProfile } from "./profiles.js";

export type AiWebTargetResult =
  | { status: "succeeded"; targetRecordId?: string }
  | { status: "skipped"; reason: string }
  | { status: "exception"; exception: ValidationException & Record<string, unknown> };

export interface AiWebTargetRunContext {
  runId: string;
  profile: TargetProfile;
  record: NormalizedIntakeRecord;
  audit: FileAuditStore;
}

export interface AiWebTargetRunnerDependencies {
  planner: AiWebPlanner;
  launchBrowser?: (options: Parameters<typeof chromium.launch>[0]) => Promise<{
    newPage(options: { viewport: { width: number; height: number } }): Promise<any>;
    close(): Promise<void>;
  }>;
  maxSteps?: number;
}

export class AiWebTargetRunner {
  private readonly launchBrowser: NonNullable<AiWebTargetRunnerDependencies["launchBrowser"]>;
  private readonly maxSteps: number;

  constructor(private readonly dependencies: AiWebTargetRunnerDependencies) {
    this.launchBrowser = dependencies.launchBrowser ?? ((options) => chromium.launch(options));
    this.maxSteps = dependencies.maxSteps ?? 30;
  }

  async runRecord(context: AiWebTargetRunContext): Promise<AiWebTargetResult> {
    const browser = await this.launchBrowser({ headless: false, chromiumSandbox: true, env: {} });
    const completedFields: string[] = [];
    const skippedFields: string[] = [];
    let latestScreenshotPath: string | undefined;
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.goto(context.profile.baseUrl, { waitUntil: "domcontentloaded" });

      for (let step = 0; step < this.maxSteps; step += 1) {
        const screenshot = await page.screenshot({ fullPage: true });
        latestScreenshotPath = await context.audit.writeScreenshot(context.record.sourceRecordId, context.profile.name, `ai-step-${step + 1}`, screenshot);
        const observation = await createObservationSnapshot({ page, screenshotPath: latestScreenshotPath });
        const plan = await this.dependencies.planner.plan({
          profile: context.profile,
          record: context.record,
          observation,
          completedFields,
          skippedFields,
          stepCount: step + 1,
        });

        await context.audit.writeEvent({
          recordId: context.record.sourceRecordId,
          target: context.profile.name,
          phase: "target",
          actionType: `ai-${plan.action.type}`,
          rationale: "rationale" in plan.action ? plan.action.rationale : undefined,
          screenshotPath: latestScreenshotPath,
          result: plan.action.type,
        });

        if (plan.action.type === "stop") {
          return {
            status: "exception",
            exception: {
              code: plan.action.code,
              severity: "error",
              message: plan.action.message,
              suggestedRemediation: "Review AI action history and latest screenshot before retrying.",
              screenshotPath: latestScreenshotPath,
            },
          };
        }

        if (plan.action.type === "verify") {
          const targetRecordId = `ai-${context.profile.name}-${context.record.sourceRecordId}`;
          await context.audit.writeTargetEvidence({
            recordId: context.record.sourceRecordId,
            target: context.profile.name,
            status: "succeeded",
            screenshotPath: latestScreenshotPath,
            targetRecordId,
            message: plan.action.rationale,
          });
          return { status: "succeeded", targetRecordId };
        }

        await executeBrowserAction(page, observation.elementSelectors, plan.action);
        if (plan.action.type === "fill" || plan.action.type === "select") {
          completedFields.push(plan.action.field);
          await context.audit.writeFieldMapping(fieldMappingFromAction(context, plan.action, plan.confidence, latestScreenshotPath));
        }
      }

      return {
        status: "exception",
        exception: {
          code: "ui_state_unexpected",
          severity: "error",
          message: `AI web runner exceeded ${this.maxSteps} steps.`,
          suggestedRemediation: "Review action history and increase the step budget only if the UI path is valid.",
          screenshotPath: latestScreenshotPath,
        },
      };
    } finally {
      await browser.close();
    }
  }
}

function fieldMappingFromAction(
  context: AiWebTargetRunContext,
  action: { type: "fill" | "select"; field: string; value: string; rationale: string },
  confidence: number,
  screenshotPath: string | undefined,
): ReportFieldMapping {
  return {
    recordId: context.record.sourceRecordId,
    target: context.profile.name,
    sourceField: action.field,
    targetField: action.field,
    normalizedValue: action.value,
    selectorCandidates: [],
    action: action.type,
    status: "succeeded",
    agentConfidence: confidence,
    agentRationale: action.rationale,
    approvalSource: "agent",
    finalValue: action.value,
    errorMessage: screenshotPath,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```sh
npm test tests/targets/aiWebTargetRunner.test.ts
```

Expected: runner test passes.

### Task 5: Orchestrator Migration

**Files:**
- Modify: `src/orchestrator/runWorkflow.ts`
- Modify: `src/cli.ts`
- Modify: `src/watcher/intakeWatcher.ts`
- Modify: `src/dev/runAll.ts`
- Test: `tests/orchestrator/runWorkflow.test.ts`
- Test: `tests/cli.test.ts`
- Test: `tests/watcher/intakeWatcher.test.ts`
- Test: `tests/dev/runAll.test.ts`

- [ ] **Step 1: Write failing orchestration tests**

Update `tests/orchestrator/runWorkflow.test.ts` to pass profiles and a fake generic runner:

```ts
const result = await runWorkflow({
  runId: "run-orchestrator",
  runsDir,
  records: [cleanRecord("demo-001")],
  profiles: [fakeProfile("openemr")],
  targetRunner: new FakeTargetRunner({ status: "succeeded", targetRecordId: "ai-openemr-demo-001" }),
  now: () => "2026-04-28T12:00:00.000Z",
});

expect(result.targetCounts.openemr).toEqual({ succeeded: 1, exception: 0, skipped: 0 });
```

Update CLI tests to assert `--targets openmrs` and `--targets openemr` both call the generic runner dependency rather than constructing destination adapters.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```sh
npm test tests/orchestrator/runWorkflow.test.ts tests/cli.test.ts tests/watcher/intakeWatcher.test.ts tests/dev/runAll.test.ts
```

Expected: failures show `runWorkflow` still expects adapters.

- [ ] **Step 3: Update workflow input and target execution**

Change `RunWorkflowInput` from:

```ts
adapters: TargetAdapter[];
agent: AgentDriver;
```

to:

```ts
profiles: TargetProfile[];
targetRunner: {
  prepare?(profiles: TargetProfile[], plannedRecords: number): Promise<void>;
  runRecord(context: {
    runId: string;
    profile: TargetProfile;
    record: NormalizedIntakeRecord;
    audit: FileAuditStore;
  }): Promise<AiWebTargetResult>;
  close?(): Promise<void>;
};
```

Update target counts, readiness, events, reports, and close handling to use
`profile.name`. Preserve the existing run artifact shape.

- [ ] **Step 4: Update CLI and watcher construction**

In `src/cli.ts`, replace `buildAdapters(config)` with:

```ts
const profiles = buildTargetProfiles(config);
const targetRunner = buildTargetRunner(config.agent);
```

Use `OpenAiUiAgentDriver` only inside the AI planner/runner path, not as an adapter driver.

In `watchCommand`, pass profiles and the target runner factory through the watcher.

- [ ] **Step 5: Run tests to verify they pass**

Run:

```sh
npm test tests/orchestrator/runWorkflow.test.ts tests/cli.test.ts tests/watcher/intakeWatcher.test.ts tests/dev/runAll.test.ts
```

Expected: selected orchestration and CLI tests pass.

### Task 6: Delete Destination-Specific Adapters

**Files:**
- Delete: `src/adapters/contract.ts`
- Delete: `src/adapters/fakeAdapter.ts`
- Delete: `src/targets/openmrs/openMrsAdapter.ts`
- Delete: `src/targets/openmrs/selectors.ts`
- Delete: `src/targets/openemr/openEmrAdapter.ts`
- Delete: `src/targets/openemr/selectors.ts`
- Delete: `tests/targets/openMrsAdapter.test.ts`
- Delete: `tests/targets/openEmrAdapter.test.ts`
- Update imports in all affected tests/source files.

- [ ] **Step 1: Search adapter references**

Run:

```sh
rg -n "TargetAdapter|FakeAdapter|OpenMrsAdapter|OpenEmrAdapter|openMrsFieldMappings|openEmrFieldMappings|src/adapters|targets/openmrs|targets/openemr" src tests
```

Expected before deletion: references still exist.

- [ ] **Step 2: Delete adapter files**

Use `apply_patch` delete hunks for the six source files and two target adapter test files.

- [ ] **Step 3: Remove remaining imports and replace tests**

Replace adapter-specific tests with:

```sh
npm test tests/targets/profiles.test.ts tests/targets/aiWebTargetRunner.test.ts tests/targets/aiWebPlanner.test.ts
```

Expected: target behavior coverage now lives around profiles, bounded actions,
planner validation, and generic runner execution.

- [ ] **Step 4: Verify no adapter references remain**

Run:

```sh
rg -n "TargetAdapter|FakeAdapter|OpenMrsAdapter|OpenEmrAdapter|openMrsFieldMappings|openEmrFieldMappings|src/adapters|targets/openmrs|targets/openemr" src tests
```

Expected: no matches.

### Task 7: Reports And Docs

**Files:**
- Modify: `src/audit/summary.ts`
- Modify: `README.md`
- Modify: `docs/demo.md`
- Modify: `docs/superpowers/specs/2026-05-08-ai-web-target-runner-design.md`
- Test: `tests/audit/auditStore.test.ts`
- Test: `tests/viewer/artifactService.test.ts`

- [ ] **Step 1: Write failing report/doc tests**

Update audit tests to expect AI action evidence:

```ts
expect(summary).toContain("OpenEMR Record Review");
expect(summary).toContain("AI rationale");
expect(summary).not.toContain("Selector or Error");
```

Update viewer tests to keep expecting target-aware names:

```ts
expect(runs[0].displayName).toContain("OpenEMR");
```

- [ ] **Step 2: Update summary wording**

Rename selector-centric columns to AI-centric columns:

```md
| Intake Field | Intake Value | AI Confidence | Target Field | AI-Mapped Value | Final Input Value | Action | Status | Evidence |
```

Keep target-aware headings.

- [ ] **Step 3: Update docs**

Update `README.md` and `docs/demo.md` to say:

- OpenMRS and OpenEMR use the same AI web target runner.
- Target profiles provide URL, credentials, target name, goal, and proof criteria.
- There are no destination-specific UI adapters.
- Live demo sites can change; failures remain auditable target exceptions.

- [ ] **Step 4: Run selected tests**

Run:

```sh
npm test tests/audit/auditStore.test.ts tests/viewer/artifactService.test.ts
```

Expected: selected report/viewer tests pass.

### Task 8: Verification And Smoke

**Files:**
- No source edits unless verification reveals a bug.

- [ ] **Step 1: Run required local verification**

Run:

```sh
npm run typecheck
npm test
git diff --check
```

Expected: all pass.

- [ ] **Step 2: Run deterministic OpenMRS smoke**

Run:

```sh
npm run dev -- run \
  --input data/demo/intake-records-normalized.json \
  --targets openmrs \
  --runs-dir runs \
  --parser deterministic \
  --synthetic-suffix auto
```

Expected: run completes with target-aware artifacts. Target success may depend
on current public demo availability; any failure must be captured as an audited
target exception, not a crash.

- [ ] **Step 3: Run deterministic OpenEMR smoke**

Run:

```sh
npm run dev -- run \
  --input data/demo/intake-records-normalized.json \
  --targets openemr \
  --runs-dir runs \
  --parser deterministic \
  --synthetic-suffix auto
```

Expected: run uses the same AI web runner code path as OpenMRS. Inspect
`run.json`, `executive-summary.md`, `summary.md`, `report.json`, and
`screenshots/`.

- [ ] **Step 4: Commit**

Run:

```sh
git status --short
git add src tests README.md docs/demo.md docs/superpowers/specs/2026-05-08-ai-web-target-runner-design.md
git commit -m "Replace UI adapters with AI web target runner"
```

Expected: commit contains the runner/profile refactor, tests, and docs.
