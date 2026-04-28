import { randomUUID } from "node:crypto";
import { FileAuditStore } from "../audit/auditStore.js";
import { renderSummary } from "../audit/summary.js";
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
  targetCounts: Partial<Record<TargetName, Record<TargetTaskStatus, number>>>;
}

interface TargetReadiness {
  ready: boolean;
  exception?: ValidationException;
}

export async function runWorkflow(input: RunWorkflowInput): Promise<RunWorkflowResult> {
  const runId = input.runId ?? `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const audit = await FileAuditStore.create({ runsDir: input.runsDir, runId, now: input.now });
  const targets = input.adapters.map((adapter) => adapter.name);
  const targetCounts = initializeTargetCounts(targets);
  const readiness = new Map<TargetName, TargetReadiness>();
  let preflightExceptions = 0;

  await audit.writeRunMetadata({
    runId,
    status: "running",
    targets,
    totalRecords: input.records.length,
  });
  await audit.writeInputArtifact("normalized-records.json", "[]\n");
  await audit.writeEvent({ phase: "run", actionType: "start", result: "workflow run started" });

  for (const adapter of input.adapters) {
    try {
      await adapter.prepare();
      readiness.set(adapter.name, { ready: true });
      await audit.writeEvent({
        target: adapter.name,
        phase: "environment",
        actionType: "prepare",
        result: "target ready",
      });
    } catch (error) {
      const exception = exceptionFromError("environment_not_ready", error);
      readiness.set(adapter.name, { ready: false, exception });
      await audit.writeException(`${adapter.name}-prepare`, exception);
      await audit.writeEvent({
        target: adapter.name,
        phase: "environment",
        actionType: "prepare",
        result: exception.message,
        exceptionCode: exception.code,
      });
    }
  }

  const normalizedRecords = [];
  try {
    for (const rawRecord of input.records) {
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
          agent: input.agent,
        });
        counts[result.status] += 1;
        await audit.writeEvent({
          recordId: validation.record.sourceRecordId,
          target: adapter.name,
          phase: "target",
          actionType: "complete",
          result: result.status,
          exceptionCode: result.status === "exception" ? result.exception.code : undefined,
        });

        if (result.status === "exception") {
          await audit.writeException(`${validation.record.sourceRecordId}-${adapter.name}`, result.exception);
        }
      }
    }

    await audit.writeInputArtifact("normalized-records.json", `${JSON.stringify(normalizedRecords, null, 2)}\n`);
  } finally {
    for (const adapter of input.adapters) {
      if (readiness.get(adapter.name)?.ready) {
        await adapter.close().catch(() => undefined);
      }
    }
  }

  const status: RunStatus = hasExceptions(preflightExceptions, targetCounts) ? "completed_with_exceptions" : "completed";

  await audit.writeSummary(
    renderSummary({
      runId,
      totalRecords: input.records.length,
      preflightExceptions,
      targetCounts,
    }),
  );
  await audit.writeRunMetadata({
    runId,
    status,
    targets,
    totalRecords: input.records.length,
    preflightExceptions,
    targetCounts,
  });
  await audit.writeEvent({ phase: "run", actionType: "finish", result: status });

  return {
    runId,
    status,
    totalRecords: input.records.length,
    preflightExceptions,
    targetCounts,
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
  targetCounts: Partial<Record<TargetName, Record<TargetTaskStatus, number>>>,
): boolean {
  return preflightExceptions > 0 || Object.values(targetCounts).some((counts) => counts.exception > 0);
}

function exceptionFromError(code: ValidationException["code"], error: unknown): ValidationException {
  return {
    code,
    severity: "error",
    message: error instanceof Error ? error.message : String(error),
    suggestedRemediation: "Review the target readiness and current UI screenshot artifacts.",
  };
}
