import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createArtifactService,
  type ViewerRunSummary,
} from "../../src/viewer/artifactService.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("createArtifactService", () => {
  it("lists run directories newest first with metadata from report and run JSON", async () => {
    const runsDir = await makeRunsDir();
    await writeRun(runsDir, "run-2026-05-01T15-42-33-006Z-older", {
      run: { status: "completed_with_exceptions", startedAt: "2026-05-01T15:42:33.006Z" },
      report: {
        status: "completed_with_exceptions",
        totalRecords: 7,
        counts: {
          preflightExceptions: 3,
          environmentExceptions: 1,
          closeExceptions: 0,
          targetCounts: { fake: { succeeded: 3, exception: 0, skipped: 0 } },
        },
      },
    });
    await writeRun(runsDir, "run-2026-05-02T10-00-00-000Z-newer", {
      run: { status: "completed", startedAt: "2026-05-02T10:00:00.000Z" },
      report: {
        status: "completed",
        totalRecords: 1,
        counts: {
          preflightExceptions: 0,
          environmentExceptions: 0,
          closeExceptions: 0,
          targetCounts: { openmrs: { succeeded: 1, exception: 0, skipped: 0 } },
        },
      },
    });
    await writeFile(join(runsDir, "not-a-directory.txt"), "ignore me");

    const service = createArtifactService({ runsDir });
    const runs = await service.listRuns();

    expect(runs.map((run) => run.runId)).toEqual([
      "run-2026-05-02T10-00-00-000Z-newer",
      "run-2026-05-01T15-42-33-006Z-older",
    ]);
    expect(runs[0]).toMatchObject<Partial<ViewerRunSummary>>({
      runId: "run-2026-05-02T10-00-00-000Z-newer",
      status: "completed",
      totalRecords: 1,
      preflightExceptions: 0,
      environmentExceptions: 0,
      closeExceptions: 0,
      hasExecutiveSummary: true,
      hasSummary: true,
    });
    expect(runs[1].targetCounts.fake?.succeeded).toBe(3);
  });

  it("falls back to folder-derived metadata when JSON is malformed or missing", async () => {
    const runsDir = await makeRunsDir();
    const runDir = join(runsDir, "run-2026-05-03T09-08-07-006Z-badjson");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run.json"), "{not-json");
    await writeFile(join(runDir, "summary.md"), "# Workflow Run\n");

    const service = createArtifactService({ runsDir });
    const runs = await service.listRuns();

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId: "run-2026-05-03T09-08-07-006Z-badjson",
      timestamp: "2026-05-03T09:08:07.006Z",
      hasExecutiveSummary: false,
      hasSummary: true,
    });
    expect(runs[0].status).toBeUndefined();
  });

  it("reads known Markdown files and reports missing Markdown as null", async () => {
    const runsDir = await makeRunsDir();
    await writeRun(runsDir, "run-2026-05-01T12-00-00-000Z-markdown", {
      summary: "# Full Summary\n",
      executiveSummary: "# Executive Summary\n",
    });

    const service = createArtifactService({ runsDir });

    await expect(service.readMarkdown("run-2026-05-01T12-00-00-000Z-markdown", "summary")).resolves.toEqual({
      fileName: "summary.md",
      markdown: "# Full Summary\n",
    });
    await expect(service.readMarkdown("run-2026-05-01T12-00-00-000Z-markdown", "executive-summary")).resolves.toEqual({
      fileName: "executive-summary.md",
      markdown: "# Executive Summary\n",
    });
    await expect(service.readMarkdown("run-2026-05-01T12-00-00-000Z-markdown", "unknown")).resolves.toBeNull();
  });

  it("resolves artifact files only inside the configured runs directory", async () => {
    const runsDir = await makeRunsDir();
    await writeRun(runsDir, "run-2026-05-01T12-00-00-000Z-artifacts", {
      summary: "# Summary\n",
    });
    await mkdir(join(runsDir, "run-2026-05-01T12-00-00-000Z-artifacts", "screenshots"), { recursive: true });
    await writeFile(join(runsDir, "run-2026-05-01T12-00-00-000Z-artifacts", "screenshots", "proof.png"), "png");

    const service = createArtifactService({ runsDir });
    const artifact = await service.resolveArtifact("run-2026-05-01T12-00-00-000Z-artifacts", "screenshots/proof.png");

    expect(artifact).toMatchObject({
      absolutePath: join(runsDir, "run-2026-05-01T12-00-00-000Z-artifacts", "screenshots", "proof.png"),
      contentType: "image/png",
    });
    await expect(readFile(artifact?.absolutePath ?? "", "utf8")).resolves.toBe("png");
    await expect(service.listArtifactDirectory("run-2026-05-01T12-00-00-000Z-artifacts", "screenshots")).resolves.toEqual({
      path: "screenshots",
      entries: [
        {
          name: "proof.png",
          path: "screenshots/proof.png",
          type: "file",
          url: "/api/runs/run-2026-05-01T12-00-00-000Z-artifacts/artifact/screenshots/proof.png",
        },
      ],
    });
    await expect(service.resolveArtifact("run-2026-05-01T12-00-00-000Z-artifacts", "../run.json")).resolves.toBeNull();
    await expect(service.resolveArtifact("../outside", "run.json")).resolves.toBeNull();
    await expect(service.resolveArtifact("run-2026-05-01T12-00-00-000Z-artifacts", "/etc/passwd")).resolves.toBeNull();
  });
});

async function makeRunsDir(): Promise<string> {
  const runsDir = await mkdtemp(join(tmpdir(), "agentic-ui-viewer-"));
  tempDirs.push(runsDir);
  return resolve(runsDir);
}

async function writeRun(
  runsDir: string,
  runId: string,
  options: {
    run?: Record<string, unknown>;
    report?: Record<string, unknown>;
    summary?: string;
    executiveSummary?: string;
  },
): Promise<void> {
  const runDir = join(runsDir, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "summary.md"), options.summary ?? "# Workflow Run\n");
  await writeFile(join(runDir, "executive-summary.md"), options.executiveSummary ?? "# Executive Summary\n");
  if (options.run) {
    await writeFile(join(runDir, "run.json"), `${JSON.stringify(options.run, null, 2)}\n`);
  }
  if (options.report) {
    await writeFile(join(runDir, "report.json"), `${JSON.stringify(options.report, null, 2)}\n`);
  }
}
