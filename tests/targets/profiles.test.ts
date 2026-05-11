import { describe, expect, it } from "vitest";
import type { CliRunConfig } from "../../src/config.js";
import { buildTargetProfiles } from "../../src/targets/profiles.js";

describe("buildTargetProfiles", () => {
  const profileConfig: Pick<CliRunConfig, "targets" | "confidenceThreshold" | "openMrs" | "openEmr" | "openKairo"> = {
    targets: ["openmrs", "openemr", "openkairo", "fake"],
    confidenceThreshold: 0.99,
    openMrs: {
      baseUrl: "https://openmrs.example.test/openmrs",
      username: "admin",
      password: "secret",
      concurrency: 1,
    },
    openEmr: {
      baseUrl: "https://openemr.example.test/openemr",
      username: "operator",
      password: "pass",
      concurrency: 1,
    },
    openKairo: {
      baseUrl: "https://openkairo.example.test",
      username: "reception@example.test",
      password: "secret",
      concurrency: 1,
    },
  };

  it("builds OpenMRS, OpenEMR, and OpenKairo profiles from config", () => {
    const profiles = buildTargetProfiles({ ...profileConfig, targets: ["openmrs", "openemr", "openkairo"] });

    expect(profiles.map((profile) => profile.name)).toEqual(["openmrs", "openemr", "openkairo"]);
    expect(profiles[0]).toMatchObject({
      name: "openmrs",
      displayName: "OpenMRS",
      baseUrl: "https://openmrs.example.test/openmrs",
      credentials: { username: "admin", password: "secret" },
      concurrency: 1,
      confidenceThreshold: 0.99,
    });
    expect(profiles[1]).toMatchObject({
      name: "openemr",
      displayName: "OpenEMR",
      baseUrl: "https://openemr.example.test/openemr",
      credentials: { username: "operator", password: "pass" },
      concurrency: 1,
      confidenceThreshold: 0.99,
    });
    expect(profiles[2]).toMatchObject({
      name: "openkairo",
      displayName: "OpenKairo",
      baseUrl: "https://openkairo.example.test",
      credentials: { username: "reception@example.test", password: "secret" },
      concurrency: 1,
      confidenceThreshold: 0.99,
    });
    expect(profiles[0].task).toContain("synthetic patient");
    expect(profiles[1].task).toContain("synthetic patient");
    expect(profiles[2].task).toContain("synthetic patient");
    expect(profiles[0].workflowHints).toContain(
      "If a login session location is required, choose Registration Desk when visible; otherwise choose Outpatient Clinic before confirming the location.",
    );
    expect(profiles[0].workflowHints).toContain(
      "The OpenMRS wizard's blank green right-arrow control is the forward/next button and may be labeled forward next button or next-button; do not use the left-arrow previous/back button.",
    );
    expect(profiles[0].workflowHints).toContain(
      "In OpenMRS, date of birth may be split into day, month, and year fields; fill all visible birthdate parts before clicking any save, register, or confirm control.",
    );
    expect(profiles[0].workflowHints.join(" ")).not.toContain("address step");
    expect(profiles[0].workflowHints.join(" ")).not.toContain("streetAddress");
    expect(profiles[0].workflowHints.join(" ")).not.toContain("stateProvince");
    expect(profiles[0].workflowHints.join(" ")).not.toContain("postalCode");
    expect(profiles[0].workflowHints.join(" ")).not.toContain("normalized state");
    expect(profiles[0].workflowHints.join(" ")).not.toContain("normalized zip");
    expect(profiles[0].workflowHints).not.toContain(
      "After name, gender, and birthdate are complete, skip optional address, phone, and relationship steps with the forward/next control unless required fields are visible.",
    );
    expect(profiles[1].workflowHints).toContain(
      "If Patient Finder reports no matching records and Add New Patient is visible, click Add New Patient rather than repeating search.",
    );
    expect(profiles[2].workflowHints).toContain("Click Create Patient only after required visible fields are filled.");
    expect(profiles[0].forbiddenActions).toContain("Do not delete patients.");
    expect(profiles[1].successCriteria).toContain("A saved patient detail page or dashboard is visible.");
  });

  it("builds a fake profile for local dry runs", () => {
    const profiles = buildTargetProfiles({ ...profileConfig, targets: ["fake"] });

    expect(profiles).toEqual([
      {
        name: "fake",
        displayName: "Local Dry Run",
        baseUrl: "local://dry-run",
        credentials: { username: "", password: "" },
        task: "Validate orchestration and audit output without entering an EMR.",
        workflowHints: [],
        successCriteria: ["The normalized record is accepted by the dry-run target."],
        forbiddenActions: [
          "Do not delete patients.",
          "Do not change admin settings.",
          "Do not use real patient data.",
          "Do not export patient lists or unrelated records.",
        ],
        concurrency: 1,
      },
    ]);
  });

  it("keeps profile criteria and forbidden action arrays isolated from mutations", () => {
    const profiles = buildTargetProfiles(profileConfig);

    profiles[0].successCriteria.push("Mutated criterion.");
    profiles[0].forbiddenActions.push("Mutated forbidden action.");
    profiles[0].workflowHints.push("Mutated hint.");

    expect(profiles[1].successCriteria).not.toContain("Mutated criterion.");
    expect(profiles[1].forbiddenActions).not.toContain("Mutated forbidden action.");
    expect(profiles[1].workflowHints).not.toContain("Mutated hint.");
    expect(profiles[2].forbiddenActions).not.toContain("Mutated forbidden action.");

    const nextProfiles = buildTargetProfiles({ ...profileConfig, targets: ["openmrs"] });

    expect(nextProfiles[0].successCriteria).not.toContain("Mutated criterion.");
    expect(nextProfiles[0].forbiddenActions).not.toContain("Mutated forbidden action.");
    expect(nextProfiles[0].workflowHints).not.toContain("Mutated hint.");
  });
});
