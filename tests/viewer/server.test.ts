import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createViewerServer, startViewerServer } from "../../src/viewer/server.js";

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
      expect(artifact.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await artifact.text()).toBe("png-bytes");

      const directoryResponse = await fetch(`${baseUrl}/api/runs/${runId}/artifact/screenshots`);
      expect(directoryResponse.status).toBe(200);
      expect(directoryResponse.headers.get("content-security-policy")).toBe("default-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'");
      const directory = await directoryResponse.text();
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

  it("returns JSON errors for unsupported methods and unknown routes", async () => {
    const runsDir = await makeRunsDir();
    const viewer = createViewerServer({ runsDir });
    await viewer.listen({ port: 0, host: "127.0.0.1" });
    try {
      const baseUrl = viewer.url();

      const method = await fetch(`${baseUrl}/api/runs`, { method: "POST" });
      expect(method.status).toBe(405);
      expect(method.headers.get("allow")).toBe("GET");
      expect(await method.json()).toEqual({ error: "Method not allowed." });

      const unknown = await fetch(`${baseUrl}/missing`);
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual({ error: "Not found." });
    } finally {
      await viewer.close();
    }
  });

  it("serves client code that formats run titles as dates while preserving raw IDs", async () => {
    const runsDir = await makeRunsDir();
    const viewer = createViewerServer({ runsDir });
    await viewer.listen({ port: 0, host: "127.0.0.1" });
    try {
      const script = await fetchText(`${viewer.url()}/assets/app.js`);

      expect(script).toContain('button.innerHTML = \'<strong></strong><span class="run-id"></span><span class="run-meta"></span>\';');
      expect(script).toContain("button.querySelector(\"strong\").textContent = formatRunTitle(run);");
      expect(script).toContain("button.querySelector(\".run-id\").textContent = run.runId;");
      expect(script).toContain('dateStyle: "medium"');
      expect(script).toContain('timeStyle: "short"');
    } finally {
      await viewer.close();
    }
  });

  it("serves CSS that emphasizes summary tabs over artifact links", async () => {
    const runsDir = await makeRunsDir();
    const viewer = createViewerServer({ runsDir });
    await viewer.listen({ port: 0, host: "127.0.0.1" });
    try {
      const css = await fetchText(`${viewer.url()}/assets/styles.css`);

      expect(css).toContain(".tabs {\n  margin-top: 22px;");
      expect(css).toContain("font-size: 15px;\n  font-weight: 700;");
      expect(css).toContain(".artifact-links a {\n  padding: 6px 8px;");
      expect(css).toContain("font-size: 12px;");
      expect(css).toContain("color: #52606c;");
      expect(css).toContain(".markdown-view tr.severity-error");
      expect(css).toContain(".severity-badge.severity-error");
      expect(css).toContain(".severity-badge.severity-warning");
      expect(css).toContain(".severity-badge.severity-info");
    } finally {
      await viewer.close();
    }
  });

  it("escapes directory listing values from run IDs, paths, and entry names", async () => {
    const runsDir = await makeRunsDir();
    const runId = "run-2026-05-04T12-00-00-000Z-<script>";
    const directoryPath = "<b>";
    await mkdir(join(runsDir, runId, directoryPath), { recursive: true });
    await writeFile(join(runsDir, runId, directoryPath, "<script>.png"), "png-bytes");

    const viewer = createViewerServer({ runsDir });
    await viewer.listen({ port: 0, host: "127.0.0.1" });
    try {
      const html = await fetchText(`${viewer.url()}/api/runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(directoryPath)}`);

      expect(html).toContain("run-2026-05-04T12-00-00-000Z-&lt;script&gt;");
      expect(html).toContain("Artifact directory: &lt;b&gt;");
      expect(html).toContain("&lt;script&gt;.png");
      expect(html).not.toContain("<script>.png");
      expect(html).not.toContain("run-2026-05-04T12-00-00-000Z-<script>");
      expect(html).not.toContain("Artifact directory: <b>");
    } finally {
      await viewer.close();
    }
  });

  it("forces active artifact types to download instead of executing in the browser", async () => {
    const runsDir = await makeRunsDir();
    const runId = "run-2026-05-04T12-00-00-000Z-active-artifact";
    await mkdir(join(runsDir, runId), { recursive: true });
    await writeFile(join(runsDir, runId, "proof.html"), "<script>window.evidence = true;</script>");

    const viewer = createViewerServer({ runsDir });
    await viewer.listen({ port: 0, host: "127.0.0.1" });
    try {
      const response = await fetch(`${viewer.url()}/api/runs/${runId}/artifact/proof.html`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(response.headers.get("content-disposition")).toBe('attachment; filename="proof.html"');
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.text()).toBe("<script>window.evidence = true;</script>");
    } finally {
      await viewer.close();
    }
  });
});

describe("startViewerServer", () => {
  it("validates runsDir, writes the URL, and returns a closeable server", async () => {
    const runsDir = await makeRunsDir();
    const writes: string[] = [];
    const stdout = { write: (chunk: string) => writes.push(chunk) };

    const viewer = await startViewerServer({ runsDir, port: 0, stdout });
    try {
      expect(viewer.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(writes).toEqual([`Viewer available at ${viewer.url()}\n`]);
      const response = await fetch(`${viewer.url()}/api/runs`);
      expect(response.status).toBe(200);
    } finally {
      await viewer.close();
    }
  });

  it("rejects missing and non-directory runsDir values with clear errors", async () => {
    const runsDir = await makeRunsDir();
    const missing = join(runsDir, "missing");
    const filePath = join(runsDir, "runs-file");
    await writeFile(filePath, "not a directory");

    await expect(startViewerServer({ runsDir: missing, port: 0, stdout: { write: () => true } })).rejects.toThrow(
      `Runs directory does not exist: ${missing}`,
    );
    await expect(startViewerServer({ runsDir: filePath, port: 0, stdout: { write: () => true } })).rejects.toThrow(
      `Runs directory is not a directory: ${filePath}`,
    );
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
