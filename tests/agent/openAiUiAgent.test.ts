import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OpenAiUiAgentDriver, type OpenAiResponsesClient } from "../../src/agent/openAiUiAgent.js";
import { STOP_AGENT_ACTION_ID } from "../../src/agent/types.js";

function createInput(screenshotPath?: string, screenshotRootDir?: string) {
  return {
    target: "fake" as const,
    recordId: "demo-001",
    step: "save",
    visibleText: "Save patient",
    screenshotPath,
    screenshotRootDir,
    allowedActions: [
      { id: "click-save", description: "Click Save" },
      { id: "click-cancel", description: "Click Cancel" },
    ],
  };
}

interface CapturedResponsesRequest {
  store?: boolean;
  input: Array<{
    role: string;
    content: Array<{
      type: string;
      text?: string;
      image_url?: string;
      detail?: string;
    }>;
  }>;
}

function createClient(outputText: string, calls: unknown[]): OpenAiResponsesClient {
  return {
    responses: {
      async create(body) {
        calls.push(body);
        return { output_text: outputText };
      },
    },
  };
}

describe("OpenAiUiAgentDriver", () => {
  it("requires an API key when no client is injected", () => {
    expect(() => new OpenAiUiAgentDriver({ model: "gpt-4o-mini" })).toThrow(
      "OPENAI_API_KEY is required when --agent openai is used.",
    );
  });

  it("sends UI context to the Responses API and validates the model decision", async () => {
    const root = await mkdtemp(join(tmpdir(), "openai-agent-"));
    const screenshotPath = "screenshots/demo-001/fake/save.png";
    await mkdir(join(root, "screenshots", "demo-001", "fake"), { recursive: true });
    await writeFile(join(root, screenshotPath), Buffer.from("png-data"));
    const calls: unknown[] = [];
    const client = createClient(
      JSON.stringify({
        actionId: "click-save",
        confidence: 0.82,
        rationale: "The visible text indicates the save button should be clicked.",
      }),
      calls,
    );
    const agent = new OpenAiUiAgentDriver({ model: "gpt-4o-mini", client });

    const decision = await agent.decide(createInput(screenshotPath, root));

    expect(decision).toEqual({
      actionId: "click-save",
      confidence: 0.82,
      rationale: "The visible text indicates the save button should be clicked.",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: "gpt-4o-mini",
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "agent_decision",
          strict: true,
        },
      },
    });
    expect(calls[0]).toHaveProperty("instructions", expect.stringContaining("JSON only"));
    const request = calls[0] as CapturedResponsesRequest;
    expect(request.input).toHaveLength(1);
    expect(request.input[0]?.role).toBe("user");
    const textPart = request.input[0]?.content.find((part) => part.type === "input_text");
    const imagePart = request.input[0]?.content.find((part) => part.type === "input_image");
    expect(JSON.parse(String(textPart?.text))).toEqual({
      target: "fake",
      recordId: "demo-001",
      step: "save",
      visibleText: "Save patient",
      screenshotPath,
      allowedActions: [
        { id: "click-save", description: "Click Save" },
        { id: "click-cancel", description: "Click Cancel" },
      ],
    });
    expect(imagePart).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,cG5nLWRhdGE=",
      detail: "auto",
    });
  });

  it("returns a stop decision when the model selects a disallowed action", async () => {
    const calls: unknown[] = [];
    const client = createClient(
      JSON.stringify({
        actionId: "click-delete",
        confidence: 0.7,
        rationale: "Delete looks related.",
      }),
      calls,
    );
    const agent = new OpenAiUiAgentDriver({ model: "gpt-4o-mini", client });

    await expect(agent.decide(createInput())).resolves.toEqual({
      actionId: STOP_AGENT_ACTION_ID,
      confidence: 0,
      rationale: "Model selected disallowed action click-delete.",
    });
  });
});
