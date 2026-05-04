import type { RunStatus, TargetName, TargetTaskStatus } from "../domain/schema.js";
import type {
  ReportAiExtraction,
  ReportDetails,
  ReportFieldMapping,
  ReportRecordInput,
  ReportIssue,
} from "./auditStore.js";

const TARGET_ORDER: TargetName[] = ["openmrs", "fake"];

export interface SummaryInput {
  runId: string;
  status?: RunStatus;
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

  appendContents(lines, input);
  appendArtifacts(lines, input);

  lines.push("## Target Counts", "");
  lines.push("| Target | Succeeded | Exceptions | Skipped |", "| --- | ---: | ---: | ---: |");

  for (const target of TARGET_ORDER) {
    const counts = input.targetCounts[target];
    if (!counts) continue;
    lines.push(`| ${target} | ${counts.succeeded ?? 0} | ${counts.exception ?? 0} | ${counts.skipped ?? 0} |`);
  }

  appendIssues(lines, input.details?.issues ?? []);
  appendOpenMrsRecordReviews(lines, input.details);

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function appendContents(lines: string[], input: SummaryInput): void {
  lines.push("## Contents", "");
  if (input.runDir || input.sourceInputPath) {
    lines.push("- [Artifacts](#artifacts)");
  }
  lines.push("- [Target Counts](#target-counts)", "- [Issues](#issues)");

  const openMrsRecordIds = openMrsReviewRecordIds(input.details);
  if (openMrsRecordIds.length > 0) {
    lines.push("- [OpenMRS Record Review](#openmrs-record-review)");
    for (const recordId of openMrsRecordIds) {
      lines.push(`  - [Record ${recordId}](#${markdownAnchor(`Record ${recordId}`)})`);
    }
  }
  lines.push("");
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
    lines.push(`| Executive summary | ${cell(pathInRun(runDir, "executive-summary.md"))} |`);
    lines.push(`| Structured report | ${cell(pathInRun(runDir, "report.json"))} |`);
  }
  lines.push("");
}

export function renderExecutiveSummary(input: SummaryInput): string {
  const issues = input.details?.issues ?? [];
  const openMrsMappings = input.details?.fieldMappings.filter((mapping) => mapping.target === "openmrs") ?? [];
  const failedOpenMrsMappings = openMrsMappings.filter((mapping) => mapping.status === "failed");
  const openMrsEvidenceRecords = new Set(
    (input.details?.targetEvidence ?? [])
      .filter((evidence) => evidence.target === "openmrs" && (evidence.fieldScreenshotPath || evidence.screenshotPath))
      .map((evidence) => evidence.recordId),
  );

  const lines = [`# Executive Summary ${input.runId}`, ""];

  lines.push("## Outcome", "");
  lines.push("| Metric | Value |", "| --- | --- |");
  if (input.status) {
    lines.push(`| Status | ${cell(input.status)} |`);
  }
  lines.push(
    `| Source records | ${input.totalRecords} |`,
    `| Preflight exceptions | ${input.preflightExceptions} |`,
    `| Environment exceptions | ${input.environmentExceptions} |`,
    `| Close exceptions | ${input.closeExceptions} |`,
    "",
  );

  lines.push("## Target Results", "");
  lines.push("| Target | Succeeded | Exceptions | Skipped |", "| --- | ---: | ---: | ---: |");
  for (const target of TARGET_ORDER) {
    const counts = input.targetCounts[target];
    if (!counts) continue;
    lines.push(`| ${target} | ${counts.succeeded ?? 0} | ${counts.exception ?? 0} | ${counts.skipped ?? 0} |`);
  }
  lines.push("");

  lines.push("## Key Findings", "");
  if (issues.length === 0) {
    lines.push("- No issues recorded.");
  } else {
    lines.push(`- ${issues.length} ${plural(issues.length, "issue")} recorded.`);
  }
  if (failedOpenMrsMappings.length > 0) {
    lines.push(`- ${failedOpenMrsMappings.length} OpenMRS field ${plural(failedOpenMrsMappings.length, "mapping")} failed.`);
  }
  if (openMrsEvidenceRecords.size > 0) {
    lines.push(
      `- ${openMrsEvidenceRecords.size} OpenMRS ${plural(openMrsEvidenceRecords.size, "record")} ${hasVerb(openMrsEvidenceRecords.size)} screenshot evidence.`,
    );
  }
  lines.push("");

  appendExecutiveIssues(lines, issues);
  appendReviewLinks(lines, input);

  return `${lines.join("\n")}\n`;
}

function appendExecutiveIssues(lines: string[], issues: ReportIssue[]): void {
  if (issues.length === 0) return;

  lines.push("## Top Issues", "");
  lines.push(
    "| Record | Target | Phase | Code | Message | Evidence |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const issue of issues.slice(0, 10)) {
    lines.push(
      `| ${cell(issue.recordId)} | ${cell(issue.target)} | ${cell(issue.phase)} | ${cell(issue.exceptionCode)} | ${cell(issue.message)} | ${cell(issue.screenshotPath)} |`,
    );
  }
  if (issues.length > 10) {
    lines.push("", `${issues.length - 10} additional issues are available in summary.md and report.json.`);
  }
  lines.push("");
}

function appendReviewLinks(lines: string[], input: SummaryInput): void {
  if (!input.runDir && !input.sourceInputPath) return;

  const runDir = input.runDir;
  lines.push("## Review Links", "");
  lines.push("| Item | Path |", "| --- | --- |");
  if (input.sourceInputPath) {
    lines.push(`| Source input | ${cell(input.sourceInputPath)} |`);
  }
  if (runDir) {
    lines.push(`| Normalized records | ${cell(pathInRun(runDir, "input/normalized-records.json"))} |`);
    lines.push(`| Full summary | ${cell(pathInRun(runDir, "summary.md"))} |`);
    lines.push(`| Structured report | ${cell(pathInRun(runDir, "report.json"))} |`);
    lines.push(`| Screenshots | ${cell(pathInRun(runDir, "screenshots/"))} |`);
    lines.push(`| Exceptions | ${cell(pathInRun(runDir, "exceptions/"))} |`);
  }
  lines.push("");
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function hasVerb(count: number): string {
  return count === 1 ? "has" : "have";
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

function appendOpenMrsRecordReviews(lines: string[], details: ReportDetails | undefined): void {
  if (!details) return;

  const openMrsMappings = details.fieldMappings.filter((mapping) => mapping.target === "openmrs");
  const mappingsByRecord = groupByRecord(openMrsMappings);
  const evidenceByRecord = groupEvidenceByRecord(details.targetEvidence.filter((evidence) => evidence.target === "openmrs"));
  const issuesByRecord = groupByRecordIssue(details.issues.filter((issue) => issue.target === "openmrs" && issue.recordId));
  const recordIds = openMrsReviewRecordIds(details);

  if (recordIds.length === 0) return;

  const aiByRecord = new Map(details.aiExtractions.map((extraction) => [extraction.recordId, extraction]));
  const inputsByRecord = new Map((details.recordInputs ?? []).map((input) => [input.recordId, input]));
  lines.push("", "## OpenMRS Record Review", "");
  for (const recordId of recordIds) {
    const input = inputsByRecord.get(recordId);
    const evidence = evidenceByRecord.get(recordId)?.[0];
    const issue = issuesByRecord.get(recordId)?.[0];
    const mappings = mappingsByRecord.get(recordId) ?? [];
    const extraction = aiByRecord.get(recordId);

    lines.push(`### Record ${recordId}`, "");
    lines.push("#### Intake Input", "");
    if (input) {
      lines.push(`- Source format: ${cell(input.sourceFormat)}`, "", "```json", formatJson(input.rawInput), "```", "");
    } else {
      lines.push("Raw input record: not available.", "");
    }

    if (evidence || issue?.screenshotPath) {
      lines.push("#### Screenshots", "");
      if (evidence?.screenshotPath && evidence.fieldScreenshotPath) {
        lines.push(`- Proof screenshot: ${cell(evidence.screenshotPath)}`);
        lines.push("", `![OpenMRS proof screenshot for ${cell(recordId)}](${markdownImagePath(evidence.screenshotPath)})`, "");
      } else if (evidence?.screenshotPath) {
        lines.push(`- Context screenshot: ${cell(evidence.screenshotPath)}`);
        lines.push("", `![OpenMRS context screenshot for ${cell(recordId)}](${markdownImagePath(evidence.screenshotPath)})`, "");
      } else if (issue?.screenshotPath) {
        lines.push(`- Exception screenshot: ${cell(issue.screenshotPath)}`);
        lines.push("", `![OpenMRS exception screenshot for ${cell(recordId)}](${markdownImagePath(issue.screenshotPath)})`, "");
      }
      if (evidence?.targetRecordId) {
        lines.push(`- Target record: ${cell(evidence.targetRecordId)}`);
      }
      if (evidence?.message) {
        lines.push(`- Result: ${cell(evidence.message)}`);
      } else if (issue?.message) {
        lines.push(`- Result: ${cell(issue.message)}`);
      }
      lines.push("");
    }

    const comparisonRows = openMrsComparisonRows(mappings, extraction, input);
    if (comparisonRows.length > 0) {
      lines.push("#### Intake to OpenMRS Comparison", "");
      lines.push("| Intake Field | Intake Value | Mapping Confidence | Normalized Field | OpenMRS Field | EMR Value | Action | Status | Selector or Error |");
      lines.push("| --- | --- | ---: | --- | --- | --- | --- | --- | --- |");
      for (const row of comparisonRows) {
        lines.push(
          `| ${cell(row.sourceLabel)} | ${cell(row.sourceValue)} | ${cell(row.confidence)} | ${cell(row.normalizedField)} | ${cell(row.targetField)} | ${cell(row.emrValue)} | ${cell(row.action)} | ${cell(row.status)} | ${cell(row.selectorOrError)} |`,
        );
      }
      lines.push("");
    }
  }
}

interface OpenMrsComparisonRow {
  sourceLabel: string;
  sourceValue: string;
  confidence?: number;
  normalizedField: string;
  targetField: string;
  emrValue: string;
  action: string;
  status: string;
  selectorOrError: string;
}

function openMrsComparisonRows(
  mappings: ReportFieldMapping[],
  extraction: ReportAiExtraction | undefined,
  input: ReportRecordInput | undefined,
): OpenMrsComparisonRow[] {
  const extracted = extractionFieldLookup(extraction);
  const inputValues = recordInputFieldLookup(input);
  const mappedFields = new Set<string>();
  const rows: OpenMrsComparisonRow[] = [];

  for (const mapping of mappings) {
    mappedFields.add(mapping.sourceField);
    const extractedSource = extracted.get(mapping.sourceField);
    const inputSource = inputValues.get(mapping.sourceField);
    const source = {
      sourceLabel: extractedSource?.sourceLabel ?? inputSource?.sourceLabel ?? mapping.sourceField,
      value: inputSource?.value ?? extractedSource?.value ?? "",
    };
    rows.push({
      sourceLabel: source.sourceLabel,
      sourceValue: source.value,
      confidence: mapping.mappingConfidence,
      normalizedField: mapping.sourceField,
      targetField: mapping.targetField,
      emrValue: mapping.normalizedValue,
      action: mapping.action ?? "",
      status: [mapping.status, mappingIntervention(mapping)].filter(Boolean).join("; "),
      selectorOrError: mapping.errorMessage ?? mapping.selectedSelector ?? "",
    });
  }

  if (!extraction) return rows;

  for (const field of [...extraction.fields, ...extraction.additionalFields]) {
    if (mappedFields.has(field.sourceField)) {
      continue;
    }
    const inputSource = inputValues.get(field.sourceField);
    rows.push({
      sourceLabel: field.sourceLabel ?? field.sourceField,
      sourceValue: inputSource?.value ?? field.value,
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

function mappingIntervention(mapping: ReportFieldMapping): string {
  const parts = [
    mapping.approvalSource,
    mapping.agentConfidence === undefined ? undefined : `agent ${Math.round(mapping.agentConfidence * 100)}%`,
    mapping.confidenceThreshold === undefined ? undefined : `threshold ${Math.round(mapping.confidenceThreshold * 100)}%`,
    mapping.originalProposedValue ? `proposed ${mapping.originalProposedValue}` : undefined,
    mapping.finalValue && mapping.finalValue !== mapping.normalizedValue ? `final ${mapping.finalValue}` : undefined,
    mapping.agentRationale ? `rationale ${mapping.agentRationale}` : undefined,
    mapping.skipReason,
  ].filter((value): value is string => Boolean(value));
  return parts.join("; ");
}

function recordInputFieldLookup(
  input: ReportRecordInput | undefined,
): Map<string, { sourceLabel: string; value: string }> {
  const lookup = new Map<string, { sourceLabel: string; value: string }>();
  if (!input || !isPlainObject(input.rawInput)) return lookup;

  for (const [field, value] of Object.entries(input.rawInput)) {
    if (value === undefined || value === null || typeof value === "object") continue;
    lookup.set(field, {
      sourceLabel: field,
      value: String(value),
    });
  }
  return lookup;
}

function extractionFieldLookup(
  extraction: ReportAiExtraction | undefined,
): Map<string, { sourceLabel: string; value: string }> {
  const lookup = new Map<string, { sourceLabel: string; value: string }>();
  if (!extraction) return lookup;
  for (const field of [...extraction.fields, ...extraction.additionalFields]) {
    lookup.set(field.sourceField, {
      sourceLabel: field.sourceLabel ?? field.sourceField,
      value: field.value,
    });
  }
  return lookup;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function groupByRecordIssue(issues: ReportIssue[]): Map<string, ReportIssue[]> {
  const groups = new Map<string, ReportIssue[]>();
  for (const issue of issues) {
    if (!issue.recordId) continue;
    const group = groups.get(issue.recordId) ?? [];
    group.push(issue);
    groups.set(issue.recordId, group);
  }
  return groups;
}

function openMrsReviewRecordIds(details: ReportDetails | undefined): string[] {
  if (!details) return [];

  const openMrsMappings = details.fieldMappings.filter((mapping) => mapping.target === "openmrs");
  const openMrsIssues = details.issues.filter((issue) => issue.target === "openmrs" && issue.recordId);
  return orderedUnique([
    ...details.targetEvidence.filter((evidence) => evidence.target === "openmrs").map((evidence) => evidence.recordId),
    ...openMrsMappings.map((mapping) => mapping.recordId),
    ...openMrsIssues.map((issue) => issue.recordId ?? ""),
  ]);
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

function markdownAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function cell(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  return String(value).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}
