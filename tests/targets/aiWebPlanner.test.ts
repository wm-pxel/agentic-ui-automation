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
