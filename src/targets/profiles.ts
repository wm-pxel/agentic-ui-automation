import type { CliRunConfig } from "../config.js";
import type { TargetName } from "../domain/schema.js";

export interface TargetProfile {
  name: TargetName;
  displayName: string;
  baseUrl: string;
  credentials: {
    username: string;
    password: string;
  };
  task: string;
  workflowHints: string[];
  successCriteria: string[];
  forbiddenActions: string[];
  concurrency: number;
  confidenceThreshold?: number;
}

type ProfileConfig = Pick<CliRunConfig, "targets" | "confidenceThreshold" | "openMrs" | "openEmr" | "openKairo">;

const DEFAULT_SUCCESS_CRITERIA = [
  "A saved patient detail page or dashboard is visible.",
  "The page shows the synthetic patient name.",
  "A proof screenshot can be captured after save.",
];

const DEFAULT_FORBIDDEN_ACTIONS = [
  "Do not delete patients.",
  "Do not change admin settings.",
  "Do not use real patient data.",
  "Do not export patient lists or unrelated records.",
];

const OPENMRS_WORKFLOW_HINTS = [
  "If a login session location is required, choose Registration Desk when visible; otherwise choose Outpatient Clinic before confirming the location.",
  "During login, fill username and password before clicking Log In.",
  "OpenMRS may show username, password, and a session location on the same login page; complete each visible login field before creating a patient.",
  "In the registration wizard, use the forward/next control, not the back/previous control, after each completed step.",
  "The OpenMRS wizard's blank green right-arrow control is the forward/next button and may be labeled forward next button or next-button; do not use the left-arrow previous/back button.",
  "In OpenMRS, date of birth may be split into day, month, and year fields; fill all visible birthdate parts before clicking any save, register, or confirm control.",
  "If the OpenMRS address step shows address inputs or a validation message requiring at least one field, fill available address fields from the normalized record before clicking the forward/next control.",
  "After name, gender, and birthdate are complete, skip optional address, phone, and relationship steps with the forward/next control unless required fields are visible.",
  "If similar patients are shown but no exact full synthetic name and birthdate match is visible, continue registering the new suffixed demo patient rather than opening an existing record.",
];

const OPENEMR_WORKFLOW_HINTS = [
  "If Patient Finder reports no matching records and Add New Patient is visible, click Add New Patient rather than repeating search.",
];

const OPENKAIRO_WORKFLOW_HINTS = [
  "If the Better with 150% zoom dialog is visible, dismiss it with Got it before clicking New Patient.",
  "Create the synthetic patient from the New Patient dialog using first name, last name, date of birth or year, and gender.",
  "Click Create Patient only after required visible fields are filled.",
];

export function buildTargetProfiles(config: ProfileConfig): TargetProfile[] {
  return config.targets.map((target) => {
    switch (target) {
      case "openmrs":
        return {
          name: "openmrs",
          displayName: "OpenMRS",
          baseUrl: config.openMrs.baseUrl ?? "https://o2.openmrs.org/openmrs/login.htm",
          credentials: {
            username: config.openMrs.username ?? "admin",
            password: config.openMrs.password ?? "Admin123",
          },
          task: "Create or register one synthetic patient from the normalized intake record.",
          workflowHints: [...OPENMRS_WORKFLOW_HINTS],
          successCriteria: [...DEFAULT_SUCCESS_CRITERIA],
          forbiddenActions: [...DEFAULT_FORBIDDEN_ACTIONS],
          concurrency: Math.max(1, config.openMrs.concurrency),
          confidenceThreshold: config.confidenceThreshold,
        };
      case "openemr":
        return {
          name: "openemr",
          displayName: "OpenEMR",
          baseUrl: config.openEmr.baseUrl ?? "https://demo.openemr.io/openemr",
          credentials: {
            username: config.openEmr.username ?? "admin",
            password: config.openEmr.password ?? "pass",
          },
          task: "Create or register one synthetic patient from the normalized intake record.",
          workflowHints: [...OPENEMR_WORKFLOW_HINTS],
          successCriteria: [...DEFAULT_SUCCESS_CRITERIA],
          forbiddenActions: [...DEFAULT_FORBIDDEN_ACTIONS],
          concurrency: Math.max(1, config.openEmr.concurrency),
          confidenceThreshold: config.confidenceThreshold,
        };
      case "openkairo":
        return {
          name: "openkairo",
          displayName: "OpenKairo",
          baseUrl: config.openKairo.baseUrl ?? "https://ehr-app-five.vercel.app",
          credentials: {
            username: config.openKairo.username ?? "reception@demo.com",
            password: config.openKairo.password ?? "Demo123!",
          },
          task: "Create or register one synthetic patient from the normalized intake record.",
          workflowHints: [...OPENKAIRO_WORKFLOW_HINTS],
          successCriteria: [...DEFAULT_SUCCESS_CRITERIA],
          forbiddenActions: [...DEFAULT_FORBIDDEN_ACTIONS],
          concurrency: Math.max(1, config.openKairo.concurrency),
          confidenceThreshold: config.confidenceThreshold,
        };
      case "fake":
        return {
          name: "fake",
          displayName: "Local Dry Run",
          baseUrl: "local://dry-run",
          credentials: { username: "", password: "" },
          task: "Validate orchestration and audit output without entering an EMR.",
          workflowHints: [],
          successCriteria: ["The normalized record is accepted by the dry-run target."],
          forbiddenActions: [...DEFAULT_FORBIDDEN_ACTIONS],
          concurrency: 1,
        };
    }
  });
}
