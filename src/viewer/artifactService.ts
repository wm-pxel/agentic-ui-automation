import { readdir, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, posix, relative, resolve } from "node:path";

export type MarkdownKind = "summary" | "executive-summary";

export interface ViewerTargetCounts {
  succeeded?: number;
  exception?: number;
  skipped?: number;
  [status: string]: number | undefined;
}

export interface ViewerArtifactLink {
  name: string;
  path: string;
  type: "file" | "directory";
  url: string;
}

export interface ViewerRunSummary {
  runId: string;
  timestamp?: string;
  status?: string;
  totalRecords?: number;
  preflightExceptions?: number;
  environmentExceptions?: number;
  closeExceptions?: number;
  targetCounts: Record<string, ViewerTargetCounts>;
  hasExecutiveSummary: boolean;
  hasSummary: boolean;
  artifacts: ViewerArtifactLink[];
}

export interface ViewerMarkdown {
  fileName: string;
  markdown: string;
}

export interface ResolvedArtifact {
  absolutePath: string;
  contentType: string;
}

export interface ViewerArtifactDirectoryEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  url: string;
}

export interface ViewerArtifactDirectory {
  path: string;
  entries: ViewerArtifactDirectoryEntry[];
}

export interface ArtifactService {
  listRuns(): Promise<ViewerRunSummary[]>;
  readMarkdown(runId: string, kind: string): Promise<ViewerMarkdown | null>;
  resolveArtifact(runId: string, artifactPath: string): Promise<ResolvedArtifact | null>;
  listArtifactDirectory(runId: string, artifactPath: string): Promise<ViewerArtifactDirectory | null>;
}

export interface ArtifactServiceOptions {
  runsDir: string;
}

const MARKDOWN_FILES: Record<MarkdownKind, string> = {
  "executive-summary": "executive-summary.md",
  summary: "summary.md",
};

const KNOWN_ARTIFACTS: Array<{ name: string; path: string }> = [
  { name: "Structured report", path: "report.json" },
  { name: "Event log", path: "events.jsonl" },
  { name: "Normalized records", path: "input/normalized-records.json" },
  { name: "Exceptions", path: "exceptions" },
  { name: "Screenshots", path: "screenshots" },
];

export function createArtifactService(options: ArtifactServiceOptions): ArtifactService {
  const runsRoot = resolve(options.runsDir);

  async function listRuns(): Promise<ViewerRunSummary[]> {
    const entries = await readdir(runsRoot, { withFileTypes: true });
    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => summarizeRun(runsRoot, entry.name)),
    );

    return runs.sort((left, right) => compareRunsNewestFirst(left, right));
  }

  async function readMarkdown(runId: string, kind: string): Promise<ViewerMarkdown | null> {
    if (!isMarkdownKind(kind)) return null;
    const runDir = resolveRunDir(runsRoot, runId);
    if (!runDir) return null;

    const fileName = MARKDOWN_FILES[kind];
    try {
      const markdown = await readFile(join(runDir, fileName), "utf8");
      return { fileName, markdown };
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }

  async function resolveArtifact(runId: string, artifactPath: string): Promise<ResolvedArtifact | null> {
    const artifact = resolveArtifactPath(runsRoot, runId, artifactPath);
    if (!artifact) return null;

    try {
      const artifactStat = await stat(artifact.absolutePath);
      if (!artifactStat.isFile()) return null;
      return {
        absolutePath: artifact.absolutePath,
        contentType: contentTypeForPath(artifact.normalizedPath),
      };
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }

  async function listArtifactDirectory(runId: string, artifactPath: string): Promise<ViewerArtifactDirectory | null> {
    const artifact = resolveArtifactPath(runsRoot, runId, artifactPath);
    if (!artifact) return null;

    try {
      const artifactStat = await stat(artifact.absolutePath);
      if (!artifactStat.isDirectory()) return null;
      const children = await readdir(artifact.absolutePath, { withFileTypes: true });
      const entries = children
        .filter((child) => child.isDirectory() || child.isFile())
        .map((child) => {
          const childPath = joinArtifactPath(artifact.normalizedPath, child.name);
          const type = child.isDirectory() ? "directory" : "file";
          return {
            name: child.name,
            path: childPath,
            type,
            url: artifactUrl(runId, childPath),
          } satisfies ViewerArtifactDirectoryEntry;
        })
        .sort((left, right) => left.name.localeCompare(right.name));

      return {
        path: artifact.normalizedPath,
        entries,
      };
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }

  return {
    listRuns,
    readMarkdown,
    resolveArtifact,
    listArtifactDirectory,
  };
}

async function summarizeRun(runsRoot: string, runId: string): Promise<ViewerRunSummary> {
  const runDir = join(runsRoot, runId);
  const [runMetadata, report, hasExecutiveSummary, hasSummary, artifacts] = await Promise.all([
    readJsonObject(join(runDir, "run.json")),
    readJsonObject(join(runDir, "report.json")),
    pathExistsAs(join(runDir, "executive-summary.md"), "file"),
    pathExistsAs(join(runDir, "summary.md"), "file"),
    listKnownArtifacts(runDir, runId),
  ]);

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
}

async function listKnownArtifacts(runDir: string, runId: string): Promise<ViewerArtifactLink[]> {
  const links = await Promise.all(
    KNOWN_ARTIFACTS.map(async (artifact) => {
      try {
        const artifactStat = await stat(join(runDir, artifact.path));
        if (!artifactStat.isFile() && !artifactStat.isDirectory()) return null;
        return {
          name: artifact.name,
          path: artifact.path,
          type: artifactStat.isDirectory() ? "directory" : "file",
          url: artifactUrl(runId, artifact.path),
        } satisfies ViewerArtifactLink;
      } catch (error) {
        if (isMissingFileError(error)) return null;
        throw error;
      }
    }),
  );

  return links.filter((link): link is ViewerArtifactLink => link !== null);
}

function resolveRunDir(runsRoot: string, runId: string): string | null {
  if (!isSafeRunId(runId)) return null;
  const runDir = resolve(runsRoot, runId);
  return isPathInside(runsRoot, runDir) ? runDir : null;
}

function resolveArtifactPath(
  runsRoot: string,
  runId: string,
  artifactPath: string,
): { absolutePath: string; normalizedPath: string } | null {
  const runDir = resolveRunDir(runsRoot, runId);
  const normalizedPath = normalizeArtifactPath(artifactPath);
  if (!runDir || normalizedPath === null) return null;

  const absolutePath = resolve(runDir, ...normalizedPath.split("/").filter(Boolean));
  if (!isPathInside(runDir, absolutePath)) return null;
  return { absolutePath, normalizedPath };
}

function normalizeArtifactPath(artifactPath: string): string | null {
  if (artifactPath.includes("\0") || artifactPath.includes("\\") || isAbsolute(artifactPath)) {
    return null;
  }

  const normalized = posix.normalize(artifactPath);
  if (normalized === ".") return "";
  if (normalized === ".." || normalized.startsWith("../")) return null;
  return normalized.replace(/^\/+/, "");
}

function isSafeRunId(runId: string): boolean {
  return (
    runId.length > 0 &&
    !runId.includes("\0") &&
    !runId.includes("/") &&
    !runId.includes("\\") &&
    !isAbsolute(runId) &&
    runId !== "." &&
    runId !== ".."
  );
}

function isPathInside(parent: string, child: string): boolean {
  const childRelativePath = relative(parent, child);
  return childRelativePath === "" || (!childRelativePath.startsWith("..") && !isAbsolute(childRelativePath));
}

function isMarkdownKind(kind: string): kind is MarkdownKind {
  return kind === "summary" || kind === "executive-summary";
}

function compareRunsNewestFirst(left: ViewerRunSummary, right: ViewerRunSummary): number {
  const leftTime = timestampSortValue(left.timestamp);
  const rightTime = timestampSortValue(right.timestamp);
  if (leftTime !== rightTime) return rightTime - leftTime;
  return right.runId.localeCompare(left.runId);
}

function timestampSortValue(timestamp: string | undefined): number {
  if (!timestamp) return 0;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function timestampFromRunId(runId: string): string | undefined {
  const match = /^run-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(runId);
  if (!match) return undefined;
  const [, date, hours, minutes, seconds, milliseconds] = match;
  return `${date}T${hours}:${minutes}:${seconds}.${milliseconds}Z`;
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch (error) {
    if (isMissingFileError(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function pathExistsAs(path: string, expectedType: "file" | "directory"): Promise<boolean> {
  try {
    const pathStat = await stat(path);
    return expectedType === "file" ? pathStat.isFile() : pathStat.isDirectory();
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

function parseTargetCounts(value: Record<string, unknown> | undefined): Record<string, ViewerTargetCounts> {
  if (!value) return {};
  const targetCounts: Record<string, ViewerTargetCounts> = {};

  for (const [target, counts] of Object.entries(value)) {
    if (!isRecord(counts)) continue;
    const parsedCounts: ViewerTargetCounts = {};
    for (const [status, count] of Object.entries(counts)) {
      if (typeof count === "number") {
        parsedCounts[status] = count;
      }
    }
    targetCounts[target] = parsedCounts;
  }

  return targetCounts;
}

function objectProperty(value: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const property = value?.[key];
  return isRecord(property) ? property : undefined;
}

function stringProperty(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const property = value?.[key];
  return typeof property === "string" ? property : undefined;
}

function numberProperty(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const property = value?.[key];
  return typeof property === "number" ? property : undefined;
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined);
}

function firstNumber(...values: Array<number | undefined>): number | undefined {
  return values.find((value) => value !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function artifactUrl(runId: string, artifactPath: string): string {
  const encodedRunId = encodeURIComponent(runId);
  const encodedPath = artifactPath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/api/runs/${encodedRunId}/artifact/${encodedPath}`;
}

function joinArtifactPath(parentPath: string, childName: string): string {
  return parentPath ? `${parentPath}/${childName}` : childName;
}

function contentTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".csv":
      return "text/csv; charset=utf-8";
    case ".gif":
      return "image/gif";
    case ".htm":
    case ".html":
      return "text/html; charset=utf-8";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".jsonl":
      return "application/x-ndjson; charset=utf-8";
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}
