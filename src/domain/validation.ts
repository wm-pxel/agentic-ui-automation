import {
  type NormalizedIntakeRecord,
  type RawIntakeRecord,
  type ValidationException,
  type ValidationResult,
} from "./schema.js";

const STATE_ALIASES: Record<string, string> = {
  illinois: "IL",
  il: "IL",
  wisconsin: "WI",
  wi: "WI",
  indiana: "IN",
  in: "IN",
};

const REQUIRED_FIELDS = [
  "sourceRecordId",
  "firstName",
  "lastName",
  "dateOfBirth",
  "sexOrGender",
  "phone",
  "streetAddress",
  "city",
  "state",
  "zip",
  "reasonForVisit",
] as const;

export function validateAndNormalizeRecord(input: RawIntakeRecord): ValidationResult {
  const exceptions: ValidationException[] = [];

  for (const field of REQUIRED_FIELDS) {
    const value = input[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      exceptions.push({
        code: "missing_required_field",
        severity: "error",
        field,
        message: `${field} is required for intake automation.`,
        rawValue: value,
        suggestedRemediation: `Provide ${field} before rerunning this record.`,
      });
    }
  }

  const dateOfBirth = normalizeDate(String(input.dateOfBirth ?? ""));
  if (input.dateOfBirth && !dateOfBirth) {
    exceptions.push({
      code: "invalid_format",
      severity: "error",
      field: "dateOfBirth",
      message: "Date of birth could not be normalized to YYYY-MM-DD.",
      rawValue: input.dateOfBirth,
      suggestedRemediation: "Use YYYY-MM-DD or MM/DD/YYYY.",
    });
  }

  const phone = normalizePhone(String(input.phone ?? ""));
  if (input.phone && !phone) {
    exceptions.push({
      code: "invalid_format",
      severity: "error",
      field: "phone",
      message: "Phone number could not be normalized.",
      rawValue: input.phone,
      suggestedRemediation: "Provide a 10-digit US phone number.",
    });
  }

  const insurancePayer = String(input.insurancePayer ?? "").trim();
  if (/^blue$/i.test(insurancePayer)) {
    exceptions.push({
      code: "ambiguous_value",
      severity: "error",
      field: "insurancePayer",
      message: "Insurance payer 'Blue' has multiple plausible mappings.",
      rawValue: input.insurancePayer,
      suggestedRemediation: "Specify the full payer name, such as Blue Cross Blue Shield of Illinois.",
    });
  }

  const state = normalizeState(String(input.state ?? ""));
  if (input.state && !state) {
    exceptions.push({
      code: "invalid_format",
      severity: "error",
      field: "state",
      message: "State could not be normalized to a two-letter code.",
      rawValue: input.state,
      suggestedRemediation: "Use a supported state name or abbreviation.",
    });
  }

  const zip = normalizeZip(String(input.zip ?? ""));
  if (input.zip && !zip) {
    exceptions.push({
      code: "invalid_format",
      severity: "error",
      field: "zip",
      message: "ZIP code could not be normalized.",
      rawValue: input.zip,
      suggestedRemediation: "Provide a five-digit ZIP code.",
    });
  }

  const partialRecord: Partial<NormalizedIntakeRecord> = {
    sourceRecordId: String(input.sourceRecordId ?? ""),
    firstName: String(input.firstName ?? "").trim(),
    lastName: String(input.lastName ?? "").trim(),
    dateOfBirth: dateOfBirth ?? "",
    sexOrGender: normalizeGender(String(input.sexOrGender ?? "")),
    phone: phone ?? "",
    email: String(input.email ?? "").trim(),
    streetAddress: String(input.streetAddress ?? "").trim(),
    city: String(input.city ?? "").trim(),
    state: state ?? "",
    zip: zip ?? "",
    insurancePayer,
    insuranceMemberId: String(input.insuranceMemberId ?? "").trim(),
    insuranceGroupId: optionalString(input.insuranceGroupId),
    reasonForVisit: String(input.reasonForVisit ?? "").trim(),
    preferredContactMethod: normalizeContactMethod(String(input.preferredContactMethod ?? "")),
    notes: optionalString(input.notes),
    sourceFormat: input.sourceFormat,
    rawSourceExcerpt: input.rawSourceExcerpt,
  };

  if (exceptions.length > 0) {
    return { ok: false, exceptions, partialRecord };
  }

  return {
    ok: true,
    record: partialRecord as NormalizedIntakeRecord,
    exceptions: [],
  };
}

function normalizeDate(value: string): string | undefined {
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) return trimmed;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (!us) return undefined;
  const month = us[1].padStart(2, "0");
  const day = us[2].padStart(2, "0");
  return `${us[3]}-${month}-${day}`;
}

function normalizePhone(value: string): string | undefined {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return undefined;
}

function normalizeState(value: string): string | undefined {
  return STATE_ALIASES[value.trim().toLowerCase()];
}

function normalizeZip(value: string): string | undefined {
  const match = /^(\d{5})(?:-\d{4})?$/.exec(value.trim());
  return match?.[1];
}

function normalizeGender(value: string): NormalizedIntakeRecord["sexOrGender"] {
  const normalized = value.trim().toLowerCase();
  if (["f", "female"].includes(normalized)) return "female";
  if (["m", "male"].includes(normalized)) return "male";
  if (["other", "nonbinary", "non-binary"].includes(normalized)) return "other";
  return "unknown";
}

function normalizeContactMethod(value: string): NormalizedIntakeRecord["preferredContactMethod"] {
  const normalized = value.trim().toLowerCase();
  if (["phone", "email", "text", "mail"].includes(normalized)) {
    return normalized as NormalizedIntakeRecord["preferredContactMethod"];
  }
  return "phone";
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
