import { describe, expect, it } from "vitest";
import { createObservationSnapshot } from "../../src/targets/pageObservation.js";

describe("createObservationSnapshot", () => {
  it("returns the full observation contract with semantic controls and element selectors", async () => {
    const page = new FakeObservationPage({
      url: "https://example.test/new",
      title: "New Patient",
      text: "Contact First Name Save",
      elements: [
        fakeElement("label", { for: "fname" }, "First Name"),
        fakeElement("input", { id: "fname", name: "fname", value: "Ava" }),
        fakeElement("select", { name: "sex", value: "Female" }),
        fakeElement("button", { class: "contact" }, "Contact"),
        fakeElement("a", { "aria-label": "Patient chart", href: "/chart" }, "Open Chart"),
        fakeElement("textarea", { name: "notes", value: "hidden note", hidden: "true" }),
      ],
    });

    const observation = await createObservationSnapshot({
      page,
      screenshotPath: "screenshots/demo/openemr/0001-observe.png",
    });

    expect(page.evaluateCalls).toBe(1);
    expect(observation.currentUrl).toBe("https://example.test/new");
    expect(observation.title).toBe("New Patient");
    expect(observation.visibleText).toBe("Contact First Name Save");
    expect(observation.screenshotPath).toBe("screenshots/demo/openemr/0001-observe.png");
    expect(observation.controls).toEqual([
      { elementId: "control-1", tag: "input", role: "textbox", label: "First Name", value: "Ava", visibleText: "First Name" },
      { elementId: "control-2", tag: "select", role: "combobox", label: "", value: "Female", visibleText: "" },
      { elementId: "control-3", tag: "button", role: "button", label: "Contact", value: "", visibleText: "Contact" },
      { elementId: "control-4", tag: "a", role: "link", label: "Patient chart", value: "", visibleText: "Open Chart" },
    ]);
    expect(observation.elementSelectors).toEqual(
      new Map([
        ["control-1", "#fname"],
        ["control-2", 'select[name="sex"]'],
        ["control-3", "button.contact"],
        ["control-4", 'a[aria-label="Patient chart"]'],
      ]),
    );
  });
});

class FakeObservationPage {
  evaluateCalls = 0;

  constructor(
    private readonly state: {
      url: string;
      title: string;
      text: string;
      elements: FakeElement[];
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

  async evaluate<T>(pageFunction: () => T): Promise<T> {
    this.evaluateCalls += 1;
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const previousNode = globalThis.Node;
    const previousCss = globalThis.CSS;

    Object.assign(globalThis, {
      document: new FakeDocument(this.state.elements),
      window: {
        getComputedStyle: (element: FakeElement) => ({
          display: element.hidden ? "none" : "block",
          visibility: element.invisible ? "hidden" : "visible",
        }),
      },
      Node: { ELEMENT_NODE: 1 },
      CSS: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") },
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

  constructor(private readonly elements: FakeElement[]) {
    this.body.children = elements;
    for (const element of elements) {
      element.parentElement = this.body;
    }
  }

  querySelectorAll(selector: string): FakeElement[] {
    const tags = selector.split(",").map((tag) => tag.trim().toUpperCase());
    return this.elements.filter((element) => tags.includes(element.tagName));
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
  parentElement: FakeElement | null = null;
  children: FakeElement[] = [];
  hidden = false;
  invisible = false;
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
    this.hidden = attributes.hidden === "true";
    this.invisible = attributes.invisible === "true";
  }

  get id(): string {
    return this.attributes.id ?? "";
  }

  get type(): string {
    return this.attributes.type ?? "";
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  closest(selector: string): FakeElement | null {
    return selector === "label" && this.tagName === "LABEL" ? this : null;
  }

  getBoundingClientRect() {
    return {
      width: this.hidden ? 0 : 100,
      height: this.hidden ? 0 : 20,
    };
  }
}

function fakeElement(tag: string, attributes: Record<string, string> = {}, text = ""): FakeElement {
  return new FakeElement(tag, attributes, text);
}
