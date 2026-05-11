import { describe, expect, it } from "vitest";
import type { AiWebAction } from "../../src/targets/browserActions.js";
import { executeBrowserAction } from "../../src/targets/browserActions.js";

function assertRunnerLevelActionsAreNotBrowserExecutable() {
  const runnerLevelAction: AiWebAction = {
    type: "stop",
    code: "ui_state_unexpected",
    message: "Stop before browser execution.",
  };

  // @ts-expect-error runner-level actions must not be accepted as browser-executable actions.
  const browserExecutableAction: Parameters<typeof executeBrowserAction>[2] = runnerLevelAction;

  void browserExecutableAction;
}

void assertRunnerLevelActionsAreNotBrowserExecutable;

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

  it("falls back to common option values when select labels do not match", async () => {
    const page = new FakeActionPage({ failSelectLabels: new Set(["Female"]) });

    await executeBrowserAction(page, new Map([["control-1", "select[name=sex]"]]), {
      type: "select",
      elementId: "control-1",
      field: "sexOrGender",
      value: "Female",
      rationale: "label match",
    });

    expect(page.actions).toEqual([
      ["select", "select[name=sex]", "label", "Female"],
      ["select", "select[name=sex]", "value", "F"],
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

  it("throws instead of silently swallowing runner-level actions at runtime", async () => {
    await expect(
      executeBrowserAction(new FakeActionPage(), new Map(), {
        type: "stop",
        code: "ui_state_unexpected",
        message: "Stop before browser execution.",
      } as never),
    ).rejects.toThrow("unsupported browser action: stop");
  });
});

class FakeActionPage {
  readonly actions: unknown[] = [];

  constructor(private readonly options: { failSelectLabels?: Set<string> } = {}) {}

  locator(selector: string) {
    return {
      fill: async (value: string) => this.actions.push(["fill", selector, value]),
      selectOption: async (option: { label?: string; value?: string }) => {
        if (option.label && this.options.failSelectLabels?.has(option.label)) {
          this.actions.push(["select", selector, "label", option.label]);
          throw new Error(`label not found: ${option.label}`);
        }
        if (option.label) {
          this.actions.push(["select", selector, option.label]);
          return;
        }
        this.actions.push(["select", selector, "value", option.value]);
      },
      click: async () => this.actions.push(["click", selector]),
    };
  }

  async waitForTimeout(timeoutMs: number) {
    this.actions.push(["wait", timeoutMs]);
  }
}
