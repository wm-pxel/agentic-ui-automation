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
      screenshotPath: "screenshots/demo/openkairo/0001-observe.png",
    });

    expect(page.evaluateCalls).toBe(1);
    expect(observation.currentUrl).toBe("https://example.test/new");
    expect(observation.title).toBe("New Patient");
    expect(observation.visibleText).toBe("Contact First Name Save");
    expect(observation.screenshotPath).toBe("screenshots/demo/openkairo/0001-observe.png");
    expect(observation.controls).toEqual([
      { elementId: "control-1", tag: "input", role: "textbox", label: "First Name", value: "Ava", visibleText: "First Name" },
      { elementId: "control-2", tag: "select", role: "combobox", label: "sex", value: "Female", visibleText: "sex" },
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

  it("falls back to unique selectors when preferred attributes collide", async () => {
    const page = new FakeObservationPage({
      url: "https://example.test/repeated",
      title: "Repeated Controls",
      text: "Choose Active Inactive",
      elements: [
        fakeElement("input", { name: "status", type: "radio", value: "active", "data-testid": "status-choice", class: "choice" }),
        fakeElement("input", { name: "status", type: "radio", value: "inactive", "data-testid": "status-choice", class: "choice" }),
        fakeElement("button", { class: "action" }, "Save first"),
        fakeElement("button", { class: "action" }, "Save second"),
      ],
    });

    const observation = await createObservationSnapshot({
      page,
      screenshotPath: "screenshots/demo/openkairo/repeated.png",
    });

    expect(observation.elementSelectors).toEqual(
      new Map([
        ["control-1", "body > input:nth-of-type(1)"],
        ["control-2", "body > input:nth-of-type(2)"],
        ["control-3", "body > button:nth-of-type(1)"],
        ["control-4", "body > button:nth-of-type(2)"],
      ]),
    );
    for (const [index, selector] of Array.from(observation.elementSelectors.values()).entries()) {
      expect(page.document.querySelectorAll(selector)).toEqual([page.elements[index]]);
    }
  });

  it("uses associated labels as click selectors for radio and checkbox controls", async () => {
    const page = new FakeObservationPage({
      url: "https://example.test/location",
      title: "Choose Location",
      text: "Outpatient Clinic Confirm",
      elements: [
        fakeElement("input", { id: "outpatient", name: "loginLocations", type: "radio", value: "outpatient" }),
        fakeElement("label", { for: "outpatient" }, "Outpatient Clinic"),
      ],
    });

    const observation = await createObservationSnapshot({
      page,
      screenshotPath: "screenshots/demo/openmrs/location.png",
    });

    expect(observation.controls).toEqual([
      {
        elementId: "control-1",
        tag: "input",
        role: "radio",
        label: "Outpatient Clinic",
        value: "outpatient",
        visibleText: "Outpatient Clinic",
      },
    ]);
    expect(observation.elementSelectors).toEqual(new Map([["control-1", 'label[for="outpatient"]']]));
  });

  it("observes controls with unusual attribute text without throwing", async () => {
    const page = new FakeObservationPage({
      url: "https://example.test/unusual",
      title: "Unusual Attributes",
      text: "Legal Name Submit",
      elements: [
        fakeElement("label", { for: "legal\nname" }, "Legal Name"),
        fakeElement("input", { id: "legal\nname", name: "patient\nname", value: "Ava" }),
        fakeElement("button", { "aria-label": "Submit\npatient \"record\"" }, "Submit"),
      ],
    });

    const observation = await createObservationSnapshot({
      page,
      screenshotPath: "screenshots/demo/openkairo/unusual.png",
    });

    expect(observation.controls).toEqual([
      { elementId: "control-1", tag: "input", role: "textbox", label: "Legal Name", value: "Ava", visibleText: "Legal Name" },
      { elementId: "control-2", tag: "button", role: "button", label: 'Submit patient "record"', value: "", visibleText: "Submit" },
    ]);
    expect(Array.from(observation.elementSelectors.values())).toEqual(["#legal\\a name", 'button[aria-label="Submit\\a patient \\"record\\""]']);
  });

  it("observes clickable non-form elements and input button values", async () => {
    const page = new FakeObservationPage({
      url: "https://example.test/login",
      title: "Login",
      text: "Registration Desk Log In",
      elements: [
        fakeElement("li", { id: "registration-desk", onclick: "chooseLocation()" }, "Registration Desk"),
        fakeElement("input", { id: "login-button", type: "submit", value: "Log In" }),
      ],
    });

    const observation = await createObservationSnapshot({
      page,
      screenshotPath: "screenshots/demo/openmrs/login.png",
    });

    expect(observation.controls).toEqual([
      {
        elementId: "control-1",
        tag: "li",
        role: "button",
        label: "Registration Desk",
        value: "",
        visibleText: "Registration Desk",
      },
      {
        elementId: "control-2",
        tag: "input",
        role: "button",
        label: "Log In",
        value: "Log In",
        visibleText: "Log In",
      },
    ]);
    expect(observation.elementSelectors).toEqual(
      new Map([
        ["control-1", "#registration-desk"],
        ["control-2", "#login-button"],
      ]),
    );
  });

  it("uses semantic navigation labels for icon-only wizard controls", async () => {
    const page = new FakeObservationPage({
      url: "https://example.test/register",
      title: "Register",
      text: "Gender",
      elements: [
        fakeElement("button", { id: "prev-button", class: "confirm" }, " "),
        fakeElement("button", { id: "next-button", class: "confirm right" }, "\n"),
      ],
    });

    const observation = await createObservationSnapshot({
      page,
      screenshotPath: "screenshots/demo/openmrs/register.png",
    });

    expect(observation.controls).toEqual([
      expect.objectContaining({
        tag: "button",
        role: "button",
        label: "previous back button",
        visibleText: "previous back button",
      }),
      expect.objectContaining({
        tag: "button",
        role: "button",
        label: "forward next button",
        visibleText: "forward next button",
      }),
    ]);
  });

  it("excludes controls hidden by an ancestor", async () => {
    const hiddenPanel = fakeElement("div", { hidden: "true" });
    const hiddenButton = fakeElement("button", { class: "open" }, "Open");
    hiddenPanel.children = [hiddenButton];
    hiddenButton.parentElement = hiddenPanel;
    const page = new FakeObservationPage({
      url: "https://example.test/matches",
      title: "Matches",
      text: "Similar patients found",
      elements: [hiddenPanel, hiddenButton, fakeElement("button", { id: "create-new" }, "Create New Patient")],
    });

    const observation = await createObservationSnapshot({
      page,
      screenshotPath: "screenshots/demo/openmrs/matches.png",
    });

    expect(observation.controls.map((control) => control.label)).toEqual(["Create New Patient"]);
  });
});

class FakeObservationPage {
  evaluateCalls = 0;
  readonly document: FakeDocument;
  readonly elements: FakeElement[];

  constructor(
    private readonly state: {
      url: string;
      title: string;
      text: string;
      elements: FakeElement[];
    },
  ) {
    this.elements = state.elements.filter((element) => element.isControl);
    this.document = new FakeDocument(state.elements);
  }

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
      document: this.document,
      window: {
        getComputedStyle: (element: FakeElement) => ({
          display: element.hidden ? "none" : "block",
          visibility: element.invisible ? "hidden" : "visible",
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
      element.parentElement = element.parentElement ?? this.body;
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

    const bodyChild = selector.match(/^body > ([a-z]+):nth-of-type\((\d+)\)$/);
    if (bodyChild) {
      const [, tag, indexText] = bodyChild;
      const index = Number(indexText) - 1;
      return this.elements.filter((element) => element.tagName === tag.toUpperCase())[index]
        ? [this.elements.filter((element) => element.tagName === tag.toUpperCase())[index]]
        : [];
    }

    const id = selector.match(/^#(.+)$/)?.[1];
    if (id) {
      return this.elements.filter((element) => element.id === unescapeCssValue(id));
    }

    const attribute = selector.match(/^([a-z]+)\[([^=]+)="(.+)"\]$/);
    if (attribute) {
      const [, tag, name, value] = attribute;
      return this.elements.filter(
        (element) => element.tagName === tag.toUpperCase() && element.getAttribute(name) === unescapeCssValue(value),
      );
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

  get labels(): FakeElement[] {
    if (!this.id || !this.ownerDocument) {
      return [];
    }
    return this.ownerDocument.elements.filter((element) => element.tagName === "LABEL" && element.getAttribute("for") === this.id);
  }

  get isControl(): boolean {
    return (
      ["INPUT", "SELECT", "TEXTAREA", "BUTTON", "A"].includes(this.tagName) ||
      this.getAttribute("onclick") !== null ||
      this.getAttribute("role") !== null ||
      this.getAttribute("tabindex") !== null
    );
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

function unescapeCssValue(value: string): string {
  return value.replace(/\\a ?/gi, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function cssEscape(value: string): string {
  return Array.from(value)
    .map((character) => {
      if (character === "\n") {
        return "\\a ";
      }
      return /[a-zA-Z0-9_-]/.test(character) ? character : `\\${character}`;
    })
    .join("");
}
