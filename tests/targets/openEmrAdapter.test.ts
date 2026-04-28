import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAuditStore } from "../../src/audit/auditStore.js";
import type { AgentDecision, AgentDecisionInput, AgentDriver } from "../../src/agent/types.js";
import type { NormalizedIntakeRecord } from "../../src/domain/schema.js";
import { OpenEmrAdapter } from "../../src/targets/openemr/openEmrAdapter.js";
import {
  OPENEMR_LOGIN_SELECTORS,
  OPENEMR_NEW_PATIENT_CANDIDATES,
  OPENEMR_SAVE_CANDIDATES,
  openEmrFieldMappings,
} from "../../src/targets/openemr/selectors.js";

describe("OpenEMR selectors", () => {
  it("maps normalized intake fields to OpenEMR selector candidates", () => {
    const mappings = openEmrFieldMappings(record("demo-001"));

    expect(mappings.map((mapping) => mapping.value)).toEqual([
      "Ava",
      "Nguyen",
      "1987-03-14",
      "1200 West Lake Street",
      "Chicago",
      "IL",
      "60607",
      "+13125550198",
      "ava.nguyen@example.test",
    ]);
    expect(mappings[0].selectors).toEqual(['input[name="form_fname"]', 'input[name="fname"]', 'input[id*="fname"]']);
    expect(mappings[8].selectors).toEqual(['input[name="form_email"]', 'input[name*="email"]']);
    expect(OPENEMR_LOGIN_SELECTORS).toEqual({
      username: ['input[name="authUser"]', "#authUser"],
      password: ['input[name="clearPass"]', "#clearPass"],
      submit: ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("Login")'],
    });
    expect(OPENEMR_NEW_PATIENT_CANDIDATES).toEqual([
      'text="New/Search"',
      'text="Patient/Client"',
      'text="New Patient"',
      'a:has-text("New/Search")',
    ]);
    expect(OPENEMR_SAVE_CANDIDATES).toEqual([
      'button:has-text("Create New Patient")',
      'button:has-text("Save")',
      'input[value="Create New Patient"]',
      'input[value="Save"]',
    ]);
  });
});

describe("OpenEmrAdapter", () => {
  it("requires OpenEMR credentials before launching a browser", async () => {
    const adapter = new OpenEmrAdapter({});

    await expect(adapter.prepare()).rejects.toThrow(
      "OPENEMR_BASE_URL, OPENEMR_USERNAME, and OPENEMR_PASSWORD are required for OpenEMR runs.",
    );
  });

  it("launches Chromium, opens a 1280x720 page, and submits the login form", async () => {
    const page = new FakeOpenEmrPage({ availableSelectors: loginSelectors() });
    const browser = new FakeOpenEmrBrowser(page);
    const launchOptions: unknown[] = [];
    const adapter = new OpenEmrAdapter(openEmrConfig(), {
      launchBrowser: async (options: unknown) => {
        launchOptions.push(options);
        return browser;
      },
    });

    await adapter.prepare();
    await adapter.close();

    expect(launchOptions).toHaveLength(1);
    expect(launchOptions[0]).toMatchObject({
      headless: false,
      chromiumSandbox: true,
      env: {},
    });
    expect((launchOptions[0] as { args: string[] }).args).toEqual(
      expect.arrayContaining(["--disable-extensions", "--disable-file-system"]),
    );
    expect(browser.newPageOptions).toEqual([{ viewport: { width: 1280, height: 720 } }]);
    expect(page.gotos).toEqual([{ url: "https://openemr.example.test", options: { waitUntil: "domcontentloaded" } }]);
    expect(page.filled).toEqual([
      { selector: 'input[name="authUser"]', value: "admin" },
      { selector: 'input[name="clearPass"]', value: "secret" },
    ]);
    expect(page.clicked).toEqual(['button[type="submit"]']);
    expect(page.waitStates).toEqual(["networkidle"]);
    expect(browser.closed).toBe(true);
  });

  it("closes the launched browser and does not leak credentials when prepare fails", async () => {
    const page = new FakeOpenEmrPage({
      availableSelectors: ['input[name="authUser"]', 'button[type="submit"]'],
    });
    const browser = new FakeOpenEmrBrowser(page);
    const adapter = new OpenEmrAdapter(openEmrConfig(), {
      launchBrowser: async () => browser,
    });

    await expect(adapter.prepare()).rejects.toThrow("No OpenEMR selector matched for login password.");

    expect(browser.closed).toBe(true);
    await expect(adapter.prepare()).rejects.not.toThrow("secret");
  });

  it("returns a UI-state exception when the agent rejects new-patient navigation", async () => {
    const root = await mkdtemp(join(tmpdir(), "openemr-nav-rejected-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openemr" });
    const page = new FakeOpenEmrPage({
      availableSelectors: loginSelectors(),
      bodyTexts: ["OpenEMR dashboard"],
    });
    const adapter = new OpenEmrAdapter(openEmrConfig(), {
      launchBrowser: async () => new FakeOpenEmrBrowser(page),
    });
    const agent = new QueuedAgent([
      {
        actionId: "navigate-new-patient",
        confidence: 0.49,
        rationale: "The OpenEMR dashboard was not ready.",
      },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({
      runId: "run-openemr",
      record: record("demo-001"),
      audit,
      agent,
    });

    expect(result).toEqual({
      status: "exception",
      exception: {
        code: "ui_state_unexpected",
        severity: "error",
        message: "Agent did not approve OpenEMR navigation.",
        suggestedRemediation: "The OpenEMR dashboard was not ready.",
      },
    });
    expect(agent.inputs.map((input) => input.step)).toEqual(["navigate-new-patient"]);
    expect(agent.inputs[0].screenshotPath).toBe("screenshots/demo-001/openemr/before-navigation.png");
    await expect(readFile(join(root, "run-openemr", agent.inputs[0].screenshotPath!), "utf8")).resolves.toBe("screenshot-1");
    expect(page.clicked).not.toContain('text="New/Search"');
  });

  it("fills patient fields and returns a possible-duplicate exception when OpenEMR reports a match", async () => {
    const root = await mkdtemp(join(tmpdir(), "openemr-duplicate-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openemr" });
    const page = new FakeOpenEmrPage({
      availableSelectors: [
        ...loginSelectors(),
        'text="Patient/Client"',
        'input[name="form_fname"]',
        'input[name="form_lname"]',
        'input[name="form_DOB"]',
        'input[name="form_street"]',
        'input[name="form_city"]',
        'select[name="form_state"]',
        'input[name="form_postal_code"]',
        'input[name="form_phone_cell"]',
        'input[name="form_email"]',
        'input[value="Save"]',
      ],
      bodyTexts: ["OpenEMR dashboard", "New Patient form", "Similar patient already exists"],
      tagNames: [['select[name="form_state"]', "select"]],
    });
    const adapter = new OpenEmrAdapter(openEmrConfig(), {
      launchBrowser: async () => new FakeOpenEmrBrowser(page),
    });
    const agent = new QueuedAgent([
      {
        actionId: "navigate-new-patient",
        confidence: 0.91,
        rationale: "The new patient menu is visible.",
      },
      {
        actionId: "save-patient",
        confidence: 0.88,
        rationale: "The form contains the normalized record.",
      },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({
      runId: "run-openemr",
      record: record("demo-001"),
      audit,
      agent,
    });

    expect(result).toEqual({
      status: "exception",
      exception: {
        code: "possible_duplicate",
        severity: "error",
        message: "OpenEMR indicated a possible duplicate patient.",
        suggestedRemediation: "Review the patient match screen and decide whether to merge, update, or skip.",
        screenshotPath: "screenshots/demo-001/openemr/after-save.png",
      },
    });
    expect(agent.inputs.map((input) => input.step)).toEqual(["navigate-new-patient", "save-patient"]);
    expect(page.clicked).toContain('text="Patient/Client"');
    expect(page.clicked).toContain('input[value="Save"]');
    expect(page.filled).toEqual(
      expect.arrayContaining([
        { selector: 'input[name="form_fname"]', value: "Ava" },
        { selector: 'input[name="form_lname"]', value: "Nguyen" },
        { selector: 'input[name="form_DOB"]', value: "1987-03-14" },
        { selector: 'input[name="form_email"]', value: "ava.nguyen@example.test" },
      ]),
    );
    expect(page.selected[0]).toEqual({ selector: 'select[name="form_state"]', option: { label: "IL" } });
    await expect(readFile(join(root, "run-openemr", "screenshots/demo-001/openemr/after-save.png"), "utf8")).resolves.toBe(
      "screenshot-3",
    );
    const events = await readFile(join(root, "run-openemr", "events.jsonl"), "utf8");
    expect(events).toContain("OpenEMR indicated a possible duplicate patient");
    expect(events).toContain("The form contains the normalized record.");
  });
});

function openEmrConfig() {
  return {
    baseUrl: "https://openemr.example.test",
    username: "admin",
    password: "secret",
  };
}

function loginSelectors(): string[] {
  return ['input[name="authUser"]', 'input[name="clearPass"]', 'button[type="submit"]'];
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
  readonly newPageOptions: unknown[] = [];
  closed = false;

  constructor(private readonly page: FakeOpenEmrPage) {}

  async newPage(options: unknown): Promise<FakeOpenEmrPage> {
    this.newPageOptions.push(options);
    return this.page;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeOpenEmrPage {
  readonly availableSelectors: Set<string>;
  readonly tagNames: Map<string, string>;
  readonly gotos: Array<{ url: string; options?: unknown }> = [];
  readonly waitStates: string[] = [];
  readonly filled: Array<{ selector: string; value: string }> = [];
  readonly selected: Array<{ selector: string; option: unknown }> = [];
  readonly clicked: string[] = [];
  private readonly bodyTexts: string[];
  private screenshotCount = 0;
  private lastBodyText = "";

  constructor(options: { availableSelectors: string[]; bodyTexts?: string[]; tagNames?: Array<[string, string]> }) {
    this.availableSelectors = new Set(options.availableSelectors);
    this.bodyTexts = [...(options.bodyTexts ?? [])];
    this.tagNames = new Map(options.tagNames ?? []);
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

  locator(selector: string): FakeOpenEmrLocator {
    return new FakeOpenEmrLocator(this, selector);
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
    this.page.selected.push({ selector: this.selector, option });
    return [];
  }

  async click(): Promise<void> {
    this.page.clicked.push(this.selector);
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
