import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { AuditEventSchema } from "../domain/schema.js";
import type { AuditEvent, TargetName, ValidationException } from "../domain/schema.js";

export interface AuditStoreOptions {
  runsDir: string;
  runId: string;
  now?: () => string;
}

export interface WriteEventInput {
  recordId?: string;
  target?: TargetName;
  phase: string;
  actionType: string;
  rationale?: string;
  screenshotPath?: string;
  result: string;
  exceptionCode?: AuditEvent["exceptionCode"];
}

export class FileAuditStore {
  private readonly screenshotCounts = new Map<string, number>();
  private readonly exceptionCounts = new Map<string, number>();

  private constructor(
    public readonly runDir: string,
    public readonly runId: string,
    private readonly now: () => string,
  ) {}

  static async create(options: AuditStoreOptions): Promise<FileAuditStore> {
    const runId = safeSegment(options.runId, "runId");
    const runDir = join(options.runsDir, runId);
    await mkdir(join(runDir, "input"), { recursive: true });
    await mkdir(join(runDir, "screenshots"), { recursive: true });
    await mkdir(join(runDir, "exceptions"), { recursive: true });
    return new FileAuditStore(runDir, runId, options.now ?? (() => new Date().toISOString()));
  }

  async writeRunMetadata(metadata: Record<string, unknown>): Promise<void> {
    await writeFile(join(this.runDir, "run.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  }

  async writeInputArtifact(name: string, content: string): Promise<void> {
    const safeName = safeSegment(name, "input artifact name");
    await writeFile(join(this.runDir, "input", safeName), content);
  }

  async writeEvent(input: WriteEventInput): Promise<AuditEvent> {
    const event = AuditEventSchema.parse({
      timestamp: this.now(),
      runId: this.runId,
      ...input,
    });
    await appendFile(join(this.runDir, "events.jsonl"), `${JSON.stringify(event)}\n`);
    return event;
  }

  async writeScreenshot(recordId: string, target: TargetName, step: string, bytes: Buffer): Promise<string> {
    const safeRecordId = safeArtifactSegment(recordId, "record");
    const safeTarget = safeArtifactSegment(target, "target");
    const safeStep = safeArtifactSegment(step, "step");
    const key = `${safeRecordId}/${safeTarget}/${safeStep}`;
    const screenshotDir = join(this.runDir, "screenshots", safeRecordId, safeTarget);
    await mkdir(screenshotDir, { recursive: true });
    return this.writeUniqueArtifact({
      counts: this.screenshotCounts,
      key,
      makeRelativePath: (count) =>
        join("screenshots", safeRecordId, safeTarget, count === 1 ? `${safeStep}.png` : `${safeStep}-${formatCount(count)}.png`),
      content: bytes,
    });
  }

  async writeException(recordId: string, exception: ValidationException & Record<string, unknown>): Promise<string> {
    const safeRecordId = safeArtifactSegment(recordId, "record");
    return this.writeUniqueArtifact({
      counts: this.exceptionCounts,
      key: safeRecordId,
      makeRelativePath: (count) =>
        join("exceptions", count === 1 ? `${safeRecordId}.json` : `${safeRecordId}-${formatCount(count)}.json`),
      content: `${JSON.stringify(exception, null, 2)}\n`,
    });
  }

  async writeSummary(markdown: string): Promise<void> {
    await writeFile(join(this.runDir, "summary.md"), markdown);
  }

  private nextCount(counts: Map<string, number>, key: string): number {
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count;
  }

  private async writeUniqueArtifact(input: {
    counts: Map<string, number>;
    key: string;
    makeRelativePath: (count: number) => string;
    content: string | Buffer;
  }): Promise<string> {
    let count = this.nextCount(input.counts, input.key);

    while (true) {
      const relativePath = input.makeRelativePath(count);
      try {
        await writeFile(join(this.runDir, relativePath), input.content, { flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY });
        input.counts.set(input.key, count);
        return relativePath;
      } catch (error) {
        if (!isFileExistsError(error)) {
          throw error;
        }
        count += 1;
      }
    }
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function safeSegment(value: string, label: string): string {
  if (value.includes("/") || value.includes("\\")) {
    throw new Error(`${label} must be a single path segment.`);
  }

  const segment = sanitize(value);
  if (segment.length === 0 || segment === "." || segment === "..") {
    throw new Error(`${label} must not be empty.`);
  }

  return segment;
}

function safeArtifactSegment(value: string, fallback: string): string {
  const segment = sanitize(value);
  if (segment.length === 0 || segment === "." || segment === "..") {
    return fallback;
  }
  return segment;
}

function formatCount(count: number): string {
  return String(count).padStart(4, "0");
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
