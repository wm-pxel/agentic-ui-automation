import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses.js";
import { STOP_AGENT_ACTION_ID, validateAgentDecision } from "./types.js";
import type { AgentDecision, AgentDecisionInput, AgentDriver } from "./types.js";

const OPENAI_API_KEY_REQUIRED_ERROR = "OPENAI_API_KEY is required when --agent openai is used.";

const SYSTEM_INSTRUCTIONS = [
  "You are a UI automation decision agent.",
  "Choose exactly one actionId from the allowed UI automation actions for the current target and step.",
  `If no allowed action is safe, return the reserved actionId "${STOP_AGENT_ACTION_ID}".`,
  'Return JSON only with actionId, confidence, and rationale, for example {"actionId":"example","confidence":0.8,"rationale":"Brief reason."}.',
  "Do not include Markdown, prose, or additional keys.",
].join(" ");

interface OpenAiResponseWithOutputText {
  output_text: string;
}

export interface OpenAiResponsesClient {
  responses: {
    create(body: ResponseCreateParamsNonStreaming): Promise<OpenAiResponseWithOutputText>;
  };
}

export interface OpenAiUiAgentOptions {
  apiKey?: string;
  model: string;
  client?: OpenAiResponsesClient;
  screenshotRootDir?: string;
}

export class OpenAiUiAgentDriver implements AgentDriver {
  private readonly client: OpenAiResponsesClient;
  private readonly model: string;
  private readonly screenshotRootDir?: string;

  constructor(options: OpenAiUiAgentOptions) {
    this.model = options.model;
    this.screenshotRootDir = options.screenshotRootDir;

    if (options.client) {
      this.client = options.client;
      return;
    }

    if (!options.apiKey) {
      throw new Error(OPENAI_API_KEY_REQUIRED_ERROR);
    }

    this.client = new OpenAI({ apiKey: options.apiKey });
  }

  async decide(input: AgentDecisionInput): Promise<AgentDecision> {
    const response = await this.client.responses.create({
      model: this.model,
      instructions: SYSTEM_INSTRUCTIONS,
      input: await buildResponseInput(input, this.screenshotRootDir),
      text: {
        format: {
          type: "json_schema",
          name: "agent_decision",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["actionId", "confidence", "rationale"],
            properties: {
              actionId: { type: "string" },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              rationale: { type: "string" },
            },
          },
        },
      },
      store: false,
      stream: false,
    });
    const parsed = JSON.parse(response.output_text) as unknown;
    const actionId = selectedActionId(parsed);

    if (typeof actionId === "string" && !isAllowedAction(input, actionId)) {
      return {
        actionId: STOP_AGENT_ACTION_ID,
        confidence: 0,
        rationale: `Model selected disallowed action ${actionId}.`,
      };
    }

    return validateAgentDecision(input, parsed as AgentDecision);
  }
}

async function buildResponseInput(input: AgentDecisionInput, screenshotRootDir?: string): Promise<ResponseCreateParamsNonStreaming["input"]> {
  const content: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "auto" }> = [
    {
      type: "input_text",
      text: JSON.stringify(buildUserContent(input), null, 2),
    },
  ];

  if (input.screenshotPath) {
    content.push({
      type: "input_image",
      image_url: await screenshotDataUrl(input.screenshotPath, screenshotRootDir),
      detail: "auto",
    });
  }

  return [{ role: "user", content }];
}

function buildUserContent(input: AgentDecisionInput): Record<string, unknown> {
  return {
    target: input.target,
    recordId: input.recordId,
    step: input.step,
    visibleText: input.visibleText ?? null,
    screenshotPath: input.screenshotPath ?? null,
    allowedActions: input.allowedActions,
  };
}

function selectedActionId(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("actionId" in value)) {
    return undefined;
  }

  return value.actionId;
}

function isAllowedAction(input: AgentDecisionInput, actionId: string): boolean {
  return actionId === STOP_AGENT_ACTION_ID || input.allowedActions.some((action) => action.id === actionId);
}

async function screenshotDataUrl(screenshotPath: string, screenshotRootDir?: string): Promise<string> {
  const absolutePath = isAbsolute(screenshotPath) ? screenshotPath : resolve(screenshotRootDir ?? process.cwd(), screenshotPath);
  const bytes = await readFile(absolutePath);
  return `data:${mimeTypeForPath(screenshotPath)};base64,${bytes.toString("base64")}`;
}

function mimeTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/png";
  }
}
