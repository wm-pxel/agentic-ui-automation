import { describe, expect, it } from "vitest";
import { ScriptedAgentDriver } from "../../src/agent/scriptedAgent.js";

describe("ScriptedAgentDriver", () => {
  it("selects the first allowed action with full confidence", async () => {
    const agent = new ScriptedAgentDriver();

    const decision = await agent.decide({
      target: "fake",
      recordId: "demo-001",
      step: "save",
      screenshotPath: "screenshots/demo-001/fake/save.png",
      visibleText: "Save Cancel",
      allowedActions: [
        { id: "save", description: "Click Save" },
        { id: "cancel", description: "Click Cancel" },
      ],
    });

    expect(decision).toEqual({
      actionId: "save",
      confidence: 1,
      rationale: "Scripted agent selected the first allowed action for step save.",
    });
  });
});
