import type { NormalizedIntakeRecord } from "../domain/schema.js";

const INTAKE_METADATA_FIELDS = new Set(["sourceRecordId", "sourceFormat", "rawSourceExcerpt"]);

export type IntakeFieldCoverageStatus = "pending" | "mapped" | "skipped";

export interface IntakeFieldCoverage {
  field: string;
  value: string;
  status: IntakeFieldCoverageStatus;
}

export function normalizedIntakeFieldEntries(
  record: NormalizedIntakeRecord,
): Array<{ field: string; value: string }> {
  return Object.entries(record)
    .filter(([field, value]) => !INTAKE_METADATA_FIELDS.has(field) && value !== undefined && value !== null)
    .map(([field, value]) => ({ field, value: String(value) }));
}

export function buildIntakeFieldCoverage(input: {
  record: NormalizedIntakeRecord;
  completedFields: readonly string[];
  skippedFields: readonly string[];
}): IntakeFieldCoverage[] {
  const completed = new Set(input.completedFields);
  const skipped = new Set(input.skippedFields);

  return normalizedIntakeFieldEntries(input.record).map(({ field, value }) => ({
    field,
    value,
    status: completed.has(field) ? "mapped" : skipped.has(field) ? "skipped" : "pending",
  }));
}
