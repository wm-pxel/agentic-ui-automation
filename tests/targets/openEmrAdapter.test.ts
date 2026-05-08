import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAuditStore } from "../../src/audit/auditStore.js";
import type { AgentDecision, AgentDecisionInput, AgentDriver } from "../../src/agent/types.js";
import type { NormalizedIntakeRecord } from "../../src/domain/schema.js";
import { OpenEmrAdapter } from "../../src/targets/openemr/openEmrAdapter.js";
import { OPENEMR_LOGIN_SELECTORS, OPENEMR_SAVE_CANDIDATES, openEmrFieldMappings } from "../../src/targets/openemr/selectors.js";

describe("OpenEMR selectors", () => {
  it("maps normalized intake fields to OpenEMR demographics selector candidates", () => {
    const mappings = openEmrFieldMappings(record("demo-001"));

    expect(mappings.map((mapping) => mapping.value)).toEqual([
      "Ava",
      "Nguyen",
      "1987-03-14",
      "Female",
      "1200 West Lake Street",
      "Chicago",
      "IL",
      "60607",
      "+13125550198",
      "ava.nguyen@example.test",
    ]);
    expect(mappings.map((mapping) => [mapping.sourceField, mapping.targetField])).toEqual([
      ["firstName", "First Name"],
      ["lastName", "Last Name"],
      ["dateOfBirth", "Date of Birth"],
      ["sexOrGender", "Sex"],
      ["streetAddress", "Street"],
      ["city", "City"],
      ["state", "State"],
      ["zip", "Postal Code"],
      ["phone", "Cell Phone"],
      ["email", "Email"],
    ]);
    expect(mappings[0].selectors).toEqual(['input[name="form_fname"]', "#form_fname"]);
    expect(mappings[3].selectors).toEqual(['select[name="form_sex"]', "#form_sex"]);
    expect(OPENEMR_LOGIN_SELECTORS).toEqual({
      username: ['input[name="authUser"]', "#authUser"],
      password: ['input[name="clearPass"]', "#clearPass"],
      submit: ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("Login")'],
    });
    expect(OPENEMR_SAVE_CANDIDATES).toEqual(['button:has-text("Create New Patient")', 'button:has-text("Save")', "#create", "#form_save"]);
  });
});

describe("OpenEmrAdapter", () => {
  it("defaults to one concurrent OpenEMR session", () => {
    expect(new OpenEmrAdapter({}).maxConcurrency).toBe(1);
  });

  it("uses the official OpenEMR demo defaults and submits the login form", async () => {
    const page = successfulCreatePage();
    const browser = new FakeOpenEmrBrowser(page);
    const launchOptions: unknown[] = [];
    const adapter = new OpenEmrAdapter({}, {
      launchBrowser: async (options: unknown) => {
        launchOptions.push(options);
        return browser;
      },
    });

    await adapter.prepare({ plannedRecords: 1 });
    await adapter.close();

    expect(launchOptions[0]).toMatchObject({
      headless: false,
      chromiumSandbox: true,
      env: {},
    });
    expect(page.gotos[0]).toEqual({ url: "https://demo.openemr.io/openemr", options: { waitUntil: "domcontentloaded" } });
    expect(page.filled).toEqual([
      { selector: 'input[name="authUser"]', value: "admin" },
      { selector: 'input[name="clearPass"]', value: "pass" },
    ]);
    expect(page.clicked).toEqual(['button[type="submit"]']);
    expect(browser.closed).toBe(true);
  });

  it("fills OpenEMR demographics and records success evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "openemr-success-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openemr" });
    const page = successfulCreatePage();
    const adapter = new OpenEmrAdapter(openEmrConfig(), {
      launchBrowser: async () => new FakeOpenEmrBrowser(page),
    });
    const agent = new QueuedAgent([
      {
        actionId: "navigate-new-patient",
        confidence: 0.91,
        rationale: "OpenEMR dashboard is ready.",
      },
    ]);

    await adapter.prepare({ plannedRecords: 1 });
    const result = await adapter.runRecord({ runId: "run-openemr", record: record("demo-001"), audit, agent });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "openemr-demo-001" });
    expect(page.gotos).toContainEqual({
      url: "https://openemr.example.test/openemr/interface/new/new.php",
      options: { waitUntil: "domcontentloaded" },
    });
    expect(page.filled).toContainEqual({ selector: 'input[name="form_fname"]', value: "Ava" });
    expect(page.filled).toContainEqual({ selector: 'input[name="form_lname"]', value: "Nguyen" });
    expect(page.selected).toContainEqual({ selector: 'select[name="form_sex"]', option: { label: "Female" } });
    expect(page.clicked).toContain('button:has-text("Create New Patient")');
    expect(agent.inputs[0]).toMatchObject({
      target: "openemr",
      step: "navigate-new-patient",
      screenshotPath: "screenshots/demo-001/openemr/0001-before-navigation.png",
    });
    await expect(readFile(join(root, "run-openemr", "screenshots", "demo-001", "openemr", "0003-after-save.png"), "utf8")).resolves.toBe("screenshot-3");
    expect(audit.getReportDetails().targetEvidence).toEqual([
      {
        recordId: "demo-001",
        target: "openemr",
        status: "succeeded",
        screenshotPath: "screenshots/demo-001/openemr/0003-after-save.png",
        fieldScreenshotPath: "screenshots/demo-001/openemr/0002-after-fill.png",
        targetRecordId: "openemr-demo-001",
        message: "submitted OpenEMR patient form",
      },
    ]);
    expect(audit.getReportDetails().fieldMappings[0]).toMatchObject({
      recordId: "demo-001",
      target: "openemr",
      sourceField: "firstName",
      targetField: "First Name",
      normalizedValue: "Ava",
      selectedSelector: 'input[name="form_fname"]',
      action: "fill",
      status: "succeeded",
    });
  });

  it("returns a UI-state exception when the agent rejects new-patient navigation", async () => {
    const root = await mkdtemp(join(tmpdir(), "openemr-nav-rejected-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openemr" });
    const page = successfulCreatePage();
    const adapter = new OpenEmrAdapter(openEmrConfig(), {
      launchBrowser: async () => new FakeOpenEmrBrowser(page),
    });
    const agent = new QueuedAgent([
      {
        actionId: "navigate-new-patient",
        confidence: 0.4,
        rationale: "The OpenEMR dashboard was not ready.",
      },
    ]);

    await adapter.prepare({ plannedRecords: 1 });
    const result = await adapter.runRecord({ runId: "run-openemr", record: record("demo-001"), audit, agent });

    expect(result).toEqual({
      status: "exception",
      exception: {
        code: "ui_state_unexpected",
        severity: "error",
        message: "Agent did not approve OpenEMR navigation.",
        suggestedRemediation: "The OpenEMR dashboard was not ready.",
      },
    });
  });

  it("records a target exception and failed mapping when a required OpenEMR field is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "openemr-missing-field-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openemr" });
    const page = successfulCreatePage({ omittedSelectors: ['input[name="form_lname"]', "#form_lname"] });
    const adapter = new OpenEmrAdapter(openEmrConfig(), {
      launchBrowser: async () => new FakeOpenEmrBrowser(page),
    });
    const agent = new QueuedAgent([{ actionId: "navigate-new-patient", confidence: 1, rationale: "ready" }]);

    await adapter.prepare({ plannedRecords: 1 });
    const result = await adapter.runRecord({ runId: "run-openemr", record: record("demo-001"), audit, agent });

    expect(result).toMatchObject({
      status: "exception",
      exception: {
        code: "ui_state_unexpected",
        severity: "error",
        message: expect.stringContaining("Timed out waiting for visible OpenEMR Last Name"),
      },
    });
    expect(audit.getReportDetails().fieldMappings).toContainEqual(
      expect.objectContaining({
        target: "openemr",
        sourceField: "lastName",
        targetField: "Last Name",
        normalizedValue: "Nguyen",
        status: "failed",
        errorMessage: expect.stringContaining("Timed out waiting for visible OpenEMR Last Name"),
      }),
    );
  });

  it("returns a possible duplicate exception when OpenEMR reports a duplicate patient", async () => {
    const root = await mkdtemp(join(tmpdir(), "openemr-duplicate-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openemr" });
    const page = successfulCreatePage({
      bodyTexts: ["OpenEMR dashboard", "New patient form", "Duplicate patient was found"],
    });
    const adapter = new OpenEmrAdapter(openEmrConfig(), {
      launchBrowser: async () => new FakeOpenEmrBrowser(page),
    });
    const agent = new QueuedAgent([{ actionId: "navigate-new-patient", confidence: 1, rationale: "ready" }]);

    await adapter.prepare({ plannedRecords: 1 });
    const result = await adapter.runRecord({ runId: "run-openemr", record: record("demo-001"), audit, agent });

    expect(result).toMatchObject({
      status: "exception",
      exception: {
        code: "possible_duplicate",
        severity: "warning",
        message: "OpenEMR reported a possible duplicate patient.",
      },
    });
  });
});

function openEmrConfig() {
  return {
    baseUrl: "https://openemr.example.test/openemr",
    username: "operator",
    password: "secret",
    concurrency: 1,
  };
}

function loginSelectors(): string[] {
  return ['input[name="authUser"]', 'input[name="clearPass"]', 'button[type="submit"]'];
}

function successfulCreatePage(options: { omittedSelectors?: string[]; bodyTexts?: string[] } = {}): FakeOpenEmrPage {
  const omitted = new Set(options.omittedSelectors ?? []);
  const selectors = [
    ...loginSelectors(),
    'input[name="form_fname"]',
    "#form_fname",
    'input[name="form_lname"]',
    "#form_lname",
    'input[name="form_DOB"]',
    'select[name="form_sex"]',
    'input[name="form_street"]',
    'input[name="form_city"]',
    'input[name="form_state"]',
    'input[name="form_postal_code"]',
    'input[name="form_phone_cell"]',
    'input[name="form_email"]',
    'button:has-text("Create New Patient")',
  ].filter((selector) => !omitted.has(selector));

  return new FakeOpenEmrPage({
    availableSelectors: selectors,
    bodyTexts: options.bodyTexts ?? ["OpenEMR dashboard", "New patient form", "Ava Nguyen Demographics\nRecord ID openemr-demo-001"],
    tagNames: [['select[name="form_sex"]', "select"]],
    selectOptions: [['select[name="form_sex"]', ["Female", "Male", "Unknown", "Other"]]],
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

class FakeOpenEmrBrowser {
  closed = false;

  constructor(private readonly page: FakeOpenEmrPage) {}

  async newPage(): Promise<FakeOpenEmrPage> {
    return this.page;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeOpenEmrPage {
  readonly availableSelectors: Set<string>;
  readonly tagNames: Map<string, string>;
  readonly selectOptions: Map<string, string[]>;
  readonly gotos: Array<{ url: string; options?: unknown }> = [];
  readonly filled: Array<{ selector: string; value: string }> = [];
  readonly selected: Array<{ selector: string; option: unknown }> = [];
  readonly clicked: string[] = [];
  private readonly bodyTexts: string[];
  private screenshotCount = 0;
  private lastBodyText = "";

  constructor(options: {
    availableSelectors: string[];
    bodyTexts: string[];
    tagNames?: Array<[string, string]>;
    selectOptions?: Array<[string, string[]]>;
  }) {
    this.availableSelectors = new Set(options.availableSelectors);
    this.bodyTexts = [...options.bodyTexts];
    this.tagNames = new Map(options.tagNames ?? []);
    this.selectOptions = new Map(options.selectOptions ?? []);
  }

  async goto(url: string, options?: unknown): Promise<void> {
    this.gotos.push({ url, options });
  }

  async waitForLoadState(): Promise<void> {}

  async screenshot(): Promise<Buffer> {
    this.screenshotCount += 1;
    return Buffer.from(`screenshot-${this.screenshotCount}`);
  }

  locator(selector: string): FakeOpenEmrLocator {
    return new FakeOpenEmrLocator(this, selector);
  }

  async evaluate<T, Arg>(_pageFunction: string | ((input: Arg) => Promise<T> | T), _input?: Arg): Promise<T> {
    return undefined as T;
  }

  hasSelector(selector: string): boolean {
    return selector === "body" || this.availableSelectors.has(selector);
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

class FakeOpenEmrLocator {
  constructor(
    private readonly page: FakeOpenEmrPage,
    private readonly selector: string,
  ) {}

  first(): FakeOpenEmrLocator {
    return this;
  }

  async count(): Promise<number> {
    return this.page.hasSelector(this.selector) ? 1 : 0;
  }

  async evaluate<T>(_pageFunction: (element: Element) => T | Promise<T>): Promise<T> {
    return this.page.tagName(this.selector) as T;
  }

  async fill(value: string): Promise<void> {
    this.page.filled.push({ selector: this.selector, value });
  }

  async selectOption(option: unknown): Promise<string[]> {
    const allowedOptions = this.page.selectOptions.get(this.selector);
    const requestedLabel = typeof option === "object" && option !== null && "label" in option ? String((option as { label: unknown }).label) : String(option);
    if (allowedOptions && !allowedOptions.includes(requestedLabel)) {
      throw new Error(`did not find option ${requestedLabel} for ${this.selector}`);
    }
    this.page.selected.push({ selector: this.selector, option });
    return [];
  }

  async click(): Promise<void> {
    if (!this.page.hasSelector(this.selector)) {
      throw new Error(`${this.selector} is not visible`);
    }
    this.page.clicked.push(this.selector);
  }

  async isVisible(): Promise<boolean> {
    return this.page.hasSelector(this.selector);
  }

  async innerText(): Promise<string> {
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
