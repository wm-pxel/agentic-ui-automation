import OpenAI from "openai";
import { z } from "zod";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses.js";
import type { NormalizedIntakeRecord } from "../domain/schema.js";
import { AiWebActionSchema } from "./browserActions.js";
import type { AiWebAction } from "./browserActions.js";
import { buildIntakeFieldCoverage } from "./intakeFieldCoverage.js";
import type { PageObservation } from "./pageObservation.js";
import type { TargetProfile } from "./profiles.js";

export const OPENAI_AI_WEB_PLANNER_API_KEY_REQUIRED_ERROR =
  "OPENAI_API_KEY is required when running non-fake targets with the AI web planner.";

const SYSTEM_INSTRUCTIONS = [
  "You plan bounded browser actions for audited synthetic patient intake data entry.",
  "Return one JSON plan only. The plan must match the provided schema.",
  "Use only observed control elementId values when filling, selecting, or clicking.",
  "Prefer filling missing normalized record fields, selecting visible options by label, clicking navigation/save controls, waiting for transitions, taking proof screenshots, or verifying success criteria.",
  "For every visible destination control, semantically compare its label, role, visible text, name, and surrounding context against all pending intake fields.",
  "Before advancing, submitting, saving, or verifying, fill or select visible controls that match pending intake fields, even when destination labels differ from normalized field names.",
  "When filling or selecting a matched intake value, set action.field to the normalized intake field name from intakeFieldCoverage.",
  "Use target workflow hints as guidance, but still choose actions only from the currently observed controls.",
  "Use recent action history to avoid repeating the same non-progress action.",
  "Before clicking a login, submit, continue, or save control, fill or select visible required fields that are blank and relevant to the task.",
  "Do not fill or select fields that are already represented in completedFields unless the visible value is wrong.",
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
  recentActions: readonly AiWebRecentAction[];
  stepCount: number;
}

export interface AiWebPlanner {
  plan(input: AiWebPlanInput): Promise<AiWebPlan>;
}

export interface AiWebRecentAction {
  actionType: AiWebAction["type"];
  target: string;
  result: string;
}

export interface OpenAiAiWebPlannerClient {
  responses: {
    create(body: ResponseCreateParamsNonStreaming): Promise<{ output_text: string; output_parsed?: unknown }>;
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

    return validateAiWebPlan(planFromResponse(response));
  }
}

function planFromResponse(response: { output_text: string; output_parsed?: unknown }): unknown {
  if (response.output_parsed) {
    return response.output_parsed;
  }

  return parseFirstJsonValue(response.output_text);
}

function parseFirstJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    const jsonText = firstJsonObjectText(value);
    return JSON.parse(jsonText) as unknown;
  }
}

function firstJsonObjectText(value: string): string {
  const start = value.indexOf("{");
  if (start < 0) {
    throw new SyntaxError("AI planner response did not contain a JSON object.");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < value.length; index += 1) {
    const character = value[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }

    if (character === "\"") {
      inString = true;
      continue;
    }

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }

  throw new SyntaxError("AI planner response did not contain a complete JSON object.");
}

function buildPlannerPrompt(input: AiWebPlanInput): Record<string, unknown> {
  return {
    targetProfile: {
      name: input.profile.name,
      displayName: input.profile.displayName,
      baseUrl: input.profile.baseUrl,
      credentials: input.profile.credentials,
      task: input.profile.task,
      workflowHints: input.profile.workflowHints,
      successCriteria: input.profile.successCriteria,
      forbiddenActions: input.profile.forbiddenActions,
    },
    normalizedRecord: input.record,
    intakeFieldCoverage: buildIntakeFieldCoverage({
      record: input.record,
      completedFields: input.completedFields,
      skippedFields: input.skippedFields,
    }),
    pageObservation: {
      currentUrl: input.observation.currentUrl,
      title: input.observation.title,
      visibleText: input.observation.visibleText,
      screenshotPath: input.observation.screenshotPath,
      controls: input.observation.controls,
    },
    completedFields: input.completedFields,
    skippedFields: input.skippedFields,
    recentActions: input.recentActions,
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
