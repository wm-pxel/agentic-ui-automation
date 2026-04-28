import { STOP_AGENT_ACTION_ID } from "./types.js";
import type { AgentDecision, AgentDecisionInput, AgentDriver } from "./types.js";

export class ScriptedAgentDriver implements AgentDriver {
  async decide(input: AgentDecisionInput): Promise<AgentDecision> {
    const [firstAction] = input.allowedActions;

    if (!firstAction) {
      return {
        actionId: STOP_AGENT_ACTION_ID,
        confidence: 0,
        rationale: `Scripted agent found no allowed actions for step ${input.step}.`,
      };
    }

    return {
      actionId: firstAction.id,
      confidence: 1,
      rationale: `Scripted agent selected the first allowed action for step ${input.step}.`,
    };
  }
}
