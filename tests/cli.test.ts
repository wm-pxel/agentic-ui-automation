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
      targetCounts: { fake?: { succeeded: number } };
    };
    expect(result.status).toBe("completed_with_exceptions");
    expect(result.preflightExceptions).toBe(3);
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

  it("returns exit code 1 and prints a concise message for parse errors", async () => {
    const io = captureIo();

    const exitCode = await runCli(["node", "agentic-ui", "run", "--targets", "fake"], io);

    expect(exitCode).toBe(1);
    expect(io.stdoutText()).toBe("");
    expect(io.stderrText()).toBe("error: required option '--input <path>' not specified\n");
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
