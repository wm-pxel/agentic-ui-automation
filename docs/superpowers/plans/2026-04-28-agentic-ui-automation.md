# Agentic UI Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a repeatable, auditable agentic UI automation pilot that parses synthetic patient intake records and enters them into OpenEMR web and Microsoft Excel desktop.

**Architecture:** A TypeScript CLI orchestrates record loading, normalization, validation, target execution, and audit artifacts. Target adapters share one contract; OpenEMR uses Playwright, Excel uses a macOS desktop automation port around Microsoft Excel, and tests use fake adapters and ports. Agentic decisions are isolated behind an `AgentDriver` so deterministic tests can use scripted decisions while real runs can use an OpenAI vision/structured-output driver over screenshots and allowed actions.

**Tech Stack:** Node.js 20+, TypeScript, Vitest, Zod, Commander, csv-parse, Playwright, OpenAI SDK, ExcelJS, macOS `osascript`/`screencapture` for Excel desktop smoke runs.

---

## File Structure

- Create `package.json`: npm scripts and runtime/dev dependencies.
- Create `tsconfig.json`: strict TypeScript configuration.
- Create `vitest.config.ts`: unit test configuration.
- Create `.gitignore`: generated artifacts, dependencies, environment files.
- Create `.env.example`: documented environment variables for OpenAI, OpenEMR, Excel, and run output.
- Create `src/index.ts`: public exports for core modules.
- Create `src/cli.ts`: command-line entrypoint.
- Create `src/config.ts`: environment and CLI configuration parsing.
- Create `src/domain/schema.ts`: normalized intake, exception, audit, and target schemas.
- Create `src/domain/validation.ts`: normalization and validation rules.
- Create `src/parsing/loadRecords.ts`: source file loading and parser routing.
- Create `src/parsing/jsonCsvParser.ts`: JSON and CSV parser.
- Create `src/parsing/textParser.ts`: semi-structured intake text parser.
- Create `src/audit/auditStore.ts`: run folder creation, JSONL event writing, screenshot writing, exception writing.
- Create `src/audit/summary.ts`: Markdown summary generation.
- Create `src/agent/types.ts`: agent decision interfaces.
- Create `src/agent/scriptedAgent.ts`: deterministic agent for tests and offline demos.
- Create `src/agent/openAiUiAgent.ts`: OpenAI screenshot-and-action-list decision driver.
- Create `src/adapters/contract.ts`: shared target adapter contract.
- Create `src/adapters/fakeAdapter.ts`: fake adapter for contract and orchestrator tests.
- Create `src/orchestrator/runWorkflow.ts`: main run loop and status handling.
- Create `src/targets/openemr/openEmrAdapter.ts`: Playwright adapter for OpenEMR.
- Create `src/targets/openemr/selectors.ts`: OpenEMR selector candidates and field mapping.
- Create `src/targets/excel/workbook.ts`: workbook creation and verification helpers.
- Create `src/targets/excel/macExcelPort.ts`: Microsoft Excel desktop automation port.
- Create `src/targets/excel/excelAdapter.ts`: Excel target adapter.
- Create `data/demo/intake-records.json`: mixed clean and invalid structured records.
- Create `data/demo/intake-notes.txt`: semi-structured text records.
- Create `tests/config.test.ts`: CLI configuration parsing tests.
- Create `tests/domain/validation.test.ts`: parser-independent validation tests.
- Create `tests/parsing/loadRecords.test.ts`: JSON, CSV, and text loading tests.
- Create `tests/audit/auditStore.test.ts`: audit artifact tests.
- Create `tests/orchestrator/runWorkflow.test.ts`: fake-adapter workflow tests.
- Create `tests/targets/excelAdapter.test.ts`: Excel adapter tests with fake desktop port.
- Create `tests/agent/scriptedAgent.test.ts`: deterministic agent tests.
- Create `docs/demo.md`: how to run local and opt-in smoke demos.

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/index.ts`

- [ ] **Step 1: Create package metadata and scripts**

Create `package.json` with this content:

```json
{
  "name": "agentic-ui-automation",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "agentic-ui": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run --passWithNoTests",
    "test:watch": "vitest",
    "dev": "tsx src/cli.ts",
    "smoke:openemr": "tsx src/cli.ts run --input data/demo/intake-records.json --targets openemr --agent scripted",
    "smoke:excel": "tsx src/cli.ts run --input data/demo/intake-records.json --targets excel --agent scripted"
  },
  "dependencies": {
    "@playwright/test": "^1.46.0",
    "commander": "^12.1.0",
    "csv-parse": "^5.5.6",
    "exceljs": "^4.4.0",
    "openai": "^4.56.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.5.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run:

```bash
npm install
```

Expected: `package-lock.json` is created and npm exits with code 0.

- [ ] **Step 3: Create TypeScript config**

Create `tsconfig.json` with this content:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"],
  "exclude": ["dist", "node_modules", "runs"]
}
```

- [ ] **Step 4: Create Vitest config**

Create `vitest.config.ts` with this content:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true,
  },
});
```

- [ ] **Step 5: Create ignore rules and environment template**

Create `.gitignore` with this content:

```gitignore
node_modules/
dist/
runs/
.env
*.log
*.xlsx
!data/**/*.xlsx
```

Create `.env.example` with this content:

```bash
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.4-mini
RUNS_DIR=runs

OPENEMR_BASE_URL=
OPENEMR_USERNAME=
OPENEMR_PASSWORD=

EXCEL_WORKBOOK_PATH=runs/intake-workbook.xlsx
```

- [ ] **Step 6: Create public export file**

Create `src/index.ts` with this content:

```ts
export * from "./domain/schema.js";
export * from "./domain/validation.js";
export * from "./parsing/loadRecords.js";
export * from "./audit/auditStore.js";
export * from "./orchestrator/runWorkflow.js";
export * from "./adapters/contract.js";
```

- [ ] **Step 7: Verify scaffold**

Run:

```bash
npm run typecheck
npm test
```

Expected: typecheck exits 0; Vitest exits 0 with no tests found or an empty test suite message.

- [ ] **Step 8: Commit scaffold**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .env.example src/index.ts
git commit -m "chore: scaffold TypeScript project"
```

## Task 2: Domain Schema And Validation

**Files:**
- Create: `src/domain/schema.ts`
- Create: `src/domain/validation.ts`
- Create: `tests/domain/validation.test.ts`

- [ ] **Step 1: Write failing validation tests**

Create `tests/domain/validation.test.ts` with this content:

```ts
import { describe, expect, it } from "vitest";
import { validateAndNormalizeRecord } from "../../src/domain/validation.js";

describe("validateAndNormalizeRecord", () => {
  it("normalizes a clean patient intake record", () => {
    const result = validateAndNormalizeRecord({
      sourceRecordId: "rec-001",
      firstName: "Ava",
      lastName: "Nguyen",
      dateOfBirth: "03/14/1987",
      sexOrGender: "Female",
      phone: "(312) 555-0198",
      email: "ava.nguyen@example.test",
      streetAddress: "1200 West Lake Street",
      city: "Chicago",
      state: "Illinois",
      zip: "60607-1234",
      insurancePayer: "Aetna",
      insuranceMemberId: "AET123456",
      insuranceGroupId: "GRP9",
      reasonForVisit: "Annual wellness visit",
      preferredContactMethod: "phone",
      notes: "Prefers morning appointments.",
      sourceFormat: "json",
      rawSourceExcerpt: "Ava Nguyen intake",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid record");
    expect(result.record.dateOfBirth).toBe("1987-03-14");
    expect(result.record.phone).toBe("+13125550198");
    expect(result.record.state).toBe("IL");
    expect(result.record.zip).toBe("60607");
  });

  it("reports missing required fields", () => {
    const result = validateAndNormalizeRecord({
      sourceRecordId: "rec-missing",
      firstName: "No",
      lastName: "Dob",
      dateOfBirth: "",
      sexOrGender: "female",
      phone: "3125550198",
      email: "missing.dob@example.test",
      streetAddress: "1 Main St",
      city: "Chicago",
      state: "IL",
      zip: "60607",
      insurancePayer: "Aetna",
      insuranceMemberId: "AET123",
      reasonForVisit: "Intake",
      preferredContactMethod: "email",
      sourceFormat: "json",
      rawSourceExcerpt: "missing DOB",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validation exception");
    expect(result.exceptions).toContainEqual(
      expect.objectContaining({
        code: "missing_required_field",
        field: "dateOfBirth",
      }),
    );
  });

  it("reports invalid phone and ambiguous insurance", () => {
    const result = validateAndNormalizeRecord({
      sourceRecordId: "rec-bad",
      firstName: "Sam",
      lastName: "Rivera",
      dateOfBirth: "1980-10-05",
      sexOrGender: "M",
      phone: "call office",
      email: "sam.rivera@example.test",
      streetAddress: "99 State St",
      city: "Chicago",
      state: "IL",
      zip: "60601",
      insurancePayer: "Blue",
      insuranceMemberId: "BLUE9",
      reasonForVisit: "New patient",
      preferredContactMethod: "text",
      sourceFormat: "json",
      rawSourceExcerpt: "Blue insurance, bad phone",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validation exception");
    expect(result.exceptions.map((exception) => exception.code)).toEqual(
      expect.arrayContaining(["invalid_format", "ambiguous_value"]),
    );
  });
});
```

- [ ] **Step 2: Run validation tests and confirm failure**

Run:

```bash
npm test -- tests/domain/validation.test.ts
```

Expected: FAIL because `src/domain/validation.ts` does not exist.

- [ ] **Step 3: Implement schemas**

Create `src/domain/schema.ts` with this content:

```ts
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
```

- [ ] **Step 4: Implement validation**

Create `src/domain/validation.ts` with this content:

```ts
import {
  type NormalizedIntakeRecord,
  type RawIntakeRecord,
  type ValidationException,
  type ValidationResult,
} from "./schema.js";

const STATE_ALIASES: Record<string, string> = {
  illinois: "IL",
  il: "IL",
  wisconsin: "WI",
  wi: "WI",
  indiana: "IN",
  in: "IN",
};

const REQUIRED_FIELDS = [
  "sourceRecordId",
  "firstName",
  "lastName",
  "dateOfBirth",
  "sexOrGender",
  "phone",
  "streetAddress",
  "city",
  "state",
  "zip",
  "reasonForVisit",
] as const;

export function validateAndNormalizeRecord(input: RawIntakeRecord): ValidationResult {
  const exceptions: ValidationException[] = [];

  for (const field of REQUIRED_FIELDS) {
    const value = input[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      exceptions.push({
        code: "missing_required_field",
        severity: "error",
        field,
        message: `${field} is required for intake automation.`,
        rawValue: value,
        suggestedRemediation: `Provide ${field} before rerunning this record.`,
      });
    }
  }

  const dateOfBirth = normalizeDate(String(input.dateOfBirth ?? ""));
  if (input.dateOfBirth && !dateOfBirth) {
    exceptions.push({
      code: "invalid_format",
      severity: "error",
      field: "dateOfBirth",
      message: "Date of birth could not be normalized to YYYY-MM-DD.",
      rawValue: input.dateOfBirth,
      suggestedRemediation: "Use YYYY-MM-DD or MM/DD/YYYY.",
    });
  }

  const phone = normalizePhone(String(input.phone ?? ""));
  if (input.phone && !phone) {
    exceptions.push({
      code: "invalid_format",
      severity: "error",
      field: "phone",
      message: "Phone number could not be normalized.",
      rawValue: input.phone,
      suggestedRemediation: "Provide a 10-digit US phone number.",
    });
  }

  const insurancePayer = String(input.insurancePayer ?? "").trim();
  if (/^blue$/i.test(insurancePayer)) {
    exceptions.push({
      code: "ambiguous_value",
      severity: "error",
      field: "insurancePayer",
      message: "Insurance payer 'Blue' has multiple plausible mappings.",
      rawValue: input.insurancePayer,
      suggestedRemediation: "Specify the full payer name, such as Blue Cross Blue Shield of Illinois.",
    });
  }

  const state = normalizeState(String(input.state ?? ""));
  if (input.state && !state) {
    exceptions.push({
      code: "invalid_format",
      severity: "error",
      field: "state",
      message: "State could not be normalized to a two-letter code.",
      rawValue: input.state,
      suggestedRemediation: "Use a supported state name or abbreviation.",
    });
  }

  const zip = normalizeZip(String(input.zip ?? ""));
  if (input.zip && !zip) {
    exceptions.push({
      code: "invalid_format",
      severity: "error",
      field: "zip",
      message: "ZIP code could not be normalized.",
      rawValue: input.zip,
      suggestedRemediation: "Provide a five-digit ZIP code.",
    });
  }

  const partialRecord: Partial<NormalizedIntakeRecord> = {
    sourceRecordId: String(input.sourceRecordId ?? ""),
    firstName: String(input.firstName ?? "").trim(),
    lastName: String(input.lastName ?? "").trim(),
    dateOfBirth: dateOfBirth ?? "",
    sexOrGender: normalizeGender(String(input.sexOrGender ?? "")),
    phone: phone ?? "",
    email: String(input.email ?? "").trim(),
    streetAddress: String(input.streetAddress ?? "").trim(),
    city: String(input.city ?? "").trim(),
    state: state ?? "",
    zip: zip ?? "",
    insurancePayer,
    insuranceMemberId: String(input.insuranceMemberId ?? "").trim(),
    insuranceGroupId: optionalString(input.insuranceGroupId),
    reasonForVisit: String(input.reasonForVisit ?? "").trim(),
    preferredContactMethod: normalizeContactMethod(String(input.preferredContactMethod ?? "")),
    notes: optionalString(input.notes),
    sourceFormat: input.sourceFormat,
    rawSourceExcerpt: input.rawSourceExcerpt,
  };

  if (exceptions.length > 0) {
    return { ok: false, exceptions, partialRecord };
  }

  return {
    ok: true,
    record: partialRecord as NormalizedIntakeRecord,
    exceptions: [],
  };
}

function normalizeDate(value: string): string | undefined {
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) return trimmed;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (!us) return undefined;
  const month = us[1].padStart(2, "0");
  const day = us[2].padStart(2, "0");
  return `${us[3]}-${month}-${day}`;
}

function normalizePhone(value: string): string | undefined {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return undefined;
}

function normalizeState(value: string): string | undefined {
  return STATE_ALIASES[value.trim().toLowerCase()];
}

function normalizeZip(value: string): string | undefined {
  const match = /^(\d{5})(?:-\d{4})?$/.exec(value.trim());
  return match?.[1];
}

function normalizeGender(value: string): NormalizedIntakeRecord["sexOrGender"] {
  const normalized = value.trim().toLowerCase();
  if (["f", "female"].includes(normalized)) return "female";
  if (["m", "male"].includes(normalized)) return "male";
  if (["other", "nonbinary", "non-binary"].includes(normalized)) return "other";
  return "unknown";
}

function normalizeContactMethod(value: string): NormalizedIntakeRecord["preferredContactMethod"] {
  const normalized = value.trim().toLowerCase();
  if (["phone", "email", "text", "mail"].includes(normalized)) {
    return normalized as NormalizedIntakeRecord["preferredContactMethod"];
  }
  return "phone";
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
```

- [ ] **Step 5: Run validation tests**

Run:

```bash
npm test -- tests/domain/validation.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit domain model**

```bash
git add src/domain/schema.ts src/domain/validation.ts tests/domain/validation.test.ts
git commit -m "feat: add intake validation model"
```

## Task 3: Source Record Loading And Parsing

**Files:**
- Create: `src/parsing/jsonCsvParser.ts`
- Create: `src/parsing/textParser.ts`
- Create: `src/parsing/loadRecords.ts`
- Create: `tests/parsing/loadRecords.test.ts`
- Create: `data/demo/intake-records.json`
- Create: `data/demo/intake-notes.txt`

- [ ] **Step 1: Write parser tests**

Create `tests/parsing/loadRecords.test.ts` with this content:

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSourceRecords } from "../../src/parsing/loadRecords.js";

describe("loadSourceRecords", () => {
  it("loads JSON records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intake-json-"));
    const path = join(dir, "records.json");
    await writeFile(path, JSON.stringify([{ sourceRecordId: "json-1", firstName: "Ava" }]));

    const records = await loadSourceRecords(path);

    expect(records).toMatchObject([
      {
        sourceRecordId: "json-1",
        firstName: "Ava",
        sourceFormat: "json",
      },
    ]);
    expect(records[0].rawSourceExcerpt).toContain("json-1");
  });

  it("loads CSV records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intake-csv-"));
    const path = join(dir, "records.csv");
    await writeFile(path, "sourceRecordId,firstName,lastName\ncsv-1,Sam,Rivera\n");

    const records = await loadSourceRecords(path);

    expect(records).toMatchObject([
      {
        sourceRecordId: "csv-1",
        firstName: "Sam",
        lastName: "Rivera",
        sourceFormat: "csv",
      },
    ]);
  });

  it("loads semi-structured text records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intake-text-"));
    const path = join(dir, "records.txt");
    await writeFile(
      path,
      [
        "Record: text-1",
        "Name: Jordan Patel",
        "DOB: 1975-04-22",
        "Phone: 312-555-0123",
        "Reason: Follow-up visit",
      ].join("\n"),
    );

    const records = await loadSourceRecords(path);

    expect(records[0]).toMatchObject({
      sourceRecordId: "text-1",
      firstName: "Jordan",
      lastName: "Patel",
      dateOfBirth: "1975-04-22",
      phone: "312-555-0123",
      reasonForVisit: "Follow-up visit",
      sourceFormat: "text",
    });
  });
});
```

- [ ] **Step 2: Run parser tests and confirm failure**

Run:

```bash
npm test -- tests/parsing/loadRecords.test.ts
```

Expected: FAIL because parsing modules do not exist.

- [ ] **Step 3: Implement JSON and CSV parser**

Create `src/parsing/jsonCsvParser.ts` with this content:

```ts
import { parse } from "csv-parse/sync";
import type { RawIntakeRecord } from "../domain/schema.js";

export function parseJsonRecords(content: string): RawIntakeRecord[] {
  const parsed = JSON.parse(content) as Array<Record<string, unknown>>;
  if (!Array.isArray(parsed)) {
    throw new Error("JSON intake input must be an array of records.");
  }
  return parsed.map((record, index) => ({
    ...record,
    sourceRecordId: String(record.sourceRecordId ?? `json-${index + 1}`),
    sourceFormat: "json",
    rawSourceExcerpt: JSON.stringify(record),
  }));
}

export function parseCsvRecords(content: string): RawIntakeRecord[] {
  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Array<Record<string, unknown>>;

  return rows.map((record, index) => ({
    ...record,
    sourceRecordId: String(record.sourceRecordId ?? `csv-${index + 1}`),
    sourceFormat: "csv",
    rawSourceExcerpt: JSON.stringify(record),
  }));
}
```

- [ ] **Step 4: Implement semi-structured text parser**

Create `src/parsing/textParser.ts` with this content:

```ts
import type { RawIntakeRecord } from "../domain/schema.js";

const FIELD_ALIASES: Record<string, string> = {
  record: "sourceRecordId",
  id: "sourceRecordId",
  name: "name",
  dob: "dateOfBirth",
  dateofbirth: "dateOfBirth",
  sex: "sexOrGender",
  gender: "sexOrGender",
  phone: "phone",
  email: "email",
  address: "streetAddress",
  city: "city",
  state: "state",
  zip: "zip",
  insurance: "insurancePayer",
  payer: "insurancePayer",
  memberid: "insuranceMemberId",
  groupid: "insuranceGroupId",
  reason: "reasonForVisit",
  preferredcontact: "preferredContactMethod",
  notes: "notes",
};

export function parseTextRecords(content: string): RawIntakeRecord[] {
  const blocks = content
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.map((block, index) => {
    const record: Record<string, unknown> = {};
    for (const line of block.split(/\n/g)) {
      const match = /^([^:]+):\s*(.+)$/.exec(line.trim());
      if (!match) continue;
      const key = normalizeKey(match[1]);
      const field = FIELD_ALIASES[key];
      if (!field) continue;
      if (field === "name") {
        const parts = match[2].trim().split(/\s+/);
        record.firstName = parts[0] ?? "";
        record.lastName = parts.slice(1).join(" ");
      } else {
        record[field] = match[2].trim();
      }
    }

    const sourceRecordId = String(record.sourceRecordId ?? `text-${index + 1}`);
    return {
      ...record,
      sourceRecordId,
      sourceFormat: "text",
      rawSourceExcerpt: block,
    };
  });
}

function normalizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}
```

- [ ] **Step 5: Implement parser router**

Create `src/parsing/loadRecords.ts` with this content:

```ts
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { RawIntakeRecord } from "../domain/schema.js";
import { parseCsvRecords, parseJsonRecords } from "./jsonCsvParser.js";
import { parseTextRecords } from "./textParser.js";

export async function loadSourceRecords(path: string): Promise<RawIntakeRecord[]> {
  const content = await readFile(path, "utf8");
  const extension = extname(path).toLowerCase();

  if (extension === ".json") return parseJsonRecords(content);
  if (extension === ".csv") return parseCsvRecords(content);
  if (extension === ".txt") return parseTextRecords(content);

  throw new Error(`Unsupported intake source extension: ${extension}`);
}
```

- [ ] **Step 6: Add demo input files**

Create `data/demo/intake-records.json` with this content:

```json
[
  {
    "sourceRecordId": "demo-001",
    "firstName": "Ava",
    "lastName": "Nguyen",
    "dateOfBirth": "03/14/1987",
    "sexOrGender": "Female",
    "phone": "(312) 555-0198",
    "email": "ava.nguyen@example.test",
    "streetAddress": "1200 West Lake Street",
    "city": "Chicago",
    "state": "Illinois",
    "zip": "60607-1234",
    "insurancePayer": "Aetna",
    "insuranceMemberId": "AET123456",
    "insuranceGroupId": "GRP9",
    "reasonForVisit": "Annual wellness visit",
    "preferredContactMethod": "phone",
    "notes": "Prefers morning appointments."
  },
  {
    "sourceRecordId": "demo-002",
    "firstName": "Marcus",
    "lastName": "Lee",
    "dateOfBirth": "1979-11-02",
    "sexOrGender": "Male",
    "phone": "773-555-0144",
    "email": "marcus.lee@example.test",
    "streetAddress": "47 North Dearborn Street",
    "city": "Chicago",
    "state": "IL",
    "zip": "60602",
    "insurancePayer": "UnitedHealthcare",
    "insuranceMemberId": "UHC99881",
    "reasonForVisit": "Medication follow-up",
    "preferredContactMethod": "email",
    "notes": "Needs interpreter for spouse."
  },
  {
    "sourceRecordId": "demo-003",
    "firstName": "Priya",
    "lastName": "Shah",
    "dateOfBirth": "1992-05-19",
    "sexOrGender": "Female",
    "phone": "3125550177",
    "email": "priya.shah@example.test",
    "streetAddress": "804 South Wabash Avenue",
    "city": "Chicago",
    "state": "IL",
    "zip": "60605",
    "insurancePayer": "Cigna",
    "insuranceMemberId": "CIG44220",
    "reasonForVisit": "New patient consult",
    "preferredContactMethod": "text"
  },
  {
    "sourceRecordId": "demo-missing-dob",
    "firstName": "Noah",
    "lastName": "Brooks",
    "dateOfBirth": "",
    "sexOrGender": "Male",
    "phone": "312-555-0188",
    "email": "noah.brooks@example.test",
    "streetAddress": "1 Main Street",
    "city": "Chicago",
    "state": "IL",
    "zip": "60601",
    "insurancePayer": "Aetna",
    "insuranceMemberId": "AET999",
    "reasonForVisit": "Initial intake",
    "preferredContactMethod": "phone"
  },
  {
    "sourceRecordId": "demo-ambiguous-insurance",
    "firstName": "Sam",
    "lastName": "Rivera",
    "dateOfBirth": "1980-10-05",
    "sexOrGender": "Other",
    "phone": "312-555-0199",
    "email": "sam.rivera@example.test",
    "streetAddress": "99 State Street",
    "city": "Chicago",
    "state": "IL",
    "zip": "60601",
    "insurancePayer": "Blue",
    "insuranceMemberId": "BLUE9",
    "reasonForVisit": "New patient",
    "preferredContactMethod": "email"
  },
  {
    "sourceRecordId": "demo-invalid-phone",
    "firstName": "Elena",
    "lastName": "Garcia",
    "dateOfBirth": "1988-02-29",
    "sexOrGender": "Female",
    "phone": "call office",
    "email": "elena.garcia@example.test",
    "streetAddress": "222 West Adams Street",
    "city": "Chicago",
    "state": "IL",
    "zip": "60606",
    "insurancePayer": "Cigna",
    "insuranceMemberId": "CIG1100",
    "reasonForVisit": "Follow-up",
    "preferredContactMethod": "phone"
  }
]
```

Create `data/demo/intake-notes.txt` with this content:

```text
Record: text-001
Name: Jordan Patel
DOB: 1975-04-22
Sex: Male
Phone: 312-555-0123
Email: jordan.patel@example.test
Address: 10 South Michigan Avenue
City: Chicago
State: IL
Zip: 60603
Insurance: Aetna
Member ID: AET555
Reason: Follow-up visit
Preferred Contact: phone
Notes: Requests afternoon appointment.
```

- [ ] **Step 7: Run parser tests**

Run:

```bash
npm test -- tests/parsing/loadRecords.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run full verification**

Run:

```bash
npm run typecheck
npm test
```

Expected: PASS.

- [ ] **Step 9: Commit parsing**

```bash
git add src/parsing tests/parsing data/demo
git commit -m "feat: add intake source parsing"
```

## Task 4: Audit Store And Summary

**Files:**
- Create: `src/audit/auditStore.ts`
- Create: `src/audit/summary.ts`
- Create: `tests/audit/auditStore.test.ts`

- [ ] **Step 1: Write failing audit tests**

Create `tests/audit/auditStore.test.ts` with this content:

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAuditStore } from "../../src/audit/auditStore.js";
import { renderSummary } from "../../src/audit/summary.js";

describe("FileAuditStore", () => {
  it("writes events, screenshots, exceptions, and summary artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-"));
    const store = await FileAuditStore.create({
      runsDir: root,
      runId: "run-test",
      now: () => "2026-04-28T12:00:00.000Z",
    });

    await store.writeEvent({
      phase: "adapter",
      actionType: "click",
      recordId: "demo-001",
      target: "fake",
      result: "clicked Save",
    });
    const screenshotPath = await store.writeScreenshot("demo-001", "fake", "after-save", Buffer.from("png"));
    await store.writeException("demo-001", {
      code: "verification_failed",
      severity: "error",
      message: "Could not verify save.",
      suggestedRemediation: "Review target screen.",
    });
    await store.writeSummary("# Summary\n");

    expect(screenshotPath).toContain("screenshots/demo-001/fake/after-save.png");

    const events = await readFile(join(root, "run-test", "events.jsonl"), "utf8");
    expect(events).toContain("\"actionType\":\"click\"");
    expect(events).toContain("\"timestamp\":\"2026-04-28T12:00:00.000Z\"");

    const exception = await readFile(join(root, "run-test", "exceptions", "demo-001.json"), "utf8");
    expect(exception).toContain("verification_failed");

    const summary = await readFile(join(root, "run-test", "summary.md"), "utf8");
    expect(summary).toBe("# Summary\n");
  });

  it("renders status counts in Markdown", () => {
    const summary = renderSummary({
      runId: "run-test",
      totalRecords: 2,
      targetCounts: {
        openemr: { succeeded: 1, exception: 1, skipped: 0 },
        excel: { succeeded: 2, exception: 0, skipped: 0 },
      },
      preflightExceptions: 1,
    });

    expect(summary).toContain("# Workflow Run run-test");
    expect(summary).toContain("| openemr | 1 | 1 | 0 |");
    expect(summary).toContain("Preflight exceptions: 1");
  });
});
```

- [ ] **Step 2: Run audit tests and confirm failure**

Run:

```bash
npm test -- tests/audit/auditStore.test.ts
```

Expected: FAIL because audit modules do not exist.

- [ ] **Step 3: Implement file audit store**

Create `src/audit/auditStore.ts` with this content:

```ts
import { mkdir, writeFile, appendFile } from "node:fs/promises";
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
    private readonly runId: string,
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
    const relativePath = join("screenshots", recordId, target, `${sanitize(step)}.png`);
    const absolutePath = join(this.runDir, relativePath);
    await mkdir(join(this.runDir, "screenshots", recordId, target), { recursive: true });
    await writeFile(absolutePath, bytes);
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
```

- [ ] **Step 4: Implement summary renderer**

Create `src/audit/summary.ts` with this content:

```ts
import type { TargetName, TargetTaskStatus } from "../domain/schema.js";

export interface SummaryInput {
  runId: string;
  totalRecords: number;
  targetCounts: Partial<Record<TargetName, Record<TargetTaskStatus, number>>>;
  preflightExceptions: number;
}

export function renderSummary(input: SummaryInput): string {
  const lines = [
    `# Workflow Run ${input.runId}`,
    "",
    `Total source records: ${input.totalRecords}`,
    `Preflight exceptions: ${input.preflightExceptions}`,
    "",
    "| Target | Succeeded | Exceptions | Skipped |",
    "| --- | ---: | ---: | ---: |",
  ];

  for (const [target, counts] of Object.entries(input.targetCounts)) {
    lines.push(`| ${target} | ${counts.succeeded ?? 0} | ${counts.exception ?? 0} | ${counts.skipped ?? 0} |`);
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}
```

- [ ] **Step 5: Run audit tests**

Run:

```bash
npm test -- tests/audit/auditStore.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run full verification**

Run:

```bash
npm run typecheck
npm test
```

Expected: PASS.

- [ ] **Step 7: Commit audit store**

```bash
git add src/audit tests/audit
git commit -m "feat: add audit artifact store"
```

## Task 5: Adapter Contract, Agent Interfaces, And Fake Adapter

**Files:**
- Create: `src/agent/types.ts`
- Create: `src/agent/scriptedAgent.ts`
- Create: `src/adapters/contract.ts`
- Create: `src/adapters/fakeAdapter.ts`
- Create: `tests/agent/scriptedAgent.test.ts`

- [ ] **Step 1: Write failing scripted agent tests**

Create `tests/agent/scriptedAgent.test.ts` with this content:

```ts
import { describe, expect, it } from "vitest";
import { ScriptedAgentDriver } from "../../src/agent/scriptedAgent.js";

describe("ScriptedAgentDriver", () => {
  it("selects the first allowed action with high confidence", async () => {
    const agent = new ScriptedAgentDriver();

    const decision = await agent.decide({
      target: "fake",
      recordId: "demo-001",
      step: "save",
      screenshotPath: "screenshots/demo-001/fake/save.png",
      visibleText: "Save patient",
      allowedActions: [
        { id: "click-save", description: "Click Save" },
        { id: "stop", description: "Stop" },
      ],
    });

    expect(decision).toEqual({
      actionId: "click-save",
      confidence: 1,
      rationale: "Scripted agent selected the first allowed action for step save.",
    });
  });
});
```

- [ ] **Step 2: Run scripted agent tests and confirm failure**

Run:

```bash
npm test -- tests/agent/scriptedAgent.test.ts
```

Expected: FAIL because agent modules do not exist.

- [ ] **Step 3: Implement agent types**

Create `src/agent/types.ts` with this content:

```ts
import type { TargetName } from "../domain/schema.js";

export interface AllowedAgentAction {
  id: string;
  description: string;
}

export interface AgentDecisionInput {
  target: TargetName;
  recordId: string;
  step: string;
  screenshotPath?: string;
  visibleText?: string;
  allowedActions: AllowedAgentAction[];
}

export interface AgentDecision {
  actionId: string;
  confidence: number;
  rationale: string;
}

export interface AgentDriver {
  decide(input: AgentDecisionInput): Promise<AgentDecision>;
}
```

- [ ] **Step 4: Implement scripted agent**

Create `src/agent/scriptedAgent.ts` with this content:

```ts
import type { AgentDecision, AgentDecisionInput, AgentDriver } from "./types.js";

export class ScriptedAgentDriver implements AgentDriver {
  async decide(input: AgentDecisionInput): Promise<AgentDecision> {
    const first = input.allowedActions[0];
    if (!first) {
      return {
        actionId: "stop",
        confidence: 0,
        rationale: `Scripted agent found no allowed actions for step ${input.step}.`,
      };
    }

    return {
      actionId: first.id,
      confidence: 1,
      rationale: `Scripted agent selected the first allowed action for step ${input.step}.`,
    };
  }
}
```

- [ ] **Step 5: Implement adapter contract**

Create `src/adapters/contract.ts` with this content:

```ts
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
  | { status: "succeeded"; targetRecordId?: string }
  | { status: "skipped"; reason: string }
  | { status: "exception"; exception: ValidationException & Record<string, unknown> };

export interface TargetAdapter {
  readonly name: TargetName;
  prepare(): Promise<void>;
  runRecord(context: TargetRunContext): Promise<TargetAdapterResult>;
  close(): Promise<void>;
}
```

- [ ] **Step 6: Implement fake adapter**

Create `src/adapters/fakeAdapter.ts` with this content:

```ts
import type { TargetAdapter, TargetAdapterResult, TargetRunContext } from "./contract.js";

export class FakeAdapter implements TargetAdapter {
  readonly name = "fake" as const;

  constructor(private readonly mode: "success" | "exception" = "success") {}

  async prepare(): Promise<void> {}

  async runRecord(context: TargetRunContext): Promise<TargetAdapterResult> {
    await context.audit.writeEvent({
      recordId: context.record.sourceRecordId,
      target: this.name,
      phase: "adapter",
      actionType: "inspect",
      result: "fake adapter inspected record",
    });

    if (this.mode === "exception") {
      return {
        status: "exception",
        exception: {
          code: "verification_failed",
          severity: "error",
          message: "Fake adapter verification failed.",
          suggestedRemediation: "Use success mode for happy-path tests.",
        },
      };
    }

    return {
      status: "succeeded",
      targetRecordId: `fake-${context.record.sourceRecordId}`,
    };
  }

  async close(): Promise<void> {}
}
```

- [ ] **Step 7: Run agent tests**

Run:

```bash
npm test -- tests/agent/scriptedAgent.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run full verification**

Run:

```bash
npm run typecheck
npm test
```

Expected: PASS.

- [ ] **Step 9: Commit adapter interfaces**

```bash
git add src/agent src/adapters tests/agent
git commit -m "feat: add agent and adapter contracts"
```

## Task 6: Workflow Orchestrator

**Files:**
- Create: `src/orchestrator/runWorkflow.ts`
- Create: `tests/orchestrator/runWorkflow.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing orchestrator tests**

Create `tests/orchestrator/runWorkflow.test.ts` with this content:

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAdapter } from "../../src/adapters/fakeAdapter.js";
import { ScriptedAgentDriver } from "../../src/agent/scriptedAgent.js";
import { runWorkflow } from "../../src/orchestrator/runWorkflow.js";

describe("runWorkflow", () => {
  it("runs valid records through adapters and writes audit artifacts", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "workflow-"));
    const result = await runWorkflow({
      runId: "run-orchestrator",
      runsDir,
      records: [
        cleanRecord("demo-001"),
        { ...cleanRecord("demo-missing"), dateOfBirth: "" },
      ],
      adapters: [new FakeAdapter("success")],
      agent: new ScriptedAgentDriver(),
      now: () => "2026-04-28T12:00:00.000Z",
    });

    expect(result.status).toBe("completed_with_exceptions");
    expect(result.preflightExceptions).toBe(1);
    expect(result.targetCounts.fake).toEqual({ succeeded: 1, exception: 0, skipped: 0 });

    const summary = await readFile(join(runsDir, "run-orchestrator", "summary.md"), "utf8");
    expect(summary).toContain("| fake | 1 | 0 | 0 |");

    const exception = await readFile(join(runsDir, "run-orchestrator", "exceptions", "demo-missing.json"), "utf8");
    expect(exception).toContain("missing_required_field");
  });
});

function cleanRecord(sourceRecordId: string) {
  return {
    sourceRecordId,
    firstName: "Ava",
    lastName: "Nguyen",
    dateOfBirth: "1987-03-14",
    sexOrGender: "Female",
    phone: "3125550198",
    email: "ava.nguyen@example.test",
    streetAddress: "1200 West Lake Street",
    city: "Chicago",
    state: "IL",
    zip: "60607",
    insurancePayer: "Aetna",
    insuranceMemberId: "AET123456",
    reasonForVisit: "Annual wellness visit",
    preferredContactMethod: "phone",
    sourceFormat: "json" as const,
    rawSourceExcerpt: "Ava Nguyen intake",
  };
}
```

- [ ] **Step 2: Run orchestrator tests and confirm failure**

Run:

```bash
npm test -- tests/orchestrator/runWorkflow.test.ts
```

Expected: FAIL because `runWorkflow.ts` does not exist.

- [ ] **Step 3: Implement workflow orchestrator**

Create `src/orchestrator/runWorkflow.ts` with this content:

```ts
import { randomUUID } from "node:crypto";
import { FileAuditStore } from "../audit/auditStore.js";
import { renderSummary } from "../audit/summary.js";
import type { AgentDriver } from "../agent/types.js";
import type { TargetAdapter, TargetAdapterResult } from "../adapters/contract.js";
import type { RawIntakeRecord, RunStatus, TargetName, TargetTaskStatus, ValidationException } from "../domain/schema.js";
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

export async function runWorkflow(input: RunWorkflowInput): Promise<RunWorkflowResult> {
  const runId = input.runId ?? `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const audit = await FileAuditStore.create({ runsDir: input.runsDir, runId, now: input.now });
  const targetCounts = initializeTargetCounts(input.adapters.map((adapter) => adapter.name));
  const readiness = new Map<TargetName, { ready: boolean; exception?: ValidationException }>();
  let preflightExceptions = 0;

  await audit.writeRunMetadata({
    runId,
    status: "running",
    targets: input.adapters.map((adapter) => adapter.name),
    totalRecords: input.records.length,
  });
  await audit.writeInputArtifact("normalized-records.json", "[]\n");
  await audit.writeEvent({ phase: "run", actionType: "start", result: "workflow run started" });

  for (const adapter of input.adapters) {
    try {
      await adapter.prepare();
      readiness.set(adapter.name, { ready: true });
    } catch (error) {
      const exception = exceptionFromError("environment_not_ready", error);
      readiness.set(adapter.name, { ready: false, exception });
      await audit.writeEvent({
        target: adapter.name,
        phase: "environment",
        actionType: "prepare",
        result: exception.message,
        exceptionCode: exception.code,
      });
    }
  }

  try {
    const normalizedRecords = [];
    for (const rawRecord of input.records) {
      const validation = validateAndNormalizeRecord(rawRecord);
      if (!validation.ok) {
        preflightExceptions += 1;
        await audit.writeException(String(rawRecord.sourceRecordId), {
          ...validation.exceptions[0],
          allExceptions: validation.exceptions,
          partialRecord: validation.partialRecord,
        });
        await audit.writeEvent({
          recordId: String(rawRecord.sourceRecordId),
          phase: "validation",
          actionType: "validate",
          result: "record stopped by validation",
          exceptionCode: validation.exceptions[0].code,
        });
        continue;
      }

      normalizedRecords.push(validation.record);

      for (const adapter of input.adapters) {
        const state = readiness.get(adapter.name);
        if (!state?.ready) {
          const exception = state?.exception ?? {
            code: "environment_not_ready",
            severity: "error",
            message: `${adapter.name} was not prepared.`,
          } satisfies ValidationException;
          targetCounts[adapter.name]!.exception += 1;
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

        const result = await adapter
          .runRecord({ runId, record: validation.record, audit, agent: input.agent })
          .catch((error): TargetAdapterResult => ({
            status: "exception",
            exception: exceptionFromError("ui_state_unexpected", error),
          }));
        targetCounts[adapter.name]![result.status] += 1;
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

  const hasExceptions =
    preflightExceptions > 0 ||
    Object.values(targetCounts).some((counts) => counts.exception > 0);
  const status: RunStatus = hasExceptions ? "completed_with_exceptions" : "completed";

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
    targets: input.adapters.map((adapter) => adapter.name),
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

function exceptionFromError(code: ValidationException["code"], error: unknown): ValidationException {
  return {
    code,
    severity: "error",
    message: error instanceof Error ? error.message : String(error),
    suggestedRemediation: "Review the target readiness and current UI screenshot artifacts.",
  };
}
```

- [ ] **Step 4: Update public exports**

Modify `src/index.ts` to this content:

```ts
export * from "./domain/schema.js";
export * from "./domain/validation.js";
export * from "./parsing/loadRecords.js";
export * from "./audit/auditStore.js";
export * from "./audit/summary.js";
export * from "./agent/types.js";
export * from "./agent/scriptedAgent.js";
export * from "./orchestrator/runWorkflow.js";
export * from "./adapters/contract.js";
export * from "./adapters/fakeAdapter.js";
```

- [ ] **Step 5: Run orchestrator tests**

Run:

```bash
npm test -- tests/orchestrator/runWorkflow.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run full verification**

Run:

```bash
npm run typecheck
npm test
```

Expected: PASS.

- [ ] **Step 7: Commit orchestrator**

```bash
git add src/orchestrator src/index.ts tests/orchestrator
git commit -m "feat: add audited workflow orchestrator"
```

## Task 7: Configuration Parsing

**Files:**
- Create: `src/config.ts`
- Create: `tests/config.test.ts`

- [ ] **Step 1: Write failing configuration tests**

Create `tests/config.test.ts` with this content:

```ts
import { describe, expect, it } from "vitest";
import { buildRunConfig, parseTargets } from "../src/config.js";

describe("configuration parsing", () => {
  it("parses comma-separated targets", () => {
    expect(parseTargets("fake,openemr,excel")).toEqual(["fake", "openemr", "excel"]);
  });

  it("builds a default run config", () => {
    const config = buildRunConfig({
      input: "data/demo/intake-records.json",
      targets: "fake",
      runsDir: "runs",
      excelWorkbookPath: "runs/intake-workbook.xlsx",
    });

    expect(config).toMatchObject({
      input: "data/demo/intake-records.json",
      targets: ["fake"],
      runsDir: "runs",
      agent: "scripted",
      excelWorkbookPath: "runs/intake-workbook.xlsx",
    });
  });
});
```

- [ ] **Step 2: Run configuration tests and confirm failure**

Run:

```bash
npm test -- tests/config.test.ts
```

Expected: FAIL because `src/config.ts` does not exist.

- [ ] **Step 3: Implement configuration parsing**

Create `src/config.ts` with this content:

```ts
import { z } from "zod";
import { TargetNameSchema } from "./domain/schema.js";

export const CliRunConfigSchema = z.object({
  input: z.string(),
  targets: z.array(TargetNameSchema).min(1),
  runsDir: z.string().default(process.env.RUNS_DIR ?? "runs"),
  agent: z.enum(["scripted", "openai"]).default("scripted"),
  excelWorkbookPath: z.string().default(process.env.EXCEL_WORKBOOK_PATH ?? "runs/intake-workbook.xlsx"),
  openEmr: z.object({
    baseUrl: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
  }),
});

export type CliRunConfig = z.infer<typeof CliRunConfigSchema>;

export function parseTargets(value: string): Array<z.infer<typeof TargetNameSchema>> {
  return value.split(",").map((target) => TargetNameSchema.parse(target.trim()));
}

export function buildRunConfig(options: {
  input: string;
  targets: string;
  runsDir?: string;
  agent?: "scripted" | "openai";
  excelWorkbookPath?: string;
}): CliRunConfig {
  return CliRunConfigSchema.parse({
    input: options.input,
    targets: parseTargets(options.targets),
    runsDir: options.runsDir,
    agent: options.agent,
    excelWorkbookPath: options.excelWorkbookPath,
    openEmr: {
      baseUrl: process.env.OPENEMR_BASE_URL,
      username: process.env.OPENEMR_USERNAME,
      password: process.env.OPENEMR_PASSWORD,
    },
  });
}
```

- [ ] **Step 4: Run configuration tests**

Run:

```bash
npm test -- tests/config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full verification**

Run:

```bash
npm run typecheck
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit configuration parsing**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add run configuration parsing"
```

## Task 8: OpenAI Agent Driver

**Files:**
- Create: `src/agent/openAiUiAgent.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Implement OpenAI UI agent driver**

Create `src/agent/openAiUiAgent.ts` with this content:

```ts
import OpenAI from "openai";
import type { AgentDecision, AgentDecisionInput, AgentDriver } from "./types.js";

export interface OpenAiUiAgentOptions {
  apiKey?: string;
  model: string;
}

export class OpenAiUiAgentDriver implements AgentDriver {
  private readonly client: OpenAI;

  constructor(private readonly options: OpenAiUiAgentOptions) {
    if (!options.apiKey) {
      throw new Error("OPENAI_API_KEY is required when --agent openai is used.");
    }
    this.client = new OpenAI({ apiKey: options.apiKey });
  }

  async decide(input: AgentDecisionInput): Promise<AgentDecision> {
    const response = await this.client.responses.create({
      model: this.options.model,
      input: [
        {
          role: "system",
          content:
            "You choose one allowed UI automation action. Return only JSON with actionId, confidence, and rationale. Stop when the screen state is uncertain.",
        },
        {
          role: "user",
          content: JSON.stringify({
            target: input.target,
            recordId: input.recordId,
            step: input.step,
            visibleText: input.visibleText,
            screenshotPath: input.screenshotPath,
            allowedActions: input.allowedActions,
          }),
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "agent_decision",
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["actionId", "confidence", "rationale"],
            properties: {
              actionId: { type: "string" },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              rationale: { type: "string" },
            },
          },
        },
      },
    });

    const text = response.output_text;
    const parsed = JSON.parse(text) as AgentDecision;
    const allowed = new Set(input.allowedActions.map((action) => action.id));
    if (!allowed.has(parsed.actionId) && parsed.actionId !== "stop") {
      return {
        actionId: "stop",
        confidence: 0,
        rationale: `Model selected disallowed action ${parsed.actionId}.`,
      };
    }
    return parsed;
  }
}
```

- [ ] **Step 2: Update exports**

Modify `src/index.ts` so the agent export section includes:

```ts
export * from "./agent/types.js";
export * from "./agent/scriptedAgent.js";
export * from "./agent/openAiUiAgent.js";
```

- [ ] **Step 3: Run agent tests and typecheck**

Run:

```bash
npm test -- tests/agent/scriptedAgent.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit OpenAI agent driver**

```bash
git add src/agent/openAiUiAgent.ts src/index.ts
git commit -m "feat: add OpenAI UI agent driver"
```

## Task 9: Excel Workbook And Desktop Adapter

**Files:**
- Create: `src/targets/excel/workbook.ts`
- Create: `src/targets/excel/macExcelPort.ts`
- Create: `src/targets/excel/excelAdapter.ts`
- Create: `tests/targets/excelAdapter.test.ts`

- [ ] **Step 1: Write failing Excel adapter tests**

Create `tests/targets/excelAdapter.test.ts` with this content:

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAuditStore } from "../../src/audit/auditStore.js";
import { ScriptedAgentDriver } from "../../src/agent/scriptedAgent.js";
import { ExcelAdapter } from "../../src/targets/excel/excelAdapter.js";
import type { ExcelDesktopPort } from "../../src/targets/excel/macExcelPort.js";
import type { NormalizedIntakeRecord } from "../../src/domain/schema.js";

describe("ExcelAdapter", () => {
  it("pastes a normalized record into Excel and verifies the workbook", async () => {
    const root = await mkdtemp(join(tmpdir(), "excel-adapter-"));
    const workbookPath = join(root, "intake.xlsx");
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-excel" });
    const port = new FakeExcelPort();
    const adapter = new ExcelAdapter({ workbookPath, port });

    await adapter.prepare();
    const result = await adapter.runRecord({
      runId: "run-excel",
      record: record("demo-001"),
      audit,
      agent: new ScriptedAgentDriver(),
    });

    expect(result.status).toBe("succeeded");
    expect(port.pastedRows[0]).toContain("Ava");
    expect(port.screenshots).toEqual(["before-demo-001", "after-demo-001"]);
  });
});

class FakeExcelPort implements ExcelDesktopPort {
  pastedRows: string[] = [];
  screenshots: string[] = [];

  async openWorkbook(): Promise<void> {}

  async pasteRow(rowNumber: number, tsv: string): Promise<void> {
    this.pastedRows.push(`${rowNumber}:${tsv}`);
  }

  async screenshot(label: string): Promise<Buffer> {
    this.screenshots.push(label);
    return Buffer.from(`png-${label}`);
  }

  async close(): Promise<void> {}
}

function record(sourceRecordId: string): NormalizedIntakeRecord {
  return {
    sourceRecordId,
    firstName: "Ava",
    lastName: "Nguyen",
    dateOfBirth: "1987-03-14",
    sexOrGender: "female",
    phone: "+13125550198",
    email: "ava.nguyen@example.test",
    streetAddress: "1200 West Lake Street",
    city: "Chicago",
    state: "IL",
    zip: "60607",
    insurancePayer: "Aetna",
    insuranceMemberId: "AET123456",
    insuranceGroupId: "GRP9",
    reasonForVisit: "Annual wellness visit",
    preferredContactMethod: "phone",
    notes: "Prefers morning appointments.",
    sourceFormat: "json",
    rawSourceExcerpt: "Ava Nguyen intake",
  };
}
```

- [ ] **Step 2: Run Excel adapter tests and confirm failure**

Run:

```bash
npm test -- tests/targets/excelAdapter.test.ts
```

Expected: FAIL because Excel target modules do not exist.

- [ ] **Step 3: Implement workbook helpers**

Create `src/targets/excel/workbook.ts` with this content:

```ts
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import ExcelJS from "exceljs";
import type { NormalizedIntakeRecord } from "../../domain/schema.js";

export const INTAKE_COLUMNS = [
  "Source Record ID",
  "First Name",
  "Last Name",
  "Date of Birth",
  "Sex/Gender",
  "Phone",
  "Email",
  "Street Address",
  "City",
  "State",
  "ZIP",
  "Insurance Payer",
  "Member ID",
  "Group ID",
  "Reason for Visit",
  "Preferred Contact",
  "Notes",
] as const;

export async function ensureWorkbook(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Intake");
  sheet.addRow([...INTAKE_COLUMNS]);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  await workbook.xlsx.writeFile(path);
}

export async function nextExcelRow(path: string): Promise<number> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.getWorksheet("Intake");
  if (!sheet) throw new Error("Workbook is missing Intake sheet.");
  return sheet.rowCount + 1;
}

export function recordToTsv(record: NormalizedIntakeRecord): string {
  return [
    record.sourceRecordId,
    record.firstName,
    record.lastName,
    record.dateOfBirth,
    record.sexOrGender,
    record.phone,
    record.email,
    record.streetAddress,
    record.city,
    record.state,
    record.zip,
    record.insurancePayer,
    record.insuranceMemberId,
    record.insuranceGroupId ?? "",
    record.reasonForVisit,
    record.preferredContactMethod,
    record.notes ?? "",
  ]
    .map((value) => value.replace(/\t/g, " ").replace(/\n/g, " "))
    .join("\t");
}
```

- [ ] **Step 4: Implement Excel desktop port**

Create `src/targets/excel/macExcelPort.ts` with this content:

```ts
import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExcelDesktopPort {
  openWorkbook(path: string): Promise<void>;
  pasteRow(rowNumber: number, tsv: string): Promise<void>;
  screenshot(label: string): Promise<Buffer>;
  close(): Promise<void>;
}

export class MacExcelPort implements ExcelDesktopPort {
  async openWorkbook(path: string): Promise<void> {
    await execFileAsync("open", ["-a", "Microsoft Excel", path]);
    await sleep(1500);
  }

  async pasteRow(rowNumber: number, tsv: string): Promise<void> {
    await copyToClipboard(tsv);
    const script = `
      tell application "Microsoft Excel"
        activate
        tell active sheet
          select range "A${rowNumber}"
        end tell
      end tell
      tell application "System Events"
        keystroke "v" using command down
      end tell
    `;
    await execFileAsync("osascript", ["-e", script]);
    await sleep(500);
  }

  async screenshot(label: string): Promise<Buffer> {
    const path = join(tmpdir(), `${label}-${Date.now()}.png`);
    await execFileAsync("/usr/sbin/screencapture", ["-x", path]);
    return await import("node:fs/promises").then((fs) => fs.readFile(path));
  }

  async close(): Promise<void> {
    const script = 'tell application "Microsoft Excel" to save active workbook';
    await execFileAsync("osascript", ["-e", script]);
  }
}

async function copyToClipboard(value: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pbcopy");
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pbcopy exited with code ${code}`));
    });
    child.stdin.end(value);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 5: Implement Excel adapter**

Create `src/targets/excel/excelAdapter.ts` with this content:

```ts
import type { TargetAdapter, TargetAdapterResult, TargetRunContext } from "../../adapters/contract.js";
import { ensureWorkbook, nextExcelRow, recordToTsv } from "./workbook.js";
import type { ExcelDesktopPort } from "./macExcelPort.js";

export interface ExcelAdapterOptions {
  workbookPath: string;
  port: ExcelDesktopPort;
}

export class ExcelAdapter implements TargetAdapter {
  readonly name = "excel" as const;

  constructor(private readonly options: ExcelAdapterOptions) {}

  async prepare(): Promise<void> {
    await ensureWorkbook(this.options.workbookPath);
    await this.options.port.openWorkbook(this.options.workbookPath);
  }

  async runRecord(context: TargetRunContext): Promise<TargetAdapterResult> {
    const before = await this.options.port.screenshot(`before-${context.record.sourceRecordId}`);
    const beforePath = await context.audit.writeScreenshot(context.record.sourceRecordId, this.name, "before-entry", before);
    await context.audit.writeEvent({
      recordId: context.record.sourceRecordId,
      target: this.name,
      phase: "desktop",
      actionType: "screenshot",
      screenshotPath: beforePath,
      result: "captured Excel before-entry screenshot",
    });

    const decision = await context.agent.decide({
      target: this.name,
      recordId: context.record.sourceRecordId,
      step: "paste-row",
      screenshotPath: beforePath,
      visibleText: "Microsoft Excel Intake sheet",
      allowedActions: [{ id: "paste-row", description: "Paste normalized intake row into the first empty table row." }],
    });

    if (decision.actionId !== "paste-row" || decision.confidence < 0.5) {
      return {
        status: "exception",
        exception: {
          code: "ui_state_unexpected",
          severity: "error",
          message: "Agent did not approve Excel row entry.",
          suggestedRemediation: decision.rationale,
        },
      };
    }

    const rowNumber = await nextExcelRow(this.options.workbookPath);
    await this.options.port.pasteRow(rowNumber, recordToTsv(context.record));
    const after = await this.options.port.screenshot(`after-${context.record.sourceRecordId}`);
    const afterPath = await context.audit.writeScreenshot(context.record.sourceRecordId, this.name, "after-entry", after);

    await context.audit.writeEvent({
      recordId: context.record.sourceRecordId,
      target: this.name,
      phase: "desktop",
      actionType: "paste",
      rationale: decision.rationale,
      screenshotPath: afterPath,
      result: `pasted record into Excel row ${rowNumber}`,
    });

    return { status: "succeeded", targetRecordId: `excel-row-${rowNumber}` };
  }

  async close(): Promise<void> {
    await this.options.port.close();
  }
}
```

- [ ] **Step 6: Run Excel adapter tests**

Run:

```bash
npm test -- tests/targets/excelAdapter.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit Excel adapter**

```bash
git add src/targets/excel tests/targets/excelAdapter.test.ts
git commit -m "feat: add Excel desktop adapter"
```

## Task 10: OpenEMR Playwright Adapter

**Files:**
- Create: `src/targets/openemr/selectors.ts`
- Create: `src/targets/openemr/openEmrAdapter.ts`

- [ ] **Step 1: Implement OpenEMR selector candidates**

Create `src/targets/openemr/selectors.ts` with this content:

```ts
import type { NormalizedIntakeRecord } from "../../domain/schema.js";

export interface FieldMapping {
  value: string;
  selectors: string[];
}

export function openEmrFieldMappings(record: NormalizedIntakeRecord): FieldMapping[] {
  return [
    { value: record.firstName, selectors: ['input[name="form_fname"]', 'input[name="fname"]', 'input[id*="fname"]'] },
    { value: record.lastName, selectors: ['input[name="form_lname"]', 'input[name="lname"]', 'input[id*="lname"]'] },
    { value: record.dateOfBirth, selectors: ['input[name="form_DOB"]', 'input[name="DOB"]', 'input[id*="DOB"]'] },
    { value: record.streetAddress, selectors: ['input[name="form_street"]', 'input[name="street"]', 'textarea[name*="street"]'] },
    { value: record.city, selectors: ['input[name="form_city"]', 'input[name="city"]'] },
    { value: record.state, selectors: ['input[name="form_state"]', 'select[name="form_state"]', 'input[name="state"]'] },
    { value: record.zip, selectors: ['input[name="form_postal_code"]', 'input[name="postal_code"]', 'input[name="zip"]'] },
    { value: record.phone, selectors: ['input[name="form_phone_cell"]', 'input[name*="phone_cell"]', 'input[name*="phone"]'] },
    { value: record.email, selectors: ['input[name="form_email"]', 'input[name*="email"]'] },
  ];
}

export const OPENEMR_LOGIN_SELECTORS = {
  username: ['input[name="authUser"]', "#authUser"],
  password: ['input[name="clearPass"]', "#clearPass"],
  submit: ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("Login")'],
};

export const OPENEMR_NEW_PATIENT_CANDIDATES = [
  'text="New/Search"',
  'text="Patient/Client"',
  'text="New Patient"',
  'a:has-text("New/Search")',
];

export const OPENEMR_SAVE_CANDIDATES = [
  'button:has-text("Create New Patient")',
  'button:has-text("Save")',
  'input[value="Create New Patient"]',
  'input[value="Save"]',
];
```

- [ ] **Step 2: Implement OpenEMR adapter**

Create `src/targets/openemr/openEmrAdapter.ts` with this content:

```ts
import { chromium, type Browser, type Page } from "@playwright/test";
import type { TargetAdapter, TargetAdapterResult, TargetRunContext } from "../../adapters/contract.js";
import {
  OPENEMR_LOGIN_SELECTORS,
  OPENEMR_NEW_PATIENT_CANDIDATES,
  OPENEMR_SAVE_CANDIDATES,
  openEmrFieldMappings,
} from "./selectors.js";

export interface OpenEmrConfig {
  baseUrl?: string;
  username?: string;
  password?: string;
}

export class OpenEmrAdapter implements TargetAdapter {
  readonly name = "openemr" as const;
  private browser?: Browser;
  private page?: Page;

  constructor(private readonly config: OpenEmrConfig) {}

  async prepare(): Promise<void> {
    if (!this.config.baseUrl || !this.config.username || !this.config.password) {
      throw new Error("OPENEMR_BASE_URL, OPENEMR_USERNAME, and OPENEMR_PASSWORD are required for OpenEMR runs.");
    }
    this.browser = await chromium.launch({
      headless: false,
      chromiumSandbox: true,
      env: {},
      args: ["--disable-extensions", "--disable-file-system"],
    });
    this.page = await this.browser.newPage({ viewport: { width: 1280, height: 720 } });
    await this.page.goto(this.config.baseUrl, { waitUntil: "domcontentloaded" });
    await fillFirst(this.page, OPENEMR_LOGIN_SELECTORS.username, this.config.username);
    await fillFirst(this.page, OPENEMR_LOGIN_SELECTORS.password, this.config.password);
    await clickFirst(this.page, OPENEMR_LOGIN_SELECTORS.submit);
    await this.page.waitForLoadState("networkidle");
  }

  async runRecord(context: TargetRunContext): Promise<TargetAdapterResult> {
    const page = this.requirePage();
    const before = await page.screenshot({ fullPage: true });
    const beforePath = await context.audit.writeScreenshot(context.record.sourceRecordId, this.name, "before-navigation", before);
    const decision = await context.agent.decide({
      target: this.name,
      recordId: context.record.sourceRecordId,
      step: "navigate-new-patient",
      screenshotPath: beforePath,
      visibleText: await visibleText(page),
      allowedActions: [{ id: "navigate-new-patient", description: "Navigate to the OpenEMR new patient form." }],
    });

    if (decision.actionId !== "navigate-new-patient" || decision.confidence < 0.5) {
      return {
        status: "exception",
        exception: {
          code: "ui_state_unexpected",
          severity: "error",
          message: "Agent did not approve OpenEMR navigation.",
          suggestedRemediation: decision.rationale,
        },
      };
    }

    await navigateToNewPatient(page);
    await context.audit.writeEvent({
      recordId: context.record.sourceRecordId,
      target: this.name,
      phase: "web",
      actionType: "navigate",
      rationale: decision.rationale,
      screenshotPath: beforePath,
      result: "navigated toward new patient form",
    });

    for (const mapping of openEmrFieldMappings(context.record)) {
      await fillFirst(page, mapping.selectors, mapping.value);
    }

    const filled = await page.screenshot({ fullPage: true });
    const filledPath = await context.audit.writeScreenshot(context.record.sourceRecordId, this.name, "after-fill", filled);
    await context.audit.writeEvent({
      recordId: context.record.sourceRecordId,
      target: this.name,
      phase: "web",
      actionType: "fill",
      screenshotPath: filledPath,
      result: "filled OpenEMR patient fields",
    });

    const saveDecision = await context.agent.decide({
      target: this.name,
      recordId: context.record.sourceRecordId,
      step: "save-patient",
      screenshotPath: filledPath,
      visibleText: await visibleText(page),
      allowedActions: [{ id: "save-patient", description: "Save the OpenEMR patient form." }],
    });

    if (saveDecision.actionId !== "save-patient" || saveDecision.confidence < 0.5) {
      return {
        status: "exception",
        exception: {
          code: "ui_state_unexpected",
          severity: "error",
          message: "Agent did not approve OpenEMR save.",
          suggestedRemediation: saveDecision.rationale,
        },
      };
    }

    await clickFirst(page, OPENEMR_SAVE_CANDIDATES);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    const after = await page.screenshot({ fullPage: true });
    const afterPath = await context.audit.writeScreenshot(context.record.sourceRecordId, this.name, "after-save", after);
    const text = await visibleText(page);

    if (/duplicate|already exists|similar patient/i.test(text)) {
      return {
        status: "exception",
        exception: {
          code: "possible_duplicate",
          severity: "error",
          message: "OpenEMR indicated a possible duplicate patient.",
          suggestedRemediation: "Review the patient match screen and decide whether to merge, update, or skip.",
          screenshotPath: afterPath,
        },
      };
    }

    await context.audit.writeEvent({
      recordId: context.record.sourceRecordId,
      target: this.name,
      phase: "web",
      actionType: "save",
      rationale: saveDecision.rationale,
      screenshotPath: afterPath,
      result: "submitted OpenEMR patient form",
    });
    return { status: "succeeded", targetRecordId: `openemr-${context.record.sourceRecordId}` };
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }

  private requirePage(): Page {
    if (!this.page) throw new Error("OpenEMR adapter was not prepared.");
    return this.page;
  }
}

async function fillFirst(page: Page, selectors: string[], value: string): Promise<void> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) {
      const tagName = await locator.evaluate((element) => element.tagName.toLowerCase()).catch(() => "input");
      if (tagName === "select") {
        await locator.selectOption({ label: value }).catch(() => locator.selectOption(value));
      } else {
        await locator.fill(value);
      }
      return;
    }
  }
  throw new Error(`No OpenEMR selector matched for value ${value}.`);
}

async function clickFirst(page: Page, selectors: string[]): Promise<void> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) {
      await locator.click();
      return;
    }
  }
  throw new Error(`No OpenEMR click selector matched: ${selectors.join(", ")}`);
}

async function navigateToNewPatient(page: Page): Promise<void> {
  for (const selector of OPENEMR_NEW_PATIENT_CANDIDATES) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) {
      await locator.click();
      await page.waitForLoadState("networkidle").catch(() => undefined);
      return;
    }
  }
  throw new Error("Could not navigate to OpenEMR new patient screen.");
}

async function visibleText(page: Page): Promise<string> {
  return page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
}
```

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit OpenEMR adapter**

```bash
git add src/targets/openemr
git commit -m "feat: add OpenEMR Playwright adapter"
```

## Task 11: CLI Wiring And Core Verification

**Files:**
- Create: `src/cli.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Implement CLI**

Create `src/cli.ts` with this content:

```ts
#!/usr/bin/env node
import { Command } from "commander";
import { FakeAdapter } from "./adapters/fakeAdapter.js";
import type { TargetAdapter } from "./adapters/contract.js";
import { ScriptedAgentDriver } from "./agent/scriptedAgent.js";
import { OpenAiUiAgentDriver } from "./agent/openAiUiAgent.js";
import { buildRunConfig } from "./config.js";
import { loadSourceRecords } from "./parsing/loadRecords.js";
import { runWorkflow } from "./orchestrator/runWorkflow.js";
import { OpenEmrAdapter } from "./targets/openemr/openEmrAdapter.js";
import { ExcelAdapter } from "./targets/excel/excelAdapter.js";
import { MacExcelPort } from "./targets/excel/macExcelPort.js";

const program = new Command();

program
  .name("agentic-ui")
  .description("Run audited agentic UI intake automation workflows.")
  .version("0.1.0");

program
  .command("run")
  .requiredOption("--input <path>", "Path to JSON, CSV, or text intake records")
  .option("--targets <targets>", "Comma-separated targets: fake,openemr,excel", "fake")
  .option("--runs-dir <path>", "Run artifact directory", process.env.RUNS_DIR ?? "runs")
  .option("--agent <agent>", "Agent driver: scripted or openai", "scripted")
  .option("--excel-workbook-path <path>", "Excel workbook path", process.env.EXCEL_WORKBOOK_PATH ?? "runs/intake-workbook.xlsx")
  .action(async (options) => {
    const config = buildRunConfig({
      input: options.input,
      targets: options.targets,
      runsDir: options.runsDir,
      agent: options.agent,
      excelWorkbookPath: options.excelWorkbookPath,
    });

    const records = await loadSourceRecords(config.input);
    const agent =
      config.agent === "openai"
        ? new OpenAiUiAgentDriver({
            apiKey: process.env.OPENAI_API_KEY,
            model: process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
          })
        : new ScriptedAgentDriver();
    const adapters = buildAdapters(config);

    const result = await runWorkflow({
      runsDir: config.runsDir,
      records,
      adapters,
      agent,
    });

    console.log(JSON.stringify(result, null, 2));
  });

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function buildAdapters(config: ReturnType<typeof buildRunConfig>): TargetAdapter[] {
  return config.targets.map((target) => {
    if (target === "fake") return new FakeAdapter("success");
    if (target === "openemr") return new OpenEmrAdapter(config.openEmr);
    if (target === "excel") {
      return new ExcelAdapter({
        workbookPath: config.excelWorkbookPath,
        port: new MacExcelPort(),
      });
    }
    throw new Error(`Unsupported target: ${target}`);
  });
}
```

- [ ] **Step 2: Update target exports**

Modify `src/index.ts` so the bottom of the file includes:

```ts
export * from "./targets/excel/excelAdapter.js";
export * from "./targets/openemr/openEmrAdapter.js";
```

- [ ] **Step 3: Run typecheck after all referenced modules exist**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run the fake-target CLI demo**

Run:

```bash
npm run dev -- run --input data/demo/intake-records.json --targets fake --runs-dir runs
```

Expected: CLI prints JSON with `status` equal to `completed_with_exceptions`, `preflightExceptions` equal to `3`, and fake target counts showing `succeeded` equal to `3`.

- [ ] **Step 5: Inspect generated artifacts**

Run:

```bash
find runs -maxdepth 3 -type f | sort
```

Expected: output includes one run directory with `run.json`, `events.jsonl`, `summary.md`, `input/normalized-records.json`, and exception JSON files.

- [ ] **Step 6: Run full test suite**

Run:

```bash
npm run typecheck
npm test
```

Expected: PASS.

- [ ] **Step 7: Commit CLI and core wiring**

```bash
git add src/cli.ts src/index.ts
git commit -m "feat: wire CLI and target adapters"
```

## Task 12: Demo Documentation And Smoke Run Instructions

**Files:**
- Create: `docs/demo.md`

- [ ] **Step 1: Create demo documentation**

Create `docs/demo.md` with this content:

```md
# Agentic UI Automation Demo

## Local Deterministic Demo

Run the fake target first. It proves parsing, validation, orchestration, audit events, exceptions, and summaries without depending on OpenEMR or Excel.

```bash
npm install
npm run dev -- run --input data/demo/intake-records.json --targets fake --runs-dir runs
```

Review:

```bash
find runs -maxdepth 3 -type f | sort
cat runs/*/summary.md
```

## OpenEMR Smoke Demo

Set official OpenEMR demo credentials in `.env` or the shell:

```bash
export OPENEMR_BASE_URL="https://your-openemr-demo-url"
export OPENEMR_USERNAME="your-demo-user"
export OPENEMR_PASSWORD="your-demo-password"
```

Install Playwright Chromium once:

```bash
npx playwright install chromium
```

Run:

```bash
npm run dev -- run --input data/demo/intake-records.json --targets openemr --runs-dir runs
```

If the public demo is unavailable or its UI has changed, the run should stop with an environment or UI-state exception and still write audit artifacts.

## Excel Desktop Smoke Demo

Prerequisites:

- Microsoft Excel desktop is installed and licensed.
- macOS Accessibility permissions allow Terminal or the runner process to control Excel.

Run:

```bash
npm run dev -- run --input data/demo/intake-records.json --targets excel --runs-dir runs --excel-workbook-path runs/intake-workbook.xlsx
```

The adapter opens Excel, writes rows to the `Intake` workbook, captures before/after screenshots, and records audit events.

## Combined Demo

```bash
npm run dev -- run --input data/demo/intake-records.json --targets openemr,excel --runs-dir runs
```

Use only synthetic data. Do not point this pilot at production systems.
```

- [ ] **Step 2: Run Markdown smoke command references**

Run:

```bash
npm run dev -- run --input data/demo/intake-records.json --targets fake --runs-dir runs
```

Expected: command succeeds and produces a run summary.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm run typecheck
npm test
```

Expected: PASS.

- [ ] **Step 4: Commit docs**

```bash
git add docs/demo.md
git commit -m "docs: add demo instructions"
```

## Task 13: Optional Target Smoke Verification

**Files:**
- No source files required unless smoke verification reveals target drift that needs narrow selector updates.

- [ ] **Step 1: Verify OpenEMR environment variables**

Run:

```bash
test -n "$OPENEMR_BASE_URL" && test -n "$OPENEMR_USERNAME" && test -n "$OPENEMR_PASSWORD"
```

Expected: exits 0. If it exits nonzero, skip OpenEMR smoke verification and record that credentials were not configured.

- [ ] **Step 2: Run OpenEMR smoke test**

Run:

```bash
npm run dev -- run --input data/demo/intake-records.json --targets openemr --runs-dir runs
```

Expected: The run either creates OpenEMR patient records for valid synthetic records or writes `ui_state_unexpected`, `possible_duplicate`, or `environment_not_ready` exceptions with screenshots. A run that fails without `run.json`, `events.jsonl`, and screenshots is not acceptable.

- [ ] **Step 3: Verify Excel is installed**

Run:

```bash
osascript -e 'id of application "Microsoft Excel"'
```

Expected: exits 0 and prints Excel's bundle identifier. If it exits nonzero, skip Excel smoke verification and record that Excel is not installed.

- [ ] **Step 4: Run Excel smoke test**

Run:

```bash
npm run dev -- run --input data/demo/intake-records.json --targets excel --runs-dir runs --excel-workbook-path runs/intake-workbook.xlsx
```

Expected: Excel opens, valid records are pasted into the workbook, screenshots are captured, and invalid records are written as exception artifacts.

- [ ] **Step 5: Run final verification**

Run:

```bash
npm run typecheck
npm test
git status --short
```

Expected: typecheck and tests pass. `git status --short` shows only intentional generated `runs/` artifacts ignored by git, or no output.

## Self-Review Checklist

- Spec coverage: Tasks 2 and 3 cover parsing and validation; Tasks 4 and 6 cover auditing and summaries; Tasks 5 and 8 cover agent boundaries; Tasks 9 and 10 cover Excel and OpenEMR adapters; Tasks 11 through 13 cover CLI, demo, and smoke verification.
- Placeholder scan: The plan avoids placeholder markers and uses explicit file paths, commands, expected outputs, and code blocks.
- Type consistency: Shared names are `NormalizedIntakeRecord`, `RawIntakeRecord`, `ValidationException`, `TargetAdapter`, `AgentDriver`, `FileAuditStore`, and `runWorkflow` throughout the plan.
