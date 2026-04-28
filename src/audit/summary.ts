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
