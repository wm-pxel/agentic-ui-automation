# Output Markdown Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a localhost-only web viewer that lists workflow runs and renders each run's generated Markdown summaries with working screenshot and artifact links.

**Architecture:** Add a focused `src/viewer/` module with three boundaries: artifact filesystem access, generated-summary Markdown rendering, and an HTTP server that serves JSON/HTML/artifact routes. Wire the server into the existing Commander CLI as a new `viewer` command and add `npm run viewer` as the user-facing script.

**Tech Stack:** TypeScript, Node built-in `http`, `fs/promises`, `path`, Commander, Vitest, existing npm scripts. No new runtime dependencies.

---

## File Structure

- Create `src/viewer/artifactService.ts`: read-only run discovery, metadata fallback, Markdown reads, artifact path safety, and artifact directory listing.
- Create `src/viewer/markdownRenderer.ts`: small generated-summary Markdown renderer that escapes HTML and rewrites run-relative links/images.
- Create `src/viewer/server.ts`: localhost HTTP server, API routes, artifact routes, HTML shell, browser JavaScript, and CSS.
- Modify `src/cli.ts`: add `viewer` command and inject a start function for CLI tests.
- Modify `package.json`: add `viewer` script.
- Create `tests/viewer/artifactService.test.ts`: temporary-directory tests for run scanning, metadata fallback, Markdown reads, and path safety.
- Create `tests/viewer/markdownRenderer.test.ts`: renderer coverage for tables, code blocks, links, images, and escaping.
- Create `tests/viewer/server.test.ts`: route-level tests against an ephemeral server.
- Modify `tests/cli.test.ts`: viewer option parsing and startup failure coverage using injected starter.
- Modify `README.md`: document the viewer in Contents, Development, Audit Artifacts, and CLI sections.
- Modify `docs/demo.md` when it contains manual audit artifact review steps; leave it unchanged when it does not mention artifact review.

---

### Task 1: Artifact Service

**Files:**
- Create: `src/viewer/artifactService.ts`
- Test: `tests/viewer/artifactService.test.ts`

- [ ] **Step 1: Write failing artifact service tests**

Create `tests/viewer/artifactService.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the failing test**

Run:

```sh
npm test -- tests/viewer/artifactService.test.ts
```

Expected: fails because `src/viewer/artifactService.ts` does not exist.

- [ ] **Step 3: Implement the artifact service**

Create `src/viewer/artifactService.ts`:

```ts
import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

export type MarkdownKind = "executive-summary" | "summary";

export interface ViewerRunSummary {
  runId: string;
  timestamp?: string;
  status?: string;
  totalRecords?: number;
  preflightExceptions?: number;
  environmentExceptions?: number;
  closeExceptions?: number;
  targetCounts: Record<string, Record<string, number>>;
  hasExecutiveSummary: boolean;
  hasSummary: boolean;
  artifacts: ViewerArtifactLink[];
}

export interface ViewerArtifactLink {
  label: string;
  path: string;
  url: string;
}

export interface ViewerMarkdown {
  fileName: "executive-summary.md" | "summary.md";
  markdown: string;
}

export interface ResolvedArtifact {
  absolutePath: string;
  contentType: string;
}

export interface ViewerArtifactDirectory {
  path: string;
  entries: ViewerArtifactDirectoryEntry[];
}

export interface ViewerArtifactDirectoryEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  url: string;
}

export interface ArtifactService {
  runsDir: string;
  listRuns(): Promise<ViewerRunSummary[]>;
  readMarkdown(runId: string, kind: string): Promise<ViewerMarkdown | null>;
  resolveArtifact(runId: string, artifactPath: string): Promise<ResolvedArtifact | null>;
  listArtifactDirectory(runId: string, artifactPath: string): Promise<ViewerArtifactDirectory | null>;
}

export function createArtifactService(options: { runsDir: string }): ArtifactService {
  const runsDir = resolve(options.runsDir);

  return {
    runsDir,

    async listRuns() {
      const entries = await readdir(runsDir, { withFileTypes: true });
      const runs = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => summarizeRun(runsDir, entry.name)),
      );

      return runs.sort((left, right) => compareRunsNewestFirst(left, right));
    },

    async readMarkdown(runId, kind) {
      const fileName = markdownFileName(kind);
      if (!fileName) return null;

      const runDir = safeJoin(runsDir, runId);
      if (!runDir) return null;

      const filePath = safeJoin(runDir, fileName);
      if (!filePath) return null;

      try {
        return {
          fileName,
          markdown: await readFile(filePath, "utf8"),
        };
      } catch {
        return null;
      }
    },

    async resolveArtifact(runId, artifactPath) {
      if (artifactPath.startsWith("/") || artifactPath.includes("\0")) return null;

      const runDir = safeJoin(runsDir, runId);
      if (!runDir) return null;

      const absolutePath = safeJoin(runDir, artifactPath);
      if (!absolutePath) return null;

      try {
        const artifactStat = await stat(absolutePath);
        if (!artifactStat.isFile()) return null;
        return {
          absolutePath,
          contentType: contentTypeFor(absolutePath),
        };
      } catch {
        return null;
      }
    },

    async listArtifactDirectory(runId, artifactPath) {
      if (artifactPath.startsWith("/") || artifactPath.includes("\0")) return null;

      const runDir = safeJoin(runsDir, runId);
      if (!runDir) return null;

      const absolutePath = safeJoin(runDir, artifactPath);
      if (!absolutePath) return null;

      try {
        const directoryStat = await stat(absolutePath);
        if (!directoryStat.isDirectory()) return null;
        const entries = await readdir(absolutePath, { withFileTypes: true });
        return {
          path: artifactPath,
          entries: entries
            .filter((entry) => entry.isDirectory() || entry.isFile())
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((entry) => {
              const childPath = `${artifactPath.replace(/\/$/, "")}/${entry.name}`;
              return {
                name: entry.name,
                path: childPath,
                type: entry.isDirectory() ? "directory" : "file",
                url: `/api/runs/${encodeURIComponent(runId)}/artifact/${encodeArtifactPath(childPath)}`,
              };
            }),
        };
      } catch {
        return null;
      }
    },
  };
}

async function summarizeRun(runsDir: string, runId: string): Promise<ViewerRunSummary> {
  const runDir = join(runsDir, runId);
  const runJson = await readJsonObject(join(runDir, "run.json"));
  const reportJson = await readJsonObject(join(runDir, "report.json"));
  const counts = readObject(reportJson?.counts);
  const runStatus = stringValue(reportJson?.status) ?? stringValue(runJson?.status);

  return {
    runId,
    timestamp: stringValue(runJson?.startedAt) ?? stringValue(runJson?.timestamp) ?? timestampFromRunId(runId),
    status: runStatus,
    totalRecords: numberValue(reportJson?.totalRecords) ?? numberValue(runJson?.totalRecords),
    preflightExceptions: numberValue(counts?.preflightExceptions) ?? numberValue(runJson?.preflightExceptions),
    environmentExceptions: numberValue(counts?.environmentExceptions) ?? numberValue(runJson?.environmentExceptions),
    closeExceptions: numberValue(counts?.closeExceptions) ?? numberValue(runJson?.closeExceptions),
    targetCounts: readTargetCounts(counts?.targetCounts ?? runJson?.targetCounts),
    hasExecutiveSummary: await exists(join(runDir, "executive-summary.md")),
    hasSummary: await exists(join(runDir, "summary.md")),
    artifacts: await artifactLinks(runDir, runId),
  };
}

async function artifactLinks(runDir: string, runId: string): Promise<ViewerArtifactLink[]> {
  const candidates = [
    ["Report JSON", "report.json"],
    ["Events JSONL", "events.jsonl"],
    ["Normalized Records", "input/normalized-records.json"],
    ["Exceptions", "exceptions"],
    ["Screenshots", "screenshots"],
  ] as const;
  const links: ViewerArtifactLink[] = [];

  for (const [label, path] of candidates) {
    if (await exists(join(runDir, path))) {
      links.push({
        label,
        path,
        url: `/api/runs/${encodeURIComponent(runId)}/artifact/${encodeArtifactPath(path)}`,
      });
    }
  }

  return links;
}

function compareRunsNewestFirst(left: ViewerRunSummary, right: ViewerRunSummary): number {
  const leftTime = left.timestamp ? Date.parse(left.timestamp) : 0;
  const rightTime = right.timestamp ? Date.parse(right.timestamp) : 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return right.runId.localeCompare(left.runId);
}

function markdownFileName(kind: string): ViewerMarkdown["fileName"] | null {
  if (kind === "executive-summary") return "executive-summary.md";
  if (kind === "summary") return "summary.md";
  return null;
}

function safeJoin(root: string, path: string): string | null {
  if (path.includes("\0")) return null;
  const resolved = resolve(root, path);
  const relativePath = relative(root, resolved);
  if (relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith(sep))) {
    return resolved;
  }
  return null;
}

function encodeArtifactPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return readObject(parsed);
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readTargetCounts(value: unknown): Record<string, Record<string, number>> {
  const object = readObject(value);
  if (!object) return {};

  const counts: Record<string, Record<string, number>> = {};
  for (const [target, targetCounts] of Object.entries(object)) {
    const targetObject = readObject(targetCounts);
    if (!targetObject) continue;

    counts[target] = {};
    for (const [status, count] of Object.entries(targetObject)) {
      if (typeof count === "number") counts[target][status] = count;
    }
  }

  return counts;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestampFromRunId(runId: string): string | undefined {
  const match = /^run-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(runId);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, millisecond] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}Z`;
}

function contentTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".jsonl":
      return "application/x-ndjson; charset=utf-8";
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".csv":
      return "text/csv; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
```

- [ ] **Step 4: Run artifact service tests**

Run:

```sh
npm test -- tests/viewer/artifactService.test.ts
```

Expected: all tests in `artifactService.test.ts` pass.

- [ ] **Step 5: Commit**

```sh
git add src/viewer/artifactService.ts tests/viewer/artifactService.test.ts
git commit -m "feat: add viewer artifact service"
```

---

### Task 2: Markdown Renderer

**Files:**
- Create: `src/viewer/markdownRenderer.ts`
- Test: `tests/viewer/markdownRenderer.test.ts`

- [ ] **Step 1: Write failing renderer tests**

Create `tests/viewer/markdownRenderer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../src/viewer/markdownRenderer.js";

describe("renderMarkdown", () => {
  it("renders generated-summary headings, lists, tables, and fenced code blocks", () => {
    const html = renderMarkdown(
      [
        "# Workflow Run run-1",
        "",
        "- [Artifacts](#artifacts)",
        "- Plain item",
        "",
        "| Target | Succeeded |",
        "| --- | ---: |",
        "| openmrs | 1 |",
        "",
        "```json",
        "{",
        "  \"status\": \"completed\"",
        "}",
        "```",
      ].join("\n"),
      { runId: "run-1" },
    );

    expect(html).toContain('<h1 id="workflow-run-run-1">Workflow Run run-1</h1>');
    expect(html).toContain('<a href="#artifacts">Artifacts</a>');
    expect(html).toContain("<li>Plain item</li>");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>Target</th>");
    expect(html).toContain('<th class="align-right">Succeeded</th>');
    expect(html).toContain('<code class="language-json">');
    expect(html).toContain("&quot;status&quot;: &quot;completed&quot;");
  });

  it("rewrites run-relative artifact links and images", () => {
    const html = renderMarkdown(
      [
        "[Structured report](report.json)",
        "",
        "![Proof](screenshots/demo-001/openmrs/after-save.png)",
      ].join("\n"),
      { runId: "run-abc" },
    );

    expect(html).toContain('<a href="/api/runs/run-abc/artifact/report.json" target="_blank" rel="noreferrer">Structured report</a>');
    expect(html).toContain('<img src="/api/runs/run-abc/artifact/screenshots/demo-001/openmrs/after-save.png" alt="Proof">');
  });

  it("escapes raw HTML and unsafe javascript URLs", () => {
    const html = renderMarkdown('<script>alert("x")</script>\n\n[bad](javascript:alert(1))', {
      runId: "run-safe",
    });

    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain('<a href="#" target="_blank" rel="noreferrer">bad</a>');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:alert");
  });
});
```

- [ ] **Step 2: Run the failing renderer test**

Run:

```sh
npm test -- tests/viewer/markdownRenderer.test.ts
```

Expected: fails because `src/viewer/markdownRenderer.ts` does not exist.

- [ ] **Step 3: Implement the renderer**

Create `src/viewer/markdownRenderer.ts`:

```ts
export interface RenderMarkdownOptions {
  runId: string;
}

export function renderMarkdown(markdown: string, options: RenderMarkdownOptions): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const className = language ? ` class="language-${escapeAttribute(language)}"` : "";
      html.push(`<pre><code${className}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    if (isTableStart(lines, index)) {
      const tableLines: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        tableLines.push(lines[index]);
        index += 1;
      }
      html.push(renderTable(tableLines, options));
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = renderInline(heading[2], options);
      const id = slugify(stripMarkdown(heading[2]));
      html.push(`<h${level} id="${escapeAttribute(id)}">${text}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*-\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*-\s+/.test(lines[index])) {
        items.push(`<li>${renderInline(lines[index].replace(/^\s*-\s+/, ""), options)}</li>`);
        index += 1;
      }
      html.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() !== "" &&
      !lines[index].startsWith("```") &&
      !isTableStart(lines, index) &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !/^\s*-\s+/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    html.push(`<p>${renderInline(paragraph.join(" "), options)}</p>`);
  }

  return html.join("\n");
}

function isTableStart(lines: string[], index: number): boolean {
  return Boolean(
    lines[index]?.trim().startsWith("|") &&
      lines[index + 1]?.trim().startsWith("|") &&
      /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[index + 1].trim()),
  );
}

function renderTable(lines: string[], options: RenderMarkdownOptions): string {
  const [headerLine, alignmentLine, ...bodyLines] = lines;
  const headers = splitTableRow(headerLine);
  const alignments = splitTableRow(alignmentLine).map((cell) => (cell.trim().endsWith(":") ? "right" : "left"));
  const head = headers
    .map((header, index) => `<th${alignClass(alignments[index])}>${renderInline(header.trim(), options)}</th>`)
    .join("");
  const body = bodyLines
    .map((row) => {
      const cells = splitTableRow(row);
      return `<tr>${cells
        .map((cell, index) => `<td${alignClass(alignments[index])}>${renderInline(cell.trim(), options)}</td>`)
        .join("")}</tr>`;
    })
    .join("");

  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function splitTableRow(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
}

function alignClass(alignment: string | undefined): string {
  return alignment === "right" ? ' class="align-right"' : "";
}

function renderInline(text: string, options: RenderMarkdownOptions): string {
  const tokens: string[] = [];
  let output = escapeHtml(text);

  output = output.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt: string, href: string) => {
    const token = `@@TOKEN${tokens.length}@@`;
    tokens.push(`<img src="${escapeAttribute(rewriteUrl(unescapeHtml(href), options.runId))}" alt="${escapeAttribute(unescapeHtml(alt))}">`);
    return token;
  });

  output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) => {
    const token = `@@TOKEN${tokens.length}@@`;
    tokens.push(
      `<a href="${escapeAttribute(rewriteUrl(unescapeHtml(href), options.runId))}" target="_blank" rel="noreferrer">${label}</a>`,
    );
    return token;
  });

  output = output.replace(/`([^`]+)`/g, "<code>$1</code>");

  return tokens.reduce((current, token, index) => current.replace(`@@TOKEN${index}@@`, token), output);
}

function rewriteUrl(rawUrl: string, runId: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith("#")) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^javascript:/i.test(trimmed)) return "#";
  if (trimmed.startsWith("/") || trimmed.includes("\0")) return "#";
  const encodedPath = trimmed.split("/").map(encodeURIComponent).join("/");
  return `/api/runs/${encodeURIComponent(runId)}/artifact/${encodedPath}`;
}

function stripMarkdown(text: string): string {
  return text.replace(/[`*_()[\]]/g, "").replace(/!\[[^\]]*]\([^)]+\)/g, "").replace(/\[([^\]]+)]\([^)]+\)/g, "$1");
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function unescapeHtml(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
}
```

- [ ] **Step 4: Run renderer tests**

Run:

```sh
npm test -- tests/viewer/markdownRenderer.test.ts
```

Expected: all tests in `markdownRenderer.test.ts` pass.

- [ ] **Step 5: Commit**

```sh
git add src/viewer/markdownRenderer.ts tests/viewer/markdownRenderer.test.ts
git commit -m "feat: render viewer markdown"
```

---

### Task 3: HTTP Viewer Server

**Files:**
- Create: `src/viewer/server.ts`
- Test: `tests/viewer/server.test.ts`

- [ ] **Step 1: Write failing server route tests**

Create `tests/viewer/server.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the failing server tests**

Run:

```sh
npm test -- tests/viewer/server.test.ts
```

Expected: fails because `src/viewer/server.ts` does not exist.

- [ ] **Step 3: Implement the HTTP server**

Create `src/viewer/server.ts`:

```ts
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  const service = createArtifactService({ runsDir: options.runsDir });
  const server = createServer((request, response) => {
    void routeRequest(request, response, service);
  });
  let address: { host: string; port: number } | null = null;

  return {
    async listen({ port, host = "127.0.0.1" }) {
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          rejectListen(error);
        };
        const onListening = () => {
          server.off("error", onError);
          const serverAddress = server.address();
          if (typeof serverAddress === "object" && serverAddress) {
            address = { host, port: serverAddress.port };
          }
          resolveListen();
        };

        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },

    async close() {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) rejectClose(error);
          else resolveClose();
        });
      });
    },

    url() {
      if (!address) throw new Error("Viewer server is not listening.");
      return `http://${address.host}:${address.port}`;
    },
  };
}

export async function startViewerServer(options: { runsDir: string; port?: number; stdout?: { write(chunk: string): unknown } }): Promise<ViewerServer> {
  const runsDir = resolve(options.runsDir);
  const runsDirStat = await stat(runsDir);
  if (!runsDirStat.isDirectory()) {
    throw new Error(`Runs directory is not a directory: ${runsDir}`);
  }

  const server = createViewerServer({ runsDir });
  const port = options.port ?? 4173;
  await server.listen({ port, host: "127.0.0.1" });
  options.stdout?.write(`Viewer available at ${server.url()}\n`);
  return server;
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: ReturnType<typeof createArtifactService>,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method !== "GET") {
    writeJson(response, 405, { error: "Method not allowed." });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    writeText(response, 200, "text/html; charset=utf-8", appHtml());
    return;
  }

  if (url.pathname === "/assets/app.js") {
    writeText(response, 200, "text/javascript; charset=utf-8", appJs());
    return;
  }

  if (url.pathname === "/assets/styles.css") {
    writeText(response, 200, "text/css; charset=utf-8", stylesCss());
    return;
  }

  if (url.pathname === "/api/runs") {
    writeJson(response, 200, { runs: await service.listRuns() });
    return;
  }

  const markdownMatch = /^\/api\/runs\/([^/]+)\/markdown\/([^/]+)$/.exec(url.pathname);
  if (markdownMatch) {
    const runId = decodeURIComponent(markdownMatch[1]);
    const kind = decodeURIComponent(markdownMatch[2]);
    const markdown = await service.readMarkdown(runId, kind);
    if (!markdown) {
      writeJson(response, 404, { error: "Markdown file not found." });
      return;
    }
    writeJson(response, 200, {
      fileName: markdown.fileName,
      markdown: markdown.markdown,
      html: renderMarkdown(markdown.markdown, { runId }),
    });
    return;
  }

  const artifactMatch = /^\/api\/runs\/([^/]+)\/artifact\/(.+)$/.exec(url.pathname);
  if (artifactMatch) {
    const runId = decodeURIComponent(artifactMatch[1]);
    const artifactPath = artifactMatch[2].split("/").map(decodeURIComponent).join("/");
    const artifact = await service.resolveArtifact(runId, artifactPath);
    if (!artifact) {
      const directory = await service.listArtifactDirectory(runId, artifactPath);
      if (!directory) {
        writeJson(response, 404, { error: "Artifact not found." });
        return;
      }
      writeText(response, 200, "text/html; charset=utf-8", directoryHtml(runId, directory.path, directory.entries));
      return;
    }
    response.writeHead(200, { "content-type": artifact.contentType });
    createReadStream(artifact.absolutePath).pipe(response);
    return;
  }

  writeJson(response, 404, { error: "Not found." });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  writeText(response, status, "application/json; charset=utf-8", `${JSON.stringify(body)}\n`);
}

function writeText(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}

function appHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Agentic UI Run Viewer</title>
    <link rel="stylesheet" href="/assets/styles.css">
  </head>
  <body>
    <main class="app">
      <aside class="sidebar">
        <header class="sidebar-header">
          <h1>Runs</h1>
          <button id="refresh-button" type="button">Refresh</button>
        </header>
        <div id="run-list" class="run-list"></div>
      </aside>
      <section class="content">
        <header class="content-header">
          <div>
            <p class="eyebrow">Audit Markdown</p>
            <h2 id="run-title">Select a run</h2>
          </div>
          <nav id="artifact-links" class="artifact-links"></nav>
        </header>
        <div class="tabs">
          <button class="tab active" type="button" data-kind="executive-summary">Executive Summary</button>
          <button class="tab" type="button" data-kind="summary">Summary</button>
        </div>
        <article id="markdown-view" class="markdown empty">Choose a run from the left pane.</article>
      </section>
    </main>
    <script type="module" src="/assets/app.js"></script>
  </body>
</html>`;
}

function directoryHtml(
  runId: string,
  artifactPath: string,
  entries: Array<{ name: string; path: string; type: "file" | "directory"; url: string }>,
): string {
  const rows = entries
    .map(
      (entry) =>
        `<li><a href="${escapeAttribute(entry.url)}">${escapeHtml(entry.name)}${entry.type === "directory" ? "/" : ""}</a></li>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Artifact directory: ${escapeHtml(artifactPath)}</title>
    <link rel="stylesheet" href="/assets/styles.css">
  </head>
  <body>
    <main class="directory-page">
      <p class="eyebrow">${escapeHtml(runId)}</p>
      <h1>Artifact directory: ${escapeHtml(artifactPath)}</h1>
      <ul>${rows}</ul>
    </main>
  </body>
</html>`;
}

function appJs(): string {
  return `
const state = { runs: [], activeRunId: null, activeKind: "executive-summary" };
const runList = document.getElementById("run-list");
const runTitle = document.getElementById("run-title");
const markdownView = document.getElementById("markdown-view");
const artifactLinks = document.getElementById("artifact-links");
document.getElementById("refresh-button").addEventListener("click", loadRuns);
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    state.activeKind = tab.dataset.kind;
    document.querySelectorAll(".tab").forEach((candidate) => candidate.classList.toggle("active", candidate === tab));
    renderSelectedRun();
  });
});
await loadRuns();
async function loadRuns() {
  const response = await fetch("/api/runs");
  const payload = await response.json();
  state.runs = payload.runs;
  state.activeRunId = state.activeRunId ?? state.runs[0]?.runId ?? null;
  renderRunList();
  await renderSelectedRun();
}
function renderRunList() {
  runList.replaceChildren();
  if (state.runs.length === 0) {
    runList.append(empty("No runs found."));
    return;
  }
  for (const run of state.runs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "run-row" + (run.runId === state.activeRunId ? " active" : "");
    button.innerHTML = \`
      <span class="run-id">\${escapeHtml(run.runId)}</span>
      <span class="run-meta">\${escapeHtml(run.status ?? "unknown")} · \${run.totalRecords ?? "?"} records · \${exceptionCount(run)} exceptions</span>
      <span class="run-time">\${escapeHtml(formatTimestamp(run.timestamp))}</span>
    \`;
    button.addEventListener("click", async () => {
      state.activeRunId = run.runId;
      renderRunList();
      await renderSelectedRun();
    });
    runList.append(button);
  }
}
async function renderSelectedRun() {
  const run = state.runs.find((candidate) => candidate.runId === state.activeRunId);
  artifactLinks.replaceChildren();
  if (!run) {
    runTitle.textContent = "Select a run";
    markdownView.className = "markdown empty";
    markdownView.textContent = "Choose a run from the left pane.";
    return;
  }
  runTitle.textContent = run.runId;
  for (const artifact of run.artifacts) {
    const link = document.createElement("a");
    link.href = artifact.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = artifact.label;
    artifactLinks.append(link);
  }
  markdownView.className = "markdown loading";
  markdownView.textContent = "Loading...";
  const response = await fetch(\`/api/runs/\${encodeURIComponent(run.runId)}/markdown/\${state.activeKind}\`);
  if (response.status === 404) {
    markdownView.className = "markdown empty";
    markdownView.textContent = "Markdown file not available for this run.";
    return;
  }
  const payload = await response.json();
  markdownView.className = "markdown";
  markdownView.innerHTML = payload.html;
}
function exceptionCount(run) {
  return (run.preflightExceptions ?? 0) + (run.environmentExceptions ?? 0) + (run.closeExceptions ?? 0);
}
function formatTimestamp(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleString() : "unknown time";
}
function empty(text) {
  const element = document.createElement("p");
  element.className = "empty";
  element.textContent = text;
  return element;
}
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function stylesCss(): string {
  return `
:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f4f6f8; }
body { margin: 0; }
.app { display: grid; grid-template-columns: 340px minmax(0, 1fr); min-height: 100vh; }
.sidebar { border-right: 1px solid #d7dde7; background: #f8fafc; min-width: 0; }
.sidebar-header { display: flex; align-items: center; justify-content: space-between; padding: 16px; border-bottom: 1px solid #d7dde7; }
.sidebar h1 { font-size: 18px; margin: 0; }
button { font: inherit; }
#refresh-button, .tab { border: 1px solid #c9d2df; background: #fff; color: #172033; border-radius: 6px; padding: 7px 10px; cursor: pointer; }
.run-list { display: flex; flex-direction: column; gap: 6px; padding: 10px; }
.run-row { display: grid; gap: 5px; width: 100%; text-align: left; border: 1px solid #dce2eb; background: #fff; border-radius: 6px; padding: 10px; cursor: pointer; }
.run-row.active { border-color: #2f6fed; box-shadow: inset 3px 0 0 #2f6fed; }
.run-id { font-weight: 700; overflow-wrap: anywhere; }
.run-meta, .run-time, .eyebrow { color: #5d6878; font-size: 12px; }
.content { min-width: 0; display: grid; grid-template-rows: auto auto minmax(0, 1fr); }
.content-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 18px 24px; border-bottom: 1px solid #d7dde7; background: #fff; }
.content-header h2 { margin: 2px 0 0; font-size: 20px; overflow-wrap: anywhere; }
.eyebrow { margin: 0; text-transform: uppercase; letter-spacing: .04em; }
.artifact-links { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.artifact-links a { border: 1px solid #c9d2df; color: #244f9e; background: #fff; border-radius: 6px; padding: 6px 9px; text-decoration: none; font-size: 13px; }
.tabs { display: flex; gap: 8px; padding: 12px 24px; background: #fff; border-bottom: 1px solid #d7dde7; }
.tab.active { background: #172033; color: #fff; border-color: #172033; }
.markdown { overflow: auto; padding: 24px; background: #fff; line-height: 1.5; }
.markdown.empty, .markdown.loading { color: #5d6878; }
.markdown h1, .markdown h2, .markdown h3 { line-height: 1.2; }
.markdown table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14px; }
.markdown th, .markdown td { border: 1px solid #d7dde7; padding: 8px 10px; vertical-align: top; }
.markdown th { background: #f4f6f8; text-align: left; }
.markdown .align-right { text-align: right; }
.markdown pre { overflow: auto; background: #111827; color: #f8fafc; border-radius: 6px; padding: 14px; }
.markdown code { font-family: "SFMono-Regular", Consolas, monospace; font-size: .92em; }
.markdown img { max-width: 100%; border: 1px solid #d7dde7; border-radius: 6px; }
.directory-page { max-width: 900px; margin: 0 auto; padding: 32px; background: #fff; min-height: 100vh; }
.directory-page a { color: #244f9e; }
@media (max-width: 860px) { .app { grid-template-columns: 1fr; } .sidebar { border-right: 0; border-bottom: 1px solid #d7dde7; } }
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runsDir = process.argv[2] ?? "runs";
  await startViewerServer({ runsDir, stdout: process.stdout });
}
```

- [ ] **Step 4: Run server tests**

Run:

```sh
npm test -- tests/viewer/server.test.ts
```

Expected: all tests in `server.test.ts` pass.

- [ ] **Step 5: Run all viewer tests**

Run:

```sh
npm test -- tests/viewer
```

Expected: all tests under `tests/viewer` pass.

- [ ] **Step 6: Commit**

```sh
git add src/viewer/server.ts tests/viewer/server.test.ts
git commit -m "feat: serve viewer web app"
```

---

### Task 4: CLI Command And npm Script

**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/cli.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing CLI tests**

Add this import near the existing imports in `tests/cli.test.ts`:

```ts
import type { ViewerServer } from "../src/viewer/server.js";
```

Add these tests inside `describe("runCli", () => { ... })`:

```ts
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

  it("passes viewer runs directory and port options", async () => {
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

  it("returns exit code 1 for invalid viewer ports", async () => {
    const io = captureIo();

    const exitCode = await runCli(["node", "agentic-ui", "viewer", "--port", "0"], io);

    expect(exitCode).toBe(1);
    expect(io.stdoutText()).toBe("");
    expect(io.stderrText()).toContain("--port must be a positive integer.");
  });
```

Add this helper near the existing test helpers:

```ts
function fakeViewerServer(): ViewerServer {
  return {
    listen: async () => undefined,
    close: async () => undefined,
    url: () => "http://127.0.0.1:4173",
  };
}
```

- [ ] **Step 2: Run the failing CLI tests**

Run:

```sh
npm test -- tests/cli.test.ts
```

Expected: TypeScript or test failure because `runCli` does not accept the injected viewer starter and the `viewer` command does not exist.

- [ ] **Step 3: Modify `src/cli.ts`**

Add this import:

```ts
import { startViewerServer, type ViewerServer } from "./viewer/server.js";
```

Add these interfaces near the existing command option interfaces:

```ts
interface ViewerCommandOptions {
  runsDir?: string;
  port?: number;
}

interface CliDependencies {
  startViewerServer?: (options: { runsDir: string; port?: number; stdout?: CliWritable }) => Promise<ViewerServer>;
}
```

Change the `runCli` signature and program creation:

```ts
export async function runCli(argv: string[] = process.argv, io: CliIo = {}, dependencies: CliDependencies = {}): Promise<number> {
  const resolvedIo = {
    stdout: io.stdout ?? defaultIo.stdout,
    stderr: io.stderr ?? defaultIo.stderr,
  };
  const program = createProgram(resolvedIo, dependencies);
```

Change `createProgram` to accept dependencies:

```ts
function createProgram(io: Required<CliIo>, dependencies: CliDependencies): Command {
```

Add the viewer command before `return program;`:

```ts
  program
    .command("viewer")
    .description("Serve a local read-only viewer for workflow run Markdown artifacts.")
    .option("--runs-dir <path>", "Directory containing run artifacts.", "runs")
    .option("--port <number>", "Localhost port for the viewer.", parsePositiveInteger)
    .action(async (options: ViewerCommandOptions) => {
      await viewerCommand(options, io.stdout, dependencies);
    });
```

Add the command handler near `watchCommand`:

```ts
async function viewerCommand(options: ViewerCommandOptions, stdout: CliWritable, dependencies: CliDependencies): Promise<void> {
  const start = dependencies.startViewerServer ?? startViewerServer;
  await start({
    runsDir: options.runsDir ?? "runs",
    port: options.port,
    stdout,
  });
}
```

Rename `parsePositiveInteger` to use the option name in error messages:

```ts
function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--port must be a positive integer.");
  }
  return parsed;
}
```

Then add a new OpenMRS concurrency parser so the existing error remains accurate:

```ts
function parseOpenMrsConcurrency(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--openmrs-concurrency must be a positive integer.");
  }
  return parsed;
}
```

Update both existing `--openmrs-concurrency` option definitions to use `parseOpenMrsConcurrency`.

- [ ] **Step 4: Modify `package.json`**

Add the viewer script next to the existing `dev` script:

```json
"viewer": "tsx src/cli.ts viewer",
```

Keep JSON ordering consistent with nearby scripts.

- [ ] **Step 5: Run CLI tests**

Run:

```sh
npm test -- tests/cli.test.ts
```

Expected: all CLI tests pass.

- [ ] **Step 6: Run typecheck**

Run:

```sh
npm run typecheck
```

Expected: TypeScript passes with no errors.

- [ ] **Step 7: Commit**

```sh
git add src/cli.ts tests/cli.test.ts package.json
git commit -m "feat: add viewer cli command"
```

---

### Task 5: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/demo.md` only if it contains manual audit artifact review steps that should reference the viewer.

- [ ] **Step 1: Update README contents**

In `README.md`, add `Run Viewer` to the Contents list after `Audit Artifacts`:

```md
- [Run Viewer](#run-viewer)
```

- [ ] **Step 2: Add the Run Viewer section**

Add this section after `## Audit Artifacts`:

```md
## Run Viewer

Start the local read-only viewer when you want to inspect generated Markdown
summaries and linked artifacts in a browser:

```sh
npm run viewer
```

The viewer serves `runs/` by default at `http://127.0.0.1:4173`. Use a different
runs directory or port when needed:

```sh
npm run viewer -- --runs-dir runs --port 4555
```

The app lists run folders newest-first, renders `executive-summary.md` and
`summary.md`, and resolves run-relative links so screenshot evidence opens from
the browser. It also exposes raw links for `report.json`, `events.jsonl`,
`input/normalized-records.json`, `exceptions/`, and `screenshots/` when those
artifacts exist.

The viewer is local-only and read-only. It does not run automation, edit records,
delete patients, or modify audit artifacts.
```

- [ ] **Step 3: Add viewer to CLI section**

In the `## CLI` section, add:

```md
Serve the local artifact viewer:

```sh
npm run dev -- viewer --runs-dir runs --port 4173
```
```

- [ ] **Step 4: Check `docs/demo.md` and update only if it reviews artifacts manually**

Run:

```sh
rg -n "summary.md|executive-summary|report.json|screenshots|manual" docs/demo.md
```

If the command prints artifact review instructions, add this sentence near that review step:

```md
For browser-based review, run `npm run viewer` and select the generated run from
the left pane.
```

If the command prints no artifact review instructions, do not modify `docs/demo.md`.

- [ ] **Step 5: Run documentation checks**

Run:

```sh
git diff --check README.md docs/demo.md
```

Expected: no whitespace errors.

- [ ] **Step 6: Commit**

If only README changed:

```sh
git add README.md
git commit -m "docs: document run viewer"
```

If README and demo docs changed:

```sh
git add README.md docs/demo.md
git commit -m "docs: document run viewer"
```

---

### Task 6: End-To-End Verification

**Files:**
- Modify only files needed for fixes found during verification.

- [ ] **Step 1: Run required repository verification**

Run:

```sh
npm run typecheck
npm test
git diff --check
```

Expected: all commands pass.

- [ ] **Step 2: Smoke-test the viewer manually**

Run:

```sh
npm run viewer
```

Expected stdout:

```text
Viewer available at http://127.0.0.1:4173
```

Open `http://127.0.0.1:4173` in a browser. Expected behavior:

- Left pane lists existing run folders from `runs/`.
- Selecting a run renders `executive-summary.md` by default.
- Switching to `Summary` renders `summary.md`.
- Screenshot images in the rendered summary load through `/api/runs/<run-id>/artifact/...`.
- Raw artifact links open in new tabs.

Stop the viewer with `Ctrl-C` after the smoke check.

- [ ] **Step 3: Inspect final diff**

Run:

```sh
git status --short
git diff --stat
git diff -- src/viewer tests/viewer src/cli.ts tests/cli.test.ts package.json README.md docs/demo.md
```

Expected: only viewer implementation, tests, CLI wiring, scripts, and docs are changed.

- [ ] **Step 4: Commit verification fixes when Step 1 or Step 2 required edits**

If Step 1 or Step 2 required changes:

```sh
git add <fixed-files>
git commit -m "fix: stabilize run viewer"
```

If no fixes were needed, do not create an empty commit.
