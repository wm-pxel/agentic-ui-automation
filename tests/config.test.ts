import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRunConfig, parseTargets } from "../src/config.js";

const ENV_KEYS = [
  "RUNS_DIR",
  "OPENMRS_BASE_URL",
  "OPENMRS_USERNAME",
  "OPENMRS_PASSWORD",
  "OPENMRS_CONCURRENCY",
  "OPENEMR_BASE_URL",
  "OPENEMR_USERNAME",
  "OPENEMR_PASSWORD",
  "OPENEMR_CONCURRENCY",
  "OPENKAIRO_BASE_URL",
  "OPENKAIRO_USERNAME",
  "OPENKAIRO_PASSWORD",
  "OPENKAIRO_CONCURRENCY",
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("parseTargets", () => {
  it("parses comma-separated target names", () => {
    expect(parseTargets("fake,openmrs,openemr,openkairo")).toEqual(["fake", "openmrs", "openemr", "openkairo"]);
  });

  it("trims whitespace around target names", () => {
    expect(parseTargets(" fake, openmrs ")).toEqual(["fake", "openmrs"]);
  });

  it("throws for invalid target names", () => {
    expect(() => parseTargets("fake,invalid")).toThrow();
  });

  it("throws for empty target segments", () => {
    expect(() => parseTargets("fake,,openmrs")).toThrow();
  });
});

describe("buildRunConfig", () => {
  it("builds a CLI run config from options", () => {
    const config = buildRunConfig({
      input: "data/demo/intake-records.json",
      targets: "fake",
      runsDir: "runs",
    });

    expect(config).toMatchObject({
      input: "data/demo/intake-records.json",
      targets: ["fake"],
      runsDir: "runs",
      parser: "openai",
    });
  });

  it("allows deterministic parsing for tests and local smoke runs", () => {
    const config = buildRunConfig({
      input: "data/demo/intake-records.json",
      targets: "fake",
      parser: "deterministic",
    });

    expect(config.parser).toBe("deterministic");
  });

  it("copies confidence threshold into the run config", () => {
    const config = buildRunConfig({
      input: "data/demo/intake-records.json",
      targets: "openmrs",
      confidenceThreshold: 0.99,
    });

    expect(config.confidenceThreshold).toBe(0.99);
  });

  it("uses fallback defaults when environment variables are unset", () => {
    const config = buildRunConfig({
      input: "data/demo/intake-records.json",
      targets: "fake",
    });

    expect(config.runsDir).toBe("runs");
  });

  it("keeps OpenMRS, OpenEMR, and OpenKairo config available for target profiles", () => {
    const config = buildRunConfig({
      input: "data/demo/intake-records.json",
      targets: "openmrs,openemr,openkairo",
    });

    expect(config.targets).toEqual(["openmrs", "openemr", "openkairo"]);
    expect(config.openMrs.baseUrl).toBe("https://o2.openmrs.org/openmrs/login.htm");
    expect(config.openEmr.baseUrl).toBe("https://demo.openemr.io/openemr");
    expect(config.openKairo.baseUrl).toBe("https://ehr-app-five.vercel.app");
  });

  it("uses environment defaults when options omit paths", () => {
    process.env.RUNS_DIR = "tmp/runs";

    const config = buildRunConfig({
      input: "data/demo/intake-records.json",
      targets: "fake",
    });

    expect(config.runsDir).toBe("tmp/runs");
  });

  it("copies OpenMRS environment variables into the config", () => {
    process.env.OPENMRS_BASE_URL = "https://openmrs.example.test";
    process.env.OPENMRS_USERNAME = "admin";
    process.env.OPENMRS_PASSWORD = "secret";
    process.env.OPENMRS_CONCURRENCY = "3";

    const config = buildRunConfig({
      input: "data/demo/intake-records.json",
      targets: "openmrs",
    });

    expect(config.openMrs).toEqual({
      baseUrl: "https://openmrs.example.test",
      username: "admin",
      password: "secret",
      concurrency: 3,
    });
  });

  it("copies OpenEMR defaults and environment variables into the config", () => {
    const defaultConfig = buildRunConfig({
      input: "data/demo/intake-records.json",
      targets: "openemr",
    });

    expect(defaultConfig.openEmr).toEqual({
      baseUrl: "https://demo.openemr.io/openemr",
      username: "admin",
      password: "pass",
      concurrency: 1,
    });

    process.env.OPENEMR_BASE_URL = "https://openemr.example.test/openemr";
    process.env.OPENEMR_USERNAME = "operator";
    process.env.OPENEMR_PASSWORD = "secret";
    process.env.OPENEMR_CONCURRENCY = "2";

    const envConfig = buildRunConfig({
      input: "data/demo/intake-records.json",
      targets: "openemr",
    });

    expect(envConfig.openEmr).toEqual({
      baseUrl: "https://openemr.example.test/openemr",
      username: "operator",
      password: "secret",
      concurrency: 2,
    });
  });

  it("copies OpenKairo defaults and environment variables into the config", () => {
    const defaultConfig = buildRunConfig({
      input: "data/demo/intake-records.json",
      targets: "openkairo",
    });

    expect(defaultConfig.openKairo).toEqual({
      baseUrl: "https://ehr-app-five.vercel.app",
      username: "reception@demo.com",
      password: "Demo123!",
      concurrency: 1,
    });

    process.env.OPENKAIRO_BASE_URL = "https://openkairo.example.test";
    process.env.OPENKAIRO_USERNAME = "demo@example.test";
    process.env.OPENKAIRO_PASSWORD = "secret";
    process.env.OPENKAIRO_CONCURRENCY = "2";

    const envConfig = buildRunConfig({
      input: "data/demo/intake-records.json",
      targets: "openkairo",
    });

    expect(envConfig.openKairo).toEqual({
      baseUrl: "https://openkairo.example.test",
      username: "demo@example.test",
      password: "secret",
      concurrency: 2,
    });
  });

  it("uses explicit OpenMRS concurrency before environment defaults", () => {
    process.env.OPENMRS_CONCURRENCY = "3";

    const config = buildRunConfig({
      input: "data/demo/intake-records.json",
      targets: "openmrs",
      openMrsConcurrency: 4,
    });

    expect(config.openMrs.concurrency).toBe(4);
  });

  it("defaults OpenMRS concurrency to 1", () => {
    const config = buildRunConfig({
      input: "data/demo/intake-records.json",
      targets: "openmrs",
    });

    expect(config.openMrs.concurrency).toBe(1);
  });

});
