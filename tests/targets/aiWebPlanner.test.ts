import { describe, expect, it } from "vitest";
import type { AiWebPlanInput } from "../../src/targets/aiWebPlanner.js";
import { StaticAiWebPlanner, validateAiWebPlan } from "../../src/targets/aiWebPlanner.js";

const runnerPlanInput = {
  profile: {} as never,
  record: {} as never,
  observation: {} as never,
  completedFields: ["firstName"],
  skippedFields: ["insuranceGroupId"],
  stepCount: 3,
} satisfies AiWebPlanInput;

void runnerPlanInput;

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

  it("returns a stop action when no queued action is available", async () => {
    const planner = new StaticAiWebPlanner([]);

    await expect(planner.plan({} as never)).resolves.toEqual({
      action: {
        type: "stop",
        code: "ui_state_unexpected",
        message: "No queued AI web action was available.",
      },
      confidence: 1,
    });
  });
});
