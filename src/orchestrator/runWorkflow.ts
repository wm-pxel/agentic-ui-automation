import { randomUUID } from "node:crypto";
import { FileAuditStore } from "../audit/auditStore.js";
import { renderSummary } from "../audit/summary.js";
import { validateAgentDecision } from "../agent/types.js";
import type { AgentDriver } from "../agent/types.js";
import { TargetAdapterResultSchema } from "../adapters/contract.js";
import type { TargetAdapter, TargetAdapterResult } from "../adapters/contract.js";
import type {
  RawIntakeRecord,
  RunStatus,
  TargetName,
  TargetTaskStatus,
  ValidationException,
} from "../domain/schema.js";
import { validateAndNormalizeRecord } from "../domain/validation.js";

export interface RunWorkflowInput {
  runId?: string;
  runsDir: string;
  sourceInputPath?: string;
  records: RawIntakeRecord[];
  adapters: TargetAdapter[];
  agent: AgentDriver;
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

export async function runWorkflow(input: RunWorkflowInput): Promise<RunWorkflowResult> {
  const runId = input.runId ?? `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const audit = await FileAuditStore.create({ runsDir: input.runsDir, runId, now: input.now });
  const agent = withScreenshotRootDir(input.agent, audit.runDir);
  const targets = input.adapters.map((adapter) => adapter.name);
  const targetCounts = initializeTargetCounts(targets);
  const readiness = new Map<TargetName, TargetReadiness>();
  const closedAdapters = new Set<TargetAdapter>();
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

    for (const adapter of input.adapters) {
      let prepareException: ValidationException | undefined;
      try {
        await adapter.prepare();
      } catch (error) {
        prepareException = exceptionFromError("environment_not_ready", error);
      }

      if (prepareException) {
        environmentExceptions += 1;
        readiness.set(adapter.name, { ready: false, exception: prepareException });
        await audit.writeException(`${adapter.name}-prepare`, prepareException);
        await audit.writeReportIssue(issueFromException({
          phase: "environment",
          target: adapter.name,
          exception: prepareException,
        }));
        await audit.writeEvent({
          target: adapter.name,
          phase: "environment",
          actionType: "prepare",
          result: prepareException.message,
          exceptionCode: prepareException.code,
        });
        continue;
      }

      readiness.set(adapter.name, { ready: true });
      await audit.writeEvent({
        target: adapter.name,
        phase: "environment",
        actionType: "prepare",
        result: "target ready",
      });
    }

    const normalizedRecords = [];
    for (const rawRecord of input.records) {
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

      for (const adapter of input.adapters) {
        const counts = targetCounts[adapter.name];
        if (!counts) continue;

        const state = readiness.get(adapter.name);
        if (!state?.ready) {
          const exception =
            state?.exception ??
            ({
              code: "environment_not_ready",
              severity: "error",
              message: `${adapter.name} was not prepared.`,
            } satisfies ValidationException);
          counts.exception += 1;
          await audit.writeException(`${validation.record.sourceRecordId}-${adapter.name}`, exception);
          await audit.writeReportIssue(issueFromException({
            phase: "target",
            target: adapter.name,
            recordId: validation.record.sourceRecordId,
            exception,
          }));
          await audit.writeEvent({
            recordId: validation.record.sourceRecordId,
            target: adapter.name,
            phase: "target",
            actionType: "skip-unavailable-target",
            result: exception.message,
            exceptionCode: exception.code,
          });
          continue;
        }

        const result = await runAdapterRecord(adapter, {
          runId,
          record: validation.record,
          audit,
          agent,
        });
        counts[result.status] += 1;
        await audit.writeEvent({
          recordId: validation.record.sourceRecordId,
          target: adapter.name,
          phase: "target",
          actionType: "complete",
          result: targetCompletionResult(result),
          exceptionCode: result.status === "exception" ? result.exception.code : undefined,
        });

        if (result.status === "exception") {
          await audit.writeException(`${validation.record.sourceRecordId}-${adapter.name}`, result.exception);
          await audit.writeReportIssue(issueFromException({
            phase: "target",
            target: adapter.name,
            recordId: validation.record.sourceRecordId,
            exception: result.exception,
          }));
        }
      }
    }

    await audit.writeInputArtifact("normalized-records.json", `${JSON.stringify(normalizedRecords, null, 2)}\n`);

    closeExceptions += await closeReadyAdapters(input.adapters, audit, readiness, closedAdapters);

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
    closeExceptions += await closeReadyAdapters(input.adapters, audit, readiness, closedAdapters);
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

function withScreenshotRootDir(agent: AgentDriver, screenshotRootDir: string): AgentDriver {
  return {
    decide: async (decisionInput) => {
      const input = {
        ...decisionInput,
        screenshotRootDir: decisionInput.screenshotRootDir ?? screenshotRootDir,
      };
      return validateAgentDecision(input, await agent.decide(input));
    },
  };
}

function initializeTargetCounts(targets: TargetName[]): Partial<Record<TargetName, Record<TargetTaskStatus, number>>> {
  const counts: Partial<Record<TargetName, Record<TargetTaskStatus, number>>> = {};
  for (const target of targets) {
    counts[target] = { succeeded: 0, exception: 0, skipped: 0 };
  }
  return counts;
}

async function runAdapterRecord(
  adapter: TargetAdapter,
  context: Parameters<TargetAdapter["runRecord"]>[0],
): Promise<TargetAdapterResult> {
  try {
    return TargetAdapterResultSchema.parse(await adapter.runRecord(context));
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

async function closeReadyAdapters(
  adapters: TargetAdapter[],
  audit: FileAuditStore,
  readiness: Map<TargetName, TargetReadiness>,
  closedAdapters: Set<TargetAdapter>,
): Promise<number> {
  let closeExceptions = 0;

  for (const adapter of adapters) {
    if (!readiness.get(adapter.name)?.ready || closedAdapters.has(adapter)) {
      continue;
    }

    closedAdapters.add(adapter);
    try {
      await adapter.close();
    } catch (error) {
      closeExceptions += 1;
      const exception = exceptionFromError("ui_state_unexpected", error);
      await audit.writeException(`${adapter.name}-close`, exception).catch(() => undefined);
      await audit
        .writeReportIssue(issueFromException({
          phase: "environment",
          target: adapter.name,
          exception,
        }))
        .catch(() => undefined);
      await audit
        .writeEvent({
          target: adapter.name,
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
    exceptionCode: input.exception.code,
    message: input.exception.message,
    suggestedRemediation: input.exception.suggestedRemediation,
    screenshotPath: stringValue(input.exception.screenshotPath),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function writeAiExtractionDetails(audit: FileAuditStore, rawRecord: RawIntakeRecord): Promise<void> {
  const extraction = rawRecord.aiExtraction;
  if (!isAiExtractionMetadata(extraction)) return;

  await audit.writeAiExtraction({
    recordId: String(rawRecord.sourceRecordId),
    model: extraction.model,
    sourceDocumentName: extraction.sourceDocumentName,
    fields: extractionFields(extraction.fields),
    additionalFields: extractionFields(extraction.additionalFields),
    issues: extraction.issues,
  });
}

function extractionFields(value: Record<string, { value: string; confidence: number; evidence?: string }>) {
  return Object.entries(value).map(([sourceField, field]) => ({
    sourceField,
    value: field.value,
    confidence: field.confidence,
    evidence: field.evidence,
  }));
}

function isAiExtractionMetadata(value: unknown): value is {
  model: string;
  sourceDocumentName: string;
  fields: Record<string, { value: string; confidence: number; evidence?: string }>;
  additionalFields: Record<string, { value: string; confidence: number; evidence?: string }>;
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

function targetCompletionResult(result: TargetAdapterResult): string {
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
