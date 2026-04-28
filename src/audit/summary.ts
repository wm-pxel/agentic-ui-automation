import type { TargetName, TargetTaskStatus } from "../domain/schema.js";

const TARGET_ORDER: TargetName[] = ["openemr", "excel", "fake"];

export interface SummaryInput {
  runId: string;
  totalRecords: number;
  targetCounts: Partial<Record<TargetName, Record<TargetTaskStatus, number>>>;
  preflightExceptions: number;
  environmentExceptions: number;
  closeExceptions: number;
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
    "| Target | Succeeded | Exceptions | Skipped |",
    "| --- | ---: | ---: | ---: |",
  ];

  for (const target of TARGET_ORDER) {
    const counts = input.targetCounts[target];
    if (!counts) continue;
    lines.push(`| ${target} | ${counts.succeeded ?? 0} | ${counts.exception ?? 0} | ${counts.skipped ?? 0} |`);
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}
