import { parse } from "csv-parse/sync";
import type { RawIntakeRecord } from "../domain/schema.js";

export function parseJsonRecords(content: string): RawIntakeRecord[] {
  const parsed = JSON.parse(content) as Array<Record<string, unknown>>;
  if (!Array.isArray(parsed)) {
    throw new Error("JSON intake input must be an array of records.");
  }
  return parsed.map((record, index) => ({
    ...record,
    sourceRecordId: String(record.sourceRecordId ?? `json-${index + 1}`),
    sourceFormat: "json",
    rawSourceExcerpt: JSON.stringify(record),
  }));
}

export function parseCsvRecords(content: string): RawIntakeRecord[] {
  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Array<Record<string, unknown>>;

  return rows.map((record, index) => ({
    ...record,
    sourceRecordId: String(record.sourceRecordId ?? `csv-${index + 1}`),
    sourceFormat: "csv",
    rawSourceExcerpt: JSON.stringify(record),
  }));
}
