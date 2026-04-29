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
    { value: openEmrBirthSex(record.sexOrGender), selectors: ['select[name="form_sex"]', 'select[name="sex"]'] },
    { value: record.streetAddress, selectors: ['input[name="form_street"]', 'input[name="street"]', 'textarea[name*="street"]'] },
    { value: record.city, selectors: ['input[name="form_city"]', 'input[name="city"]'] },
    { value: openEmrStateLabel(record.state), selectors: ['input[name="form_state"]', 'select[name="form_state"]', 'input[name="state"]'] },
    { value: record.zip, selectors: ['input[name="form_postal_code"]', 'input[name="postal_code"]', 'input[name="zip"]'] },
    { value: record.phone, selectors: ['input[name="form_phone_cell"]', 'input[name*="phone_cell"]', 'input[name*="phone"]'] },
    { value: record.email, selectors: ['input[name="form_email"]', 'input[name*="email"]'] },
  ];
}

function openEmrBirthSex(value: NormalizedIntakeRecord["sexOrGender"]): string {
  switch (value) {
    case "female":
      return "Female";
    case "male":
      return "Male";
    case "unknown":
    case "other":
      return "Unknown";
  }
}

function openEmrStateLabel(value: string): string {
  return US_STATE_LABELS[value] ?? value;
}

const US_STATE_LABELS: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};

export const OPENEMR_LOGIN_SELECTORS = {
  username: ['input[name="authUser"]', "#authUser"],
  password: ['input[name="clearPass"]', "#clearPass"],
  submit: ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("Login")'],
};

export const OPENEMR_PATIENT_MENU_CANDIDATES = [
  'text="Patient"',
  'div.menuLabel:has-text("Patient")',
];

export const OPENEMR_NEW_PATIENT_CANDIDATES = [
  'text="New/Search"',
  'div.menuLabel:has-text("New/Search")',
  'text="Patient/Client"',
  'text="New Patient"',
  'a:has-text("New/Search")',
];

export const OPENEMR_CONTACT_SECTION_CANDIDATES = [
  'button:has-text("Contact")',
];

export const OPENEMR_CONFIRM_CREATE_CANDIDATES = [
  'button:has-text("Confirm Create New Patient")',
  'input[value="Confirm Create New Patient"]',
];

export const OPENEMR_SAVE_CANDIDATES = [
  'button:has-text("Create New Patient")',
  'button:has-text("Save")',
  'input[value="Create New Patient"]',
  'input[value="Save"]',
];
