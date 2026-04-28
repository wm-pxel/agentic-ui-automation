import { describe, expect, it } from "vitest";
import { TargetAdapterResultSchema } from "../../src/adapters/contract.js";
import { ScriptedAgentDriver } from "../../src/agent/scriptedAgent.js";
import { validateAgentDecision } from "../../src/agent/types.js";

describe("ScriptedAgentDriver", () => {
  it("selects the first allowed action with full confidence", async () => {
    const agent = new ScriptedAgentDriver();

    const decision = await agent.decide({
      target: "fake",
      recordId: "demo-001",
      step: "save",
      screenshotPath: "screenshots/demo-001/fake/save.png",
      visibleText: "Save patient",
      allowedActions: [
        { id: "click-save", description: "Click Save" },
        { id: "stop", description: "Stop" },
      ],
    });

    expect(decision).toEqual({
      actionId: "click-save",
      confidence: 1,
      rationale: "Scripted agent selected the first allowed action for step save.",
    });
  });

  it("returns stop with zero confidence when no actions are allowed", async () => {
    const agent = new ScriptedAgentDriver();

    const decision = await agent.decide({
      target: "fake",
      recordId: "demo-001",
      step: "save",
      allowedActions: [],
    });

    expect(decision).toEqual({
      actionId: "stop",
      confidence: 0,
      rationale: "Scripted agent found no allowed actions for step save.",
    });
  });

  it("rejects decisions with confidence outside the valid range", () => {
    expect(() =>
      validateAgentDecision(
        {
          target: "fake",
          recordId: "demo-001",
          step: "save",
          allowedActions: [{ id: "click-save", description: "Click Save" }],
        },
        {
          actionId: "click-save",
          confidence: 1.1,
          rationale: "Too confident.",
        },
      ),
    ).toThrow();
  });

  it("rejects decisions with disallowed actions", () => {
    expect(() =>
      validateAgentDecision(
        {
          target: "fake",
          recordId: "demo-001",
          step: "save",
          allowedActions: [{ id: "click-save", description: "Click Save" }],
        },
        {
          actionId: "click-cancel",
          confidence: 1,
          rationale: "Disallowed action.",
        },
      ),
    ).toThrow("not allowed");
  });

  it("validates target adapter results at runtime", () => {
    expect(
      TargetAdapterResultSchema.parse({
        status: "succeeded",
        targetRecordId: "fake-demo-001",
      }),
    ).toEqual({
      status: "succeeded",
      targetRecordId: "fake-demo-001",
    });

    expect(() =>
      TargetAdapterResultSchema.parse({
        status: "skipped",
      }),
    ).toThrow();
  });
});
