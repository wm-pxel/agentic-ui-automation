import { parse } from "csv-parse/sync";
import type { RawIntakeRecord } from "../domain/schema.js";

export function parseJsonRecords(content: string): RawIntakeRecord[] {
  const parsed = JSON.parse(content) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("JSON intake input must be an array of records.");
  }

  const records = parsed.map((record, index) => {
    if (!isPlainObject(record)) {
      throw new Error(`JSON intake record at index ${index} must be an object.`);
    }
    return record;
  });

  return records.map((record, index) => ({
    ...record,
    sourceRecordId: String(record.sourceRecordId ?? `json-${index + 1}`),
    sourceFormat: "json",
    rawSourceExcerpt: rawSourceExcerptFor(record),
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rawSourceExcerptFor(record: Record<string, unknown>): string {
  return typeof record.rawSourceExcerpt === "string" && record.rawSourceExcerpt.trim().length > 0
    ? record.rawSourceExcerpt
    : JSON.stringify(record);
}
