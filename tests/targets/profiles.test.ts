import { describe, expect, it } from "vitest";
import { buildTargetProfiles } from "../../src/targets/profiles.js";

describe("buildTargetProfiles", () => {
  it("builds OpenMRS and OpenEMR profiles from config", () => {
    const profiles = buildTargetProfiles({
      targets: ["openmrs", "openemr"],
      openMrs: {
        baseUrl: "https://openmrs.example.test/openmrs",
        username: "admin",
        password: "secret",
        concurrency: 1,
        interactiveFieldConfirmation: false,
        fieldConfidenceThreshold: 0.8,
      },
      openEmr: {
        baseUrl: "https://openemr.example.test/openemr",
        username: "operator",
        password: "pass",
        concurrency: 1,
      },
    });

    expect(profiles.map((profile) => profile.name)).toEqual(["openmrs", "openemr"]);
    expect(profiles[0]).toMatchObject({
      name: "openmrs",
      displayName: "OpenMRS",
      baseUrl: "https://openmrs.example.test/openmrs",
      credentials: { username: "admin", password: "secret" },
      concurrency: 1,
    });
    expect(profiles[1]).toMatchObject({
      name: "openemr",
      displayName: "OpenEMR",
      baseUrl: "https://openemr.example.test/openemr",
      credentials: { username: "operator", password: "pass" },
      concurrency: 1,
    });
    expect(profiles[0].task).toContain("synthetic patient");
    expect(profiles[1].task).toContain("synthetic patient");
    expect(profiles[0].forbiddenActions).toContain("Do not delete patients.");
    expect(profiles[1].successCriteria).toContain("A saved patient detail page or dashboard is visible.");
  });
});
