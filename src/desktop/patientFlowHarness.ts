import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import type { SyntheticPatientInput } from "./intakeQueue.js";

export function syntheticComputerUsePatient(now = new Date()): SyntheticPatientInput {
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);

  return {
    firstName: "Computer",
    lastName: `Use ${stamp}`,
    dateOfBirth: "1992-09-23",
    sexOrGender: "female",
    phone: `312555${stamp.slice(-4)}`,
    email: `computer.use.${stamp}@example.test`,
    streetAddress: "500 West Monroe Street",
    city: "Chicago",
    state: "IL",
    zip: "60661",
    insurancePayer: "Aetna",
    insuranceMemberId: `CU${stamp.slice(-8)}`,
    insuranceGroupId: "GRP4",
    reasonForVisit: "New patient wellness visit",
    preferredContactMethod: "email",
    notes: "Created by the Computer Use desktop patient flow.",
  };
}

export async function readyFileSnapshot(inbox: string): Promise<Set<string>> {
  try {
    const entries = await readdir(inbox);
    return new Set(entries.filter((entry) => entry.endsWith(".ready.csv")));
  } catch (error) {
    if (isMissingDirectoryError(error)) return new Set();
    throw error;
  }
}

export async function detectNewReadyFile(inbox: string, before: Set<string>): Promise<string | null> {
  const after = await readyFileSnapshot(inbox);
  const created = [...after].filter((entry) => !before.has(entry)).sort();
  return created.length > 0 ? join(inbox, created[0]) : null;
}

export async function detectNewReadyFileForPatient(
  inbox: string,
  before: Set<string>,
  patient: SyntheticPatientInput,
): Promise<string | null> {
  const after = await readyFileSnapshot(inbox);
  const created = [...after].filter((entry) => !before.has(entry)).sort();
  for (const fileName of created) {
    const filePath = join(inbox, fileName);
    if (await readyFileContainsOnlyPatient(filePath, patient)) {
      return filePath;
    }
  }
  return null;
}

export function codexOutputShowsComputerUse(output: string): boolean {
  if (/failed to load plugin=.*computer-use/i.test(output) || /Computer Use unavailable/i.test(output)) {
    return false;
  }
  if (codexOutputShowsForbiddenAutomation(output)) {
    return false;
  }
  return codexJsonEvents(output).some((event) =>
    eventContainsToolName(event, /mcp__computer_use__|computer_use|get_app_state|list_apps/i),
  );
}

export function codexOutputShowsForbiddenAutomation(output: string): boolean {
  return codexJsonEvents(output).some((event) =>
    eventContainsToolName(event, /exec_command|apply_patch|write_stdin|playwright|_electron|window\.intakeApp|intake:export/i),
  );
}

export function buildComputerUsePrompt({ patient, inbox }: { patient: SyntheticPatientInput; inbox: string }): string {
  return `You are driving the already-running visible Intake Queue desktop app as a third-party desktop application.

Use Codex Computer Use only. Click and type through the UI that is already open on screen.

Hard boundaries:
- Do not use Playwright.
- Do not launch Electron or start a private app instance.
- Do not use IPC, preload APIs, window.intakeApp, devtools console access, filesystem shortcuts, or application internals.
- Do not edit source code or generated build files.
- Use synthetic/demo data only.

Task:
1. In the visible Intake Queue app, create a new patient with exactly this JSON data:
${JSON.stringify(patient, null, 2)}
2. Save/add the patient through the app UI.
3. Select only the newly-created patient if selection is required.
4. Export the selected patient through the app UI.
5. The export must create a new .ready.csv handoff file in this inbox:
${inbox}
6. Leave the Intake Queue app running when finished.

Report the UI status text and the exported file path if the app displays one.`;
}

async function readyFileContainsOnlyPatient(filePath: string, patient: SyntheticPatientInput): Promise<boolean> {
  const content = await readFile(filePath, "utf8");
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
  }) as Array<Record<string, string>>;
  if (records.length !== 1) return false;

  const record = records[0];
  return (
    record.firstName === patient.firstName &&
    record.lastName === patient.lastName &&
    record.dateOfBirth === patient.dateOfBirth &&
    record.sexOrGender === patient.sexOrGender &&
    record.phone === patient.phone &&
    record.email === patient.email &&
    record.streetAddress === patient.streetAddress &&
    record.city === patient.city &&
    record.state === patient.state &&
    record.zip === patient.zip &&
    record.insurancePayer === patient.insurancePayer &&
    record.insuranceMemberId === patient.insuranceMemberId &&
    record.insuranceGroupId === (patient.insuranceGroupId ?? "") &&
    record.reasonForVisit === patient.reasonForVisit &&
    record.preferredContactMethod === patient.preferredContactMethod &&
    record.notes === (patient.notes ?? "")
  );
}

function isMissingDirectoryError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function codexJsonEvents(output: string): unknown[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"))
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return undefined;
      }
    })
    .filter((event): event is unknown => event !== undefined);
}

function eventContainsToolName(value: unknown, pattern: RegExp): boolean {
  return eventStringValues(value).some((text) => pattern.test(text));
}

function eventStringValues(value: unknown): string[] {
  const values: string[] = [];
  collectEventStringValues(value, values);
  return values;
}

function collectEventStringValues(value: unknown, values: string[]): void {
  if (typeof value === "string") {
    values.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectEventStringValues(item, values);
    }
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (["text", "message", "body", "summary", "output"].includes(key)) {
      continue;
    }
    collectEventStringValues(child, values);
  }
}
