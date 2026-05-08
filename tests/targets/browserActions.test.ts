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

  it("waits when executing a planner wait action", async () => {
    const page = new FakeActionPage();

    await executeBrowserAction(page, new Map(), { type: "wait", reason: "page transition" });

    expect(page.actions).toEqual([["wait", 1000]]);
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

  async waitForTimeout(timeoutMs: number) {
    this.actions.push(["wait", timeoutMs]);
  }
}
