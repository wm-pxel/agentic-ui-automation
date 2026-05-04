import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import type { SyntheticPatientInput } from "./intakeQueue.js";

const computerUseMcpExecutableSegments = [
  "Codex Computer Use.app",
  "Contents",
  "SharedSupport",
  "SkyComputerUseClient.app",
  "Contents",
  "MacOS",
  "SkyComputerUseClient",
];

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

export async function handoffCsvSnapshot(inbox: string): Promise<Set<string>> {
  const entries = await handoffCsvFiles(inbox);
  return new Set(entries.map((entry) => entry.relativePath));
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
  const after = await handoffCsvFiles(inbox);
  const created = after.filter((entry) => !before.has(entry.relativePath)).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  for (const { absolutePath: filePath } of created) {
    if (await readyFileContainsOnlyPatient(filePath, patient)) {
      return filePath;
    }
  }
  return null;
}

export function codexOutputShowsComputerUse(output: string): boolean {
  if (/Computer Use unavailable/i.test(output) || codexOutputShowsComputerUseDenied(output)) {
    return false;
  }
  if (codexOutputShowsForbiddenAutomation(output)) {
    return false;
  }
  return codexJsonEvents(output).some((event) =>
    eventContainsToolName(event, /mcp__computer_use__(click|type_text|set_value|press_key|scroll|drag)|\b(click|type_text|set_value|press_key|scroll|drag)\b/i),
  );
}

export function codexOutputShowsComputerUseDenied(output: string): boolean {
  return /Computer Use approval denied via MCP elicitation|Computer Use is not allowed to use the app/i.test(output);
}

export function codexOutputShowsForbiddenAutomation(output: string): boolean {
  return codexJsonEvents(output).some((event) =>
    eventContainsToolName(event, /command_execution|exec_command|apply_patch|write_stdin|playwright|_electron|window\.intakeApp|intake:export/i),
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
- If Computer Use approval is denied via MCP elicitation, stop immediately and report that denial. Do not try unrelated apps.

Task:
1. First clear any already-selected seed records. If the "Select ready" checkbox is checked, click it so no existing ready records are selected.
2. In the visible Intake Queue app, create a new patient with exactly this JSON data:
${JSON.stringify(patient, null, 2)}
3. Save/add the patient through the app UI.
4. Confirm the queue shows the newly-created patient named "${patient.firstName} ${patient.lastName}".
5. Select only the newly-created patient. Do not leave any seeded patient selected.
6. Export the selected patient through the app UI.
7. The export must create a new .ready.csv handoff file in this inbox:
${inbox}
8. Leave the Intake Queue app running when finished.

Do not finish after merely inspecting apps or reading the UI. Finish only after clicking the app controls to add and export the patient.

Report the UI status text, the selected record count before export, and the exported file path if the app displays one.`;
}

export async function resolveComputerUseMcpCommand(pluginRoot?: string): Promise<string> {
  const envCommand = pluginRoot === undefined ? process.env.COMPUTER_USE_MCP_COMMAND?.trim() : undefined;
  if (envCommand) return envCommand;
  const root = pluginRoot ?? defaultComputerUsePluginRoot();

  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (isMissingDirectoryError(error)) {
      throw new Error(`Computer Use plugin cache not found at ${root}`);
    }
    throw error;
  });
  const versionDirectories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareVersionLike)
    .reverse();

  for (const version of versionDirectories) {
    const command = join(root, version, ...computerUseMcpExecutableSegments);
    if (await fileExists(command)) return command;
  }

  throw new Error(`Computer Use MCP helper not found under ${root}`);
}

export function buildCodexExecArgs({
  prompt,
  computerUseMcpCommand,
  cwd,
}: {
  prompt: string;
  computerUseMcpCommand: string;
  cwd: string;
}): string[] {
  return [
    "exec",
    "-m",
    "gpt-5.4",
    "--json",
    "--disable",
    "shell_tool",
    "--disable",
    "plugins",
    "--sandbox",
    "read-only",
    "-c",
    'approval_policy="never"',
    "-c",
    `mcp_servers.computer_use.command=${tomlString(computerUseMcpCommand)}`,
    "-c",
    'mcp_servers.computer_use.args=["mcp"]',
    "-c",
    "mcp_servers.computer_use.startup_timeout_sec=20.0",
    "-c",
    "mcp_servers.computer_use.tool_timeout_sec=120.0",
    "-C",
    cwd,
    prompt,
  ];
}

async function readyFileContainsOnlyPatient(filePath: string, patient: SyntheticPatientInput): Promise<boolean> {
  const content = await readFile(filePath, "utf8").catch((error) => {
    if (isMissingDirectoryError(error)) return undefined;
    throw error;
  });
  if (content === undefined) return false;
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

async function handoffCsvFiles(inbox: string): Promise<Array<{ relativePath: string; absolutePath: string }>> {
  const directories = ["", "processing", "processed"];
  const groups = await Promise.all(
    directories.map(async (directory) => {
      const directoryPath = directory ? join(inbox, directory) : inbox;
      const names = await readdir(directoryPath).catch((error) => {
        if (isMissingDirectoryError(error)) return [];
        throw error;
      });
      return names
        .filter((name) => name.endsWith(".csv"))
        .map((name) => ({
          relativePath: directory ? `${directory}/${name}` : name,
          absolutePath: join(directoryPath, name),
        }));
    }),
  );
  return groups.flat();
}

function defaultComputerUsePluginRoot(): string {
  return join(homedir(), ".codex", "plugins", "cache", "openai-bundled", "computer-use");
}

async function fileExists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch((error) => {
      if (isMissingDirectoryError(error)) return false;
      throw error;
    });
}

function compareVersionLike(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function tomlString(value: string): string {
  return JSON.stringify(value);
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
