import { describe, expect, it } from "vitest";
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
  });
});
