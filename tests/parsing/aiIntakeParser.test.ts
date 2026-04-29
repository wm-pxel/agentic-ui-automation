import { describe, expect, it } from "vitest";
import {
  OPENAI_PARSER_API_KEY_REQUIRED_ERROR,
  OpenAiIntakeParser,
  type OpenAiParserClient,
} from "../../src/parsing/aiIntakeParser.js";
import type { SourceDocument } from "../../src/parsing/sourceDocuments.js";

function createClient(outputText: string, calls: unknown[]): OpenAiParserClient {
  return {
    responses: {
      async create(body) {
        calls.push(body);
        return { output_text: outputText };
      },
    },
  };
}

describe("OpenAiIntakeParser", () => {
  it("requires an API key when no client is injected", () => {
    expect(() => new OpenAiIntakeParser({ model: "gpt-5.4-mini" })).toThrow(OPENAI_PARSER_API_KEY_REQUIRED_ERROR);
  });

  it("extracts multiple records with structured field evidence", async () => {
    const calls: unknown[] = [];
    const parser = new OpenAiIntakeParser({
      model: "gpt-test",
      client: createClient(
        JSON.stringify({
          records: [
            {
              sourceRecordId: "doc-1",
              fields: [
                { field: "firstName", value: "Ava", confidence: 0.96, evidence: "Name: Ava Nguyen" },
                { field: "lastName", value: "Nguyen", confidence: 0.96, evidence: "Name: Ava Nguyen" },
                { field: "dateOfBirth", value: "1987-03-14", confidence: 0.94, evidence: "DOB: 1987-03-14" },
                { field: "sexOrGender", value: "female", confidence: 0.9, evidence: "Sex: female" },
                { field: "phone", value: "312-555-0198", confidence: 0.92, evidence: "Phone: 312-555-0198" },
                { field: "email", value: "ava@example.test", confidence: 0.97, evidence: "ava@example.test" },
                {
                  field: "streetAddress",
                  value: "1200 West Lake Street",
                  confidence: 0.93,
                  evidence: "1200 West Lake Street",
                },
                { field: "city", value: "Chicago", confidence: 0.93, evidence: "Chicago, IL 60607" },
                { field: "state", value: "IL", confidence: 0.93, evidence: "Chicago, IL 60607" },
                { field: "zip", value: "60607", confidence: 0.93, evidence: "60607" },
                { field: "insurancePayer", value: "Aetna", confidence: 0.9, evidence: "Aetna" },
                { field: "insuranceMemberId", value: "AET123", confidence: 0.9, evidence: "AET123" },
                {
                  field: "reasonForVisit",
                  value: "Annual wellness visit",
                  confidence: 0.9,
                  evidence: "Annual wellness visit",
                },
                { field: "preferredContactMethod", value: "phone", confidence: 0.8, evidence: "Prefers phone" },
              ],
              additionalFields: [{ field: "employer", value: "Acme", confidence: 0.7, evidence: "Employer: Acme" }],
              issues: [],
            },
            {
              sourceRecordId: "doc-2",
              fields: [
                { field: "firstName", value: "Marcus", confidence: 0.95, evidence: "Marcus Lee" },
                { field: "lastName", value: "Lee", confidence: 0.95, evidence: "Marcus Lee" },
              ],
              additionalFields: [],
              issues: [{ field: "dateOfBirth", message: "DOB not present", severity: "warning" }],
            },
          ],
        }),
        calls,
      ),
    });

    const records = await parser.parseDocument(sourceDocument("text", "Two patient records"));

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      sourceRecordId: "doc-1",
      sourceFormat: "text",
      firstName: "Ava",
      lastName: "Nguyen",
      dateOfBirth: "1987-03-14",
      phone: "312-555-0198",
      aiExtraction: {
        parser: "openai",
        model: "gpt-test",
        sourceDocumentName: "intake.txt",
        fields: {
          firstName: { confidence: 0.96, evidence: "Name: Ava Nguyen" },
        },
        additionalFields: {
          employer: { value: "Acme", confidence: 0.7, evidence: "Employer: Acme" },
        },
      },
    });
    expect(records[1]).toMatchObject({
      sourceRecordId: "doc-2",
      aiExtraction: {
        issues: [{ field: "dateOfBirth", message: "DOB not present", severity: "warning" }],
      },
    });
    expect(calls[0]).toMatchObject({
      model: "gpt-test",
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "intake_extraction",
          strict: true,
        },
      },
    });
  });

  it("uses a strict OpenAI-compatible schema for extracted field collections", async () => {
    const calls: unknown[] = [];
    const parser = new OpenAiIntakeParser({
      model: "gpt-test",
      client: createClient(JSON.stringify({ records: [] }), calls),
    });

    await parser.parseDocument(sourceDocument("text", "No intake records"));

    const schema = (calls[0] as { text: { format: { schema: Record<string, unknown> } } }).text.format.schema;
    expect(schema).toMatchObject({
      properties: {
        records: {
          items: {
            properties: {
              fields: {
                type: "array",
                items: {
                  properties: {
                    field: {
                      enum: expect.arrayContaining(["firstName", "lastName", "dateOfBirth", "sexOrGender"]),
                    },
                  },
                  required: ["field", "value", "confidence", "evidence"],
                },
              },
              additionalFields: {
                type: "array",
                items: {
                  required: ["field", "value", "confidence", "evidence"],
                },
              },
            },
          },
        },
      },
    });
    expect(JSON.stringify(schema)).not.toContain('"additionalProperties":{"type":"object"');
  });
});

function sourceDocument(format: SourceDocument["format"], text: string): SourceDocument {
  return {
    path: `/tmp/intake.${format === "text" ? "txt" : format}`,
    name: `intake.${format === "text" ? "txt" : format}`,
    format,
    text,
  };
}
