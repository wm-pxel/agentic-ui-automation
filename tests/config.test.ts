import { describe, expect, it } from "vitest";
import { buildRunConfig, parseTargets } from "../src/config.js";

describe("parseTargets", () => {
  it("parses comma-separated target names", () => {
    expect(parseTargets("fake,openemr,excel")).toEqual(["fake", "openemr", "excel"]);
  });
});

describe("buildRunConfig", () => {
  it("builds a CLI run config from options", () => {
    const config = buildRunConfig({
      input: "data/demo/intake-records.json",
      target: "fake",
      runsDir: "runs",
      excelWorkbookPath: "runs/intake-workbook.xlsx",
    });

    expect(config).toMatchObject({
      input: "data/demo/intake-records.json",
      targets: ["fake"],
      runsDir: "runs",
      agent: "scripted",
      excelWorkbookPath: "runs/intake-workbook.xlsx",
    });
  });
});
