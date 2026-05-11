import { randomUUID } from "node:crypto";
import { z } from "zod";
import { FileAuditStore } from "../audit/auditStore.js";
import { renderExecutiveSummary, renderSummary } from "../audit/summary.js";
import type {
  RawIntakeRecord,
  NormalizedIntakeRecord,
  RunStatus,
  TargetName,
  TargetTaskStatus,
  ValidationException,
} from "../domain/schema.js";
import { ValidationExceptionSchema } from "../domain/schema.js";
import { validateAndNormalizeRecord } from "../domain/validation.js";
import type { AiWebTargetResult } from "../targets/aiWebTargetRunner.js";
import type { TargetProfile } from "../targets/profiles.js";

export interface TargetRunner {
  prepare?(profiles: TargetProfile[], plannedRecords: number): Promise<void>;
  runRecord(context: {
    runId: string;
    profile: TargetProfile;
    record: NormalizedIntakeRecord;
    audit: FileAuditStore;
  }): Promise<AiWebTargetResult>;
  close?(): Promise<void>;
}

export interface RunWorkflowInput {
  runId?: string;
  runsDir: string;
  sourceInputPath?: string;
  records: RawIntakeRecord[];
  profiles: TargetProfile[];
  targetRunner: TargetRunner;
  now?: () => string;
}

export interface RunWorkflowResult {
  runId: string;
  status: RunStatus;
  totalRecords: number;
  preflightExceptions: number;
  environmentExceptions: number;
  closeExceptions: number;
  targetCounts: Partial<Record<TargetName, Record<TargetTaskStatus, number>>>;
}

interface TargetReadiness {
  ready: boolean;
  exception?: ValidationException;
}

interface TargetRun {
  profile: TargetProfile;
  record: NormalizedIntakeRecord;
}

const AiWebTargetResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    targetRecordId: z.string().optional(),
  }),
  z.object({
    status: z.literal("skipped"),
    reason: z.string(),
  }),
  z.object({
    status: z.literal("exception"),
    exception: ValidationExceptionSchema.and(z.record(z.unknown())),
  }),
]);

export async function runWorkflow(input: RunWorkflowInput): Promise<RunWorkflowResult> {
  const runId = input.runId ?? `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const audit = await FileAuditStore.create({ runsDir: input.runsDir, runId, now: input.now });
  const targets = input.profiles.map((profile) => profile.name);
  const targetCounts = initializeTargetCounts(targets);
  const readiness = new Map<TargetName, TargetReadiness>();
  let closedTargetRunner = false;
  let targetRunnerPrepareAttempted = false;
  let preflightExceptions = 0;
  let environmentExceptions = 0;
  let closeExceptions = 0;
  let initialMetadataWritten = false;

  try {
    await audit.writeRunMetadata({
      runId,
      status: "running",
      targets,
      totalRecords: input.records.length,
      sourceInputPath: input.sourceInputPath,
    });
    initialMetadataWritten = true;
    await audit.writeInputArtifact("normalized-records.json", "[]\n");
    await audit.writeEvent({ phase: "run", actionType: "start", result: "workflow run started" });

    let prepareException: ValidationException | undefined;
    try {
      targetRunnerPrepareAttempted = Boolean(input.targetRunner.prepare);
      await input.targetRunner.prepare?.(input.profiles, input.records.length);
    } catch (error) {
      prepareException = exceptionFromError("environment_not_ready", error);
    }

    for (const profile of input.profiles) {
      if (prepareException) {
        environmentExceptions += 1;
        readiness.set(profile.name, { ready: false, exception: prepareException });
        await audit.writeException(`${profile.name}-prepare`, prepareException);
        await audit.writeReportIssue(issueFromException({
          phase: "environment",
          target: profile.name,
          exception: prepareException,
        }));
        await audit.writeEvent({
          target: profile.name,
          phase: "environment",
          actionType: "prepare",
          result: prepareException.message,
          exceptionCode: prepareException.code,
        });
        continue;
      }

      readiness.set(profile.name, { ready: true });
      await audit.writeEvent({
        target: profile.name,
        phase: "environment",
        actionType: "prepare",
        result: "target ready",
      });
    }

    const normalizedRecords = [];
    const targetRuns: TargetRun[] = [];
    for (const rawRecord of input.records) {
      await audit.writeRecordInput({
        recordId: String(rawRecord.sourceRecordId),
        sourceFormat: rawRecord.sourceFormat,
        rawInput: rawInputForReport(rawRecord),
      });
      await writeAiExtractionDetails(audit, rawRecord);
      const validation = validateAndNormalizeRecord(rawRecord);

      if (!validation.ok) {
        preflightExceptions += 1;
        const primaryException = validation.exceptions[0] ?? {
          code: "invalid_format",
          severity: "error",
          message: "Record failed validation.",
        };
        await audit.writeException(String(rawRecord.sourceRecordId), {
          ...primaryException,
          allExceptions: validation.exceptions,
          partialRecord: validation.partialRecord,
        });
        await audit.writeReportIssue(issueFromException({
          phase: "validation",
          recordId: String(rawRecord.sourceRecordId),
          exception: primaryException,
        }));
        await audit.writeEvent({
          recordId: String(rawRecord.sourceRecordId),
          phase: "validation",
          actionType: "validate",
          result: "record stopped by validation",
          exceptionCode: primaryException.code,
        });
        continue;
      }

      normalizedRecords.push(validation.record);

      for (const profile of input.profiles) {
        const counts = targetCounts[profile.name];
        if (!counts) continue;

        const state = readiness.get(profile.name);
        if (!state?.ready) {
          const exception =
            state?.exception ??
            ({
              code: "environment_not_ready",
              severity: "error",
              message: `${profile.name} was not prepared.`,
            } satisfies ValidationException);
          counts.exception += 1;
          await audit.writeException(`${validation.record.sourceRecordId}-${profile.name}`, exception);
          await audit.writeReportIssue(issueFromException({
            phase: "target",
            target: profile.name,
            recordId: validation.record.sourceRecordId,
            exception,
          }));
          await audit.writeEvent({
            recordId: validation.record.sourceRecordId,
            target: profile.name,
            phase: "target",
            actionType: "skip-unavailable-target",
            result: exception.message,
            exceptionCode: exception.code,
          });
          continue;
        }

        targetRuns.push({ profile, record: validation.record });
      }
    }

    await runTargetRecords({
      targetRuns,
      profiles: input.profiles,
      runId,
      audit,
      targetRunner: input.targetRunner,
      targetCounts,
    });

    await audit.writeInputArtifact("normalized-records.json", `${JSON.stringify(normalizedRecords, null, 2)}\n`);

    closeExceptions += await closeReadyTargetRunner(
      input.targetRunner,
      input.profiles,
      audit,
      readiness,
      targetRunnerPrepareAttempted,
      () => {
        if (closedTargetRunner) return false;
        closedTargetRunner = true;
        return true;
      },
    );

    const status: RunStatus = hasExceptions(preflightExceptions, environmentExceptions, closeExceptions, targetCounts)
      ? "completed_with_exceptions"
      : "completed";

    await writeRunReportArtifacts({
      audit,
      runId,
      sourceInputPath: input.sourceInputPath,
      status,
      totalRecords: input.records.length,
      preflightExceptions,
      environmentExceptions,
      closeExceptions,
      targetCounts,
    });
    await audit.writeRunMetadata({
      runId,
      status,
      targets,
      sourceInputPath: input.sourceInputPath,
      totalRecords: input.records.length,
      preflightExceptions,
      environmentExceptions,
      closeExceptions,
      targetCounts,
    });
    await audit.writeEvent({ phase: "run", actionType: "finish", result: status });

    return {
      runId,
      status,
      totalRecords: input.records.length,
      preflightExceptions,
      environmentExceptions,
      closeExceptions,
      targetCounts,
    };
  } catch (error) {
    closeExceptions += await closeReadyTargetRunner(
      input.targetRunner,
      input.profiles,
      audit,
      readiness,
      targetRunnerPrepareAttempted,
      () => {
        if (closedTargetRunner) return false;
        closedTargetRunner = true;
        return true;
      },
    );
    if (initialMetadataWritten) {
      await writeFailedRunArtifacts({
        audit,
        runId,
        targets,
        sourceInputPath: input.sourceInputPath,
        totalRecords: input.records.length,
        preflightExceptions,
        environmentExceptions,
        closeExceptions,
        targetCounts,
        error,
      });
    }
    throw error;
  }
}

function initializeTargetCounts(targets: TargetName[]): Partial<Record<TargetName, Record<TargetTaskStatus, number>>> {
  const counts: Partial<Record<TargetName, Record<TargetTaskStatus, number>>> = {};
  for (const target of targets) {
    counts[target] = { succeeded: 0, exception: 0, skipped: 0 };
  }
  return counts;
}

async function runTargetRecords(input: {
  targetRuns: TargetRun[];
  profiles: TargetProfile[];
  runId: string;
  audit: FileAuditStore;
  targetRunner: TargetRunner;
  targetCounts: Partial<Record<TargetName, Record<TargetTaskStatus, number>>>;
}): Promise<void> {
  let firstError: unknown;
  await Promise.all(
    input.profiles.map(async (profile) => {
      try {
        await runTargetProfileRecords(input, profile);
      } catch (error) {
        firstError ??= error;
      }
    }),
  );
  if (firstError !== undefined) {
    throw firstError;
  }
}

async function runTargetProfileRecords(
  input: {
    targetRuns: TargetRun[];
    runId: string;
    audit: FileAuditStore;
    targetRunner: TargetRunner;
    targetCounts: Partial<Record<TargetName, Record<TargetTaskStatus, number>>>;
  },
  profile: TargetProfile,
): Promise<void> {
  const runs = input.targetRuns.filter((run) => run.profile === profile);
  if (runs.length === 0) return;

  await mapWithConcurrency(runs, profileConcurrency(profile), async (run) => {
    await input.audit.writeEvent({
      recordId: run.record.sourceRecordId,
      target: profile.name,
      phase: "target",
      actionType: "start",
      result: "target record started",
    });
    const result = await runTargetRunnerRecord(input.targetRunner, {
      runId: input.runId,
      profile,
      record: run.record,
      audit: input.audit,
    });
    const counts = input.targetCounts[profile.name];
    if (counts) {
      counts[result.status] += 1;
    }
    await input.audit.writeEvent({
      recordId: run.record.sourceRecordId,
      target: profile.name,
      phase: "target",
      actionType: "complete",
      result: targetCompletionResult(result),
      exceptionCode: result.status === "exception" ? result.exception.code : undefined,
    });

    if (result.status === "exception") {
      await input.audit.writeException(`${run.record.sourceRecordId}-${profile.name}`, result.exception);
      await input.audit.writeReportIssue(issueFromException({
        phase: "target",
        target: profile.name,
        recordId: run.record.sourceRecordId,
        exception: result.exception,
      }));
    }
  });
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  let firstError: unknown;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length && firstError === undefined) {
        const item = items[nextIndex];
        nextIndex += 1;
        if (item !== undefined) {
          try {
            await worker(item);
          } catch (error) {
            firstError = error;
          }
        }
      }
    }),
  );
  if (firstError !== undefined) {
    throw firstError;
  }
}

function profileConcurrency(profile: TargetProfile): number {
  const value = profile.concurrency;
  return Number.isInteger(value) && value > 0 ? value : 1;
}

async function runTargetRunnerRecord(
  targetRunner: TargetRunner,
  context: Parameters<TargetRunner["runRecord"]>[0],
): Promise<AiWebTargetResult> {
  try {
    return AiWebTargetResultSchema.parse(await targetRunner.runRecord(context));
  } catch (error) {
    return {
      status: "exception",
      exception: exceptionFromError("ui_state_unexpected", error),
    };
  }
}

function hasExceptions(
  preflightExceptions: number,
  environmentExceptions: number,
  closeExceptions: number,
  targetCounts: Partial<Record<TargetName, Record<TargetTaskStatus, number>>>,
): boolean {
  return (
    preflightExceptions > 0 ||
    environmentExceptions > 0 ||
    closeExceptions > 0 ||
    Object.values(targetCounts).some((counts) => counts.exception > 0)
  );
}

async function closeReadyTargetRunner(
  targetRunner: TargetRunner,
  profiles: TargetProfile[],
  audit: FileAuditStore,
  readiness: Map<TargetName, TargetReadiness>,
  closeAfterPrepareAttempt: boolean,
  claimClose: () => boolean,
): Promise<number> {
  const readyProfiles = profiles.filter((profile) => readiness.get(profile.name)?.ready);
  const reportProfiles = readyProfiles.length > 0 ? readyProfiles : profiles;
  if (!targetRunner.close || (readyProfiles.length === 0 && !closeAfterPrepareAttempt) || !claimClose()) {
    return 0;
  }

  let closeExceptions = 0;

  try {
    await targetRunner.close();
  } catch (error) {
    closeExceptions += 1;
    const exception = exceptionFromError("ui_state_unexpected", error);
    for (const profile of reportProfiles) {
      await audit.writeException(`${profile.name}-close`, exception).catch(() => undefined);
      await audit
        .writeReportIssue(issueFromException({
          phase: "environment",
          target: profile.name,
          exception,
        }))
        .catch(() => undefined);
      await audit
        .writeEvent({
          target: profile.name,
          phase: "environment",
          actionType: "close",
          result: exception.message,
          exceptionCode: exception.code,
        })
        .catch(() => undefined);
    }
  }

  return closeExceptions;
}

async function writeFailedRunArtifacts(input: {
  audit: FileAuditStore;
  runId: string;
  targets: TargetName[];
  sourceInputPath?: string;
  totalRecords: number;
  preflightExceptions: number;
  environmentExceptions: number;
  closeExceptions: number;
  targetCounts: Partial<Record<TargetName, Record<TargetTaskStatus, number>>>;
  error: unknown;
}): Promise<void> {
  const exception = exceptionFromError("ui_state_unexpected", input.error);
  await input.audit
    .writeReportIssue(issueFromException({
      phase: "run",
      exception,
    }))
    .catch(() => undefined);
  await writeRunReportArtifacts({
    audit: input.audit,
    runId: input.runId,
    sourceInputPath: input.sourceInputPath,
    status: "failed",
    totalRecords: input.totalRecords,
    preflightExceptions: input.preflightExceptions,
    environmentExceptions: input.environmentExceptions,
    closeExceptions: input.closeExceptions,
    targetCounts: input.targetCounts,
  }).catch(() => undefined);
  await input.audit
    .writeRunMetadata({
      runId: input.runId,
      status: "failed",
      targets: input.targets,
      sourceInputPath: input.sourceInputPath,
      totalRecords: input.totalRecords,
      preflightExceptions: input.preflightExceptions,
      environmentExceptions: input.environmentExceptions,
      closeExceptions: input.closeExceptions,
      targetCounts: input.targetCounts,
      failure: exception,
    })
    .catch(() => undefined);
  await input.audit
    .writeEvent({
      phase: "run",
      actionType: "finish",
      result: "failed",
      exceptionCode: exception.code,
      rationale: exception.message,
    })
    .catch(() => undefined);
}

async function writeRunReportArtifacts(input: {
  audit: FileAuditStore;
  runId: string;
  sourceInputPath?: string;
  status: RunStatus;
  totalRecords: number;
  preflightExceptions: number;
  environmentExceptions: number;
  closeExceptions: number;
  targetCounts: Partial<Record<TargetName, Record<TargetTaskStatus, number>>>;
}): Promise<void> {
  const details = input.audit.getReportDetails();
  await input.audit.writeSummary(
    renderSummary({
      runId: input.runId,
      status: input.status,
      runDir: input.audit.runDir,
      sourceInputPath: input.sourceInputPath,
      totalRecords: input.totalRecords,
      preflightExceptions: input.preflightExceptions,
      environmentExceptions: input.environmentExceptions,
      closeExceptions: input.closeExceptions,
      targetCounts: input.targetCounts,
      details,
    }),
  );
  await input.audit.writeExecutiveSummary(
    renderExecutiveSummary({
      runId: input.runId,
      status: input.status,
      runDir: input.audit.runDir,
      sourceInputPath: input.sourceInputPath,
      totalRecords: input.totalRecords,
      preflightExceptions: input.preflightExceptions,
      environmentExceptions: input.environmentExceptions,
      closeExceptions: input.closeExceptions,
      targetCounts: input.targetCounts,
      details,
    }),
  );
  await input.audit.writeReportJson({
    runId: input.runId,
    status: input.status,
    totalRecords: input.totalRecords,
    counts: {
      preflightExceptions: input.preflightExceptions,
      environmentExceptions: input.environmentExceptions,
      closeExceptions: input.closeExceptions,
      targetCounts: input.targetCounts,
    },
    details,
  });
}

function issueFromException(input: {
  phase: string;
  target?: TargetName;
  recordId?: string;
  exception: ValidationException & Record<string, unknown>;
}) {
  return {
    phase: input.phase,
    target: input.target,
    recordId: input.recordId,
    severity: input.exception.severity,
    exceptionCode: input.exception.code,
    message: input.exception.message,
    suggestedRemediation: input.exception.suggestedRemediation,
    screenshotPath: stringValue(input.exception.screenshotPath),
  };
}

function rawInputForReport(rawRecord: RawIntakeRecord): unknown {
  const record = rawRecord as Record<string, unknown>;
  if (record.sourceRawRecord !== undefined) {
    return record.sourceRawRecord;
  }

  const {
    rawSourceExcerpt: _rawSourceExcerpt,
    aiExtraction: _aiExtraction,
    sourceRawRecord: _sourceRawRecord,
    ...rawInput
  } = record;
  return rawInput;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function writeAiExtractionDetails(audit: FileAuditStore, rawRecord: RawIntakeRecord): Promise<void> {
  const extraction = rawRecord.aiExtraction;
  if (!isAiExtractionMetadata(extraction)) return;
  const recordId = String(rawRecord.sourceRecordId);

  await audit.writeAiExtraction({
    recordId,
    model: extraction.model,
    sourceDocumentName: extraction.sourceDocumentName,
    fields: extractionFields(extraction.fields),
    additionalFields: extractionFields(extraction.additionalFields),
    issues: extraction.issues,
  });

  for (const issue of extraction.issues) {
    await audit.writeReportIssue({
      phase: "extraction",
      recordId,
      severity: issue.severity,
      message: issue.message,
      suggestedRemediation: remediationForExtractionIssue(issue.severity),
    });
  }
}

function remediationForExtractionIssue(severity: "info" | "warning" | "error"): string {
  switch (severity) {
    case "error":
      return "Correct the extracted source field before running target automation.";
    case "warning":
      return "Review the source extraction evidence and confirm the field before relying on the run.";
    case "info":
      return "Review the source extraction note during audit sign-off.";
  }
}

function extractionFields(value: Record<string, { sourceLabel?: string; value: string; confidence: number; evidence?: string }>) {
  return Object.entries(value).map(([sourceField, field]) => ({
    sourceField,
    sourceLabel: field.sourceLabel,
    value: field.value,
    confidence: field.confidence,
    evidence: field.evidence,
  }));
}

function isAiExtractionMetadata(value: unknown): value is {
  model: string;
  sourceDocumentName: string;
  fields: Record<string, { sourceLabel?: string; value: string; confidence: number; evidence?: string }>;
  additionalFields: Record<string, { sourceLabel?: string; value: string; confidence: number; evidence?: string }>;
  issues: Array<{ field?: string; message: string; severity: "info" | "warning" | "error" }>;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "model" in value &&
    typeof value.model === "string" &&
    "sourceDocumentName" in value &&
    typeof value.sourceDocumentName === "string" &&
    "fields" in value &&
    typeof value.fields === "object" &&
    value.fields !== null &&
    "additionalFields" in value &&
    typeof value.additionalFields === "object" &&
    value.additionalFields !== null &&
    "issues" in value &&
    Array.isArray(value.issues)
  );
}

function targetCompletionResult(result: AiWebTargetResult): string {
  if (result.status === "skipped") {
    return `skipped: ${result.reason}`;
  }

  return result.status;
}

function exceptionFromError(code: ValidationException["code"], error: unknown): ValidationException {
  return {
    code,
    severity: "error",
    message: error instanceof Error ? error.message : String(error),
    suggestedRemediation: "Review the target readiness and current UI screenshot artifacts.",
  };
}
