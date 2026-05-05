import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { AuditEventSchema } from "../domain/schema.js";
import type {
  AuditEvent,
  ExceptionSeverity,
  RunStatus,
  TargetName,
  TargetTaskStatus,
  ValidationException,
} from "../domain/schema.js";

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

export type ReportFieldMappingStatus = "succeeded" | "failed" | "skipped";
export type ReportFieldApprovalSource =
  | "agent"
  | "operator_confirmed"
  | "operator_edited"
  | "operator_skipped"
  | "operator_stopped";

export interface ReportFieldMapping {
  recordId: string;
  target: TargetName;
  sourceField: string;
  targetField: string;
  normalizedValue: string;
  mappingConfidence?: number;
  selectorCandidates: string[];
  selectedSelector?: string;
  action?: "fill" | "select";
  status: ReportFieldMappingStatus;
  agentConfidence?: number;
  confidenceThreshold?: number;
  agentRationale?: string;
  approvalSource?: ReportFieldApprovalSource;
  originalProposedValue?: string;
  finalValue?: string;
  skipReason?: string;
  errorMessage?: string;
}

export interface ReportIssue {
  phase: string;
  target?: TargetName;
  recordId?: string;
  severity?: ExceptionSeverity;
  exceptionCode?: AuditEvent["exceptionCode"];
  message: string;
  suggestedRemediation?: string;
  screenshotPath?: string;
}

export interface ReportAiExtractionField {
  sourceField: string;
  sourceLabel?: string;
  value: string;
  confidence: number;
  evidence?: string;
}

export interface ReportAiExtraction {
  recordId: string;
  model: string;
  sourceDocumentName: string;
  fields: ReportAiExtractionField[];
  additionalFields: ReportAiExtractionField[];
  issues: Array<{ field?: string; message: string; severity: "info" | "warning" | "error" }>;
}

export interface ReportRecordInput {
  recordId: string;
  sourceFormat: string;
  rawInput: unknown;
}

export interface ReportTargetEvidence {
  recordId: string;
  target: TargetName;
  status: TargetTaskStatus;
  screenshotPath?: string;
  fieldScreenshotPath?: string;
  targetRecordId?: string;
  message?: string;
}

export interface ReportDetails {
  fieldMappings: ReportFieldMapping[];
  aiExtractions: ReportAiExtraction[];
  issues: ReportIssue[];
  recordInputs: ReportRecordInput[];
  targetEvidence: ReportTargetEvidence[];
}

export interface RunReport {
  runId: string;
  status: RunStatus;
  totalRecords: number;
  counts: {
    preflightExceptions: number;
    environmentExceptions: number;
    closeExceptions: number;
    targetCounts: Partial<Record<TargetName, Record<TargetTaskStatus, number>>>;
  };
  details: ReportDetails;
}

export type BuildReportInput = Omit<RunReport, "runId" | "counts" | "details"> & RunReport["counts"];

export class FileAuditStore {
  private readonly screenshotCounts = new Map<string, number>();
  private readonly exceptionCounts = new Map<string, number>();
  private readonly reportDetails: ReportDetails = {
    fieldMappings: [],
    aiExtractions: [],
    issues: [],
    recordInputs: [],
    targetEvidence: [],
  };

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

  async writeExecutiveSummary(markdown: string): Promise<void> {
    await writeFile(join(this.runDir, "executive-summary.md"), markdown);
  }

  async writeFieldMapping(mapping: ReportFieldMapping): Promise<void> {
    this.reportDetails.fieldMappings.push({
      ...mapping,
      selectorCandidates: [...mapping.selectorCandidates],
    });
  }

  async writeReportIssue(issue: ReportIssue): Promise<void> {
    if (this.reportDetails.issues.some((existing) => sameReportIssue(existing, issue))) {
      return;
    }
    this.reportDetails.issues.push({ ...issue });
  }

  async writeAiExtraction(extraction: ReportAiExtraction): Promise<void> {
    this.reportDetails.aiExtractions.push(cloneAiExtraction(extraction));
  }

  async writeRecordInput(input: ReportRecordInput): Promise<void> {
    if (this.reportDetails.recordInputs.some((existing) => existing.recordId === input.recordId)) {
      return;
    }
    this.reportDetails.recordInputs.push({
      ...input,
      rawInput: cloneJsonValue(input.rawInput),
    });
  }

  async writeTargetEvidence(evidence: ReportTargetEvidence): Promise<void> {
    if (this.reportDetails.targetEvidence.some((existing) => sameTargetEvidence(existing, evidence))) {
      return;
    }
    this.reportDetails.targetEvidence.push({ ...evidence });
  }

  getReportDetails(): ReportDetails {
    return {
      fieldMappings: this.reportDetails.fieldMappings.map((mapping) => ({
        ...mapping,
        selectorCandidates: [...mapping.selectorCandidates],
      })),
      aiExtractions: this.reportDetails.aiExtractions.map(cloneAiExtraction),
      issues: this.reportDetails.issues.map((issue) => ({ ...issue })),
      recordInputs: this.reportDetails.recordInputs.map((input) => ({
        ...input,
        rawInput: cloneJsonValue(input.rawInput),
      })),
      targetEvidence: this.reportDetails.targetEvidence.map((evidence) => ({ ...evidence })),
    };
  }

  buildReport(input: BuildReportInput): RunReport {
    return {
      runId: this.runId,
      status: input.status,
      totalRecords: input.totalRecords,
      counts: {
        preflightExceptions: input.preflightExceptions,
        environmentExceptions: input.environmentExceptions,
        closeExceptions: input.closeExceptions,
        targetCounts: input.targetCounts,
      },
      details: this.getReportDetails(),
    };
  }

  async writeReportJson(report: RunReport): Promise<void> {
    await writeFile(join(this.runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
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

function sameReportIssue(a: ReportIssue, b: ReportIssue): boolean {
  return (
    a.phase === b.phase &&
    a.target === b.target &&
    a.recordId === b.recordId &&
    a.severity === b.severity &&
    a.exceptionCode === b.exceptionCode &&
    a.message === b.message &&
    a.screenshotPath === b.screenshotPath
  );
}

function sameTargetEvidence(a: ReportTargetEvidence, b: ReportTargetEvidence): boolean {
  return (
    a.recordId === b.recordId &&
    a.target === b.target &&
    a.status === b.status &&
    a.screenshotPath === b.screenshotPath &&
    a.fieldScreenshotPath === b.fieldScreenshotPath &&
    a.targetRecordId === b.targetRecordId &&
    a.message === b.message
  );
}

function cloneAiExtraction(extraction: ReportAiExtraction): ReportAiExtraction {
  return {
    ...extraction,
    fields: extraction.fields.map((field) => ({ ...field })),
    additionalFields: extraction.additionalFields.map((field) => ({ ...field })),
    issues: extraction.issues.map((issue) => ({ ...issue })),
  };
}

function cloneJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as unknown;
}
