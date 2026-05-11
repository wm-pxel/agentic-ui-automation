import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createArtifactService } from "./artifactService.js";
import { renderMarkdown } from "./markdownRenderer.js";

export interface ViewerServerOptions {
  runsDir: string;
}

export interface ViewerListenOptions {
  port: number;
  host?: string;
}

export interface ViewerServer {
  listen(options: ViewerListenOptions): Promise<void>;
  close(): Promise<void>;
  url(): string;
}

export function createViewerServer(options: ViewerServerOptions): ViewerServer {
  const artifactService = createArtifactService({ runsDir: options.runsDir });
  const server = createServer(async (request, response) => {
    try {
      await handleRequest(request, response, artifactService);
    } catch (error) {
      if (!response.headersSent) {
        writeJson(response, 500, { error: "Internal server error." });
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
    }
  });

  let listenHost = "127.0.0.1";

  return {
    listen({ port, host = "127.0.0.1" }: ViewerListenOptions): Promise<void> {
      listenHost = host;
      return new Promise((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    close(): Promise<void> {
      if (!server.listening) return Promise.resolve();
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    url(): string {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Viewer server is not listening.");
      }
      return `http://${listenHost}:${address.port}`;
    },
  };
}

export async function startViewerServer(options: ViewerServerOptions & { port?: number; stdout?: { write(chunk: string): unknown } }): Promise<ViewerServer> {
  let runsDirStat;
  try {
    runsDirStat = await stat(options.runsDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Runs directory does not exist: ${options.runsDir}`);
    }
    throw error;
  }

  if (!runsDirStat.isDirectory()) {
    throw new Error(`Runs directory is not a directory: ${options.runsDir}`);
  }

  const viewer = createViewerServer({ runsDir: options.runsDir });
  await viewer.listen({ port: options.port ?? 4173, host: "127.0.0.1" });
  const url = viewer.url();
  (options.stdout ?? process.stdout).write(`Viewer available at ${url}\n`);
  return viewer;
}

type ArtifactService = ReturnType<typeof createArtifactService>;

async function handleRequest(request: IncomingMessage, response: ServerResponse, artifactService: ArtifactService): Promise<void> {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "Method not allowed." }, { Allow: "GET" });
    return;
  }

  const url = parseRequestUrl(request);
  if (!url) {
    writeJson(response, 404, { error: "Not found." });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    writeHtml(response, 200, INDEX_HTML);
    return;
  }
  if (url.pathname === "/assets/app.js") {
    writeText(response, 200, "text/javascript; charset=utf-8", APP_JS);
    return;
  }
  if (url.pathname === "/assets/styles.css") {
    writeText(response, 200, "text/css; charset=utf-8", STYLES_CSS);
    return;
  }
  if (url.pathname === "/api/runs") {
    writeJson(response, 200, { runs: await artifactService.listRuns() });
    return;
  }

  const segments = decodePathSegments(url.pathname);
  if (!segments) {
    writeJson(response, 404, { error: "Not found." });
    return;
  }

  const markdownRoute = matchMarkdownRoute(segments);
  if (markdownRoute) {
    const markdown = await artifactService.readMarkdown(markdownRoute.runId, markdownRoute.kind);
    if (!markdown) {
      writeJson(response, 404, { error: "Markdown file not found." });
      return;
    }
    writeJson(response, 200, {
      fileName: markdown.fileName,
      markdown: markdown.markdown,
      html: renderMarkdown(markdown.markdown, { runId: markdownRoute.runId }),
    });
    return;
  }

  const artifactRoute = matchArtifactRoute(segments);
  if (artifactRoute) {
    const artifact = await artifactService.resolveArtifact(artifactRoute.runId, artifactRoute.artifactPath);
    if (artifact) {
      await streamFile(response, artifact.absolutePath, artifact.contentType);
      return;
    }

    const directory = await artifactService.listArtifactDirectory(artifactRoute.runId, artifactRoute.artifactPath);
    if (directory) {
      writeHtml(response, 200, renderDirectoryListing(artifactRoute.runId, directory.path, directory.entries));
      return;
    }

    writeJson(response, 404, { error: "Artifact not found." });
    return;
  }

  writeJson(response, 404, { error: "Not found." });
}

function parseRequestUrl(request: IncomingMessage): URL | null {
  try {
    return new URL(request.url ?? "/", "http://127.0.0.1");
  } catch {
    return null;
  }
}

function decodePathSegments(pathname: string): string[] | null {
  try {
    return pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

function matchMarkdownRoute(segments: string[]): { runId: string; kind: string } | null {
  if (segments.length !== 5 || segments[0] !== "api" || segments[1] !== "runs" || segments[3] !== "markdown") return null;
  return { runId: segments[2] ?? "", kind: segments[4] ?? "" };
}

function matchArtifactRoute(segments: string[]): { runId: string; artifactPath: string } | null {
  if (segments.length < 5 || segments[0] !== "api" || segments[1] !== "runs" || segments[3] !== "artifact") return null;
  return { runId: segments[2] ?? "", artifactPath: segments.slice(4).join("/") };
}

async function streamFile(response: ServerResponse, absolutePath: string, contentType: string): Promise<void> {
  response.writeHead(200, artifactResponseHeaders(absolutePath, contentType));

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absolutePath);
    let settled = false;

    const cleanup = () => {
      stream.off("error", onStreamError);
      response.off("finish", onFinish);
      response.off("close", onClose);
      response.off("error", onResponseError);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onStreamError = (error: Error) => {
      response.destroy(error);
      settle(() => reject(error));
    };
    const onResponseError = (error: Error) => {
      stream.destroy();
      settle(() => reject(error));
    };
    const onClose = () => {
      if (response.writableEnded) {
        settle(resolve);
        return;
      }
      stream.destroy();
      settle(() => reject(new Error("Response closed before artifact stream completed.")));
    };
    const onFinish = () => {
      settle(resolve);
    };

    stream.on("error", onStreamError);
    response.on("finish", onFinish);
    response.on("close", onClose);
    response.on("error", onResponseError);
    stream.pipe(response);
  });
}

function artifactResponseHeaders(absolutePath: string, contentType: string): Record<string, string> {
  if (!isActiveArtifactContentType(contentType)) {
    return responseHeaders(contentType);
  }

  return responseHeaders("application/octet-stream", {
    "Content-Disposition": `attachment; filename="${attachmentFileName(absolutePath)}"`,
  });
}

function isActiveArtifactContentType(contentType: string): boolean {
  const normalizedType = contentType.toLowerCase().split(";")[0]?.trim();
  return normalizedType === "text/html" || normalizedType === "image/svg+xml" || normalizedType === "text/javascript";
}

function attachmentFileName(path: string): string {
  const fileName = path.split(/[\\/]/).pop() ?? "artifact";
  return fileName.replace(/[\u0000-\u001f"\\]/g, "_") || "artifact";
}

function renderDirectoryListing(
  runId: string,
  artifactPath: string,
  entries: Array<{ name: string; type: "file" | "directory"; url: string }>,
): string {
  const title = `Artifact directory: ${artifactPath || "."}`;
  const items = entries
    .map((entry) => {
      const suffix = entry.type === "directory" ? "/" : "";
      return `<li><a href="${escapeAttribute(entry.url)}">${escapeHtml(entry.name)}${suffix}</a> <span>${escapeHtml(entry.type)}</span></li>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/assets/styles.css">
</head>
<body class="directory-page">
  <main class="directory-listing">
    <p class="eyebrow">${escapeHtml(runId)}</p>
    <h1>${escapeHtml(title)}</h1>
    <ul>${items}</ul>
  </main>
</body>
</html>`;
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown, headers?: Record<string, string>): void {
  writeText(response, statusCode, "application/json; charset=utf-8", `${JSON.stringify(value)}\n`, headers);
}

function writeHtml(response: ServerResponse, statusCode: number, html: string): void {
  writeText(response, statusCode, "text/html; charset=utf-8", html, {
    "Content-Security-Policy": "default-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'",
  });
}

function writeText(response: ServerResponse, statusCode: number, contentType: string, body: string, headers?: Record<string, string>): void {
  response.writeHead(statusCode, responseHeaders(contentType, headers));
  response.end(body);
}

function responseHeaders(contentType: string, headers?: Record<string, string>): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agentic UI Run Viewer</title>
  <link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
  <div id="app" class="app-shell">
    <aside class="run-pane">
      <header>
        <h1>Agentic UI Run Viewer</h1>
      </header>
      <div id="run-list" class="run-list" aria-label="Runs"></div>
    </aside>
    <main class="detail-pane">
      <section id="run-detail" class="empty-state">Select a run to inspect summaries and artifacts.</section>
    </main>
  </div>
  <script type="module" src="/assets/app.js"></script>
</body>
</html>`;

const APP_JS = `
const runList = document.querySelector("#run-list");
const runDetail = document.querySelector("#run-detail");
let runs = [];
let selectedRunId = "";
let selectedKind = "executive-summary";

async function loadRuns() {
  const response = await fetch("/api/runs");
  if (!response.ok) throw new Error("Unable to load runs.");
  const payload = await response.json();
  runs = payload.runs || [];
  selectedRunId = runs[0]?.runId || "";
  renderRuns();
  await renderSelectedRun();
}

function renderRuns() {
  runList.replaceChildren(...runs.map((run) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = run.runId === selectedRunId ? "run-item selected" : "run-item";
    button.innerHTML = '<strong></strong><span class="run-id"></span><span class="run-meta"></span>';
    button.querySelector("strong").textContent = formatRunTitle(run);
    button.querySelector(".run-id").textContent = run.runId;
    button.querySelector(".run-meta").textContent = [run.status, formatCount(run.totalRecords)].filter(Boolean).join(" · ");
    button.addEventListener("click", async () => {
      selectedRunId = run.runId;
      selectedKind = run.hasExecutiveSummary ? "executive-summary" : "summary";
      renderRuns();
      await renderSelectedRun();
    });
    return button;
  }));
}

async function renderSelectedRun() {
  const run = runs.find((candidate) => candidate.runId === selectedRunId);
  if (!run) {
    runDetail.className = "empty-state";
    runDetail.textContent = "No runs found.";
    return;
  }

  if (selectedKind === "executive-summary" && !run.hasExecutiveSummary) selectedKind = "summary";
  if (selectedKind === "summary" && !run.hasSummary) selectedKind = "executive-summary";

  runDetail.className = "run-detail";
  runDetail.replaceChildren();
  const header = document.createElement("header");
  header.className = "detail-header";
  header.innerHTML = "<div><p></p><h2></h2></div><dl></dl>";
  header.querySelector("p").textContent = [run.status || "unknown status", run.runId].join(" · ");
  header.querySelector("h2").textContent = formatRunTitle(run);
  header.querySelector("dl").append(
    metric("Records", run.totalRecords),
    metric("Preflight", run.preflightExceptions),
    metric("Environment", run.environmentExceptions),
    metric("Close", run.closeExceptions),
  );

  const tabs = document.createElement("div");
  tabs.className = "tabs";
  tabs.append(tab("executive-summary", "Executive Summary", run.hasExecutiveSummary), tab("summary", "Summary", run.hasSummary));

  const artifacts = document.createElement("nav");
  artifacts.className = "artifact-links";
  artifacts.setAttribute("aria-label", "Artifacts");
  for (const artifact of run.artifacts || []) {
    const link = document.createElement("a");
    link.href = artifact.url;
    link.textContent = artifact.name;
    link.target = "_blank";
    link.rel = "noreferrer";
    artifacts.append(link);
  }

  const markdown = document.createElement("article");
  markdown.className = "markdown-view";
  markdown.textContent = "Loading...";
  runDetail.append(header, tabs, artifacts, markdown);
  await loadMarkdown(run, markdown);
}

async function loadMarkdown(run, container) {
  if (!run.hasExecutiveSummary && !run.hasSummary) {
    container.textContent = "No summary markdown is available for this run.";
    return;
  }
  const response = await fetch("/api/runs/" + encodeURIComponent(run.runId) + "/markdown/" + selectedKind);
  if (!response.ok) {
    container.textContent = "Markdown file not found.";
    return;
  }
  const payload = await response.json();
  container.innerHTML = payload.html;
}

function tab(kind, label, enabled) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = kind === selectedKind ? "tab selected" : "tab";
  button.disabled = !enabled;
  button.textContent = label;
  button.addEventListener("click", async () => {
    selectedKind = kind;
    await renderSelectedRun();
  });
  return button;
}

function metric(label, value) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = "<dt></dt><dd></dd>";
  wrapper.querySelector("dt").textContent = label;
  wrapper.querySelector("dd").textContent = value ?? "n/a";
  return wrapper;
}

function formatCount(value) {
  return typeof value === "number" ? value + " records" : "";
}

function formatRunTitle(run) {
  return [run.targetLabel, formatRunTimestamp(run)].filter(Boolean).join(" - ") || run.displayName || formatRunId(run.runId);
}

function formatRunTimestamp(run) {
  const date = run.timestamp ? new Date(run.timestamp) : null;
  if (!date || Number.isNaN(date.getTime())) return formatRunId(run.runId);
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function formatRunId(runId) {
  return String(runId || "Untitled run").replace(/^run-/, "");
}

loadRuns().catch((error) => {
  runDetail.className = "empty-state";
  runDetail.textContent = error.message;
});
`;

const STYLES_CSS = `
:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #1e252b;
  background: #f7f8fa;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
}
.app-shell {
  display: grid;
  grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
  min-height: 100vh;
}
.run-pane {
  border-right: 1px solid #d9dee5;
  background: #ffffff;
  overflow: auto;
}
.run-pane header {
  padding: 20px;
  border-bottom: 1px solid #e4e7ec;
}
h1 {
  margin: 0;
  font-size: 20px;
  line-height: 1.2;
}
.run-list {
  display: grid;
  gap: 1px;
}
.run-item {
  width: 100%;
  padding: 14px 20px;
  border: 0;
  border-bottom: 1px solid #edf0f3;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.run-item:hover,
.run-item.selected {
  background: #eef5f8;
}
.run-item strong,
.run-item span {
  display: block;
  overflow-wrap: anywhere;
}
.run-item strong {
  font-size: 14px;
}
.run-item span {
  margin-top: 4px;
  color: #66717d;
  font-size: 12px;
}
.run-item .run-id {
  color: #3f4a55;
  font-family: "SFMono-Regular", Consolas, monospace;
}
.detail-pane {
  min-width: 0;
  overflow: auto;
}
.empty-state {
  padding: 32px;
  color: #66717d;
}
.run-detail {
  padding: 24px 32px 48px;
}
.detail-header {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  padding-bottom: 20px;
  border-bottom: 1px solid #dfe4ea;
}
.detail-header p {
  margin: 0 0 6px;
  color: #66717d;
  font-size: 13px;
  text-transform: uppercase;
}
.detail-header h2 {
  margin: 0;
  font-size: 22px;
  overflow-wrap: anywhere;
}
dl {
  display: grid;
  grid-template-columns: repeat(4, minmax(72px, 1fr));
  gap: 12px;
  margin: 0;
}
dt {
  color: #66717d;
  font-size: 12px;
}
dd {
  margin: 2px 0 0;
  font-weight: 700;
}
.tabs,
.artifact-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.tabs {
  margin-top: 22px;
  padding-bottom: 12px;
  border-bottom: 1px solid #dfe4ea;
}
.tab {
  min-width: 148px;
  padding: 11px 16px;
  border: 1px solid #aebdca;
  border-radius: 6px;
  background: #ffffff;
  color: #17242d;
  font: inherit;
  font-size: 15px;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
}
.tab.selected {
  border-color: #27606f;
  background: #27606f;
  color: #ffffff;
}
.tab:disabled {
  color: #98a2ad;
  cursor: not-allowed;
}
.artifact-links {
  margin-top: 12px;
}
.artifact-links a {
  padding: 6px 8px;
  border: 1px solid #d8dde4;
  border-radius: 6px;
  background: #f7f8fa;
  color: #52606c;
  font: inherit;
  font-size: 12px;
  line-height: 1;
  text-decoration: none;
}
.markdown-view {
  max-width: 980px;
  margin-top: 24px;
  padding-top: 8px;
}
.markdown-view img {
  max-width: 100%;
  height: auto;
  border: 1px solid #d7dde3;
}
.markdown-view table {
  width: 100%;
  border-collapse: collapse;
}
.markdown-view th,
.markdown-view td {
  padding: 8px;
  border: 1px solid #d7dde3;
}
.markdown-view tr.attention-row {
  background: #fff4d6;
}
.markdown-view tr.attention-row td {
  border-color: #e1b85f;
}
.markdown-view tr.severity-error {
  background: #fff1f2;
}
.markdown-view tr.severity-error td {
  border-color: #f0b8c0;
}
.markdown-view tr.severity-warning {
  background: #fff8e5;
}
.markdown-view tr.severity-warning td {
  border-color: #e7c96d;
}
.markdown-view tr.severity-info {
  background: #edf6ff;
}
.markdown-view tr.severity-info td {
  border-color: #a8cdeb;
}
.severity-badge {
  display: inline-flex;
  align-items: center;
  min-width: 64px;
  justify-content: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  line-height: 1.4;
}
.severity-badge.severity-error {
  background: #b4232f;
  color: #ffffff;
}
.severity-badge.severity-warning {
  background: #8a5c00;
  color: #ffffff;
}
.severity-badge.severity-info {
  background: #1769a6;
  color: #ffffff;
}
.align-right {
  text-align: right;
}
.directory-page {
  padding: 32px;
}
.directory-listing {
  max-width: 880px;
}
.eyebrow {
  color: #66717d;
  overflow-wrap: anywhere;
}
.directory-listing li {
  margin: 8px 0;
}
@media (max-width: 760px) {
  .app-shell {
    grid-template-columns: 1fr;
  }
  .run-pane {
    max-height: 42vh;
    border-right: 0;
    border-bottom: 1px solid #d9dee5;
  }
  .run-detail {
    padding: 20px;
  }
  .detail-header {
    display: block;
  }
  dl {
    grid-template-columns: repeat(2, minmax(72px, 1fr));
    margin-top: 16px;
  }
}
`;
