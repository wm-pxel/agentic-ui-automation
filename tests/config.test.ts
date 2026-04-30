import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRunConfig, parseTargets } from "../src/config.js";

const ENV_KEYS = [
  "RUNS_DIR",
  "OPENEMR_BASE_URL",
  "OPENEMR_USERNAME",
  "OPENEMR_PASSWORD",
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
    expect(parseTargets("fake,openemr")).toEqual(["fake", "openemr"]);
  });

  it("trims whitespace around target names", () => {
    expect(parseTargets(" fake, openemr ")).toEqual(["fake", "openemr"]);
  });

  it("throws for invalid target names", () => {
    expect(() => parseTargets("fake,invalid")).toThrow();
  });

  it("throws for empty target segments", () => {
    expect(() => parseTargets("fake,,openemr")).toThrow();
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

  it("copies OpenEMR environment variables into the config", () => {
    process.env.OPENEMR_BASE_URL = "https://openemr.example.test";
    process.env.OPENEMR_USERNAME = "admin";
    process.env.OPENEMR_PASSWORD = "secret";

    const config = buildRunConfig({
      input: "data/demo/intake-records.json",
      targets: "openemr",
    });

    expect(config.openEmr).toEqual({
      baseUrl: "https://openemr.example.test",
      username: "admin",
      password: "secret",
    });
  });
});
