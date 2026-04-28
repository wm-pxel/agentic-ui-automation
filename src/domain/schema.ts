import { z } from "zod";

export const TargetNameSchema = z.enum(["openemr", "excel", "fake"]);
export type TargetName = z.infer<typeof TargetNameSchema>;

export const SourceFormatSchema = z.enum(["json", "csv", "text"]);
export type SourceFormat = z.infer<typeof SourceFormatSchema>;

export const ExceptionCodeSchema = z.enum([
  "missing_required_field",
  "invalid_format",
  "ambiguous_value",
  "possible_duplicate",
  "ui_state_unexpected",
  "verification_failed",
  "environment_not_ready",
]);
export type ExceptionCode = z.infer<typeof ExceptionCodeSchema>;

export const ExceptionSeveritySchema = z.enum(["info", "warning", "error"]);
export type ExceptionSeverity = z.infer<typeof ExceptionSeveritySchema>;

export const ValidationExceptionSchema = z.object({
  code: ExceptionCodeSchema,
  severity: ExceptionSeveritySchema.default("error"),
  field: z.string().optional(),
  message: z.string(),
  rawValue: z.unknown().optional(),
  suggestedRemediation: z.string().optional(),
});
export type ValidationException = z.infer<typeof ValidationExceptionSchema>;

export const RawIntakeRecordSchema = z.record(z.unknown()).and(
  z.object({
    sourceRecordId: z.string(),
    sourceFormat: SourceFormatSchema,
    rawSourceExcerpt: z.string(),
  }),
);
export type RawIntakeRecord = z.infer<typeof RawIntakeRecordSchema>;

export const NormalizedIntakeRecordSchema = z.object({
  sourceRecordId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  dateOfBirth: z.string(),
  sexOrGender: z.enum(["female", "male", "unknown", "other"]),
  phone: z.string(),
  email: z.string(),
  streetAddress: z.string(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
  insurancePayer: z.string(),
  insuranceMemberId: z.string(),
  insuranceGroupId: z.string().optional(),
  reasonForVisit: z.string(),
  preferredContactMethod: z.enum(["phone", "email", "text", "mail"]),
  notes: z.string().optional(),
  sourceFormat: SourceFormatSchema,
  rawSourceExcerpt: z.string(),
});
export type NormalizedIntakeRecord = z.infer<typeof NormalizedIntakeRecordSchema>;

export type ValidationResult =
  | { ok: true; record: NormalizedIntakeRecord; exceptions: [] }
  | { ok: false; exceptions: ValidationException[]; partialRecord: Partial<NormalizedIntakeRecord> };

export const RunStatusSchema = z.enum(["created", "running", "completed", "completed_with_exceptions", "failed"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const TargetTaskStatusSchema = z.enum(["succeeded", "skipped", "exception"]);
export type TargetTaskStatus = z.infer<typeof TargetTaskStatusSchema>;

export const AuditEventSchema = z.object({
  timestamp: z.string(),
  runId: z.string(),
  recordId: z.string().optional(),
  target: TargetNameSchema.optional(),
  phase: z.string(),
  actionType: z.string(),
  rationale: z.string().optional(),
  screenshotPath: z.string().optional(),
  result: z.string(),
  exceptionCode: ExceptionCodeSchema.optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;
