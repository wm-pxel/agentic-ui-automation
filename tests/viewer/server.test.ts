import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createViewerServer } from "../../src/viewer/server.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("createViewerServer", () => {
  it("serves the app shell, run list, rendered markdown, and artifacts", async () => {
    const runsDir = await makeRunsDir();
    const runId = "run-2026-05-04T12-00-00-000Z-server";
    await mkdir(join(runsDir, runId, "screenshots", "demo-001", "openmrs"), { recursive: true });
    await writeFile(join(runsDir, runId, "run.json"), JSON.stringify({ status: "completed", startedAt: "2026-05-04T12:00:00.000Z" }));
    await writeFile(
      join(runsDir, runId, "report.json"),
      JSON.stringify({
        status: "completed",
        totalRecords: 1,
        counts: { preflightExceptions: 0, environmentExceptions: 0, closeExceptions: 0, targetCounts: {} },
      }),
    );
    await writeFile(join(runsDir, runId, "summary.md"), "# Summary\n\n![Proof](screenshots/demo-001/openmrs/after-save.png)\n");
    await writeFile(join(runsDir, runId, "executive-summary.md"), "# Executive\n");
    await writeFile(join(runsDir, runId, "screenshots", "demo-001", "openmrs", "after-save.png"), "png-bytes");

    const viewer = createViewerServer({ runsDir });
    await viewer.listen({ port: 0, host: "127.0.0.1" });
    try {
      const baseUrl = viewer.url();
      const shell = await fetchText(`${baseUrl}/`);
      expect(shell).toContain("Agentic UI Run Viewer");

      const runs = (await fetchJson(`${baseUrl}/api/runs`)) as { runs: Array<{ runId: string; totalRecords: number }> };
      expect(runs.runs).toEqual([expect.objectContaining({ runId, totalRecords: 1 })]);

      const markdown = (await fetchJson(`${baseUrl}/api/runs/${encodeURIComponent(runId)}/markdown/summary`)) as {
        fileName: string;
        html: string;
      };
      expect(markdown.fileName).toBe("summary.md");
      expect(markdown.html).toContain('<h1 id="summary">Summary</h1>');
      expect(markdown.html).toContain(`/api/runs/${runId}/artifact/screenshots/demo-001/openmrs/after-save.png`);

      const artifact = await fetch(`${baseUrl}/api/runs/${runId}/artifact/screenshots/demo-001/openmrs/after-save.png`);
      expect(artifact.status).toBe(200);
      expect(artifact.headers.get("content-type")).toBe("image/png");
      expect(await artifact.text()).toBe("png-bytes");

      const directory = await fetchText(`${baseUrl}/api/runs/${runId}/artifact/screenshots`);
      expect(directory).toContain("Artifact directory: screenshots");
      expect(directory).toContain("demo-001");
    } finally {
      await viewer.close();
    }
  });

  it("returns clear HTTP errors for missing markdown and unsafe artifacts", async () => {
    const runsDir = await makeRunsDir();
    const runId = "run-2026-05-04T12-00-00-000Z-errors";
    await mkdir(join(runsDir, runId), { recursive: true });

    const viewer = createViewerServer({ runsDir });
    await viewer.listen({ port: 0, host: "127.0.0.1" });
    try {
      const baseUrl = viewer.url();

      const markdown = await fetch(`${baseUrl}/api/runs/${runId}/markdown/summary`);
      expect(markdown.status).toBe(404);
      expect(await markdown.json()).toEqual({ error: "Markdown file not found." });

      const unsafe = await fetch(`${baseUrl}/api/runs/${runId}/artifact/..%2Frun.json`);
      expect(unsafe.status).toBe(404);
      expect(await unsafe.json()).toEqual({ error: "Artifact not found." });
    } finally {
      await viewer.close();
    }
  });
});

async function makeRunsDir(): Promise<string> {
  const runsDir = await mkdtemp(join(tmpdir(), "agentic-ui-viewer-server-"));
  tempDirs.push(runsDir);
  return runsDir;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return response.text();
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return response.json();
}
