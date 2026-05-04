import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

  it("falls back to run JSON for counts when report JSON is absent", async () => {
    const runsDir = await makeRunsDir();
    await writeRun(runsDir, "run-2026-05-04T08-00-00-000Z-runjson", {
      run: {
        status: "completed_with_exceptions",
        startedAt: "2026-05-04T08:00:00.000Z",
        totalRecords: 9,
        preflightExceptions: 2,
        environmentExceptions: 1,
        closeExceptions: 4,
        targetCounts: { openmrs: { succeeded: 5, exception: 2, skipped: 1 } },
      },
    });

    const service = createArtifactService({ runsDir });
    const runs = await service.listRuns();

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject<Partial<ViewerRunSummary>>({
      runId: "run-2026-05-04T08-00-00-000Z-runjson",
      status: "completed_with_exceptions",
      timestamp: "2026-05-04T08:00:00.000Z",
      totalRecords: 9,
      preflightExceptions: 2,
      environmentExceptions: 1,
      closeExceptions: 4,
    });
    expect(runs[0].targetCounts.openmrs).toEqual({ succeeded: 5, exception: 2, skipped: 1 });
  });

  it("falls back to run JSON for counts when report JSON is malformed", async () => {
    const runsDir = await makeRunsDir();
    const runDir = join(runsDir, "run-2026-05-04T09-00-00-000Z-badreport");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "run.json"),
      `${JSON.stringify(
        {
          totalRecords: 3,
          preflightExceptions: 0,
          environmentExceptions: 1,
          closeExceptions: 0,
          targetCounts: { fake: { succeeded: 2, exception: 1, skipped: 0 } },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(runDir, "report.json"), "{not-json");

    const service = createArtifactService({ runsDir });
    const runs = await service.listRuns();

    expect(runs[0]).toMatchObject<Partial<ViewerRunSummary>>({
      totalRecords: 3,
      preflightExceptions: 0,
      environmentExceptions: 1,
      closeExceptions: 0,
    });
    expect(runs[0].targetCounts.fake).toEqual({ succeeded: 2, exception: 1, skipped: 0 });
  });

  it("includes raw artifact links for known files and directories when present", async () => {
    const runsDir = await makeRunsDir();
    const runId = "run-2026-05-04T10-00-00-000Z-links";
    const runDir = join(runsDir, runId);
    await writeRun(runsDir, runId, {
      report: {
        status: "completed",
        totalRecords: 1,
        counts: {
          preflightExceptions: 0,
          environmentExceptions: 0,
          closeExceptions: 0,
          targetCounts: {},
        },
      },
    });
    await writeFile(join(runDir, "events.jsonl"), "{}\n");
    await mkdir(join(runDir, "input"), { recursive: true });
    await writeFile(join(runDir, "input", "normalized-records.json"), "[]\n");
    await mkdir(join(runDir, "exceptions"), { recursive: true });
    await mkdir(join(runDir, "screenshots"), { recursive: true });

    const service = createArtifactService({ runsDir });
    const runs = await service.listRuns();

    expect(runs[0].artifacts).toEqual([
      {
        name: "Structured report",
        path: "report.json",
        type: "file",
        url: `/api/runs/${runId}/artifact/report.json`,
      },
      {
        name: "Event log",
        path: "events.jsonl",
        type: "file",
        url: `/api/runs/${runId}/artifact/events.jsonl`,
      },
      {
        name: "Normalized records",
        path: "input/normalized-records.json",
        type: "file",
        url: `/api/runs/${runId}/artifact/input/normalized-records.json`,
      },
      {
        name: "Exceptions",
        path: "exceptions",
        type: "directory",
        url: `/api/runs/${runId}/artifact/exceptions`,
      },
      {
        name: "Screenshots",
        path: "screenshots",
        type: "directory",
        url: `/api/runs/${runId}/artifact/screenshots`,
      },
    ]);
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

  it("reports missing known Markdown files as null", async () => {
    const runsDir = await makeRunsDir();
    const runDir = join(runsDir, "run-2026-05-01T12-00-00-000Z-missing-markdown");
    await mkdir(runDir, { recursive: true });

    const service = createArtifactService({ runsDir });

    await expect(service.readMarkdown("run-2026-05-01T12-00-00-000Z-missing-markdown", "summary")).resolves.toBeNull();
  });

  it("rejects Markdown symlinks that resolve outside the selected run", async () => {
    const runsDir = await makeRunsDir();
    const outsideDir = await makeRunsDir();
    const runDir = join(runsDir, "run-2026-05-01T12-00-00-000Z-markdown-symlink");
    await mkdir(runDir, { recursive: true });
    const outsideSummary = join(outsideDir, "summary.md");
    await writeFile(outsideSummary, "# Outside Summary\n");
    await symlink(outsideSummary, join(runDir, "summary.md"));

    const service = createArtifactService({ runsDir });

    await expect(service.readMarkdown("run-2026-05-01T12-00-00-000Z-markdown-symlink", "summary")).resolves.toBeNull();
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
    await expect(service.resolveArtifact("run-2026-05-01T12-00-00-000Z-artifacts", "screenshots/\0proof.png")).resolves.toBeNull();
    await expect(service.listArtifactDirectory("run-2026-05-01T12-00-00-000Z-artifacts", "../screenshots")).resolves.toBeNull();
    await expect(service.listArtifactDirectory("../outside", "screenshots")).resolves.toBeNull();
    await expect(service.listArtifactDirectory("run-2026-05-01T12-00-00-000Z-artifacts", "/tmp")).resolves.toBeNull();
    await expect(service.listArtifactDirectory("run-2026-05-01T12-00-00-000Z-artifacts", "screenshots/\0")).resolves.toBeNull();
  });

  it("rejects artifact file symlinks that resolve outside the selected run", async () => {
    const runsDir = await makeRunsDir();
    const outsideDir = await makeRunsDir();
    const runId = "run-2026-05-01T12-00-00-000Z-file-symlink";
    const runDir = join(runsDir, runId);
    await mkdir(join(runDir, "screenshots"), { recursive: true });
    const outsideFile = join(outsideDir, "proof.png");
    await writeFile(outsideFile, "outside");
    await symlink(outsideFile, join(runDir, "screenshots", "proof.png"));

    const service = createArtifactService({ runsDir });

    await expect(service.resolveArtifact(runId, "screenshots/proof.png")).resolves.toBeNull();
  });

  it("rejects artifact directory symlinks that resolve outside the selected run", async () => {
    const runsDir = await makeRunsDir();
    const outsideDir = await makeRunsDir();
    const runId = "run-2026-05-01T12-00-00-000Z-directory-symlink";
    const runDir = join(runsDir, runId);
    const outsideScreenshots = join(outsideDir, "screenshots");
    await mkdir(runDir, { recursive: true });
    await mkdir(outsideScreenshots, { recursive: true });
    await writeFile(join(outsideScreenshots, "proof.png"), "outside");
    await symlink(outsideScreenshots, join(runDir, "screenshots"));

    const service = createArtifactService({ runsDir });

    await expect(service.listArtifactDirectory(runId, "screenshots")).resolves.toBeNull();
  });

  it("rejects run directory symlinks that resolve outside the configured runs directory", async () => {
    const runsDir = await makeRunsDir();
    const outsideDir = await makeRunsDir();
    const runId = "run-2026-05-01T12-00-00-000Z-run-symlink";
    await mkdir(join(outsideDir, "screenshots"), { recursive: true });
    await writeFile(join(outsideDir, "summary.md"), "# Outside Summary\n");
    await writeFile(join(outsideDir, "screenshots", "proof.png"), "outside");
    await symlink(outsideDir, join(runsDir, runId));

    const service = createArtifactService({ runsDir });

    await expect(service.readMarkdown(runId, "summary")).resolves.toBeNull();
    await expect(service.resolveArtifact(runId, "screenshots/proof.png")).resolves.toBeNull();
    await expect(service.listArtifactDirectory(runId, "screenshots")).resolves.toBeNull();
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
