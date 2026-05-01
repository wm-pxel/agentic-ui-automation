import { extname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { RawIntakeRecord, ValidationException } from "../domain/schema.js";
import { validateAndNormalizeRecord } from "../domain/validation.js";
import { OpenAiIntakeParser } from "../parsing/aiIntakeParser.js";
import { loadSourceRecords } from "../parsing/loadRecords.js";
import { writeIntakeHandoff, type WriteIntakeHandoffResult } from "../handoff/intakeHandoff.js";

export const DEFAULT_SEED_DATA_PATH = "data/demo/intake-seed-records.json";

export interface IntakeQueue {
  sourcePath: string;
  sourceName: string;
  items: IntakeQueueItem[];
}

export interface IntakeQueueItem {
  sourceRecordId: string;
  displayName: string;
  exportReady: boolean;
  record: RawIntakeRecord;
  normalizedRecord?: Record<string, unknown>;
  exceptions: ValidationException[];
  rawSourceExcerpt: string;
  aiIssues: Array<{ field?: string; message: string; severity: string }>;
  lowestConfidence?: number;
}

export interface ExportReadyRecordsInput {
  queue: IntakeQueue;
  selectedRecordIds?: string[];
  inbox?: string;
}

export type SyntheticPatientInput = Pick<
  RawIntakeRecord,
  | "firstName"
  | "lastName"
  | "dateOfBirth"
  | "sexOrGender"
  | "phone"
  | "email"
  | "streetAddress"
  | "city"
  | "state"
  | "zip"
  | "insurancePayer"
  | "insuranceMemberId"
  | "insuranceGroupId"
  | "reasonForVisit"
  | "preferredContactMethod"
  | "notes"
>;

export async function loadSeedIntakeQueue(path = DEFAULT_SEED_DATA_PATH): Promise<IntakeQueue> {
  return loadIntakeQueueFromFile(resolve(path));
}

export async function loadIntakeQueueFromFile(path: string): Promise<IntakeQueue> {
  const records = await loadRecordsForQueue(path);
  return buildIntakeQueue(path, records);
}

export function buildIntakeQueue(sourcePath: string, records: RawIntakeRecord[]): IntakeQueue {
  return {
    sourcePath,
    sourceName: sourcePath.split(/[\\/]/).pop() ?? sourcePath,
    items: records.map((record) => {
      const validation = validateAndNormalizeRecord(record);
      const normalizedRecord = validation.ok ? validation.record : validation.partialRecord;
      const exceptions = validation.ok ? [] : validation.exceptions;
      return {
        sourceRecordId: String(record.sourceRecordId),
        displayName: displayNameFor(record),
        exportReady: validation.ok,
        record,
        normalizedRecord,
        exceptions,
        rawSourceExcerpt: String(record.rawSourceExcerpt ?? ""),
        aiIssues: aiIssuesFor(record),
        lowestConfidence: lowestConfidenceFor(record),
      };
    }),
  };
}

export function addSyntheticPatientRecord(
  queue: IntakeQueue,
  input: SyntheticPatientInput,
  now = () => new Date(),
): IntakeQueue {
  const isoTimestamp = now().toISOString().replace(/\D/g, "").slice(0, 14);
  const timestamp = `${isoTimestamp.slice(0, 8)}T${isoTimestamp.slice(8)}`;
  const sourceRecordId = `desktop-created-${timestamp}-${randomUUID().slice(0, 6)}`;
  const record: RawIntakeRecord = {
    ...input,
    sourceRecordId,
    sourceFormat: "json",
    rawSourceExcerpt: syntheticSourceExcerpt(input, sourceRecordId),
  };

  return buildIntakeQueue(queue.sourcePath, [record, ...queue.items.map((item) => item.record)]);
}

export async function exportReadyRecords(input: ExportReadyRecordsInput): Promise<WriteIntakeHandoffResult> {
  const selected = new Set(input.selectedRecordIds ?? input.queue.items.filter((item) => item.exportReady).map((item) => item.sourceRecordId));
  const records = input.queue.items
    .filter((item) => item.exportReady && selected.has(item.sourceRecordId))
    .map((item) => item.record);

  if (records.length === 0) {
    throw new Error("No export-ready intake records were selected.");
  }

  return writeIntakeHandoff({ records, inbox: input.inbox });
}

async function loadRecordsForQueue(path: string): Promise<RawIntakeRecord[]> {
  const extension = extname(path).toLowerCase();
  if (extension === ".pdf" || extension === ".docx") {
    return new OpenAiIntakeParser({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_PARSER_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
    }).parseFile(path);
  }

  return loadSourceRecords(path);
}

function displayNameFor(record: RawIntakeRecord): string {
  const name = [record.firstName, record.lastName]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join(" ");
  return name || String(record.sourceRecordId);
}

function syntheticSourceExcerpt(input: SyntheticPatientInput, sourceRecordId: string): string {
  const values = [
    `Synthetic intake record ${sourceRecordId}`,
    `Name: ${String(input.firstName ?? "").trim()} ${String(input.lastName ?? "").trim()}`.trim(),
    `DOB: ${String(input.dateOfBirth ?? "").trim()}`,
    `Gender: ${String(input.sexOrGender ?? "").trim()}`,
    `Phone: ${String(input.phone ?? "").trim()}`,
    `Email: ${String(input.email ?? "").trim()}`,
    `Address: ${String(input.streetAddress ?? "").trim()}, ${String(input.city ?? "").trim()}, ${String(input.state ?? "").trim()} ${String(input.zip ?? "").trim()}`,
    `Insurance: ${String(input.insurancePayer ?? "").trim()} ${String(input.insuranceMemberId ?? "").trim()}`.trim(),
    `Reason: ${String(input.reasonForVisit ?? "").trim()}`,
    `Preferred contact: ${String(input.preferredContactMethod ?? "").trim()}`,
    `Notes: ${String(input.notes ?? "").trim()}`,
  ];
  return values.filter((value) => !value.endsWith(":")).join("\n");
}

function aiIssuesFor(record: RawIntakeRecord): Array<{ field?: string; message: string; severity: string }> {
  const aiExtraction = aiExtractionFor(record);
  if (!aiExtraction || !Array.isArray(aiExtraction.issues)) return [];
  return aiExtraction.issues
    .filter((issue): issue is Record<string, unknown> => typeof issue === "object" && issue !== null)
    .map((issue) => ({
      field: typeof issue.field === "string" ? issue.field : undefined,
      message: String(issue.message ?? ""),
      severity: String(issue.severity ?? "info"),
    }))
    .filter((issue) => issue.message.length > 0);
}

function lowestConfidenceFor(record: RawIntakeRecord): number | undefined {
  const aiExtraction = aiExtractionFor(record);
  if (!aiExtraction || typeof aiExtraction.fields !== "object" || aiExtraction.fields === null) return undefined;
  const values = Object.values(aiExtraction.fields)
    .filter((field): field is Record<string, unknown> => typeof field === "object" && field !== null)
    .map((field) => field.confidence)
    .filter((value): value is number => typeof value === "number");
  if (values.length === 0) return undefined;
  return Math.min(...values);
}

function aiExtractionFor(record: RawIntakeRecord): Record<string, unknown> | undefined {
  const value = record.aiExtraction;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
