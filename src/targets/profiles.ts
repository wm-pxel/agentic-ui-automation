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
  successCriteria: string[];
  forbiddenActions: string[];
  concurrency: number;
}

type ProfileConfig = Pick<CliRunConfig, "targets" | "openMrs" | "openEmr">;

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

export function buildTargetProfiles(config: ProfileConfig): TargetProfile[] {
  return config.targets.map((target) => {
    switch (target) {
      case "openmrs":
        return {
          name: "openmrs",
          displayName: "OpenMRS",
          baseUrl: config.openMrs.baseUrl ?? "https://o2.openmrs.org/openmrs",
          credentials: {
            username: config.openMrs.username ?? "admin",
            password: config.openMrs.password ?? "Admin123",
          },
          task: "Create or register one synthetic patient from the normalized intake record.",
          successCriteria: [...DEFAULT_SUCCESS_CRITERIA],
          forbiddenActions: [...DEFAULT_FORBIDDEN_ACTIONS],
          concurrency: Math.max(1, config.openMrs.concurrency),
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
          successCriteria: [...DEFAULT_SUCCESS_CRITERIA],
          forbiddenActions: [...DEFAULT_FORBIDDEN_ACTIONS],
          concurrency: Math.max(1, config.openEmr.concurrency),
        };
      case "fake":
        return {
          name: "fake",
          displayName: "Local Dry Run",
          baseUrl: "local://dry-run",
          credentials: { username: "", password: "" },
          task: "Validate orchestration and audit output without entering an EMR.",
          successCriteria: ["The normalized record is accepted by the dry-run target."],
          forbiddenActions: [...DEFAULT_FORBIDDEN_ACTIONS],
          concurrency: 1,
        };
    }
  });
}
