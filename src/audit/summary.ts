import type { TargetName, TargetTaskStatus } from "../domain/schema.js";
import type {
  ReportAiExtraction,
  ReportDetails,
  ReportFieldMapping,
  ReportIssue,
} from "./auditStore.js";

const TARGET_ORDER: TargetName[] = ["openemr", "excel", "fake"];

export interface SummaryInput {
  runId: string;
  runDir?: string;
  sourceInputPath?: string;
  totalRecords: number;
  targetCounts: Partial<Record<TargetName, Record<TargetTaskStatus, number>>>;
  preflightExceptions: number;
  environmentExceptions: number;
  closeExceptions: number;
  details?: ReportDetails;
}

export function renderSummary(input: SummaryInput): string {
  const lines = [
    `# Workflow Run ${input.runId}`,
    "",
    `Total source records: ${input.totalRecords}`,
    `Preflight exceptions: ${input.preflightExceptions}`,
    `Environment exceptions: ${input.environmentExceptions}`,
    `Close exceptions: ${input.closeExceptions}`,
    "",
  ];

  appendArtifacts(lines, input);

  lines.push("| Target | Succeeded | Exceptions | Skipped |", "| --- | ---: | ---: | ---: |");

  for (const target of TARGET_ORDER) {
    const counts = input.targetCounts[target];
    if (!counts) continue;
    lines.push(`| ${target} | ${counts.succeeded ?? 0} | ${counts.exception ?? 0} | ${counts.skipped ?? 0} |`);
  }

  appendIssues(lines, input.details?.issues ?? []);
  appendOpenEmrRecordReviews(lines, input.details);

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function appendArtifacts(lines: string[], input: SummaryInput): void {
  if (!input.runDir && !input.sourceInputPath) return;

  const runDir = input.runDir;
  lines.push("## Artifacts", "");
  lines.push("| Artifact | Path |");
  lines.push("| --- | --- |");
  if (input.sourceInputPath) {
    lines.push(`| Source input | ${cell(input.sourceInputPath)} |`);
  }
  if (runDir) {
    lines.push(`| Normalized records | ${cell(pathInRun(runDir, "input/normalized-records.json"))} |`);
    lines.push(`| Exceptions | ${cell(pathInRun(runDir, "exceptions/"))} |`);
    lines.push(`| Screenshots | ${cell(pathInRun(runDir, "screenshots/"))} |`);
    lines.push(`| Event log | ${cell(pathInRun(runDir, "events.jsonl"))} |`);
    lines.push(`| Structured report | ${cell(pathInRun(runDir, "report.json"))} |`);
  }
  lines.push("");
}

function pathInRun(runDir: string, path: string): string {
  return `${runDir.replace(/\/$/, "")}/${path}`;
}

function appendIssues(lines: string[], issues: ReportIssue[]): void {
  lines.push("", "## Issues", "");
  if (issues.length === 0) {
    lines.push("No issues recorded.");
    return;
  }

  lines.push(
    "| Record | Target | Phase | Code | Message | Remediation | Evidence |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const issue of issues) {
    lines.push(
      `| ${cell(issue.recordId)} | ${cell(issue.target)} | ${cell(issue.phase)} | ${cell(issue.exceptionCode)} | ${cell(issue.message)} | ${cell(issue.suggestedRemediation)} | ${cell(issue.screenshotPath)} |`,
    );
  }
}

function appendOpenEmrRecordReviews(lines: string[], details: ReportDetails | undefined): void {
  if (!details) return;

  const openEmrMappings = details.fieldMappings.filter((mapping) => mapping.target === "openemr");
  const mappingsByRecord = groupByRecord(openEmrMappings);
  const evidenceByRecord = groupEvidenceByRecord(details.targetEvidence.filter((evidence) => evidence.target === "openemr"));
  const openEmrIssues = details.issues.filter((issue) => issue.target === "openemr" && issue.recordId);
  const recordIds = orderedUnique([
    ...details.targetEvidence.filter((evidence) => evidence.target === "openemr").map((evidence) => evidence.recordId),
    ...openEmrMappings.map((mapping) => mapping.recordId),
    ...openEmrIssues.map((issue) => issue.recordId ?? ""),
  ]);

  if (recordIds.length === 0) return;

  const aiByRecord = new Map(details.aiExtractions.map((extraction) => [extraction.recordId, extraction]));
  const inputsByRecord = new Map((details.recordInputs ?? []).map((input) => [input.recordId, input]));
  lines.push("", "## OpenEMR Record Review", "");
  for (const recordId of recordIds) {
    const input = inputsByRecord.get(recordId);
    const evidence = evidenceByRecord.get(recordId)?.[0];
    const mappings = mappingsByRecord.get(recordId) ?? [];
    const extraction = aiByRecord.get(recordId);

    lines.push(`### Record ${recordId}`, "");
    lines.push("#### Intake Input", "");
    if (input) {
      lines.push(`- Source format: ${cell(input.sourceFormat)}`, "", "```json", formatJson(input.rawInput), "```", "");
    } else {
      lines.push("Raw input record: not available.", "");
    }

    if (evidence) {
      lines.push("#### Screenshots", "");
      if (evidence.fieldScreenshotPath) {
        lines.push(`- Filled-field screenshot: ${cell(evidence.fieldScreenshotPath)}`);
        lines.push("", `![OpenEMR filled fields screenshot for ${cell(recordId)}](${markdownImagePath(evidence.fieldScreenshotPath)})`, "");
      }
      if (evidence.targetRecordId) {
        lines.push(`- Target record: ${cell(evidence.targetRecordId)}`);
      }
      if (evidence.message) {
        lines.push(`- Result: ${cell(evidence.message)}`);
      }
      lines.push("");
    }

    const comparisonRows = openEmrComparisonRows(mappings, extraction);
    if (comparisonRows.length > 0) {
      lines.push("#### Intake to OpenEMR Comparison", "");
      lines.push("| Intake Field | Intake Value | AI Confidence | Intake Evidence | Normalized Field | OpenEMR Field | EMR Value | Action | Status | Selector or Error |");
      lines.push("| --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |");
      for (const row of comparisonRows) {
        lines.push(
          `| ${cell(row.sourceLabel)} | ${cell(row.sourceValue)} | ${cell(row.confidence)} | ${cell(row.evidence)} | ${cell(row.normalizedField)} | ${cell(row.targetField)} | ${cell(row.emrValue)} | ${cell(row.action)} | ${cell(row.status)} | ${cell(row.selectorOrError)} |`,
        );
      }
      lines.push("");
    }
  }
}

interface OpenEmrComparisonRow {
  sourceLabel: string;
  sourceValue: string;
  confidence?: number;
  evidence: string;
  normalizedField: string;
  targetField: string;
  emrValue: string;
  action: string;
  status: string;
  selectorOrError: string;
}

function openEmrComparisonRows(mappings: ReportFieldMapping[], extraction: ReportAiExtraction | undefined): OpenEmrComparisonRow[] {
  const extracted = extractionFieldLookup(extraction);
  const mappedFields = new Set<string>();
  const rows: OpenEmrComparisonRow[] = [];

  for (const mapping of mappings) {
    mappedFields.add(mapping.sourceField);
    const source = extracted.get(mapping.sourceField) ?? {
      sourceLabel: mapping.sourceField,
      value: "",
      confidence: undefined,
      evidence: "",
    };
    rows.push({
      sourceLabel: source.sourceLabel,
      sourceValue: source.value,
      confidence: source.confidence,
      evidence: source.evidence,
      normalizedField: mapping.sourceField,
      targetField: mapping.targetField,
      emrValue: mapping.normalizedValue,
      action: mapping.action ?? "",
      status: mapping.status,
      selectorOrError: mapping.errorMessage ?? mapping.selectedSelector ?? "",
    });
  }

  if (!extraction) return rows;

  for (const field of [...extraction.fields, ...extraction.additionalFields]) {
    if (mappedFields.has(field.sourceField)) {
      continue;
    }
    rows.push({
      sourceLabel: field.sourceLabel ?? field.sourceField,
      sourceValue: field.value,
      confidence: field.confidence,
      evidence: field.evidence ?? "",
      normalizedField: field.sourceField,
      targetField: "",
      emrValue: "",
      action: "",
      status: "not mapped",
      selectorOrError: "",
    });
  }

  return rows;
}

function extractionFieldLookup(
  extraction: ReportAiExtraction | undefined,
): Map<string, { sourceLabel: string; value: string; confidence?: number; evidence: string }> {
  const lookup = new Map<string, { sourceLabel: string; value: string; confidence?: number; evidence: string }>();
  if (!extraction) return lookup;
  for (const field of [...extraction.fields, ...extraction.additionalFields]) {
    lookup.set(field.sourceField, {
      sourceLabel: field.sourceLabel ?? field.sourceField,
      value: field.value,
      confidence: field.confidence,
      evidence: field.evidence ?? "",
    });
  }
  return lookup;
}

function groupEvidenceByRecord<T extends { recordId: string }>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.recordId) ?? [];
    group.push(item);
    groups.set(item.recordId, group);
  }
  return groups;
}

function groupByRecord(mappings: ReportFieldMapping[]): Map<string, ReportFieldMapping[]> {
  const groups = new Map<string, ReportFieldMapping[]>();
  for (const mapping of mappings) {
    const group = groups.get(mapping.recordId) ?? [];
    group.push(mapping);
    groups.set(mapping.recordId, group);
  }
  return groups;
}

function orderedUnique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

function markdownImagePath(path: string | undefined): string {
  return encodeURI(path ?? "").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function cell(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  return String(value).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}
