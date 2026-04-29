import { describe, expect, it } from "vitest";
import type { RawIntakeRecord } from "../../src/domain/schema.js";
import { validateAndNormalizeRecord } from "../../src/domain/validation.js";
import { applySyntheticSuffix } from "../../src/parsing/syntheticRecords.js";

describe("applySyntheticSuffix", () => {
  it("derives phone numbers from the suffix so separate synthetic runs differ", () => {
    const [firstRecord] = applySyntheticSuffix([record("demo-001")], "case123");
    const [secondRecord] = applySyntheticSuffix([record("demo-001")], "case124");
    const first = validateAndNormalizeRecord(firstRecord);
    const second = validateAndNormalizeRecord(secondRecord);

    expect(first.ok ? first.record.phone : undefined).toMatch(/^\+1312555\d{4}$/);
    expect(second.ok ? second.record.phone : undefined).toMatch(/^\+1312555\d{4}$/);
    expect(first.ok && second.ok && first.record.phone).not.toBe(second.ok ? second.record.phone : undefined);
  });
});

function record(sourceRecordId: string): RawIntakeRecord {
  return {
    sourceRecordId,
    firstName: "Ava",
    lastName: "Nguyen",
    dateOfBirth: "1987-03-14",
    sexOrGender: "Female",
    phone: "312-555-0198",
    email: "ava.nguyen@example.test",
    streetAddress: "1200 West Lake Street",
    city: "Chicago",
    state: "IL",
    zip: "60607",
    insurancePayer: "Aetna",
    insuranceMemberId: "AET123456",
    reasonForVisit: "Annual wellness visit",
    preferredContactMethod: "phone",
    sourceFormat: "json",
    rawSourceExcerpt: "{}",
  };
}
