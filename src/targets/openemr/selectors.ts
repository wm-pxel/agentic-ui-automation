import type { NormalizedIntakeRecord } from "../../domain/schema.js";

export const OPENEMR_LOGIN_SELECTORS = {
  username: ['input[name="authUser"]', "#authUser"],
  password: ['input[name="clearPass"]', "#clearPass"],
  submit: ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("Login")'],
};

export const OPENEMR_SAVE_CANDIDATES = [
  'button:has-text("Create New Patient")',
  'button:has-text("Save")',
  "#create",
  "#form_save",
];

export interface OpenEmrFieldMapping {
  sourceField: keyof NormalizedIntakeRecord;
  targetField: string;
  value: string;
  selectors: string[];
  required: boolean;
  mappingConfidence: number;
}

export function openEmrFieldMappings(record: NormalizedIntakeRecord): OpenEmrFieldMapping[] {
  return [
    {
      sourceField: "firstName",
      targetField: "First Name",
      value: record.firstName,
      selectors: ['input[name="form_fname"]', "#form_fname"],
      required: true,
      mappingConfidence: 0.99,
    },
    {
      sourceField: "lastName",
      targetField: "Last Name",
      value: record.lastName,
      selectors: ['input[name="form_lname"]', "#form_lname"],
      required: true,
      mappingConfidence: 0.99,
    },
    {
      sourceField: "dateOfBirth",
      targetField: "Date of Birth",
      value: record.dateOfBirth,
      selectors: ['input[name="form_DOB"]', "#form_DOB"],
      required: true,
      mappingConfidence: 0.97,
    },
    {
      sourceField: "sexOrGender",
      targetField: "Sex",
      value: openEmrSexLabel(record.sexOrGender),
      selectors: ['select[name="form_sex"]', "#form_sex"],
      required: true,
      mappingConfidence: 0.97,
    },
    {
      sourceField: "streetAddress",
      targetField: "Street",
      value: record.streetAddress,
      selectors: ['input[name="form_street"]', "#form_street"],
      required: false,
      mappingConfidence: 0.95,
    },
    {
      sourceField: "city",
      targetField: "City",
      value: record.city,
      selectors: ['input[name="form_city"]', "#form_city"],
      required: false,
      mappingConfidence: 0.95,
    },
    {
      sourceField: "state",
      targetField: "State",
      value: record.state,
      selectors: ['input[name="form_state"]', "#form_state"],
      required: false,
      mappingConfidence: 0.95,
    },
    {
      sourceField: "zip",
      targetField: "Postal Code",
      value: record.zip,
      selectors: ['input[name="form_postal_code"]', "#form_postal_code"],
      required: false,
      mappingConfidence: 0.95,
    },
    {
      sourceField: "phone",
      targetField: "Cell Phone",
      value: record.phone,
      selectors: ['input[name="form_phone_cell"]', "#form_phone_cell"],
      required: false,
      mappingConfidence: 0.95,
    },
    {
      sourceField: "email",
      targetField: "Email",
      value: record.email,
      selectors: ['input[name="form_email"]', "#form_email"],
      required: false,
      mappingConfidence: 0.95,
    },
  ];
}

function openEmrSexLabel(value: NormalizedIntakeRecord["sexOrGender"]): string {
  switch (value) {
    case "female":
      return "Female";
    case "male":
      return "Male";
    case "other":
      return "Other";
    case "unknown":
      return "Unknown";
  }
}
