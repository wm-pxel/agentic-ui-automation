import type { TargetName } from "./schema.js";

export const TARGET_ORDER: TargetName[] = ["openmrs", "openemr", "openkairo", "fake"];

const TARGET_LABELS: Record<TargetName, string> = {
  openmrs: "OpenMRS",
  openemr: "OpenEMR",
  openkairo: "OpenKairo",
  fake: "Fake Target",
};

export function targetLabel(target: string): string {
  return TARGET_LABELS[target as TargetName] ?? titleCaseTarget(target);
}

export function targetWithKey(target: string): string {
  return `${targetLabel(target)} (${target})`;
}

export function targetListLabel(targets: string[]): string {
  return targets.map(targetLabel).join(" + ");
}

export function targetDestinationLabel(targets: string[]): string {
  const label = targets.length === 1 ? "Destination target" : "Destination targets";
  return `${label}: ${targets.map(targetWithKey).join(", ")}`;
}

function titleCaseTarget(target: string): string {
  return target
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ") || target;
}
