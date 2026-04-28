import type { TargetName } from "../domain/schema.js";

export interface AllowedAgentAction {
  id: string;
  description: string;
}

export interface AgentDecisionInput {
  target: TargetName;
  recordId: string;
  step: string;
  screenshotPath?: string;
  visibleText?: string;
  allowedActions: AllowedAgentAction[];
}

export interface AgentDecision {
  actionId: string;
  confidence: number;
  rationale: string;
}

export interface AgentDriver {
  decide(input: AgentDecisionInput): Promise<AgentDecision>;
}
