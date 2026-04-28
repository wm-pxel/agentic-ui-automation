import { describe, expect, it } from "vitest";
import { NormalizedIntakeRecordSchema } from "../../src/domain/schema.js";
import { validateAndNormalizeRecord } from "../../src/domain/validation.js";

describe("validateAndNormalizeRecord", () => {
  it("normalizes a clean patient intake record", () => {
    const result = validateAndNormalizeRecord({
      sourceRecordId: "rec-001",
      firstName: "Ava",
      lastName: "Nguyen",
      dateOfBirth: "03/14/1987",
      sexOrGender: "Female",
      phone: "(312) 555-0198",
      email: "ava.nguyen@example.test",
      streetAddress: "1200 West Lake Street",
      city: "Chicago",
      state: "Illinois",
      zip: "60607-1234",
      insurancePayer: "Aetna",
      insuranceMemberId: "AET123456",
      insuranceGroupId: "GRP9",
      reasonForVisit: "Annual wellness visit",
      preferredContactMethod: "phone",
      notes: "Prefers morning appointments.",
      sourceFormat: "json",
      rawSourceExcerpt: "Ava Nguyen intake",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid record");
    expect(result.record.dateOfBirth).toBe("1987-03-14");
    expect(result.record.phone).toBe("+13125550198");
    expect(result.record.state).toBe("IL");
    expect(result.record.zip).toBe("60607");
    expect(result.record.sexOrGender).toBe("female");
    expect(result.record.preferredContactMethod).toBe("phone");
    expect(result.record.insuranceGroupId).toBe("GRP9");
    expect(result.record.notes).toBe("Prefers morning appointments.");
  });

  it("reports missing required fields", () => {
    const result = validateAndNormalizeRecord({
      sourceRecordId: "rec-missing",
      firstName: "No",
      lastName: "Dob",
      dateOfBirth: "",
      sexOrGender: "female",
      phone: "3125550198",
      email: "missing.dob@example.test",
      streetAddress: "1 Main St",
      city: "Chicago",
      state: "IL",
      zip: "60607",
      insurancePayer: "Aetna",
      insuranceMemberId: "AET123",
      reasonForVisit: "Intake",
      preferredContactMethod: "email",
      sourceFormat: "json",
      rawSourceExcerpt: "missing DOB",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validation exception");
    expect(result.exceptions).toContainEqual(
      expect.objectContaining({
        code: "missing_required_field",
        field: "dateOfBirth",
      }),
    );
  });

  it("reports invalid phone and ambiguous insurance", () => {
    const result = validateAndNormalizeRecord({
      sourceRecordId: "rec-bad",
      firstName: "Sam",
      lastName: "Rivera",
      dateOfBirth: "1980-10-05",
      sexOrGender: "M",
      phone: "call office",
      email: "sam.rivera@example.test",
      streetAddress: "99 State St",
      city: "Chicago",
      state: "IL",
      zip: "60601",
      insurancePayer: "Blue",
      insuranceMemberId: "BLUE9",
      reasonForVisit: "New patient",
      preferredContactMethod: "text",
      sourceFormat: "json",
      rawSourceExcerpt: "Blue insurance, bad phone",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validation exception");
    expect(result.exceptions.map((exception) => exception.code)).toEqual(
      expect.arrayContaining(["invalid_format", "ambiguous_value"]),
    );
    expect(result.exceptions).toContainEqual(
      expect.objectContaining({
        code: "invalid_format",
        field: "phone",
      }),
    );
    expect(result.exceptions).toContainEqual(
      expect.objectContaining({
        code: "ambiguous_value",
        field: "insurancePayer",
      }),
    );
  });

  it("reports all missing normalized required fields", () => {
    const incompleteRecord = {
      sourceRecordId: "rec-missing-contract",
      firstName: "Morgan",
      lastName: "Lee",
      dateOfBirth: "1987-03-14",
      sexOrGender: "female",
      phone: "3125550198",
      email: "morgan.lee@example.test",
      streetAddress: "1 Main St",
      city: "Chicago",
      state: "IL",
      zip: "60607",
      reasonForVisit: "Intake",
    } as unknown as Parameters<typeof validateAndNormalizeRecord>[0];

    const result = validateAndNormalizeRecord(incompleteRecord);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validation exception");
    for (const field of [
      "insurancePayer",
      "insuranceMemberId",
      "preferredContactMethod",
      "sourceFormat",
      "rawSourceExcerpt",
    ]) {
      expect(result.exceptions).toContainEqual(
        expect.objectContaining({
          code: "missing_required_field",
          field,
        }),
      );
    }
  });

  it("reports invalid calendar dates", () => {
    const validRecord = {
      sourceRecordId: "rec-bad-date",
      firstName: "Casey",
      lastName: "Miller",
      sexOrGender: "female",
      phone: "3125550198",
      email: "casey.miller@example.test",
      streetAddress: "1 Main St",
      city: "Chicago",
      state: "IL",
      zip: "60607",
      insurancePayer: "Aetna",
      insuranceMemberId: "AET123",
      reasonForVisit: "Intake",
      preferredContactMethod: "email",
      sourceFormat: "json" as const,
      rawSourceExcerpt: "bad date",
    };

    for (const dateOfBirth of ["1987-99-99", "02/31/1987", "13/40/1987"]) {
      const result = validateAndNormalizeRecord({ ...validRecord, dateOfBirth });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected validation exception");
      expect(result.exceptions).toContainEqual(
        expect.objectContaining({
          code: "invalid_format",
          field: "dateOfBirth",
        }),
      );
    }
  });

  it("rejects invalid normalized record contract fields", () => {
    const normalizedRecord = {
      sourceRecordId: "rec-normalized",
      firstName: "Ava",
      lastName: "Nguyen",
      dateOfBirth: "1987-03-14",
      sexOrGender: "female",
      phone: "+13125550198",
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
      rawSourceExcerpt: "Ava Nguyen intake",
    };

    for (const invalidField of [
      { dateOfBirth: "1987-99-99" },
      { phone: "3125550198" },
      { email: "not-an-email" },
      { state: "Illinois" },
      { zip: "60607-1234" },
    ]) {
      expect(NormalizedIntakeRecordSchema.safeParse({ ...normalizedRecord, ...invalidField }).success).toBe(false);
    }
  });

  it("reports invalid email from the normalized schema contract", () => {
    const result = validateAndNormalizeRecord({
      sourceRecordId: "rec-bad-email",
      firstName: "Ava",
      lastName: "Nguyen",
      dateOfBirth: "1987-03-14",
      sexOrGender: "female",
      phone: "3125550198",
      email: "not-an-email",
      streetAddress: "1200 West Lake Street",
      city: "Chicago",
      state: "IL",
      zip: "60607",
      insurancePayer: "Aetna",
      insuranceMemberId: "AET123456",
      reasonForVisit: "Annual wellness visit",
      preferredContactMethod: "phone",
      sourceFormat: "json",
      rawSourceExcerpt: "bad email",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validation exception");
    expect(result.exceptions).toContainEqual(
      expect.objectContaining({
        code: "invalid_format",
        field: "email",
      }),
    );
  });

  it("reports invalid runtime source format from the normalized schema contract", () => {
    const result = validateAndNormalizeRecord({
      sourceRecordId: "rec-bad-source-format",
      firstName: "Ava",
      lastName: "Nguyen",
      dateOfBirth: "1987-03-14",
      sexOrGender: "female",
      phone: "3125550198",
      email: "ava.nguyen@example.test",
      streetAddress: "1200 West Lake Street",
      city: "Chicago",
      state: "IL",
      zip: "60607",
      insurancePayer: "Aetna",
      insuranceMemberId: "AET123456",
      reasonForVisit: "Annual wellness visit",
      preferredContactMethod: "phone",
      sourceFormat: "xml",
      rawSourceExcerpt: "bad source format",
    } as never);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validation exception");
    expect(result.exceptions).toContainEqual(
      expect.objectContaining({
        code: "invalid_format",
        field: "sourceFormat",
      }),
    );
  });
});
