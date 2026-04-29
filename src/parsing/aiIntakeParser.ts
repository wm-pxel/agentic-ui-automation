import OpenAI from "openai";
import { z } from "zod";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses.js";
import type { RawIntakeRecord } from "../domain/schema.js";
import { loadSourceDocument, type SourceDocument } from "./sourceDocuments.js";

export const OPENAI_PARSER_API_KEY_REQUIRED_ERROR = "OPENAI_API_KEY is required when --parser openai is used.";

const NORMALIZED_INTAKE_FIELDS = [
  "firstName",
  "lastName",
  "dateOfBirth",
  "sexOrGender",
  "phone",
  "email",
  "streetAddress",
  "city",
  "state",
  "zip",
  "insurancePayer",
  "insuranceMemberId",
  "insuranceGroupId",
  "reasonForVisit",
  "preferredContactMethod",
  "notes",
] as const;

const SYSTEM_INSTRUCTIONS = [
  "You extract patient intake records from source documents for audited EMR data entry.",
  "Return structured JSON only.",
  "Extract every patient intake record present in the source.",
  "Use null only when a value is not present or is too ambiguous.",
  "Include concise source evidence snippets and confidence scores for extracted fields.",
  `The fields array must use only these normalized intake field names: ${NORMALIZED_INTAKE_FIELDS.join(", ")}.`,
  "Put any source fields that do not map to those normalized names in additionalFields.",
  "Split full patient names into firstName and lastName.",
  "Map sex/gender source labels to sexOrGender, address/street labels to streetAddress, insurance/provider/payer labels to insurancePayer, member ID labels to insuranceMemberId, reason/visit labels to reasonForVisit, and preferred contact labels to preferredContactMethod.",
  "Do not invent values.",
].join(" ");

const AiExtractedFieldEntrySchema = z.object({
  field: z.string(),
  value: z.string(),
  confidence: z.number().min(0).max(1),
  evidence: z.string(),
});

const AiExtractedRecordSchema = z.object({
  sourceRecordId: z.string().nullable(),
  fields: z.array(AiExtractedFieldEntrySchema),
  additionalFields: z.array(AiExtractedFieldEntrySchema),
  issues: z.array(
    z.object({
      field: z.string().nullable(),
      message: z.string(),
      severity: z.enum(["info", "warning", "error"]),
    }),
  ),
});

const AiParserResponseSchema = z.object({
  records: z.array(AiExtractedRecordSchema),
});

type AiParserResponse = z.infer<typeof AiParserResponseSchema>;

export interface AiExtractionMetadata {
  parser: "openai";
  model: string;
  sourceDocumentName: string;
  sourceFormat: SourceDocument["format"];
  fields: Record<string, ExtractedFieldValue>;
  additionalFields: Record<string, ExtractedFieldValue>;
  issues: Array<{ field?: string; message: string; severity: "info" | "warning" | "error" }>;
}

type ExtractedFieldValue = Omit<z.infer<typeof AiExtractedFieldEntrySchema>, "field">;

export interface OpenAiParserClient {
  responses: {
    create(body: ResponseCreateParamsNonStreaming): Promise<{ output_text: string }>;
  };
}

export interface OpenAiIntakeParserOptions {
  apiKey?: string;
  model: string;
  client?: OpenAiParserClient;
}

export class OpenAiIntakeParser {
  private readonly client: OpenAiParserClient;
  private readonly model: string;

  constructor(options: OpenAiIntakeParserOptions) {
    this.model = options.model;
    if (options.client) {
      this.client = options.client;
      return;
    }
    if (!options.apiKey) {
      throw new Error(OPENAI_PARSER_API_KEY_REQUIRED_ERROR);
    }
    this.client = new OpenAI({ apiKey: options.apiKey });
  }

  async parseFile(path: string): Promise<RawIntakeRecord[]> {
    return this.parseDocument(await loadSourceDocument(path));
  }

  async parseDocument(document: SourceDocument): Promise<RawIntakeRecord[]> {
    const response = await this.client.responses.create({
      model: this.model,
      instructions: SYSTEM_INSTRUCTIONS,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify(
                {
                  sourceDocumentName: document.name,
                  sourceFormat: document.format,
                  sourceText: document.text,
                },
                null,
                2,
              ),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "intake_extraction",
          strict: true,
          schema: aiParserJsonSchema(),
        },
      },
      store: false,
      stream: false,
    });

    const parsed = AiParserResponseSchema.parse(JSON.parse(response.output_text) as unknown);
    return toRawRecords(parsed, document, this.model);
  }
}

function toRawRecords(response: AiParserResponse, document: SourceDocument, model: string): RawIntakeRecord[] {
  return response.records.map((record, index) => {
    const sourceRecordId = record.sourceRecordId?.trim() || `${document.format}-${index + 1}`;
    const fields = fieldEntriesToMap(record.fields);
    const additionalFields = fieldEntriesToMap(record.additionalFields);
    const rawRecord: Record<string, unknown> = {
      sourceRecordId,
      sourceFormat: document.format === "pdf" || document.format === "docx" ? "text" : document.format,
      rawSourceExcerpt: excerptFromFields(fields, document.text),
      aiExtraction: {
        parser: "openai",
        model,
        sourceDocumentName: document.name,
        sourceFormat: document.format,
        fields,
        additionalFields,
        issues: record.issues.map((issue) => ({
          field: issue.field ?? undefined,
          message: issue.message,
          severity: issue.severity,
        })),
      } satisfies AiExtractionMetadata,
    };

    for (const [field, extraction] of Object.entries(fields)) {
      rawRecord[field] = extraction.value;
    }

    return rawRecord as RawIntakeRecord;
  });
}

function fieldEntriesToMap(entries: Array<z.infer<typeof AiExtractedFieldEntrySchema>>): Record<string, ExtractedFieldValue> {
  const fields: Record<string, ExtractedFieldValue> = {};
  for (const entry of entries) {
    const field = entry.field.trim();
    if (!field) {
      continue;
    }
    fields[field] = {
      value: entry.value,
      confidence: entry.confidence,
      evidence: entry.evidence,
    };
  }
  return fields;
}

function excerptFromFields(fields: Record<string, { evidence?: string }>, fallback: string): string {
  const evidence = Object.values(fields)
    .map((field) => field.evidence)
    .filter((value): value is string => Boolean(value))
    .slice(0, 5)
    .join("\n");
  return evidence || fallback.slice(0, 1000);
}

function aiParserJsonSchema(): Record<string, unknown> {
  const fieldExtractionEntry = {
    type: "object",
    additionalProperties: false,
    required: ["field", "value", "confidence", "evidence"],
    properties: {
      field: { type: "string" },
      value: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      evidence: { type: "string" },
    },
  };

  return {
    type: "object",
    additionalProperties: false,
    required: ["records"],
    properties: {
      records: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["sourceRecordId", "fields", "additionalFields", "issues"],
          properties: {
            sourceRecordId: { type: ["string", "null"] },
            fields: {
              type: "array",
              items: {
                ...fieldExtractionEntry,
                properties: {
                  ...fieldExtractionEntry.properties,
                  field: { type: "string", enum: [...NORMALIZED_INTAKE_FIELDS] },
                },
              },
            },
            additionalFields: {
              type: "array",
              items: fieldExtractionEntry,
            },
            issues: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["field", "message", "severity"],
                properties: {
                  field: { type: ["string", "null"] },
                  message: { type: "string" },
                  severity: { type: "string", enum: ["info", "warning", "error"] },
                },
              },
            },
          },
        },
      },
    },
  };
}
