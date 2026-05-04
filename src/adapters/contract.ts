import { z } from "zod";
import type { FileAuditStore } from "../audit/auditStore.js";
import type { AgentDriver } from "../agent/types.js";
import { ValidationExceptionSchema } from "../domain/schema.js";
import type { NormalizedIntakeRecord, TargetName, ValidationException } from "../domain/schema.js";

export interface TargetRunContext {
  runId: string;
  record: NormalizedIntakeRecord;
  audit: FileAuditStore;
  agent: AgentDriver;
}

export interface TargetPrepareContext {
  plannedRecords: number;
}

export type TargetAdapterResult =
  | {
      status: "succeeded";
      targetRecordId?: string;
    }
  | {
      status: "skipped";
      reason: string;
    }
  | {
      status: "exception";
      exception: ValidationException & Record<string, unknown>;
    };

export const TargetAdapterResultSchema = z.discriminatedUnion("status", [
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

export interface TargetAdapter {
  readonly name: TargetName;
  readonly maxConcurrency?: number;
  prepare(context?: TargetPrepareContext): Promise<void>;
  runRecord(context: TargetRunContext): Promise<TargetAdapterResult>;
  close(): Promise<void>;
}
