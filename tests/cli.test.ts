import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { writeIntakeHandoff } from "../src/handoff/intakeHandoff.js";
import type { AiWebTargetResult, AiWebTargetRunContext } from "../src/targets/aiWebTargetRunner.js";
import type { TargetProfile } from "../src/targets/profiles.js";
import type { ViewerServer } from "../src/viewer/server.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("runCli", () => {
  it("runs the fake target and prints the workflow result as JSON", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "agentic-ui-cli-"));
    tempDirs.push(runsDir);
    const io = captureIo();

    const exitCode = await runCli(
      [
        "node",
        "agentic-ui",
        "run",
        "--input",
        "data/demo/intake-records-normalized.json",
        "--targets",
        "fake",
        "--runs-dir",
        runsDir,
        "--parser",
        "deterministic",
      ],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe("");
    const result = JSON.parse(io.stdoutText()) as {
      runId: string;
      status: string;
      preflightExceptions: number;
      environmentExceptions: number;
      closeExceptions: number;
      targetCounts: { fake?: { succeeded: number } };
    };
    expect(result.status).toBe("completed_with_exceptions");
    expect(result.preflightExceptions).toBe(3);
    expect(result.environmentExceptions).toBe(0);
    expect(result.closeExceptions).toBe(0);
    expect(result.targetCounts.fake?.succeeded).toBe(3);

    await expect(readJson(join(runsDir, result.runId, "run.json"))).resolves.toMatchObject({
      status: "completed_with_exceptions",
      preflightExceptions: 3,
    });
    await expect(readFile(join(runsDir, result.runId, "events.jsonl"), "utf8")).resolves.toContain(
      "workflow run started",
    );
    await expect(readFile(join(runsDir, result.runId, "summary.md"), "utf8")).resolves.toContain(
      "# Fake Target Workflow Run",
    );
    await expect(readJson(join(runsDir, result.runId, "input", "normalized-records.json"))).resolves.toHaveLength(3);
    await expect(readJson(join(runsDir, result.runId, "exceptions", "demo-invalid-phone.json"))).resolves.toMatchObject({
      code: "invalid_format",
    });
  });

  it("applies a synthetic suffix to valid source records before running targets", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "agentic-ui-cli-synthetic-"));
    tempDirs.push(runsDir);
    const io = captureIo();

    const exitCode = await runCli(
      [
        "node",
        "agentic-ui",
        "run",
        "--input",
        "data/demo/intake-records-normalized.json",
        "--targets",
        "fake",
        "--runs-dir",
        runsDir,
        "--synthetic-suffix",
        "case123",
        "--parser",
        "deterministic",
      ],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe("");
    const result = JSON.parse(io.stdoutText()) as {
      runId: string;
      preflightExceptions: number;
      targetCounts: { fake?: { succeeded: number } };
    };
    expect(result.preflightExceptions).toBe(3);
    expect(result.targetCounts.fake?.succeeded).toBe(3);

    await expect(readJson(join(runsDir, result.runId, "input", "normalized-records.json"))).resolves.toMatchObject([
      {
        sourceRecordId: "demo-001-case123",
        firstName: "Ava",
        lastName: "Nguyen Case123",
        phone: "+13125553562",
        email: "ava.nguyen+case123@example.test",
        insuranceMemberId: "AET123456-CASE123-1",
      },
      {
        sourceRecordId: "demo-002-case123",
        lastName: "Lee Case123",
        phone: "+13125553563",
        email: "marcus.lee+case123@example.test",
      },
      {
        sourceRecordId: "demo-003-case123",
        lastName: "Shah Case123",
        phone: "+13125553564",
        email: "priya.shah+case123@example.test",
      },
    ]);
    await expect(readJson(join(runsDir, result.runId, "exceptions", "demo-missing-dob.json"))).resolves.toMatchObject({
      code: "missing_required_field",
    });
  });

  it("runs the severity-level demo input and writes error, warning, and info issues", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "agentic-ui-cli-severity-"));
    tempDirs.push(runsDir);
    const io = captureIo();

    const exitCode = await runCli(
      [
        "node",
        "agentic-ui",
        "run",
        "--input",
        "data/demo/intake-records-severity-levels.json",
        "--targets",
        "fake",
        "--runs-dir",
        runsDir,
        "--parser",
        "deterministic",
      ],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe("");
    const result = JSON.parse(io.stdoutText()) as {
      runId: string;
      status: string;
      preflightExceptions: number;
      targetCounts: { fake?: { succeeded: number } };
    };
    expect(result.status).toBe("completed_with_exceptions");
    expect(result.preflightExceptions).toBe(1);
    expect(result.targetCounts.fake?.succeeded).toBe(1);

    const report = await readJson(join(runsDir, result.runId, "report.json")) as {
      details: { issues: Array<Record<string, unknown>> };
    };
    expect(report.details.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordId: "severity-error-missing-dob",
          severity: "error",
          exceptionCode: "missing_required_field",
        }),
        expect.objectContaining({
          recordId: "severity-warning-info",
          severity: "warning",
          phase: "extraction",
          message: "Insurance member ID came from a low-quality source note.",
        }),
        expect.objectContaining({
          recordId: "severity-warning-info",
          severity: "info",
          phase: "extraction",
          message: "Preferred contact method was inferred from appointment notes.",
        }),
      ]),
    );

    const executiveSummary = await readFile(join(runsDir, result.runId, "executive-summary.md"), "utf8");
    expect(executiveSummary).toContain("| error | severity-error-missing-dob |");
    expect(executiveSummary).toContain("| warning | severity-warning-info |");
    expect(executiveSummary).toContain("| info | severity-warning-info |");
  });

  it.each(["openmrs", "openemr"] as const)(
    "runs %s through the injected generic target runner path",
    async (target) => {
      const runsDir = await mkdtemp(join(tmpdir(), `agentic-ui-cli-${target}-`));
      tempDirs.push(runsDir);
      const io = captureIo();
      const runner = new FakeTargetRunner();
      const factoryCalls: Array<{ profiles: TargetProfile[] }> = [];

      const exitCode = await runCli(
        [
          "node",
          "agentic-ui",
          "run",
          "--input",
          "data/demo/intake-records-normalized.json",
          "--targets",
          target,
          "--runs-dir",
          runsDir,
          "--parser",
          "deterministic",
          "--confidence-threshold",
          ".99",
          "--field-confirmation",
          "prompt-on-low-confidence",
        ],
        io,
        {
          buildTargetRunner: ({ profiles }) => {
            factoryCalls.push({ profiles });
            return runner;
          },
        },
      );

      expect(exitCode).toBe(0);
      expect(io.stderrText()).toBe("");
      expect(factoryCalls).toHaveLength(1);
      expect(factoryCalls[0]?.profiles.map((profile) => profile.name)).toEqual([target]);
      expect(factoryCalls[0]?.profiles[0]?.confidenceThreshold).toBe(0.99);
      expect(factoryCalls[0]?.profiles[0]?.fieldConfirmation).toBe("prompt-on-low-confidence");
      expect(runner.runProfiles).toEqual([target, target, target]);
      const result = JSON.parse(io.stdoutText()) as {
        targetCounts: Record<string, { succeeded: number; exception: number; skipped: number }>;
      };
      expect(result.targetCounts[target]).toEqual({ succeeded: 3, exception: 0, skipped: 0 });
    },
  );

  it("routes fake profiles through dry-run and non-fake profiles through the default AI runner in mixed runs", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "agentic-ui-cli-mixed-"));
    tempDirs.push(runsDir);
    const io = captureIo();
    const aiRunner = new FakeTargetRunner();
    let aiRunnerBuilds = 0;

    const exitCode = await runCli(
      [
        "node",
        "agentic-ui",
        "run",
        "--input",
        "data/demo/intake-records-normalized.json",
        "--targets",
        "fake,openmrs",
        "--runs-dir",
        runsDir,
        "--parser",
        "deterministic",
      ],
      io,
      {
        buildAiTargetRunner: () => {
          aiRunnerBuilds += 1;
          return aiRunner;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe("");
    expect(aiRunnerBuilds).toBe(1);
    expect(aiRunner.runProfiles).toEqual(["openmrs", "openmrs", "openmrs"]);

    const result = JSON.parse(io.stdoutText()) as {
      runId: string;
      targetCounts: Record<string, { succeeded: number; exception: number; skipped: number }>;
    };
    expect(result.targetCounts.fake).toEqual({ succeeded: 3, exception: 0, skipped: 0 });
    expect(result.targetCounts.openmrs).toEqual({ succeeded: 3, exception: 0, skipped: 0 });
    await expect(readFile(join(runsDir, result.runId, "events.jsonl"), "utf8")).resolves.toContain(
      "dry run accepted",
    );
  });

  it("returns exit code 1 and prints a concise message for parse errors", async () => {
    const io = captureIo();

    const exitCode = await runCli(["node", "agentic-ui", "run", "--targets", "fake"], io);

    expect(exitCode).toBe(1);
    expect(io.stdoutText()).toBe("");
    expect(io.stderrText()).toBe("error: required option '--input <path>' not specified\n");
  });

  it.each([
    ["run", ["run", "--input", "data/demo/intake-records-normalized.json", "--agent", "scripted"]],
    ["watch", ["watch", "--once", "--agent", "scripted"]],
  ] as const)("rejects removed --agent option on %s", async (_command, args) => {
    const io = captureIo();

    const exitCode = await runCli(["node", "agentic-ui", ...args], io);

    expect(exitCode).toBe(1);
    expect(io.stdoutText()).toBe("");
    expect(io.stderrText()).toContain("unknown option '--agent'");
  });

  it("rejects removed OpenMRS field confirmation options", async () => {
    const io = captureIo();

    const exitCode = await runCli(
      [
        "node",
        "agentic-ui",
        "run",
        "--input",
        "data/demo/intake-records-normalized.json",
        "--targets",
        "fake",
        "--parser",
        "deterministic",
        "--openmrs-interactive-field-confirmation",
      ],
      io,
    );

    expect(exitCode).toBe(1);
    expect(io.stdoutText()).toBe("");
    expect(io.stderrText()).toContain("unknown option '--openmrs-interactive-field-confirmation'");
  });

  it("reports the OpenEMR concurrency option name when its value is invalid", async () => {
    const io = captureIo();

    const exitCode = await runCli(
      [
        "node",
        "agentic-ui",
        "run",
        "--input",
        "data/demo/intake-records-normalized.json",
        "--targets",
        "openemr",
        "--parser",
        "deterministic",
        "--openemr-concurrency",
        "0",
      ],
      io,
    );

    expect(exitCode).toBe(1);
    expect(io.stdoutText()).toBe("");
    expect(io.stderrText()).toContain("--openemr-concurrency must be a positive integer.");
  });

  it.each([
    ["run", ["run", "--input", "data/demo/intake-records-normalized.json", "--confidence-threshold", "1.1"]],
    ["watch", ["watch", "--once", "--confidence-threshold", "-0.1"]],
  ] as const)("rejects invalid confidence threshold values on %s", async (_command, args) => {
    const io = captureIo();

    const exitCode = await runCli(["node", "agentic-ui", ...args], io);

    expect(exitCode).toBe(1);
    expect(io.stdoutText()).toBe("");
    expect(io.stderrText()).toContain("--confidence-threshold must be a number from 0 through 1.");
  });

  it.each([
    ["run", ["run", "--input", "data/demo/intake-records-normalized.json", "--field-confirmation", "always"]],
    ["watch", ["watch", "--once", "--field-confirmation", "always"]],
  ] as const)("rejects invalid field confirmation modes on %s", async (_command, args) => {
    const io = captureIo();

    const exitCode = await runCli(["node", "agentic-ui", ...args], io);

    expect(exitCode).toBe(1);
    expect(io.stdoutText()).toBe("");
    expect(io.stderrText()).toContain("Allowed choices are auto, prompt-on-low-confidence.");
  });

  it("requires an OpenAI API key for default non-fake target runs", async () => {
    const io = captureIo();
    const originalApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const exitCode = await runCli(
        [
          "node",
          "agentic-ui",
          "run",
          "--input",
          "data/demo/intake-records-normalized.json",
          "--targets",
          "openmrs",
          "--parser",
          "deterministic",
        ],
        io,
      );

      expect(exitCode).toBe(1);
      expect(io.stdoutText()).toBe("");
      expect(io.stderrText()).toContain("OPENAI_API_KEY is required when running non-fake targets with the AI web planner.");
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }
    }
  });

  it("starts the viewer command with default runs directory and port", async () => {
    const io = captureIo();
    const calls: Array<{ runsDir: string; port?: number }> = [];
    const exitCode = await runCli(["node", "agentic-ui", "viewer"], io, {
      startViewerServer: async (options) => {
        calls.push({ runsDir: options.runsDir, port: options.port });
        options.stdout?.write("Viewer available at http://127.0.0.1:4173\n");
        return fakeViewerServer();
      },
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([{ runsDir: "runs", port: undefined }]);
    expect(io.stdoutText()).toBe("Viewer available at http://127.0.0.1:4173\n");
    expect(io.stderrText()).toBe("");
  });

  it("starts the viewer command with a custom runs directory and port", async () => {
    const io = captureIo();
    const calls: Array<{ runsDir: string; port?: number }> = [];
    const exitCode = await runCli(
      ["node", "agentic-ui", "viewer", "--runs-dir", "custom-runs", "--port", "4555"],
      io,
      {
        startViewerServer: async (options) => {
          calls.push({ runsDir: options.runsDir, port: options.port });
          return fakeViewerServer();
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([{ runsDir: "custom-runs", port: 4555 }]);
    expect(io.stderrText()).toBe("");
  });

  it("allows port zero so the viewer can use an available ephemeral port", async () => {
    const io = captureIo();
    const calls: Array<{ runsDir: string; port?: number }> = [];
    const exitCode = await runCli(["node", "agentic-ui", "viewer", "--port", "0"], io, {
      startViewerServer: async (options) => {
        calls.push({ runsDir: options.runsDir, port: options.port });
        return fakeViewerServer();
      },
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([{ runsDir: "runs", port: 0 }]);
    expect(io.stderrText()).toBe("");
  });

  it("rejects invalid viewer ports", async () => {
    const io = captureIo();

    const exitCode = await runCli(["node", "agentic-ui", "viewer", "--port", "-1"], io, {
      startViewerServer: async () => fakeViewerServer(),
    });

    expect(exitCode).toBe(1);
    expect(io.stdoutText()).toBe("");
    expect(io.stderrText()).toContain("--port must be zero or a positive integer.");
  });

  it("processes ready intake exports with the watch command in once mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentic-ui-cli-watch-"));
    tempDirs.push(root);
    const inbox = join(root, "inbox");
    const runsDir = join(root, "runs");
    await writeIntakeHandoff({
      inbox,
      records: [
        {
          sourceRecordId: "cli-watch-001",
          firstName: "Ava",
          lastName: "Nguyen",
          dateOfBirth: "1987-03-14",
          sexOrGender: "female",
          phone: "312-555-0198",
          email: "ava.nguyen@example.test",
          streetAddress: "1200 West Lake Street",
          city: "Chicago",
          state: "IL",
          zip: "60607",
          insurancePayer: "Aetna",
          insuranceMemberId: "AET123456",
          reasonForVisit: "Annual wellness visit",
          preferredContactMethod: "phone",
          sourceFormat: "json",
          rawSourceExcerpt: "cli-watch-001",
        },
      ],
    });
    const io = captureIo();

    const exitCode = await runCli(
      [
        "node",
        "agentic-ui",
        "watch",
        "--once",
        "--inbox",
        inbox,
        "--targets",
        "fake",
        "--runs-dir",
        runsDir,
      ],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe("");
    const result = JSON.parse(io.stdoutText()) as { status: string; run?: { runId: string } };
    expect(result.status).toBe("processed");
    await expect(readJson(join(runsDir, result.run?.runId ?? "", "run.json"))).resolves.toMatchObject({
      status: "completed",
      targetCounts: {
        fake: {
          succeeded: 1,
        },
      },
    });
  });

  it("defaults watch runs to an automatic synthetic suffix", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentic-ui-cli-watch-suffix-"));
    tempDirs.push(root);
    const inbox = join(root, "inbox");
    const runsDir = join(root, "runs");
    await writeIntakeHandoff({
      inbox,
      records: [
        {
          sourceRecordId: "cli-watch-suffix-001",
          firstName: "Ava",
          lastName: "Nguyen",
          dateOfBirth: "1987-03-14",
          sexOrGender: "female",
          phone: "312-555-0198",
          email: "ava.nguyen@example.test",
          streetAddress: "1200 West Lake Street",
          city: "Chicago",
          state: "IL",
          zip: "60607",
          insurancePayer: "Aetna",
          insuranceMemberId: "AET123456",
          reasonForVisit: "Annual wellness visit",
          preferredContactMethod: "phone",
          sourceFormat: "json",
          rawSourceExcerpt: "cli-watch-suffix-001",
        },
      ],
    });
    const io = captureIo();

    const exitCode = await runCli(
      [
        "node",
        "agentic-ui",
        "watch",
        "--once",
        "--inbox",
        inbox,
        "--targets",
        "fake",
        "--runs-dir",
        runsDir,
      ],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe("");
    const result = JSON.parse(io.stdoutText()) as { status: string; run?: { runId: string } };
    expect(result.status).toBe("processed");
    const normalized = (await readJson(
      join(runsDir, result.run?.runId ?? "", "input", "normalized-records.json"),
    )) as Array<{ sourceRecordId: string; lastName: string; email: string; insuranceMemberId: string }>;
    expect(normalized[0]?.sourceRecordId).toMatch(/^cli-watch-suffix-001-run-\d{14}-[a-f0-9]{5}$/);
    expect(normalized[0]?.lastName).toMatch(/^Nguyen Run-\d{14}-[a-f0-9]{5}$/);
    expect(normalized[0]?.email).toMatch(/^ava\.nguyen\+run-\d{14}-[a-f0-9]{5}@example\.test$/);
    expect(normalized[0]?.insuranceMemberId).toMatch(/^AET123456-RUN-\d{14}-[A-F0-9]{5}-1$/);
  });

  it("defaults to AI parsing and fails clearly without an OpenAI API key", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "agentic-ui-cli-openai-required-"));
    tempDirs.push(runsDir);
    const io = captureIo();
    const originalApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const exitCode = await runCli(
        [
          "node",
          "agentic-ui",
          "run",
          "--input",
          "data/demo/intake-records-normalized.json",
          "--targets",
          "fake",
          "--runs-dir",
          runsDir,
        ],
        io,
      );

      expect(exitCode).toBe(1);
      expect(io.stdoutText()).toBe("");
      expect(io.stderrText()).toContain("OPENAI_API_KEY is required when --parser openai is used.");
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }
    }
  });

  it("prints command help for no-argument invocation", async () => {
    const io = captureIo();

    const exitCode = await runCli(["node", "agentic-ui"], io);

    expect(exitCode).toBe(1);
    expect(io.stdoutText()).toBe("");
    expect(io.stderrText()).toContain("Usage: agentic-ui");
    expect(io.stderrText()).not.toContain("(outputHelp)");
  });
});

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout: {
      write: (chunk: string) => {
        stdout.push(chunk);
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderr.push(chunk);
      },
    },
    stdoutText: () => stdout.join(""),
    stderrText: () => stderr.join(""),
  };
}

function fakeViewerServer(): ViewerServer {
  return {
    listen: async () => undefined,
    close: async () => undefined,
    url: () => "http://127.0.0.1:4173",
  };
}

class FakeTargetRunner {
  readonly runProfiles: string[] = [];

  async prepare(_profiles: TargetProfile[], _plannedRecords: number): Promise<void> {}

  async runRecord(context: AiWebTargetRunContext): Promise<AiWebTargetResult> {
    this.runProfiles.push(context.profile.name);
    return { status: "succeeded" };
  }

  async close(): Promise<void> {}
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}
