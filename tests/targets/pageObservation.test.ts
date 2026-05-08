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
