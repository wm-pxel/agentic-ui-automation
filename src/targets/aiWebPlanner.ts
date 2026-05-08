import OpenAI from "openai";
import { z } from "zod";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses.js";
import type { NormalizedIntakeRecord } from "../domain/schema.js";
import { AiWebActionSchema } from "./browserActions.js";
import type { AiWebAction } from "./browserActions.js";
import type { PageObservation } from "./pageObservation.js";
import type { TargetProfile } from "./profiles.js";

export const OPENAI_AI_WEB_PLANNER_API_KEY_REQUIRED_ERROR =
  "OPENAI_API_KEY is required when running non-fake targets with the AI web planner.";

const SYSTEM_INSTRUCTIONS = [
  "You plan bounded browser actions for audited synthetic patient intake data entry.",
  "Return one JSON plan only. The plan must match the provided schema.",
  "Use only observed control elementId values when filling, selecting, or clicking.",
  "Prefer filling missing normalized record fields, selecting visible options by label, clicking navigation/save controls, waiting for transitions, taking proof screenshots, or verifying success criteria.",
  "Never plan deletion, admin setting changes, exports of unrelated records, or use of real patient data.",
  "If no observed action is safe or useful, return a stop action with a concise message.",
].join(" ");

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

export interface OpenAiAiWebPlannerClient {
  responses: {
    create(body: ResponseCreateParamsNonStreaming): Promise<{ output_text: string }>;
  };
}

export interface OpenAiAiWebPlannerOptions {
  apiKey?: string;
  model: string;
  client?: OpenAiAiWebPlannerClient;
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

export class OpenAiAiWebPlanner implements AiWebPlanner {
  private readonly client: OpenAiAiWebPlannerClient;
  private readonly model: string;

  constructor(options: OpenAiAiWebPlannerOptions) {
    this.model = options.model;

    if (options.client) {
      this.client = options.client;
      return;
    }

    if (!options.apiKey) {
      throw new Error(OPENAI_AI_WEB_PLANNER_API_KEY_REQUIRED_ERROR);
    }

    this.client = new OpenAI({ apiKey: options.apiKey });
  }

  async plan(input: AiWebPlanInput): Promise<AiWebPlan> {
    const response = await this.client.responses.create({
      model: this.model,
      instructions: SYSTEM_INSTRUCTIONS,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify(buildPlannerPrompt(input), null, 2),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "ai_web_plan",
          strict: true,
          schema: aiWebPlanJsonSchema(),
        },
      },
      store: false,
      stream: false,
    });

    return validateAiWebPlan(JSON.parse(response.output_text) as unknown);
  }
}

function buildPlannerPrompt(input: AiWebPlanInput): Record<string, unknown> {
  return {
    targetProfile: {
      name: input.profile.name,
      displayName: input.profile.displayName,
      baseUrl: input.profile.baseUrl,
      credentials: input.profile.credentials,
      task: input.profile.task,
      successCriteria: input.profile.successCriteria,
      forbiddenActions: input.profile.forbiddenActions,
    },
    normalizedRecord: input.record,
    pageObservation: {
      currentUrl: input.observation.currentUrl,
      title: input.observation.title,
      visibleText: input.observation.visibleText,
      screenshotPath: input.observation.screenshotPath,
      controls: input.observation.controls,
    },
    completedFields: input.completedFields,
    skippedFields: input.skippedFields,
    stepCount: input.stepCount,
    allowedActionTypes: ["fill", "select", "click", "wait", "screenshot", "verify", "stop"],
  };
}

function aiWebPlanJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["action", "confidence"],
    properties: {
      action: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "elementId", "field", "value", "rationale"],
            properties: {
              type: { type: "string", enum: ["fill"] },
              elementId: { type: "string" },
              field: { type: "string" },
              value: { type: "string" },
              rationale: { type: "string" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "elementId", "field", "value", "rationale"],
            properties: {
              type: { type: "string", enum: ["select"] },
              elementId: { type: "string" },
              field: { type: "string" },
              value: { type: "string" },
              rationale: { type: "string" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "elementId", "purpose", "rationale"],
            properties: {
              type: { type: "string", enum: ["click"] },
              elementId: { type: "string" },
              purpose: { type: "string" },
              rationale: { type: "string" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "reason"],
            properties: {
              type: { type: "string", enum: ["wait"] },
              reason: { type: "string" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "label"],
            properties: {
              type: { type: "string", enum: ["screenshot"] },
              label: { type: "string" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "criteria", "rationale"],
            properties: {
              type: { type: "string", enum: ["verify"] },
              criteria: { type: "string" },
              rationale: { type: "string" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "code", "message"],
            properties: {
              type: { type: "string", enum: ["stop"] },
              code: { type: "string", enum: ["ui_state_unexpected", "possible_duplicate", "verification_failed"] },
              message: { type: "string" },
            },
          },
        ],
      },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };
}

export type { AiWebAction };
