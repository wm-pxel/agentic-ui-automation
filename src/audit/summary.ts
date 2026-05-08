import type { RunStatus, TargetName, TargetTaskStatus } from "../domain/schema.js";
import { TARGET_ORDER, targetDestinationLabel, targetLabel, targetListLabel, targetWithKey } from "../domain/targets.js";
import type {
  ReportAiExtraction,
  ReportDetails,
  ReportFieldMapping,
  ReportRecordInput,
  ReportIssue,
} from "./auditStore.js";

const SEVERITY_ORDER = ["error", "warning", "info"] as const;

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
  const targets = orderedTargets(input.targetCounts);
  const lines = [
    `# ${targetListLabel(targets)} Workflow Run ${input.runId}`,
    "",
    targetDestinationLabel(targets),
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
  lines.push("| Target | Key | Succeeded | Exceptions | Skipped |", "| --- | --- | ---: | ---: | ---: |");

  for (const target of targets) {
    const counts = input.targetCounts[target];
    if (!counts) continue;
    lines.push(
      `| ${targetLabel(target)} | ${target} | ${counts.succeeded ?? 0} | ${counts.exception ?? 0} | ${counts.skipped ?? 0} |`,
    );
  }

  appendIssues(lines, input.details?.issues ?? []);
  appendTargetRecordReviews(lines, input.details);

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function appendContents(lines: string[], input: SummaryInput): void {
  lines.push("## Contents", "");
  if (input.runDir || input.sourceInputPath) {
    lines.push("- [Artifacts](#artifacts)");
  }
  lines.push("- [Target Counts](#target-counts)", "- [Issues](#issues)");

  for (const target of reviewTargets(input.details)) {
    const recordIds = reviewRecordIds(input.details, target);
    if (recordIds.length > 0) {
      const label = targetLabel(target);
      lines.push(`- [${label} Record Review](#${markdownAnchor(`${label} Record Review`)})`);
      for (const recordId of recordIds) {
        lines.push(`  - [${label} record ${recordId}](#${markdownAnchor(`${label} Record ${recordId}`)})`);
      }
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
  const targets = orderedTargets(input.targetCounts);
  const issues = input.details?.issues ?? [];
  const failedMappingsByTarget = groupFailedMappingsByTarget(input.details?.fieldMappings ?? []);
  const evidenceRecordsByTarget = groupEvidenceRecordsByTarget(input.details?.targetEvidence ?? []);

  const lines = [`# ${targetListLabel(targets)} Executive Summary ${input.runId}`, ""];

  lines.push("## Outcome", "");
  lines.push("| Metric | Value |", "| --- | --- |");
  if (input.status) {
    lines.push(`| Status | ${cell(input.status)} |`);
  }
  lines.push(
    `| ${targets.length === 1 ? "Destination target" : "Destination targets"} | ${cell(targets.map(targetWithKey).join(", "))} |`,
    `| Source records | ${input.totalRecords} |`,
    `| Preflight exceptions | ${input.preflightExceptions} |`,
    `| Environment exceptions | ${input.environmentExceptions} |`,
    `| Close exceptions | ${input.closeExceptions} |`,
    "",
  );

  lines.push("## Target Results", "");
  lines.push("| Target | Key | Succeeded | Exceptions | Skipped |", "| --- | --- | ---: | ---: | ---: |");
  for (const target of targets) {
    const counts = input.targetCounts[target];
    if (!counts) continue;
    lines.push(
      `| ${targetLabel(target)} | ${target} | ${counts.succeeded ?? 0} | ${counts.exception ?? 0} | ${counts.skipped ?? 0} |`,
    );
  }
  lines.push("");

  lines.push("## Key Findings", "");
  if (issues.length === 0) {
    lines.push("- No issues recorded.");
  } else {
    lines.push(`- ${issues.length} ${plural(issues.length, "issue")} recorded.`);
  }
  for (const target of targets) {
    const failedMappings = failedMappingsByTarget.get(target) ?? [];
    if (failedMappings.length > 0) {
      lines.push(
        `- ${failedMappings.length} ${targetLabel(target)} field ${plural(failedMappings.length, "mapping")} failed.`,
      );
    }
    const evidenceRecords = evidenceRecordsByTarget.get(target);
    if (!evidenceRecords || evidenceRecords.size === 0) continue;
    lines.push(
      `- ${evidenceRecords.size} ${targetLabel(target)} ${plural(evidenceRecords.size, "record")} ${hasVerb(evidenceRecords.size)} screenshot evidence.`,
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
    "| Severity | Record | Target | Phase | Code | Message | Remediation | Evidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const issue of issues.slice(0, 10)) {
    lines.push(
      `| ${cell(issueSeverity(issue))} | ${cell(issue.recordId)} | ${cell(issue.target)} | ${cell(issue.phase)} | ${cell(issue.exceptionCode)} | ${cell(issue.message)} | ${cell(issue.suggestedRemediation)} | ${cell(issue.screenshotPath)} |`,
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

  lines.push("### Severity Counts", "");
  lines.push("| Severity | Count |", "| --- | ---: |");
  for (const severity of SEVERITY_ORDER) {
    const count = issues.filter((issue) => issueSeverity(issue) === severity).length;
    if (count > 0) {
      lines.push(`| ${severity} | ${count} |`);
    }
  }
  lines.push("");

  lines.push(
    "| Severity | Record | Target | Phase | Code | Message | Remediation | Evidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const issue of issues) {
    lines.push(
      `| ${cell(issueSeverity(issue))} | ${cell(issue.recordId)} | ${cell(issue.target)} | ${cell(issue.phase)} | ${cell(issue.exceptionCode)} | ${cell(issue.message)} | ${cell(issue.suggestedRemediation)} | ${cell(issue.screenshotPath)} |`,
    );
  }
}

function issueSeverity(issue: ReportIssue): "error" | "warning" | "info" {
  return issue.severity ?? "error";
}

function appendTargetRecordReviews(lines: string[], details: ReportDetails | undefined): void {
  if (!details) return;

  const aiByRecord = new Map(details.aiExtractions.map((extraction) => [extraction.recordId, extraction]));
  const inputsByRecord = new Map((details.recordInputs ?? []).map((input) => [input.recordId, input]));
  for (const target of reviewTargets(details)) {
    const targetMappings = details.fieldMappings.filter((mapping) => mapping.target === target);
    const mappingsByRecord = groupByRecord(targetMappings);
    const evidenceByRecord = groupEvidenceByRecord(details.targetEvidence.filter((evidence) => evidence.target === target));
    const issuesByRecord = groupByRecordIssue(details.issues.filter((issue) => issue.target === target && issue.recordId));
    const recordIds = reviewRecordIds(details, target);
    const label = targetLabel(target);

    if (recordIds.length === 0) continue;

    lines.push("", `## ${label} Record Review`, "");
    for (const recordId of recordIds) {
      const input = inputsByRecord.get(recordId);
      const evidence = evidenceByRecord.get(recordId)?.[0];
      const issue = issuesByRecord.get(recordId)?.[0];
      const mappings = mappingsByRecord.get(recordId) ?? [];
      const extraction = aiByRecord.get(recordId);

      lines.push(`### ${label} Record ${recordId}`, "");
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
        lines.push("", `![${label} proof screenshot for ${cell(recordId)}](${markdownImagePath(evidence.screenshotPath)})`, "");
      } else if (evidence?.screenshotPath) {
        lines.push(`- Context screenshot: ${cell(evidence.screenshotPath)}`);
        lines.push("", `![${label} context screenshot for ${cell(recordId)}](${markdownImagePath(evidence.screenshotPath)})`, "");
      } else if (issue?.screenshotPath) {
        lines.push(`- Exception screenshot: ${cell(issue.screenshotPath)}`);
        lines.push("", `![${label} exception screenshot for ${cell(recordId)}](${markdownImagePath(issue.screenshotPath)})`, "");
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

    const comparisonRows = targetComparisonRows(mappings, extraction, input);
    if (comparisonRows.length > 0) {
      lines.push(`#### Intake to ${label} Comparison`, "");
      lines.push(`Rows highlighted yellow in the viewer indicate ${label} mappings whose AI confidence is below the configured threshold.`, "");
      lines.push("| Intake Field | Intake Value | AI Confidence | Target Field | AI-Mapped Value | Final Input Value | Action | Status | Evidence |");
      lines.push("| --- | --- | ---: | --- | --- | --- | --- | --- | --- |");
      for (const row of comparisonRows) {
        lines.push(
          `| ${cell(row.sourceLabel)} | ${cell(row.sourceValue)} | ${cell(row.confidence)} | ${cell(row.targetField)} | ${cell(row.aiMappedValue)} | ${cell(row.finalInputValue)} | ${cell(row.action)} | ${cell(row.status)} | ${cell(row.evidence)} |`,
        );
      }
      lines.push("");
    }
  }
  }
}

interface TargetComparisonRow {
  sourceLabel: string;
  sourceValue: string;
  confidence: string;
  targetField: string;
  aiMappedValue: string;
  finalInputValue: string;
  action: string;
  status: string;
  evidence: string;
}

function targetComparisonRows(
  mappings: ReportFieldMapping[],
  extraction: ReportAiExtraction | undefined,
  input: ReportRecordInput | undefined,
): TargetComparisonRow[] {
  const extracted = extractionFieldLookup(extraction);
  const inputValues = recordInputFieldLookup(input);
  const mappedFields = new Set<string>();
  const rows: TargetComparisonRow[] = [];

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
      confidence: mappingConfidenceCell(mapping),
      targetField: mapping.targetField,
      aiMappedValue: mapping.normalizedValue,
      finalInputValue: finalInputValue(mapping),
      action: mapping.action ?? "",
      status: [mapping.status, mappingIntervention(mapping)].filter(Boolean).join("; "),
      evidence: mappingEvidence(mapping),
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
      confidence: "",
      targetField: "",
      aiMappedValue: "",
      finalInputValue: "",
      action: "",
      status: "not mapped",
      evidence: "",
    });
  }

  return rows;
}

function finalInputValue(mapping: ReportFieldMapping): string {
  if (mapping.status === "skipped") return "";
  return mapping.finalValue ?? mapping.normalizedValue;
}

function mappingConfidenceCell(mapping: ReportFieldMapping): string {
  const parts = [
    mapping.mappingConfidence === undefined ? undefined : String(mapping.mappingConfidence),
    mappingUserInputStatus(mapping),
  ].filter((value): value is string => Boolean(value));
  return parts.join("; ");
}

function mappingUserInputStatus(mapping: ReportFieldMapping): string | undefined {
  switch (mapping.approvalSource) {
    case "operator_confirmed":
      return "user confirmed";
    case "operator_edited":
      return "user edited";
    case "operator_skipped":
      return "user skipped";
    case "operator_stopped":
      return "user stopped";
    case "agent":
      return "no user input";
    case undefined:
      return undefined;
  }
}

function mappingIntervention(mapping: ReportFieldMapping): string {
  const lowConfidenceFlag = mappingLowConfidenceFlag(mapping);
  const parts = [
    lowConfidenceFlag,
    mapping.approvalSource,
    mapping.agentConfidence === undefined ? undefined : `agent ${Math.round(mapping.agentConfidence * 100)}%`,
    lowConfidenceFlag || mapping.confidenceThreshold === undefined ? undefined : `threshold ${Math.round(mapping.confidenceThreshold * 100)}%`,
    mapping.originalProposedValue === undefined ? undefined : `proposed ${metadataValue(mapping.originalProposedValue)}`,
    mapping.finalValue === undefined ? undefined : `final ${metadataValue(mapping.finalValue)}`,
    mapping.agentRationale === undefined ? undefined : `AI rationale ${metadataValue(mapping.agentRationale)}`,
    mapping.skipReason === undefined ? undefined : metadataValue(mapping.skipReason),
  ].filter((value): value is string => Boolean(value));
  return parts.join("; ");
}

function mappingEvidence(mapping: ReportFieldMapping): string {
  return mapping.errorMessage ?? mapping.fieldScreenshotPath ?? "";
}

function mappingLowConfidenceFlag(mapping: ReportFieldMapping): string | undefined {
  if (mapping.mappingConfidence === undefined || mapping.confidenceThreshold === undefined) return undefined;
  if (mapping.mappingConfidence >= mapping.confidenceThreshold) return undefined;
  return `low confidence: ${Math.round(mapping.mappingConfidence * 100)}% below threshold ${Math.round(mapping.confidenceThreshold * 100)}%`;
}

function metadataValue(value: string): string {
  return value === "" ? "<empty>" : value;
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

function reviewTargets(details: ReportDetails | undefined): TargetName[] {
  if (!details) return [];

  const targets = orderedUnique([
    ...details.targetEvidence.map((evidence) => evidence.target),
    ...details.fieldMappings.map((mapping) => mapping.target),
    ...details.issues.map((issue) => issue.target ?? ""),
  ]);
  return orderedTargets(Object.fromEntries(targets.map((target) => [target, { succeeded: 0, exception: 0, skipped: 0 }])));
}

function reviewRecordIds(details: ReportDetails | undefined, target: TargetName): string[] {
  if (!details) return [];

  const targetMappings = details.fieldMappings.filter((mapping) => mapping.target === target);
  const targetIssues = details.issues.filter((issue) => issue.target === target && issue.recordId);
  return orderedUnique([
    ...details.targetEvidence.filter((evidence) => evidence.target === target).map((evidence) => evidence.recordId),
    ...targetMappings.map((mapping) => mapping.recordId),
    ...targetIssues.map((issue) => issue.recordId ?? ""),
  ]);
}

function orderedTargets(targetCounts: Partial<Record<TargetName, Record<TargetTaskStatus, number>>>): TargetName[] {
  const present = Object.keys(targetCounts) as TargetName[];
  return [
    ...TARGET_ORDER.filter((target) => present.includes(target)),
    ...present.filter((target) => !TARGET_ORDER.includes(target)),
  ];
}

function groupFailedMappingsByTarget(mappings: ReportFieldMapping[]): Map<TargetName, ReportFieldMapping[]> {
  const groups = new Map<TargetName, ReportFieldMapping[]>();
  for (const mapping of mappings) {
    if (mapping.status !== "failed") continue;
    const group = groups.get(mapping.target) ?? [];
    group.push(mapping);
    groups.set(mapping.target, group);
  }
  return groups;
}

function groupEvidenceRecordsByTarget(evidenceItems: Array<{ target: TargetName; recordId: string; screenshotPath?: string; fieldScreenshotPath?: string }>): Map<TargetName, Set<string>> {
  const groups = new Map<TargetName, Set<string>>();
  for (const evidence of evidenceItems) {
    if (!evidence.screenshotPath && !evidence.fieldScreenshotPath) continue;
    const group = groups.get(evidence.target) ?? new Set<string>();
    group.add(evidence.recordId);
    groups.set(evidence.target, group);
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
