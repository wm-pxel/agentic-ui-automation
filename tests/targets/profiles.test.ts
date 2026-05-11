import { describe, expect, it } from "vitest";
import type { CliRunConfig } from "../../src/config.js";
import { buildTargetProfiles } from "../../src/targets/profiles.js";

describe("buildTargetProfiles", () => {
  const profileConfig: Pick<CliRunConfig, "targets" | "confidenceThreshold" | "openMrs" | "openKairo"> = {
    targets: ["openmrs", "openkairo", "fake"],
    confidenceThreshold: 0.99,
    openMrs: {
      baseUrl: "https://openmrs.example.test/openmrs",
      username: "admin",
      password: "secret",
      concurrency: 1,
    },
    openKairo: {
      baseUrl: "https://openkairo.example.test",
      username: "reception@example.test",
      password: "secret",
      concurrency: 1,
    },
  };

  it("builds OpenMRS and OpenKairo profiles from config", () => {
    const profiles = buildTargetProfiles({ ...profileConfig, targets: ["openmrs", "openkairo"] });

    expect(profiles.map((profile) => profile.name)).toEqual(["openmrs", "openkairo"]);
    expect(profiles[0]).toMatchObject({
      name: "openmrs",
      displayName: "OpenMRS",
      baseUrl: "https://openmrs.example.test/openmrs",
      credentials: { username: "admin", password: "secret" },
      concurrency: 1,
      confidenceThreshold: 0.99,
    });
    expect(profiles[1]).toMatchObject({
      name: "openkairo",
      displayName: "OpenKairo",
      baseUrl: "https://openkairo.example.test",
      credentials: { username: "reception@example.test", password: "secret" },
      concurrency: 1,
      confidenceThreshold: 0.99,
    });
    expect(profiles[0].task).toContain("synthetic patient");
    expect(profiles[1].task).toContain("synthetic patient");
    expect(profiles[0].workflowHints).toEqual([]);
    expect(profiles[1].workflowHints).toEqual([]);
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
