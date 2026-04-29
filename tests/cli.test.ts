import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

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
        "data/demo/intake-records.json",
        "--targets",
        "fake",
        "--runs-dir",
        runsDir,
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
    await expect(readFile(join(runsDir, result.runId, "summary.md"), "utf8")).resolves.toContain("# Workflow Run");
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
        "data/demo/intake-records.json",
        "--targets",
        "fake",
        "--runs-dir",
        runsDir,
        "--synthetic-suffix",
        "case123",
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
        phone: "+13125550200",
        email: "ava.nguyen+case123@example.test",
        insuranceMemberId: "AET123456-CASE123-1",
      },
      {
        sourceRecordId: "demo-002-case123",
        lastName: "Lee Case123",
        phone: "+13125550201",
        email: "marcus.lee+case123@example.test",
      },
      {
        sourceRecordId: "demo-003-case123",
        lastName: "Shah Case123",
        phone: "+13125550202",
        email: "priya.shah+case123@example.test",
      },
    ]);
    await expect(readJson(join(runsDir, result.runId, "exceptions", "demo-missing-dob.json"))).resolves.toMatchObject({
      code: "missing_required_field",
    });
  });

  it("returns exit code 1 and prints a concise message for parse errors", async () => {
    const io = captureIo();

    const exitCode = await runCli(["node", "agentic-ui", "run", "--targets", "fake"], io);

    expect(exitCode).toBe(1);
    expect(io.stdoutText()).toBe("");
    expect(io.stderrText()).toBe("error: required option '--input <path>' not specified\n");
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

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}
