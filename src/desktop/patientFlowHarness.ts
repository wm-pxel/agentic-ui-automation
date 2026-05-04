import { readdir } from "node:fs/promises";
import { join } from "node:path";
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

function isMissingDirectoryError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
