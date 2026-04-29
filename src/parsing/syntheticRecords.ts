import type { RawIntakeRecord } from "../domain/schema.js";
import { validateAndNormalizeRecord } from "../domain/validation.js";

export function applySyntheticSuffix(records: RawIntakeRecord[], suffix: string | undefined): RawIntakeRecord[] {
  if (!suffix) return records;

  const token = normalizeSyntheticSuffix(suffix);
  let validRecordIndex = 0;

  return records.map((record) => {
    const validation = validateAndNormalizeRecord(record);
    if (!validation.ok) return record;

    const transformed = buildSyntheticRecord(record, token, validRecordIndex);
    validRecordIndex += 1;
    return transformed;
  });
}

export function normalizeSyntheticSuffix(value: string): string {
  const token = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);

  if (token.length === 0) {
    throw new Error("Synthetic suffix must contain at least one letter or digit.");
  }

  return token;
}

function buildSyntheticRecord(record: RawIntakeRecord, token: string, validRecordIndex: number): RawIntakeRecord {
  const validation = validateAndNormalizeRecord(record);
  if (!validation.ok) return record;

  const normalized = validation.record;
  const syntheticRecord: RawIntakeRecord = {
    ...normalized,
    sourceRecordId: `${normalized.sourceRecordId}-${token}`,
    lastName: `${normalized.lastName} ${displaySuffix(token)}`,
    phone: syntheticPhone(token, validRecordIndex),
    email: emailWithTag(normalized.email, token),
    insuranceMemberId: `${normalized.insuranceMemberId}-${token.toUpperCase()}-${validRecordIndex + 1}`,
    sourceFormat: record.sourceFormat,
    aiExtraction: record.aiExtraction,
    rawSourceExcerpt: "",
  };

  syntheticRecord.rawSourceExcerpt = JSON.stringify(syntheticRecordWithoutExcerpt(syntheticRecord));
  return syntheticRecord;
}

function displaySuffix(token: string): string {
  return token.charAt(0).toUpperCase() + token.slice(1);
}

function syntheticPhone(token: string, validRecordIndex: number): string {
  const suffixBase = 1000 + ((hashToken(token) + validRecordIndex) % 8000);
  return `312555${String(suffixBase).padStart(4, "0")}`;
}

function hashToken(token: string): number {
  let hash = 0;
  for (const character of token) {
    hash = (hash * 31 + character.charCodeAt(0)) % 8000;
  }
  return hash;
}

function emailWithTag(email: string, token: string): string {
  const atIndex = email.indexOf("@");
  if (atIndex === -1) return email;
  return `${email.slice(0, atIndex)}+${token}${email.slice(atIndex)}`;
}

function syntheticRecordWithoutExcerpt(record: RawIntakeRecord): Record<string, unknown> {
  const { rawSourceExcerpt, ...rest } = record;
  return rest;
}
