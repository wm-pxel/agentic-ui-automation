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

  appendAiExtractions(lines, input.details?.aiExtractions ?? []);
  appendIssues(lines, input.details?.issues ?? []);
  appendOpenEmrSuccessEvidence(input.details, lines);
  appendOpenEmrFieldMappings(lines, input.details?.fieldMappings ?? [], input.details?.aiExtractions ?? []);

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

function appendAiExtractions(lines: string[], aiExtractions: ReportAiExtraction[]): void {
  if (aiExtractions.length === 0) return;

  lines.push("", "## AI Source Extraction", "");
  lines.push("| Record | Source Label | Normalized Field | Value | Confidence | Evidence |");
  lines.push("| --- | --- | --- | --- | ---: | --- |");

  for (const extraction of aiExtractions) {
    for (const field of extraction.fields) {
      lines.push(
        `| ${cell(extraction.recordId)} | ${cell(field.sourceLabel ?? field.sourceField)} | ${cell(field.sourceField)} | ${cell(field.value)} | ${cell(field.confidence)} | ${cell(field.evidence)} |`,
      );
    }
    for (const field of extraction.additionalFields) {
      lines.push(
        `| ${cell(extraction.recordId)} | ${cell(field.sourceLabel ?? field.sourceField)} | ${cell(field.sourceField)} | ${cell(field.value)} | ${cell(field.confidence)} | ${cell(field.evidence)} |`,
      );
    }
  }
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

function appendOpenEmrSuccessEvidence(details: ReportDetails | undefined, lines: string[]): void {
  if (!details) return;

  const successfulEvidence = (details.targetEvidence ?? []).filter(
    (evidence) => evidence.target === "openemr" && evidence.status === "succeeded" && evidence.screenshotPath,
  );
  if (successfulEvidence.length === 0) return;

  const inputsByRecord = new Map((details.recordInputs ?? []).map((input) => [input.recordId, input]));
  lines.push("", "## OpenEMR Success Evidence", "");
  for (const evidence of successfulEvidence) {
    const input = inputsByRecord.get(evidence.recordId);
    lines.push(`### Record ${evidence.recordId}`, "");
    lines.push(`- Proof screenshot: ${cell(evidence.screenshotPath)}`);
    lines.push("", `![OpenEMR success screenshot for ${cell(evidence.recordId)}](${markdownImagePath(evidence.screenshotPath)})`, "");
    if (evidence.targetRecordId) {
      lines.push(`- Target record: ${cell(evidence.targetRecordId)}`);
    }
    if (evidence.message) {
      lines.push(`- Result: ${cell(evidence.message)}`);
    }
    if (input) {
      lines.push(`- Source format: ${cell(input.sourceFormat)}`, "", "```json", formatJson(input.rawInput), "```", "");
    } else {
      lines.push("- Raw input record: not available", "");
    }
  }
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

function markdownImagePath(path: string | undefined): string {
  return encodeURI(path ?? "").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function appendOpenEmrFieldMappings(
  lines: string[],
  fieldMappings: ReportFieldMapping[],
  aiExtractions: ReportAiExtraction[],
): void {
  const openEmrMappings = fieldMappings.filter((mapping) => mapping.target === "openemr");
  if (openEmrMappings.length === 0) return;

  const sourceFields = sourceFieldLookup(aiExtractions);
  lines.push("", "## Intake to OpenEMR Field Mapping", "");
  for (const [recordId, mappings] of groupByRecord(openEmrMappings)) {
    lines.push(`### Record ${recordId}`, "");
    lines.push("| Intake Field | Intake Value | Intake Evidence | Normalized Field | OpenEMR Field | EMR Value | Action | Status | Selected Selector | Error |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const mapping of mappings) {
      const source = sourceFields.get(`${recordId}\0${mapping.sourceField}`) ?? {
        sourceLabel: mapping.sourceField,
        value: "",
        evidence: "",
      };
      lines.push(
        `| ${cell(source.sourceLabel)} | ${cell(source.value)} | ${cell(source.evidence)} | ${cell(mapping.sourceField)} | ${cell(mapping.targetField)} | ${cell(mapping.normalizedValue)} | ${cell(mapping.action)} | ${cell(mapping.status)} | ${cell(mapping.selectedSelector)} | ${cell(mapping.errorMessage)} |`,
      );
    }
    lines.push("");
  }
}

function sourceFieldLookup(aiExtractions: ReportAiExtraction[]): Map<string, { sourceLabel: string; value: string; evidence: string }> {
  const lookup = new Map<string, { sourceLabel: string; value: string; evidence: string }>();
  for (const extraction of aiExtractions) {
    for (const field of extraction.fields) {
      lookup.set(`${extraction.recordId}\0${field.sourceField}`, {
        sourceLabel: field.sourceLabel ?? field.sourceField,
        value: field.value,
        evidence: field.evidence ?? "",
      });
    }
  }
  return lookup;
}

function groupByRecord(mappings: ReportFieldMapping[]): Array<[string, ReportFieldMapping[]]> {
  const groups = new Map<string, ReportFieldMapping[]>();
  for (const mapping of mappings) {
    const group = groups.get(mapping.recordId) ?? [];
    group.push(mapping);
    groups.set(mapping.recordId, group);
  }
  return [...groups.entries()];
}

function cell(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  return String(value).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}
