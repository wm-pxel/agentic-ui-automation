import { z } from "zod";
import type { TargetName } from "../domain/schema.js";

export const AllowedAgentActionSchema = z.object({
  id: z.string(),
  description: z.string(),
});

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

export const AgentDecisionSchema = z.object({
  actionId: z.string().min(1),
  confidence: z.number().finite().min(0).max(1),
  rationale: z.string().min(1),
});

export interface AgentDriver {
  decide(input: AgentDecisionInput): Promise<AgentDecision>;
}

export function validateAgentDecision(input: AgentDecisionInput, decision: AgentDecision): AgentDecision {
  const parsed = AgentDecisionSchema.parse(decision);
  const allowedActionIds = new Set(input.allowedActions.map((action) => action.id));

  if (parsed.actionId !== "stop" && !allowedActionIds.has(parsed.actionId)) {
    throw new Error(`Agent decision actionId "${parsed.actionId}" is not allowed for step ${input.step}.`);
  }

  return parsed;
}
