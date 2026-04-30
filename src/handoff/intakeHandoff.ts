import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { RawIntakeRecord } from "../domain/schema.js";

export const READY_EXTENSION = ".ready.json";
export const READY_CSV_EXTENSION = ".ready.csv";

export interface WriteIntakeHandoffInput {
  records: RawIntakeRecord[];
  inbox?: string;
  now?: () => Date;
  format?: "csv" | "json";
}

export interface WriteIntakeHandoffResult {
  inbox: string;
  pendingPath: string;
  readyPath: string;
  recordCount: number;
}

export function defaultIntakeInbox(): string {
  return join(homedir(), "Downloads", "agentic-ui-intake");
}

export function isReadyHandoffFile(path: string): boolean {
  const name = basename(path);
  return name.endsWith(READY_EXTENSION) || name.endsWith(READY_CSV_EXTENSION);
}

export async function writeIntakeHandoff(input: WriteIntakeHandoffInput): Promise<WriteIntakeHandoffResult> {
  const inbox = input.inbox ?? defaultIntakeInbox();
  await mkdir(inbox, { recursive: true });

  const stamp = (input.now?.() ?? new Date()).toISOString().replace(/\D/g, "").slice(0, 14);
  const id = randomUUID().slice(0, 8);
  const baseName = `intake-export-${stamp}-${id}`;
  const pendingPath = join(inbox, `${baseName}.pending`);
  const format = input.format ?? "csv";
  const readyPath = join(inbox, `${baseName}${format === "csv" ? READY_CSV_EXTENSION : READY_EXTENSION}`);

  await writeFile(pendingPath, serializeHandoffRecords(input.records, format), "utf8");
  await rename(pendingPath, readyPath);

  return {
    inbox,
    pendingPath,
    readyPath,
    recordCount: input.records.length,
  };
}

function serializeHandoffRecords(records: RawIntakeRecord[], format: "csv" | "json"): string {
  if (format === "json") return `${JSON.stringify(records, null, 2)}\n`;
  return recordsToCsv(records);
}

function recordsToCsv(records: RawIntakeRecord[]): string {
  const preferredColumns = [
    "sourceRecordId",
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
  ];
  const extraColumns = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!preferredColumns.includes(key) && key !== "sourceFormat" && key !== "rawSourceExcerpt") {
        extraColumns.add(key);
      }
    }
  }
  const columns = [...preferredColumns, ...[...extraColumns].sort(), "rawSourceExcerpt"];
  const lines = [columns.map(csvCell).join(",")];
  for (const record of records) {
    lines.push(columns.map((column) => csvCell(record[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}
