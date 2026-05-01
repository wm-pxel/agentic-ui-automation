import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRunConfig, parseTargets } from "../src/config.js";

const ENV_KEYS = [
  "RUNS_DIR",
  "OPENMRS_BASE_URL",
  "OPENMRS_USERNAME",
  "OPENMRS_PASSWORD",
  "OPENMRS_CONCURRENCY",
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
    expect(parseTargets("fake,openmrs")).toEqual(["fake", "openmrs"]);
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
      agent: "scripted",
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

  it("uses fallback defaults when environment variables are unset", () => {
    const config = buildRunConfig({
      input: "data/demo/intake-records.json",
      targets: "fake",
    });

    expect(config.runsDir).toBe("runs");
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

  it("uses explicit OpenMRS concurrency before environment defaults", () => {
    process.env.OPENMRS_CONCURRENCY = "3";

    const config = buildRunConfig({
      input: "data/demo/intake-records.json",
      targets: "openmrs",
      openMrsConcurrency: 4,
    });

    expect(config.openMrs.concurrency).toBe(4);
  });
});
