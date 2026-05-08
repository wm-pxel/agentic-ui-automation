import { z } from "zod";
import type { NormalizedIntakeRecord } from "../domain/schema.js";
import type { AiWebAction } from "./browserActions.js";
import type { PageObservation } from "./pageObservation.js";
import type { TargetProfile } from "./profiles.js";

const AiWebActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("fill"),
      elementId: z.string(),
      field: z.string(),
      value: z.string(),
      rationale: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("select"),
      elementId: z.string(),
      field: z.string(),
      value: z.string(),
      rationale: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("click"),
      elementId: z.string(),
      purpose: z.string(),
      rationale: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("wait"),
      reason: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("screenshot"),
      label: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("verify"),
      criteria: z.string(),
      rationale: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("stop"),
      code: z.enum(["ui_state_unexpected", "possible_duplicate", "verification_failed"]),
      message: z.string(),
    })
    .strict(),
]);

export const AiWebPlanSchema = z
  .object({
    action: AiWebActionSchema,
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type AiWebPlan = z.infer<typeof AiWebPlanSchema>;

export interface AiWebPlanInput {
  record: NormalizedIntakeRecord;
  profile: TargetProfile;
  observation: PageObservation;
  completedFields: readonly string[];
  skippedFields: readonly string[];
  stepCount: number;
}

export interface AiWebPlanner {
  plan(input: AiWebPlanInput): Promise<AiWebPlan>;
}

export function validateAiWebPlan(plan: unknown): AiWebPlan {
  return AiWebPlanSchema.parse(plan);
}

export class StaticAiWebPlanner implements AiWebPlanner {
  private readonly queuedPlans: unknown[];

  constructor(plans: readonly unknown[]) {
    this.queuedPlans = [...plans];
  }

  async plan(_input: AiWebPlanInput): Promise<AiWebPlan> {
    if (this.queuedPlans.length > 0) {
      return validateAiWebPlan(this.queuedPlans.shift());
    }

    return validateAiWebPlan({
      action: {
        type: "stop",
        code: "ui_state_unexpected",
        message: "No queued AI web action was available.",
      },
      confidence: 1,
    });
  }
}

export type { AiWebAction };
