# Output Markdown Viewer And Computer Use Patient Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local run-artifact Markdown viewer and make `npm run desktop:patient-flow` drive the already-open Electron intake app through Codex Computer Use instead of launching its own app instance.

**Architecture:** Keep workflow execution, desktop intake, and artifact viewing separate. The viewer is a localhost-only HTTP server with a small static browser UI and a filesystem service constrained to `runs/`; the patient-flow command is an npm wrapper around a tightly scoped `codex exec` prompt plus a small local data/handoff harness.

**Tech Stack:** TypeScript, Node HTTP server, `commander`, `markdown-it`, Vitest, Electron app UI, Codex CLI with Computer Use.

---

## Scope Check

The approved spec contains two related deliverables: the black-box Computer Use patient flow and the artifact viewer. They can be implemented independently but should stay in one plan because the README must present the same three-command E2E flow plus the viewer command. Implement in this order:

1. Finish the viewer backend and UI.
2. Add the Computer Use patient-flow harness and npm command replacement.
3. Update docs and run verification.

There are existing uncommitted edits in `src/viewer/artifactService.ts` and `tests/viewer/artifactService.test.ts`. Treat them as user/current-branch work: read them, preserve their intent, and build on them rather than reverting.

## File Structure

- `src/viewer/artifactService.ts`: owns safe read-only access to `runs/<run-id>/`, run discovery, Markdown reads, artifact resolution, and artifact directory listings.
- `tests/viewer/artifactService.test.ts`: covers run discovery, metadata fallback, Markdown reads, artifact links, path containment, and directory listing.
- `src/viewer/markdown.ts`: create; wraps `markdown-it` with HTML disabled and rewrites local artifact URLs for links/images.
- `tests/viewer/markdown.test.ts`: create; covers headings, tables, code blocks, links, images, and HTML escaping.
- `src/viewer/server.ts`: create; localhost HTTP server and API/static routes for the artifact viewer.
- `tests/viewer/server.test.ts`: create; covers route behavior without leaving a server running.
- `src/viewer/static/index.html`: create; static app shell for the viewer.
- `src/viewer/static/styles.css`: create; quiet operational UI styling for run list, tabs, metadata, Markdown, and artifact links.
- `src/viewer/static/app.js`: create; browser-side run list, tab switching, Markdown loading, and artifact display.
- `src/viewer/cli.ts`: create; parses `--runs-dir` and `--port`, starts the server, chooses next free port, and prints the URL.
- `src/desktop/patientFlowHarness.ts`: create; generates synthetic patient data, snapshots the handoff inbox before/after export, and formats the narrow Codex prompt.
- `scripts/run-electron-patient-flow.mjs`: replace the Playwright/Electron launch implementation with a Node wrapper that invokes the compiled harness/Codex command.
- `tests/desktop/patientFlowHarness.test.ts`: create; covers synthetic patient generation, handoff detection, and prompt boundary text.
- `package.json`: add `markdown-it`, `@types/markdown-it`, `artifacts:viewer`, and adjust `desktop:patient-flow`.
- `README.md`: update front-and-center commands and viewer docs.
- `docs/demo.md`: update manual demo validation to include viewer when useful.

## Task 1: Stabilize Artifact Service Metadata

**Files:**
- Modify: `src/viewer/artifactService.ts`
- Modify: `tests/viewer/artifactService.test.ts`

- [ ] **Step 1: Write failing tests for current run metadata shapes**

Add or confirm these tests in `tests/viewer/artifactService.test.ts`:

```ts
it("reads counts from current run.json shape when report JSON is absent", async () => {
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
```

Also add a sibling test for malformed `report.json` falling back to that same `run.json` shape.

- [ ] **Step 2: Run the artifact service tests and verify failure**

Run:

```sh
npm test -- tests/viewer/artifactService.test.ts
```

Expected before the fix: at least one assertion fails because `preflightExceptions`, `environmentExceptions`, `closeExceptions`, or `targetCounts` are not read from the current top-level `run.json` shape.

- [ ] **Step 3: Implement metadata fallback**

Update `summarizeRun` in `src/viewer/artifactService.ts` so counts read from `report.counts` first, then top-level `run.json`:

```ts
const reportCounts = objectProperty(report, "counts");

return {
  runId,
  timestamp: firstString(
    stringProperty(runMetadata, "startedAt"),
    stringProperty(runMetadata, "timestamp"),
    stringProperty(report, "startedAt"),
    timestampFromRunId(runId),
  ),
  status: firstString(stringProperty(report, "status"), stringProperty(runMetadata, "status")),
  totalRecords: firstNumber(numberProperty(report, "totalRecords"), numberProperty(runMetadata, "totalRecords")),
  preflightExceptions: firstNumber(
    numberProperty(reportCounts, "preflightExceptions"),
    numberProperty(runMetadata, "preflightExceptions"),
  ),
  environmentExceptions: firstNumber(
    numberProperty(reportCounts, "environmentExceptions"),
    numberProperty(runMetadata, "environmentExceptions"),
  ),
  closeExceptions: firstNumber(numberProperty(reportCounts, "closeExceptions"), numberProperty(runMetadata, "closeExceptions")),
  targetCounts: parseTargetCounts(objectProperty(reportCounts, "targetCounts") ?? objectProperty(runMetadata, "targetCounts")),
  hasExecutiveSummary,
  hasSummary,
  artifacts,
};
```

- [ ] **Step 4: Run the artifact service tests and verify pass**

Run:

```sh
npm test -- tests/viewer/artifactService.test.ts
```

Expected: all `artifactService` tests pass.

- [ ] **Step 5: Commit this task**

```sh
git add src/viewer/artifactService.ts tests/viewer/artifactService.test.ts
git commit -m "Fix viewer run metadata fallback"
```

## Task 2: Add Markdown Renderer

**Files:**
- Create: `src/viewer/markdown.ts`
- Create: `tests/viewer/markdown.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install Markdown dependency**

Run:

```sh
npm install markdown-it
npm install -D @types/markdown-it
```

Expected: `package.json` and `package-lock.json` include `markdown-it` and `@types/markdown-it`.

- [ ] **Step 2: Write failing renderer tests**

Create `tests/viewer/markdown.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderRunMarkdown } from "../../src/viewer/markdown.js";

describe("renderRunMarkdown", () => {
  it("renders generated summary Markdown patterns", () => {
    const html = renderRunMarkdown({
      runId: "run-2026-05-04T12-00-00-000Z-demo",
      markdown: [
        "# Executive Summary",
        "",
        "- No issues recorded.",
        "",
        "| Metric | Value |",
        "| --- | --- |",
        "| Status | completed |",
        "",
        "```json",
        "{\"ok\":true}",
        "```",
      ].join("\n"),
    });

    expect(html).toContain("<h1>Executive Summary</h1>");
    expect(html).toContain("<li>No issues recorded.</li>");
    expect(html).toContain("<table>");
    expect(html).toContain("<code>{&quot;ok&quot;:true}</code>");
  });

  it("rewrites run-relative links and images through artifact routes", () => {
    const html = renderRunMarkdown({
      runId: "run-2026-05-04T12-00-00-000Z-demo",
      markdown: [
        "[Report](report.json)",
        "![Proof](screenshots/demo/openmrs/after-save.png)",
      ].join("\n\n"),
    });

    expect(html).toContain('href="/api/runs/run-2026-05-04T12-00-00-000Z-demo/artifact/report.json"');
    expect(html).toContain('src="/api/runs/run-2026-05-04T12-00-00-000Z-demo/artifact/screenshots/demo/openmrs/after-save.png"');
  });

  it("escapes raw HTML", () => {
    const html = renderRunMarkdown({
      runId: "run-2026-05-04T12-00-00-000Z-demo",
      markdown: "<script>alert('x')</script>",
    });

    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("does not rewrite absolute URLs or anchors", () => {
    const html = renderRunMarkdown({
      runId: "run-2026-05-04T12-00-00-000Z-demo",
      markdown: "[OpenMRS](https://openmrs.org/demo/) [Anchor](#target-counts)",
    });

    expect(html).toContain('href="https://openmrs.org/demo/"');
    expect(html).toContain('href="#target-counts"');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```sh
npm test -- tests/viewer/markdown.test.ts
```

Expected: FAIL because `src/viewer/markdown.ts` does not exist.

- [ ] **Step 4: Implement renderer**

Create `src/viewer/markdown.ts`:

```ts
import MarkdownIt from "markdown-it";

export interface RenderRunMarkdownInput {
  runId: string;
  markdown: string;
}

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
});

const defaultImageRenderer =
  markdown.renderer.rules.image ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

const defaultLinkOpenRenderer =
  markdown.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

markdown.renderer.rules.image = (tokens, idx, options, env, self) => {
  rewriteTokenAttribute(tokens[idx], "src", env);
  return defaultImageRenderer(tokens, idx, options, env, self);
};

markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  rewriteTokenAttribute(tokens[idx], "href", env);
  return defaultLinkOpenRenderer(tokens, idx, options, env, self);
};

export function renderRunMarkdown(input: RenderRunMarkdownInput): string {
  return markdown.render(input.markdown, { runId: input.runId });
}

function rewriteTokenAttribute(token: { attrGet(name: string): string | null; attrSet(name: string, value: string): void }, name: string, env: unknown): void {
  const value = token.attrGet(name);
  const runId = runIdFromEnv(env);
  if (!value || !runId || !shouldRewrite(value)) return;
  token.attrSet(name, `/api/runs/${encodeURIComponent(runId)}/artifact/${encodeArtifactPath(value)}`);
}

function runIdFromEnv(env: unknown): string | undefined {
  if (typeof env !== "object" || env === null || !("runId" in env)) return undefined;
  const value = (env as { runId?: unknown }).runId;
  return typeof value === "string" ? value : undefined;
}

function shouldRewrite(value: string): boolean {
  return !value.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith("/");
}

function encodeArtifactPath(path: string): string {
  return path
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join("/");
}
```

- [ ] **Step 5: Run renderer tests and verify pass**

Run:

```sh
npm test -- tests/viewer/markdown.test.ts
```

Expected: all renderer tests pass.

- [ ] **Step 6: Commit this task**

```sh
git add package.json package-lock.json src/viewer/markdown.ts tests/viewer/markdown.test.ts
git commit -m "Add viewer markdown renderer"
```

## Task 3: Add Viewer HTTP Server

**Files:**
- Create: `src/viewer/server.ts`
- Create: `tests/viewer/server.test.ts`

- [ ] **Step 1: Write failing server route tests**

Create `tests/viewer/server.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createArtifactViewerServer } from "../../src/viewer/server.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("createArtifactViewerServer", () => {
  it("serves run list and rendered markdown", async () => {
    const runsDir = await makeRunsDir();
    const runId = "run-2026-05-04T12-00-00-000Z-demo";
    const runDir = join(runsDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run.json"), `${JSON.stringify({ status: "completed", totalRecords: 1 })}\n`);
    await writeFile(join(runDir, "summary.md"), "# Summary\n\n![Proof](screenshots/proof.png)\n");

    const server = createArtifactViewerServer({ runsDir });
    await usingServer(server, async (baseUrl) => {
      const runs = await fetchJson(`${baseUrl}/api/runs`);
      expect(runs.runs[0]).toMatchObject({ runId, status: "completed", hasSummary: true });

      const markdown = await fetchJson(`${baseUrl}/api/runs/${runId}/markdown/summary`);
      expect(markdown.fileName).toBe("summary.md");
      expect(markdown.html).toContain("<h1>Summary</h1>");
      expect(markdown.html).toContain(`/api/runs/${runId}/artifact/screenshots/proof.png`);
    });
  });

  it("serves artifact files and directory listings safely", async () => {
    const runsDir = await makeRunsDir();
    const runId = "run-2026-05-04T12-00-00-000Z-demo";
    const screenshotDir = join(runsDir, runId, "screenshots");
    await mkdir(screenshotDir, { recursive: true });
    await writeFile(join(screenshotDir, "proof.png"), "png");

    const server = createArtifactViewerServer({ runsDir });
    await usingServer(server, async (baseUrl) => {
      const directory = await fetchJson(`${baseUrl}/api/runs/${runId}/artifact/screenshots`);
      expect(directory.entries).toEqual([
        {
          name: "proof.png",
          path: "screenshots/proof.png",
          type: "file",
          url: `/api/runs/${runId}/artifact/screenshots/proof.png`,
        },
      ]);

      const file = await fetch(`${baseUrl}/api/runs/${runId}/artifact/screenshots/proof.png`);
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toContain("image/png");
      await expect(file.text()).resolves.toBe("png");
    });
  });

  it("returns not found for missing markdown and unsafe artifact paths", async () => {
    const runsDir = await makeRunsDir();
    await mkdir(join(runsDir, "run-2026-05-04T12-00-00-000Z-demo"), { recursive: true });

    const server = createArtifactViewerServer({ runsDir });
    await usingServer(server, async (baseUrl) => {
      expect((await fetch(`${baseUrl}/api/runs/run-2026-05-04T12-00-00-000Z-demo/markdown/summary`)).status).toBe(404);
      expect((await fetch(`${baseUrl}/api/runs/run-2026-05-04T12-00-00-000Z-demo/artifact/..%2Fsecret.txt`)).status).toBe(404);
    });
  });
});

async function makeRunsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "viewer-server-test-"));
  tempDirs.push(dir);
  return dir;
}

async function usingServer(server: { listen(port?: number): Promise<{ url: string }>; close(): Promise<void> }, callback: (baseUrl: string) => Promise<void>): Promise<void> {
  const { url } = await server.listen(0);
  try {
    await callback(url);
  } finally {
    await server.close();
  }
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return response.json();
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```sh
npm test -- tests/viewer/server.test.ts
```

Expected: FAIL because `src/viewer/server.ts` does not exist.

- [ ] **Step 3: Implement HTTP server**

Create `src/viewer/server.ts`:

```ts
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createArtifactService } from "./artifactService.js";
import { renderRunMarkdown } from "./markdown.js";

export interface ArtifactViewerServerOptions {
  runsDir: string;
}

export interface StartedArtifactViewerServer {
  url: string;
  port: number;
}

export interface ArtifactViewerServer {
  listen(port?: number): Promise<StartedArtifactViewerServer>;
  close(): Promise<void>;
}

const STATIC_ROOT = fileURLToPath(new URL("./static/", import.meta.url));

export function createArtifactViewerServer(options: ArtifactViewerServerOptions): ArtifactViewerServer {
  const service = createArtifactService({ runsDir: options.runsDir });
  let server: Server | undefined;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    if (url.pathname === "/api/runs") {
      sendJson(response, 200, { runs: await service.listRuns() });
      return;
    }

    const markdownMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/markdown\/([^/]+)$/);
    if (markdownMatch) {
      const runId = decodeURIComponent(markdownMatch[1]);
      const kind = decodeURIComponent(markdownMatch[2]);
      const markdown = await service.readMarkdown(runId, kind);
      if (!markdown) {
        sendJson(response, 404, { error: "Markdown not found" });
        return;
      }
      sendJson(response, 200, {
        ...markdown,
        html: renderRunMarkdown({ runId, markdown: markdown.markdown }),
      });
      return;
    }

    const artifactMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/artifact(?:\/(.*))?$/);
    if (artifactMatch) {
      const runId = decodeURIComponent(artifactMatch[1]);
      const artifactPath = decodeArtifactPath(artifactMatch[2] ?? "");
      const directory = await service.listArtifactDirectory(runId, artifactPath);
      if (directory) {
        sendJson(response, 200, directory);
        return;
      }
      const artifact = await service.resolveArtifact(runId, artifactPath);
      if (!artifact) {
        sendJson(response, 404, { error: "Artifact not found" });
        return;
      }
      response.writeHead(200, { "content-type": artifact.contentType });
      createReadStream(artifact.absolutePath).pipe(response);
      return;
    }

    await serveStatic(url.pathname, response);
  }

  return {
    async listen(port = 4173) {
      server = createServer((request, response) => {
        handle(request, response).catch((error) => {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
        });
      });
      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject);
        server?.listen(port, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      return { url: `http://127.0.0.1:${actualPort}`, port: actualPort };
    },
    async close() {
      if (!server) return;
      await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
      server = undefined;
    },
  };
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const fileName = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (fileName.includes("..") || fileName.includes("\\")) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  try {
    const content = await readFile(join(STATIC_ROOT, fileName));
    response.writeHead(200, { "content-type": staticContentType(fileName) });
    response.end(content);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

function decodeArtifactPath(value: string): string {
  return value
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part))
    .join("/");
}

function staticContentType(fileName: string): string {
  switch (extname(fileName)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
```

- [ ] **Step 4: Run server tests and fix compile issues**

Run:

```sh
npm test -- tests/viewer/server.test.ts
```

Expected: all API route tests pass. Static app-shell coverage is added in Task 4.

- [ ] **Step 5: Commit this task**

```sh
git add src/viewer/server.ts tests/viewer/server.test.ts
git commit -m "Add artifact viewer server"
```

## Task 4: Add Viewer Static UI

**Files:**
- Create: `src/viewer/static/index.html`
- Create: `src/viewer/static/styles.css`
- Create: `src/viewer/static/app.js`
- Modify: `tests/viewer/server.test.ts`

- [ ] **Step 1: Add static route test**

Append to `tests/viewer/server.test.ts`:

```ts
it("serves the viewer app shell", async () => {
  const runsDir = await makeRunsDir();
  const server = createArtifactViewerServer({ runsDir });

  await usingServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    await expect(response.text()).resolves.toContain("Run Artifact Viewer");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```sh
npm test -- tests/viewer/server.test.ts
```

Expected: FAIL because `index.html` does not exist or does not contain `Run Artifact Viewer`.

- [ ] **Step 3: Create HTML shell**

Create `src/viewer/static/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Run Artifact Viewer</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="viewer-shell">
      <aside class="run-list-panel">
        <header>
          <h1>Run Artifact Viewer</h1>
          <p id="run-count">Loading runs</p>
        </header>
        <div id="run-list" class="run-list"></div>
      </aside>
      <section class="run-detail">
        <header class="detail-header">
          <div>
            <h2 id="run-title">Select a run</h2>
            <p id="run-meta"></p>
          </div>
          <div id="artifact-links" class="artifact-links"></div>
        </header>
        <nav class="tabs" aria-label="Markdown files">
          <button class="tab active" type="button" data-kind="executive-summary">Executive Summary</button>
          <button class="tab" type="button" data-kind="summary">Summary</button>
        </nav>
        <article id="markdown" class="markdown empty">Select a run to view its Markdown output.</article>
      </section>
    </main>
    <script src="/app.js"></script>
  </body>
</html>
```

- [ ] **Step 4: Create browser app**

Create `src/viewer/static/app.js`:

```js
const state = {
  runs: [],
  activeRunId: null,
  activeKind: "executive-summary",
};

const el = {
  runCount: document.getElementById("run-count"),
  runList: document.getElementById("run-list"),
  runTitle: document.getElementById("run-title"),
  runMeta: document.getElementById("run-meta"),
  artifactLinks: document.getElementById("artifact-links"),
  markdown: document.getElementById("markdown"),
};

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    state.activeKind = tab.dataset.kind;
    document.querySelectorAll(".tab").forEach((candidate) => {
      candidate.classList.toggle("active", candidate.dataset.kind === state.activeKind);
    });
    void renderActiveRun();
  });
});

void loadRuns();

async function loadRuns() {
  const response = await fetch("/api/runs");
  const data = await response.json();
  state.runs = data.runs ?? [];
  state.activeRunId = state.runs[0]?.runId ?? null;
  renderRunList();
  await renderActiveRun();
}

function renderRunList() {
  el.runCount.textContent = `${state.runs.length} ${state.runs.length === 1 ? "run" : "runs"}`;
  el.runList.replaceChildren();
  if (state.runs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = "No runs found.";
    el.runList.append(empty);
    return;
  }
  for (const run of state.runs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `run-row ${run.runId === state.activeRunId ? "active" : ""}`;
    button.addEventListener("click", () => {
      state.activeRunId = run.runId;
      renderRunList();
      void renderActiveRun();
    });
    button.innerHTML = `
      <strong>${escapeHtml(run.runId)}</strong>
      <span>${escapeHtml(run.status ?? "unknown")} · ${escapeHtml(formatCounts(run))}</span>
      <small>${escapeHtml(run.timestamp ?? "")}</small>
    `;
    el.runList.append(button);
  }
}

async function renderActiveRun() {
  const run = state.runs.find((candidate) => candidate.runId === state.activeRunId);
  if (!run) {
    el.runTitle.textContent = "Select a run";
    el.runMeta.textContent = "";
    el.artifactLinks.replaceChildren();
    el.markdown.className = "markdown empty";
    el.markdown.textContent = "Select a run to view its Markdown output.";
    return;
  }

  el.runTitle.textContent = run.runId;
  el.runMeta.textContent = `${run.status ?? "unknown"} · ${formatCounts(run)}`;
  renderArtifactLinks(run);

  const response = await fetch(`/api/runs/${encodeURIComponent(run.runId)}/markdown/${state.activeKind}`);
  if (response.status === 404) {
    el.markdown.className = "markdown empty";
    el.markdown.textContent = `${labelForKind(state.activeKind)} is not available for this run.`;
    return;
  }
  const data = await response.json();
  el.markdown.className = "markdown";
  el.markdown.innerHTML = data.html;
}

function renderArtifactLinks(run) {
  el.artifactLinks.replaceChildren();
  for (const artifact of run.artifacts ?? []) {
    const link = document.createElement("a");
    link.href = artifact.url;
    link.textContent = artifact.name;
    link.target = "_blank";
    link.rel = "noreferrer";
    el.artifactLinks.append(link);
  }
}

function formatCounts(run) {
  const total = run.totalRecords ?? 0;
  const exceptions = (run.preflightExceptions ?? 0) + (run.environmentExceptions ?? 0) + (run.closeExceptions ?? 0);
  return `${total} records, ${exceptions} exceptions`;
}

function labelForKind(kind) {
  return kind === "summary" ? "Summary" : "Executive summary";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
```

- [ ] **Step 5: Create CSS**

Create `src/viewer/static/styles.css`:

```css
:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #1f2933;
  background: #f6f7f9;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 980px;
  background: #f6f7f9;
}

button {
  font: inherit;
}

.viewer-shell {
  display: grid;
  grid-template-columns: 380px 1fr;
  height: 100vh;
}

.run-list-panel {
  min-height: 0;
  border-right: 1px solid #d8dee6;
  background: #ffffff;
  display: grid;
  grid-template-rows: auto 1fr;
}

.run-list-panel header,
.detail-header {
  padding: 18px 22px;
  border-bottom: 1px solid #e5e9ef;
}

h1,
h2 {
  margin: 0;
  line-height: 1.2;
}

h1 {
  font-size: 22px;
}

h2 {
  font-size: 20px;
}

p {
  margin: 5px 0 0;
  color: #52616f;
}

.run-list {
  overflow: auto;
}

.run-row {
  display: grid;
  gap: 4px;
  width: 100%;
  padding: 13px 16px;
  border: 0;
  border-bottom: 1px solid #eef1f4;
  background: #ffffff;
  text-align: left;
  cursor: pointer;
}

.run-row.active {
  background: #e8f3f1;
}

.run-row span,
.run-row small {
  color: #52616f;
  font-size: 12px;
}

.run-detail {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: auto auto 1fr;
}

.detail-header {
  display: flex;
  justify-content: space-between;
  gap: 18px;
}

.artifact-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-content: flex-start;
  justify-content: flex-end;
}

.artifact-links a {
  border: 1px solid #b8c2cc;
  border-radius: 6px;
  padding: 6px 9px;
  color: #0f5f59;
  text-decoration: none;
  background: #ffffff;
  font-size: 12px;
}

.tabs {
  display: flex;
  gap: 6px;
  padding: 0 22px;
  border-bottom: 1px solid #d8dee6;
  background: #ffffff;
}

.tab {
  min-height: 40px;
  border: 0;
  border-bottom: 3px solid transparent;
  background: transparent;
  cursor: pointer;
}

.tab.active {
  border-bottom-color: #0f766e;
  color: #0f766e;
  font-weight: 700;
}

.markdown {
  overflow: auto;
  padding: 24px;
  max-width: 1180px;
}

.markdown.empty,
.empty-list {
  color: #52616f;
  padding: 20px;
}

.markdown table {
  border-collapse: collapse;
  width: 100%;
  margin: 16px 0;
  background: #ffffff;
}

.markdown th,
.markdown td {
  border: 1px solid #d8dee6;
  padding: 8px 10px;
  text-align: left;
  vertical-align: top;
}

.markdown th {
  background: #eef2f5;
}

.markdown pre {
  overflow: auto;
  padding: 14px;
  background: #111827;
  color: #f9fafb;
  border-radius: 6px;
}

.markdown code {
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
}

.markdown img {
  max-width: 100%;
  border: 1px solid #d8dee6;
}
```

- [ ] **Step 6: Run server tests and verify pass**

Run:

```sh
npm test -- tests/viewer/server.test.ts
```

Expected: all server tests pass.

- [ ] **Step 7: Commit this task**

```sh
git add src/viewer/static/index.html src/viewer/static/styles.css src/viewer/static/app.js tests/viewer/server.test.ts
git commit -m "Add artifact viewer UI"
```

## Task 5: Add Viewer CLI And Npm Command

**Files:**
- Create: `src/viewer/cli.ts`
- Create: `tests/viewer/cli.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing CLI tests**

Create `tests/viewer/cli.test.ts`:

```ts
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseViewerArgs, findAvailablePort } from "../../src/viewer/cli.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("viewer CLI", () => {
  it("parses defaults and explicit options", () => {
    expect(parseViewerArgs(["node", "cli"])).toEqual({ runsDir: "runs", port: 4173 });
    expect(parseViewerArgs(["node", "cli", "--runs-dir", "tmp-runs", "--port", "4200"])).toEqual({
      runsDir: "tmp-runs",
      port: 4200,
    });
  });

  it("rejects invalid ports", () => {
    expect(() => parseViewerArgs(["node", "cli", "--port", "0"])).toThrow("--port must be between 1 and 65535.");
    expect(() => parseViewerArgs(["node", "cli", "--port", "abc"])).toThrow("--port must be between 1 and 65535.");
  });

  it("finds the requested available port", async () => {
    await expect(findAvailablePort(0)).resolves.toEqual(expect.any(Number));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```sh
npm test -- tests/viewer/cli.test.ts
```

Expected: FAIL because `src/viewer/cli.ts` does not exist.

- [ ] **Step 3: Implement CLI**

Create `src/viewer/cli.ts`:

```ts
#!/usr/bin/env node
import { access, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { Command } from "commander";
import { createArtifactViewerServer } from "./server.js";

export interface ViewerCliOptions {
  runsDir: string;
  port: number;
}

export function parseViewerArgs(argv: string[]): ViewerCliOptions {
  const program = new Command();
  let parsed: ViewerCliOptions = { runsDir: "runs", port: 4173 };
  program
    .exitOverride()
    .option("--runs-dir <path>", "Directory containing run folders.", "runs")
    .option("--port <number>", "Preferred local port.", parsePort, 4173)
    .action((options: ViewerCliOptions) => {
      parsed = options;
    });
  program.parse(argv);
  return parsed;
}

export async function runViewerCli(argv = process.argv): Promise<void> {
  const options = parseViewerArgs(argv);
  await validateRunsDir(options.runsDir);
  const port = await findAvailablePort(options.port);
  const server = createArtifactViewerServer({ runsDir: options.runsDir });
  const started = await server.listen(port);
  process.stdout.write(`Artifact viewer running at ${started.url}\n`);
}

export async function findAvailablePort(startPort: number): Promise<number> {
  if (startPort === 0) return listenProbe(0);
  for (let port = startPort; port <= 65535; port += 1) {
    const available = await canListen(port);
    if (available) return port;
  }
  throw new Error(`No available port found at or above ${startPort}.`);
}

async function validateRunsDir(runsDir: string): Promise<void> {
  await access(runsDir);
  const runsStat = await stat(runsDir);
  if (!runsStat.isDirectory()) {
    throw new Error(`Runs path is not a directory: ${runsDir}`);
  }
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port must be between 1 and 65535.");
  }
  return port;
}

async function canListen(port: number): Promise<boolean> {
  try {
    await listenProbe(port);
    return true;
  } catch {
    return false;
  }
}

function listenProbe(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      server.close((error) => (error ? reject(error) : resolve(actualPort)));
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runViewerCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Add npm command**

Modify `package.json` scripts:

```json
"artifacts:viewer": "tsx src/viewer/cli.ts"
```

- [ ] **Step 5: Run CLI tests and a local startup smoke**

Run:

```sh
npm test -- tests/viewer/cli.test.ts
npm run artifacts:viewer -- --port 4173
```

Expected: tests pass. The startup smoke prints `Artifact viewer running at http://127.0.0.1:4173` or the next available port and keeps running; stop it with `Ctrl-C`.

- [ ] **Step 6: Commit this task**

```sh
git add package.json src/viewer/cli.ts tests/viewer/cli.test.ts
git commit -m "Add artifact viewer CLI"
```

## Task 6: Replace Patient Flow With Computer Use Harness

**Files:**
- Create: `src/desktop/patientFlowHarness.ts`
- Create: `tests/desktop/patientFlowHarness.test.ts`
- Modify: `scripts/run-electron-patient-flow.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing harness tests**

Create `tests/desktop/patientFlowHarness.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildComputerUsePrompt,
  detectNewReadyFile,
  syntheticComputerUsePatient,
} from "../../src/desktop/patientFlowHarness.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("patientFlowHarness", () => {
  it("generates synthetic patient data", () => {
    const patient = syntheticComputerUsePatient(new Date("2026-05-04T12:34:56.000Z"));

    expect(patient).toMatchObject({
      firstName: "Computer",
      lastName: "Use 20260504123456",
      dateOfBirth: "1992-09-23",
      sexOrGender: "female",
      email: "computer.use.20260504123456@example.test",
      preferredContactMethod: "email",
    });
    expect(patient.phone).toBe("3125553456");
    expect(patient.insuranceMemberId).toBe("CU04123456");
  });

  it("detects a new ready CSV file", async () => {
    const inbox = await makeTempDir();
    const before = new Set(["old.ready.csv"]);
    await writeFile(join(inbox, "old.ready.csv"), "old");
    await writeFile(join(inbox, "new.ready.csv"), "new");

    await expect(detectNewReadyFile(inbox, before)).resolves.toBe(join(inbox, "new.ready.csv"));
  });

  it("builds a prompt that forbids app internals", () => {
    const patient = syntheticComputerUsePatient(new Date("2026-05-04T12:34:56.000Z"));
    const prompt = buildComputerUsePrompt({ patient, inbox: "/tmp/inbox" });

    expect(prompt).toContain("Use Computer Use");
    expect(prompt).toContain("Do not use Playwright");
    expect(prompt).toContain("Do not call Electron IPC");
    expect(prompt).toContain("First Name: Computer");
    expect(prompt).toContain("/tmp/inbox");
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "patient-flow-harness-test-"));
  tempDirs.push(dir);
  return dir;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```sh
npm test -- tests/desktop/patientFlowHarness.test.ts
```

Expected: FAIL because `src/desktop/patientFlowHarness.ts` does not exist.

- [ ] **Step 3: Implement harness module**

Create `src/desktop/patientFlowHarness.ts`:

```ts
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SyntheticPatientInput } from "./intakeQueue.js";

export interface BuildComputerUsePromptInput {
  patient: SyntheticPatientInput;
  inbox: string;
}

export function syntheticComputerUsePatient(now = new Date()): SyntheticPatientInput {
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  return {
    firstName: "Computer",
    lastName: `Use ${stamp}`,
    dateOfBirth: "1992-09-23",
    sexOrGender: "female",
    phone: `312555${stamp.slice(-4)}`,
    email: `computer.use.${stamp}@example.test`,
    streetAddress: "500 West Monroe Street",
    city: "Chicago",
    state: "IL",
    zip: "60661",
    insurancePayer: "Aetna",
    insuranceMemberId: `CU${stamp.slice(-8)}`,
    insuranceGroupId: "GRP4",
    reasonForVisit: "New patient wellness visit",
    preferredContactMethod: "email",
    notes: "Created by the Computer Use desktop patient flow.",
  };
}

export async function readyFileSnapshot(inbox: string): Promise<Set<string>> {
  try {
    const entries = await readdir(inbox);
    return new Set(entries.filter((entry) => entry.endsWith(".ready.csv")));
  } catch {
    return new Set();
  }
}

export async function detectNewReadyFile(inbox: string, before: Set<string>): Promise<string | null> {
  const entries = await readdir(inbox);
  const created = entries
    .filter((entry) => entry.endsWith(".ready.csv") && !before.has(entry))
    .sort();
  return created[0] ? join(inbox, created[0]) : null;
}

export function buildComputerUsePrompt(input: BuildComputerUsePromptInput): string {
  const patient = input.patient;
  return [
    "Use Computer Use to control the already-running visible macOS desktop app named Intake Queue.",
    "Do not use Playwright. Do not launch Electron. Do not call Electron IPC, preload APIs, window.intakeApp, or any app internals.",
    "If the Intake Queue app is not running or cannot be focused, stop and report that npm run desktop:dev must be started first.",
    "Create exactly one synthetic patient through the visible UI:",
    `First Name: ${patient.firstName}`,
    `Last Name: ${patient.lastName}`,
    `Date Of Birth: ${patient.dateOfBirth}`,
    `Gender: ${patient.sexOrGender}`,
    `Phone: ${patient.phone}`,
    `Email: ${patient.email}`,
    `Street Address: ${patient.streetAddress}`,
    `City: ${patient.city}`,
    `State: ${patient.state}`,
    `ZIP: ${patient.zip}`,
    `Insurance Payer: ${patient.insurancePayer}`,
    `Member ID: ${patient.insuranceMemberId}`,
    `Group ID: ${patient.insuranceGroupId ?? ""}`,
    `Preferred Contact: ${patient.preferredContactMethod}`,
    `Reason For Visit: ${patient.reasonForVisit}`,
    `Notes: ${patient.notes ?? ""}`,
    "After adding the patient, ensure only that created patient is selected and click Export Selected.",
    `The expected handoff inbox is ${input.inbox}.`,
    "When complete, respond with a short success message. If any UI step fails, report the failed step.",
  ].join("\n");
}
```

- [ ] **Step 4: Replace script wrapper**

Modify `scripts/run-electron-patient-flow.mjs` so it builds the patient, snapshots the inbox, runs `codex exec`, then detects the new ready file:

```js
#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { defaultIntakeInbox } from "../dist/src/handoff/intakeHandoff.js";
import {
  buildComputerUsePrompt,
  detectNewReadyFile,
  readyFileSnapshot,
  syntheticComputerUsePatient,
} from "../dist/src/desktop/patientFlowHarness.js";

const inbox = defaultIntakeInbox();
mkdirSync(inbox, { recursive: true });

const patient = syntheticComputerUsePatient();
const before = await readyFileSnapshot(inbox);
const prompt = buildComputerUsePrompt({ patient, inbox });

const result = spawnSync("codex", ["exec", "--cd", process.cwd(), "--sandbox", "danger-full-access", "--ask-for-approval", "never", prompt], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (result.status !== 0) {
  process.stderr.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

let readyPath = null;
for (let attempt = 0; attempt < 50; attempt += 1) {
  readyPath = await detectNewReadyFile(inbox, before);
  if (readyPath) break;
  await delay(200);
}

if (!readyPath) {
  process.stderr.write(`No new .ready.csv appeared in ${inbox} after Computer Use flow completed.\n`);
  process.exit(1);
}

console.log(JSON.stringify({ status: "exported", patient, readyPath }, null, 2));
```

- [ ] **Step 5: Keep npm command building before running**

Keep `package.json` script:

```json
"desktop:patient-flow": "npm run desktop:build && node scripts/run-electron-patient-flow.mjs"
```

This ensures `dist/src/desktop/patientFlowHarness.js` exists before the script imports it. It does not launch Electron.

- [ ] **Step 6: Run harness tests**

Run:

```sh
npm test -- tests/desktop/patientFlowHarness.test.ts
```

Expected: all harness tests pass.

- [ ] **Step 7: Commit this task**

```sh
git add src/desktop/patientFlowHarness.ts tests/desktop/patientFlowHarness.test.ts scripts/run-electron-patient-flow.mjs package.json
git commit -m "Use Computer Use for desktop patient flow"
```

## Task 7: Update Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/demo.md`

- [ ] **Step 1: Update README E2E section**

Modify the front-and-center `README.md` E2E text so it says:

```md
`desktop:patient-flow` requires the Electron app from `npm run desktop:dev` to
already be running. It uses Codex Computer Use to click and type through the
visible app UI, creates one synthetic patient, exports only that patient, and
prints the generated patient data and handoff path. It does not launch a private
Electron instance or call app internals.
```

- [ ] **Step 2: Add viewer docs**

Add an `Artifact Viewer` section to `README.md`:

````md
## Artifact Viewer

Start the local read-only viewer:

```sh
npm run artifacts:viewer
```

The viewer defaults to `runs/`, binds to localhost, prints the URL it selected,
and renders `executive-summary.md`, `summary.md`, `report.json`, exceptions,
events, normalized records, and screenshots for completed runs. Use
`--runs-dir <path>` to inspect a different run directory and `--port <number>`
to request a preferred port.
````

- [ ] **Step 3: Update docs/demo.md**

Add viewer usage to manual validation:

````md
To review generated run artifacts in a browser, start:

```sh
npm run artifacts:viewer
```

Open the printed localhost URL and select the latest run to inspect the
executive summary, full summary, screenshots, and raw JSON artifacts.
````

- [ ] **Step 4: Run docs grep checks**

Run:

```sh
rg -n "desktop:patient-flow|artifacts:viewer|Computer Use|Playwright" README.md docs/demo.md
```

Expected: README documents `desktop:patient-flow` as Computer Use black-box UI automation, and does not describe it as launching its own Electron instance.

- [ ] **Step 5: Commit this task**

```sh
git add README.md docs/demo.md
git commit -m "Document artifact viewer and Computer Use flow"
```

## Task 8: Full Verification

**Files:**
- Read: all changed files

- [ ] **Step 1: Run focused tests**

Run:

```sh
npm test -- tests/viewer/artifactService.test.ts tests/viewer/markdown.test.ts tests/viewer/server.test.ts tests/viewer/cli.test.ts tests/desktop/patientFlowHarness.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run required repo verification**

Run:

```sh
npm run typecheck
npm test
git diff --check
```

Expected: all commands pass.

- [ ] **Step 3: Smoke the viewer server**

Run:

```sh
npm run artifacts:viewer -- --port 4173
```

Expected: command prints `Artifact viewer running at http://127.0.0.1:4173` or the next available port. Open the printed URL and confirm the run list loads. Stop the server with `Ctrl-C`.

- [ ] **Step 4: Smoke the Computer Use patient flow locally**

In three terminals, run:

```sh
npm run watch:intake
npm run desktop:dev
npm run desktop:patient-flow
```

Expected: the third command controls the already-open app, creates one synthetic patient through the UI, exports one `.ready.csv`, prints JSON with `status`, `patient`, and `readyPath`, and the watcher writes a new `runs/<run-id>/summary.md`.

- [ ] **Step 5: Verify the latest run in the viewer**

With `npm run artifacts:viewer` running, open the printed URL and select the latest run.

Expected: `Executive Summary` and `Summary` tabs render, screenshot images load through `/api/runs/<runId>/artifact/...`, and raw artifact links open read-only content.

- [ ] **Step 6: Final commit if verification caused doc or minor fixes**

If verification required changes, commit them:

```sh
git add package.json package-lock.json README.md docs/demo.md scripts/run-electron-patient-flow.mjs src/desktop/patientFlowHarness.ts src/viewer/artifactService.ts src/viewer/markdown.ts src/viewer/server.ts src/viewer/cli.ts src/viewer/static/index.html src/viewer/static/styles.css src/viewer/static/app.js tests/desktop/patientFlowHarness.test.ts tests/viewer/artifactService.test.ts tests/viewer/markdown.test.ts tests/viewer/server.test.ts tests/viewer/cli.test.ts
git commit -m "Verify viewer and patient flow"
```

If no changes were needed, do not create an empty commit.
