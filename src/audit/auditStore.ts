import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  private constructor(
    public readonly runDir: string,
    public readonly runId: string,
    private readonly now: () => string,
  ) {}

  static async create(options: AuditStoreOptions): Promise<FileAuditStore> {
    const runDir = join(options.runsDir, options.runId);
    await mkdir(join(runDir, "input"), { recursive: true });
    await mkdir(join(runDir, "screenshots"), { recursive: true });
    await mkdir(join(runDir, "exceptions"), { recursive: true });
    return new FileAuditStore(runDir, options.runId, options.now ?? (() => new Date().toISOString()));
  }

  async writeRunMetadata(metadata: Record<string, unknown>): Promise<void> {
    await writeFile(join(this.runDir, "run.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  }

  async writeInputArtifact(name: string, content: string): Promise<void> {
    await writeFile(join(this.runDir, "input", name), content);
  }

  async writeEvent(input: WriteEventInput): Promise<AuditEvent> {
    const event: AuditEvent = {
      timestamp: this.now(),
      runId: this.runId,
      ...input,
    };
    await appendFile(join(this.runDir, "events.jsonl"), `${JSON.stringify(event)}\n`);
    return event;
  }

  async writeScreenshot(recordId: string, target: TargetName, step: string, bytes: Buffer): Promise<string> {
    const safeStep = sanitize(step);
    const relativePath = join("screenshots", recordId, target, `${safeStep}.png`);
    const screenshotDir = join(this.runDir, "screenshots", recordId, target);
    await mkdir(screenshotDir, { recursive: true });
    await writeFile(join(this.runDir, relativePath), bytes);
    return relativePath;
  }

  async writeException(recordId: string, exception: ValidationException & Record<string, unknown>): Promise<void> {
    await writeFile(join(this.runDir, "exceptions", `${sanitize(recordId)}.json`), `${JSON.stringify(exception, null, 2)}\n`);
  }

  async writeSummary(markdown: string): Promise<void> {
    await writeFile(join(this.runDir, "summary.md"), markdown);
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}
