import type { FileAuditStore } from "../audit/auditStore.js";
import type { AgentDriver } from "../agent/types.js";
import type { NormalizedIntakeRecord, TargetName, ValidationException } from "../domain/schema.js";

export interface TargetRunContext {
  runId: string;
  record: NormalizedIntakeRecord;
  audit: FileAuditStore;
  agent: AgentDriver;
}

export type TargetAdapterResult =
  | {
      status: "succeeded";
      targetRecordId: string;
    }
  | {
      status: "skipped";
      reason: string;
    }
  | {
      status: "exception";
      exception: ValidationException;
    };

export interface TargetAdapter {
  name: TargetName;
  prepare(): Promise<void>;
  runRecord(context: TargetRunContext): Promise<TargetAdapterResult>;
  close(): Promise<void>;
}
