import type { NormalizedIntakeRecord } from "../../domain/schema.js";

export interface FieldMapping {
  sourceField: keyof NormalizedIntakeRecord;
  targetField: string;
  value: string;
  mappingConfidence: number;
  selectors: string[];
  required?: boolean;
}

export function openMrsFieldMappings(record: NormalizedIntakeRecord): FieldMapping[] {
  const birthdate = openMrsBirthdateParts(record.dateOfBirth);
  return [
    {
      sourceField: "firstName",
      targetField: "Given Name",
      value: record.firstName,
      mappingConfidence: 0.99,
      selectors: ['input[name="givenName"]'],
      required: true,
    },
    {
      sourceField: "lastName",
      targetField: "Family Name",
      value: record.lastName,
      mappingConfidence: 0.99,
      selectors: ['input[name="familyName"]'],
      required: true,
    },
    {
      sourceField: "sexOrGender",
      targetField: "Gender",
      value: openMrsGender(record.sexOrGender),
      mappingConfidence: 0.97,
      selectors: ['select[name="gender"]', "#gender-field"],
      required: true,
    },
    {
      sourceField: "dateOfBirth",
      targetField: "Birthdate Day",
      value: birthdate.day,
      mappingConfidence: 0.96,
      selectors: ['input[name="birthdateDay"]', "#birthdateDay-field"],
      required: true,
    },
    {
      sourceField: "dateOfBirth",
      targetField: "Birthdate Month",
      value: birthdate.month,
      mappingConfidence: 0.96,
      selectors: ['select[name="birthdateMonth"]', "#birthdateMonth-field"],
      required: true,
    },
    {
      sourceField: "dateOfBirth",
      targetField: "Birthdate Year",
      value: birthdate.year,
      mappingConfidence: 0.96,
      selectors: ['input[name="birthdateYear"]', "#birthdateYear-field"],
      required: true,
    },
    {
      sourceField: "streetAddress",
      targetField: "Address Line 1",
      value: record.streetAddress,
      mappingConfidence: 0.98,
      selectors: ['input[name="address1"]', "#address1"],
    },
    {
      sourceField: "city",
      targetField: "City/Village",
      value: record.city,
      mappingConfidence: 0.98,
      selectors: ['input[name="cityVillage"]', "#cityVillage"],
    },
    {
      sourceField: "state",
      targetField: "State/Province",
      value: openMrsStateLabel(record.state),
      mappingConfidence: 0.96,
      selectors: ['input[name="stateProvince"]', "#stateProvince"],
    },
    {
      sourceField: "zip",
      targetField: "Postal Code",
      value: record.zip,
      mappingConfidence: 0.98,
      selectors: ['input[name="postalCode"]', "#postalCode"],
    },
    {
      sourceField: "phone",
      targetField: "Phone Number",
      value: record.phone,
      mappingConfidence: 0.99,
      selectors: ['input[name="phoneNumber"]', 'input.phone'],
    },
  ];
}

function openMrsGender(value: NormalizedIntakeRecord["sexOrGender"]): string {
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

function openMrsBirthdateParts(value: string): { day: string; month: string; year: string } {
  const [year, month, day] = value.split("-");
  return {
    day: String(Number(day)),
    month: MONTH_LABELS[Number(month) - 1] ?? month,
    year,
  };
}

const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function openMrsStateLabel(value: string): string {
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

export const OPENMRS_LOGIN_SELECTORS = {
  username: ['input[name="username"]', "#username"],
  password: ['input[name="password"]', "#password"],
  location: ['#Registration\\ Desk', '#sessionLocation li:has-text("Registration Desk")', "#sessionLocation li"],
  submit: ["#loginButton", 'input[value="Log In"]', 'button:has-text("Log In")'],
};

export const OPENMRS_PATIENT_MENU_CANDIDATES = [
  'a:has-text("Register a patient")',
  'a[href*="registrationapp/registerPatient"]',
];

export const OPENMRS_NEW_PATIENT_CANDIDATES = [
  'a:has-text("Register a patient")',
  'a[href*="registrationapp/registerPatient"]',
];

export const OPENMRS_CONTACT_SECTION_CANDIDATES: string[] = [];

export const OPENMRS_CONFIRM_CREATE_CANDIDATES = [
  "#reviewSimilarPatientsButton",
  'button:has-text("Review patient")',
  'text="Similar patients"',
];

export const OPENMRS_SAVE_CANDIDATES = [
  "#submit",
  'input[value="Confirm"]',
];

export const OPENMRS_NEXT_CANDIDATES = [
  "#next-button",
  'button:has-text("Next")',
];

export const OPENMRS_PATIENT_DASHBOARD_CONTACT_CANDIDATES = [
  "#patient-header-contactInfo",
  'a:has-text("Show Contact Info")',
];
