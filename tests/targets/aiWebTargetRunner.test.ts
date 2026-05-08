import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAuditStore } from "../../src/audit/auditStore.js";
import type { NormalizedIntakeRecord } from "../../src/domain/schema.js";
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
      profile: profile(),
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
        approvalSource: "agent",
        selectedSelector: "#first-name",
        selectorCandidates: ["#first-name"],
        fieldScreenshotPath: "screenshots/demo-001/openemr/0002-ai-field-firstName.png",
      }),
    );
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
  readonly document = new FakeDocument([
    fakeElement("label", { for: "first-name" }, "First Name"),
    fakeElement("input", { id: "first-name", value: "" }),
    fakeElement("button", { class: "save" }, "Save"),
  ]);

  url(): string {
    return this.gotoUrls.at(-1) ?? "about:blank";
  }

  async title(): Promise<string> {
    return "New Patient";
  }

  locator(selector: string) {
    return {
      innerText: async () => (selector === "body" ? "First Name Save Ava Nguyen" : ""),
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
      const tags = selector.split(",").map((tag) => tag.trim().toUpperCase());
      return this.elements.filter((element) => tags.includes(element.tagName));
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
