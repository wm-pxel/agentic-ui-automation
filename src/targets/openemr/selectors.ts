import type { NormalizedIntakeRecord } from "../../domain/schema.js";

export interface FieldMapping {
  value: string;
  selectors: string[];
}

export function openEmrFieldMappings(record: NormalizedIntakeRecord): FieldMapping[] {
  return [
    { value: record.firstName, selectors: ['input[name="form_fname"]', 'input[name="fname"]', 'input[id*="fname"]'] },
    { value: record.lastName, selectors: ['input[name="form_lname"]', 'input[name="lname"]', 'input[id*="lname"]'] },
    { value: record.dateOfBirth, selectors: ['input[name="form_DOB"]', 'input[name="DOB"]', 'input[id*="DOB"]'] },
    { value: record.streetAddress, selectors: ['input[name="form_street"]', 'input[name="street"]', 'textarea[name*="street"]'] },
    { value: record.city, selectors: ['input[name="form_city"]', 'input[name="city"]'] },
    { value: record.state, selectors: ['input[name="form_state"]', 'select[name="form_state"]', 'input[name="state"]'] },
    { value: record.zip, selectors: ['input[name="form_postal_code"]', 'input[name="postal_code"]', 'input[name="zip"]'] },
    { value: record.phone, selectors: ['input[name="form_phone_cell"]', 'input[name*="phone_cell"]', 'input[name*="phone"]'] },
    { value: record.email, selectors: ['input[name="form_email"]', 'input[name*="email"]'] },
  ];
}

export const OPENEMR_LOGIN_SELECTORS = {
  username: ['input[name="authUser"]', "#authUser"],
  password: ['input[name="clearPass"]', "#clearPass"],
  submit: ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("Login")'],
};

export const OPENEMR_NEW_PATIENT_CANDIDATES = [
  'text="New/Search"',
  'text="Patient/Client"',
  'text="New Patient"',
  'a:has-text("New/Search")',
];

export const OPENEMR_SAVE_CANDIDATES = [
  'button:has-text("Create New Patient")',
  'button:has-text("Save")',
  'input[value="Create New Patient"]',
  'input[value="Save"]',
];
