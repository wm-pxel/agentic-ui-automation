import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAuditStore } from "../../src/audit/auditStore.js";
import type { AgentDecision, AgentDecisionInput, AgentDriver } from "../../src/agent/types.js";
import type { NormalizedIntakeRecord } from "../../src/domain/schema.js";
import { OpenEmrAdapter } from "../../src/targets/openemr/openEmrAdapter.js";
import {
  OPENEMR_CONTACT_SECTION_CANDIDATES,
  OPENEMR_CONFIRM_CREATE_CANDIDATES,
  OPENEMR_LOGIN_SELECTORS,
  OPENEMR_NEW_PATIENT_CANDIDATES,
  OPENEMR_PATIENT_MENU_CANDIDATES,
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
      "Female",
      "1200 West Lake Street",
      "Chicago",
      "Illinois",
      "60607",
      "+13125550198",
      "ava.nguyen@example.test",
    ]);
    expect(mappings[0].selectors).toEqual(['input[name="form_fname"]', 'input[name="fname"]', 'input[id*="fname"]']);
    expect(mappings[3].selectors).toEqual(['select[name="form_sex"]', 'select[name="sex"]']);
    expect(mappings[9].selectors).toEqual(['input[name="form_email"]', 'input[name*="email"]']);
    expect(OPENEMR_LOGIN_SELECTORS).toEqual({
      username: ['input[name="authUser"]', "#authUser"],
      password: ['input[name="clearPass"]', "#clearPass"],
      submit: ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("Login")'],
    });
    expect(OPENEMR_PATIENT_MENU_CANDIDATES).toEqual([
      'text="Patient"',
      'div.menuLabel:has-text("Patient")',
    ]);
    expect(OPENEMR_NEW_PATIENT_CANDIDATES).toEqual([
      'text="New/Search"',
      'div.menuLabel:has-text("New/Search")',
      'text="Patient/Client"',
      'text="New Patient"',
      'a:has-text("New/Search")',
    ]);
    expect(OPENEMR_CONTACT_SECTION_CANDIDATES).toEqual(['button:has-text("Contact")']);
    expect(OPENEMR_CONFIRM_CREATE_CANDIDATES).toEqual([
      'button:has-text("Confirm Create New Patient")',
      'input[value="Confirm Create New Patient"]',
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

    await expect(adapter.prepare()).rejects.toThrow("No visible OpenEMR selector matched for login password");

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
        'text="Patient"',
        'text="New/Search"',
        'input[name="form_fname"]',
        'input[name="form_lname"]',
        'input[name="form_DOB"]',
        'select[name="form_sex"]',
        'input[name="form_street"]',
        'input[name="form_city"]',
        'select[name="form_state"]',
        'input[name="form_postal_code"]',
        'input[name="form_phone_cell"]',
        'input[name="form_email"]',
        'input[value="Save"]',
      ],
      visibleSelectors: [
        ...loginSelectors(),
        'text="Patient"',
        'input[name="form_fname"]',
        'input[name="form_lname"]',
        'input[name="form_DOB"]',
        'select[name="form_sex"]',
        'input[name="form_street"]',
        'input[name="form_city"]',
        'select[name="form_state"]',
        'input[name="form_postal_code"]',
        'input[name="form_phone_cell"]',
        'input[name="form_email"]',
        'input[value="Save"]',
      ],
      hoverReveals: {
        'text="Patient"': ['text="New/Search"'],
      },
      bodyTexts: ["OpenEMR dashboard", "New Patient form", "Similar patient already exists"],
      tagNames: [
        ['select[name="form_sex"]', "select"],
        ['select[name="form_state"]', "select"],
      ],
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
    expect(page.hovered).toContain('text="Patient"');
    expect(page.clicked).toContain('text="New/Search"');
    expect(page.clicked).toContain('input[value="Save"]');
    expect(page.filled).toEqual(
      expect.arrayContaining([
        { selector: 'input[name="form_fname"]', value: "Ava" },
        { selector: 'input[name="form_lname"]', value: "Nguyen" },
        { selector: 'input[name="form_DOB"]', value: "1987-03-14" },
        { selector: 'input[name="form_email"]', value: "ava.nguyen@example.test" },
      ]),
    );
    expect(page.selected).toContainEqual({ selector: 'select[name="form_sex"]', option: { label: "Female" } });
    expect(page.selected).toContainEqual({ selector: 'select[name="form_state"]', option: { label: "Illinois" } });
    await expect(readFile(join(root, "run-openemr", "screenshots/demo-001/openemr/after-save.png"), "utf8")).resolves.toBe(
      "screenshot-3",
    );
    const events = await readFile(join(root, "run-openemr", "events.jsonl"), "utf8");
    expect(events).toContain("OpenEMR indicated a possible duplicate patient");
    expect(events).toContain("The form contains the normalized record.");
  });

  it("opens the menu form, expands contact fields, and confirms creation when no matches are found", async () => {
    const root = await mkdtemp(join(tmpdir(), "openemr-confirm-create-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openemr" });
    const formFrame = new FakeOpenEmrPage({
      availableSelectors: [
        'button:has-text("Contact")',
        'input[name="form_fname"]',
        'input[name="form_lname"]',
        'input[name="form_DOB"]',
        'select[name="form_sex"]',
        'input[name="form_street"]',
        'input[name="form_city"]',
        'input[name="form_state"]',
        'input[name="form_postal_code"]',
        'input[name="form_phone_cell"]',
        'input[name="form_email"]',
        'button:has-text("Create New Patient")',
      ],
      visibleSelectors: [
        'button:has-text("Contact")',
        'input[name="form_fname"]',
        'input[name="form_lname"]',
        'input[name="form_DOB"]',
        'select[name="form_sex"]',
        'button:has-text("Create New Patient")',
      ],
      clickReveals: {
        'button:has-text("Contact")': [
          'input[name="form_street"]',
          'input[name="form_city"]',
          'input[name="form_state"]',
          'input[name="form_postal_code"]',
          'input[name="form_phone_cell"]',
          'input[name="form_email"]',
        ],
      },
      clickHides: {
        'button:has-text("Create New Patient")': ['button:has-text("Create New Patient")'],
      },
      bodyTexts: ["Search or Add Patient", "Created patient"],
      tagNames: [['select[name="form_sex"]', "select"]],
    });
    const confirmFrame = new FakeOpenEmrPage({
      availableSelectors: ['button:has-text("Confirm Create New Patient")'],
      visibleSelectors: ['button:has-text("Confirm Create New Patient")'],
      clickHides: {
        'button:has-text("Confirm Create New Patient")': ['button:has-text("Confirm Create New Patient")'],
      },
      bodyTexts: [
        "No matches were found.\nConfirm Create New Patient Cancel",
        "No matches were found.\nConfirm Create New Patient Cancel",
        "No matches were found.\nConfirm Create New Patient Cancel",
        "Created patient",
      ],
    });
    const page = new FakeOpenEmrPage({
      availableSelectors: [...loginSelectors(), 'text="Patient"', 'text="New/Search"'],
      visibleSelectors: [...loginSelectors(), 'text="Patient"'],
      hoverReveals: {
        'text="Patient"': ['text="New/Search"'],
      },
      childFrames: [formFrame, confirmFrame],
      bodyTexts: ["OpenEMR dashboard"],
    });
    const adapter = new OpenEmrAdapter(openEmrConfig(), {
      launchBrowser: async () => new FakeOpenEmrBrowser(page),
    });
    const agent = new QueuedAgent([
      {
        actionId: "navigate-new-patient",
        confidence: 0.91,
        rationale: "The patient menu is visible.",
      },
      {
        actionId: "save-patient",
        confidence: 0.88,
        rationale: "The framed form contains the normalized record.",
      },
    ]);

    await adapter.prepare();
    const result = await adapter.runRecord({
      runId: "run-openemr",
      record: record("demo-001"),
      audit,
      agent,
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "openemr-demo-001" });
    expect(page.hovered).toContain('text="Patient"');
    expect(page.clicked).toContain('text="New/Search"');
    expect(formFrame.clicked).toContain('button:has-text("Contact")');
    expect(formFrame.filled).toEqual(
      expect.arrayContaining([
        { selector: 'input[name="form_fname"]', value: "Ava" },
        { selector: 'input[name="form_lname"]', value: "Nguyen" },
        { selector: 'input[name="form_DOB"]', value: "1987-03-14" },
        { selector: 'input[name="form_email"]', value: "ava.nguyen@example.test" },
      ]),
    );
    expect(formFrame.selected).toContainEqual({ selector: 'select[name="form_sex"]', option: { label: "Female" } });
    expect(formFrame.clicked).toContain('button:has-text("Create New Patient")');
    expect(confirmFrame.clicked).toContain('button:has-text("Confirm Create New Patient")');
    await expect(readFile(join(root, "run-openemr", "screenshots/demo-001/openemr/after-save.png"), "utf8")).resolves.toBe(
      "screenshot-3",
    );
  });

  it("uses a fresh OpenEMR session for each record after one is saved", async () => {
    const root = await mkdtemp(join(tmpdir(), "openemr-fresh-session-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openemr" });
    const pages = [successfulCreatePage(), successfulCreatePage()];
    const browsers = pages.map((page) => new FakeOpenEmrBrowser(page));
    const adapter = new OpenEmrAdapter(openEmrConfig(), {
      launchBrowser: async () => {
        const browser = browsers.shift();
        if (!browser) {
          throw new Error("No fake browser left.");
        }
        return browser;
      },
    });
    const agent = new QueuedAgent([
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "First form visible." },
      { actionId: "save-patient", confidence: 0.88, rationale: "First form ready." },
      { actionId: "navigate-new-patient", confidence: 0.91, rationale: "Second form visible." },
      { actionId: "save-patient", confidence: 0.88, rationale: "Second form ready." },
    ]);

    await adapter.prepare();
    await adapter.runRecord({ runId: "run-openemr", record: record("demo-001"), audit, agent });
    await adapter.runRecord({ runId: "run-openemr", record: record("demo-002"), audit, agent });

    expect(pages[0].clicked).toContain('button:has-text("Confirm Create New Patient")');
    expect(pages[1].clicked).toContain('button:has-text("Confirm Create New Patient")');
    expect(browsers).toHaveLength(0);
  });

  it("returns a verification exception when save leaves the create form visible", async () => {
    const root = await mkdtemp(join(tmpdir(), "openemr-save-unverified-"));
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-openemr" });
    const page = new FakeOpenEmrPage({
      availableSelectors: [
        ...loginSelectors(),
        'button:has-text("Contact")',
        'input[name="form_fname"]',
        'input[name="form_lname"]',
        'input[name="form_DOB"]',
        'select[name="form_sex"]',
        'input[name="form_street"]',
        'input[name="form_city"]',
        'input[name="form_state"]',
        'input[name="form_postal_code"]',
        'input[name="form_phone_cell"]',
        'input[name="form_email"]',
        'button:has-text("Create New Patient")',
      ],
      visibleSelectors: [
        ...loginSelectors(),
        'button:has-text("Contact")',
        'input[name="form_fname"]',
        'input[name="form_lname"]',
        'input[name="form_DOB"]',
        'select[name="form_sex"]',
        'button:has-text("Create New Patient")',
      ],
      clickReveals: {
        'button:has-text("Contact")': [
          'input[name="form_street"]',
          'input[name="form_city"]',
          'input[name="form_state"]',
          'input[name="form_postal_code"]',
          'input[name="form_phone_cell"]',
          'input[name="form_email"]',
        ],
      },
      bodyTexts: ["OpenEMR dashboard", "Search or Add Patient", "Search or Add Patient Create New Patient"],
      tagNames: [['select[name="form_sex"]', "select"]],
    });
    const adapter = new OpenEmrAdapter(openEmrConfig(), {
      launchBrowser: async () => new FakeOpenEmrBrowser(page),
    });
    const agent = new QueuedAgent([
      {
        actionId: "navigate-new-patient",
        confidence: 0.91,
        rationale: "The patient form is visible.",
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
        code: "verification_failed",
        severity: "error",
        message: "OpenEMR still showed the new-patient form after save.",
        suggestedRemediation: "Review required fields and the after-save screenshot before retrying.",
        screenshotPath: "screenshots/demo-001/openemr/after-save.png",
      },
    });
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

function successfulCreatePage(): FakeOpenEmrPage {
  return new FakeOpenEmrPage({
    availableSelectors: [
      ...loginSelectors(),
      'text="Patient"',
      'text="New/Search"',
      'button:has-text("Contact")',
      'input[name="form_fname"]',
      'input[name="form_lname"]',
      'input[name="form_DOB"]',
      'select[name="form_sex"]',
      'input[name="form_street"]',
      'input[name="form_city"]',
      'select[name="form_state"]',
      'input[name="form_postal_code"]',
      'input[name="form_phone_cell"]',
      'input[name="form_email"]',
      'button:has-text("Create New Patient")',
      'button:has-text("Confirm Create New Patient")',
    ],
    visibleSelectors: [
      ...loginSelectors(),
      'text="Patient"',
      'button:has-text("Contact")',
      'input[name="form_fname"]',
      'input[name="form_lname"]',
      'input[name="form_DOB"]',
      'select[name="form_sex"]',
      'button:has-text("Create New Patient")',
      'button:has-text("Confirm Create New Patient")',
    ],
    hoverReveals: {
      'text="Patient"': ['text="New/Search"'],
    },
    clickReveals: {
      'button:has-text("Contact")': [
        'input[name="form_street"]',
        'input[name="form_city"]',
        'select[name="form_state"]',
        'input[name="form_postal_code"]',
        'input[name="form_phone_cell"]',
        'input[name="form_email"]',
      ],
    },
    clickHides: {
      'button:has-text("Create New Patient")': ['button:has-text("Create New Patient")'],
      'button:has-text("Confirm Create New Patient")': ['button:has-text("Confirm Create New Patient")'],
    },
    bodyTexts: [
      "OpenEMR dashboard",
      "Search or Add Patient",
      "No matches were found.\nConfirm Create New Patient Cancel",
      "No matches were found.\nConfirm Create New Patient Cancel",
      "Created patient",
    ],
    tagNames: [
      ['select[name="form_sex"]', "select"],
      ['select[name="form_state"]', "select"],
    ],
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
  readonly visibleSelectors?: Set<string>;
  readonly hoverReveals: Map<string, string[]>;
  readonly clickReveals: Map<string, string[]>;
  readonly clickHides: Map<string, string[]>;
  readonly childFrames: FakeOpenEmrPage[];
  readonly tagNames: Map<string, string>;
  readonly gotos: Array<{ url: string; options?: unknown }> = [];
  readonly waitStates: string[] = [];
  readonly filled: Array<{ selector: string; value: string }> = [];
  readonly selected: Array<{ selector: string; option: unknown }> = [];
  readonly clicked: string[] = [];
  readonly hovered: string[] = [];
  private readonly bodyTexts: string[];
  private screenshotCount = 0;
  private lastBodyText = "";

  constructor(options: {
    availableSelectors: string[];
    visibleSelectors?: string[];
    hoverReveals?: Record<string, string[]>;
    clickReveals?: Record<string, string[]>;
    clickHides?: Record<string, string[]>;
    childFrames?: FakeOpenEmrPage[];
    bodyTexts?: string[];
    tagNames?: Array<[string, string]>;
  }) {
    this.availableSelectors = new Set(options.availableSelectors);
    this.visibleSelectors = options.visibleSelectors ? new Set(options.visibleSelectors) : undefined;
    this.hoverReveals = new Map(Object.entries(options.hoverReveals ?? {}));
    this.clickReveals = new Map(Object.entries(options.clickReveals ?? {}));
    this.clickHides = new Map(Object.entries(options.clickHides ?? {}));
    this.childFrames = options.childFrames ?? [];
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

  frames(): FakeOpenEmrPage[] {
    return this.childFrames;
  }

  hasSelector(selector: string): boolean {
    return selector === "body" || this.availableSelectors.has(selector);
  }

  isVisible(selector: string): boolean {
    if (selector === "body") {
      return true;
    }

    return this.hasSelector(selector) && (!this.visibleSelectors || this.visibleSelectors.has(selector));
  }

  revealFromHover(selector: string): void {
    this.hovered.push(selector);
    this.reveal(selector, this.hoverReveals);
  }

  revealFromClick(selector: string): void {
    this.reveal(selector, this.clickReveals);
    for (const hiddenSelector of this.clickHides.get(selector) ?? []) {
      this.visibleSelectors?.delete(hiddenSelector);
    }
  }

  private reveal(selector: string, revealMap: Map<string, string[]>): void {
    for (const revealedSelector of revealMap.get(selector) ?? []) {
      this.visibleSelectors?.add(revealedSelector);
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
    if (!this.page.isVisible(this.selector)) {
      throw new Error(`${this.selector} is not visible`);
    }
    this.page.clicked.push(this.selector);
    this.page.revealFromClick(this.selector);
  }

  async hover(): Promise<void> {
    if (!this.page.isVisible(this.selector)) {
      throw new Error(`${this.selector} is not visible`);
    }
    this.page.revealFromHover(this.selector);
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
