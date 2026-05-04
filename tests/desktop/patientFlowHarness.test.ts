import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildComputerUsePrompt,
  codexOutputShowsComputerUse,
  detectNewReadyFile,
  detectNewReadyFileForPatient,
  readyFileSnapshot,
  syntheticComputerUsePatient,
} from "../../src/desktop/patientFlowHarness.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("Computer Use patient flow harness", () => {
  it("builds a deterministic synthetic demo patient from the timestamp", () => {
    const patient = syntheticComputerUsePatient(new Date("2026-05-04T14:03:27.000Z"));

    expect(patient).toEqual({
      firstName: "Computer",
      lastName: "Use 20260504140327",
      dateOfBirth: "1992-09-23",
      sexOrGender: "female",
      phone: "3125550327",
      email: "computer.use.20260504140327@example.test",
      streetAddress: "500 West Monroe Street",
      city: "Chicago",
      state: "IL",
      zip: "60661",
      insurancePayer: "Aetna",
      insuranceMemberId: "CU04140327",
      insuranceGroupId: "GRP4",
      reasonForVisit: "New patient wellness visit",
      preferredContactMethod: "email",
      notes: "Created by the Computer Use desktop patient flow.",
    });
  });

  it("detects only newly-created CSV ready files", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "computer-use-ready-"));
    tempDirs.push(inbox);
    await writeFile(join(inbox, "existing.ready.csv"), "firstName\nAva\n", "utf8");
    await writeFile(join(inbox, "existing.ready.json"), "[]\n", "utf8");
    await writeFile(join(inbox, "pending.pending"), "", "utf8");
    const before = await readyFileSnapshot(inbox);

    expect(before).toEqual(new Set(["existing.ready.csv"]));
    expect(await detectNewReadyFile(inbox, before)).toBeNull();

    await writeFile(join(inbox, "new.ready.csv"), "firstName\nComputer\n", "utf8");

    expect(await detectNewReadyFile(inbox, before)).toBe(join(inbox, "new.ready.csv"));
  });

  it("detects only a newly-created ready CSV containing exactly the generated patient", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "computer-use-ready-patient-"));
    tempDirs.push(inbox);
    const patient = syntheticComputerUsePatient(new Date("2026-05-04T14:03:27.000Z"));
    const before = await readyFileSnapshot(inbox);

    await writeFile(
      join(inbox, "wrong.ready.csv"),
      [
        "sourceRecordId,firstName,lastName,dateOfBirth,sexOrGender,phone,email,insuranceMemberId",
        "wrong,Ava,Nguyen,1990-01-01,female,3125550000,ava@example.test,WRONG",
      ].join("\n"),
      "utf8",
    );
    await expect(detectNewReadyFileForPatient(inbox, before, patient)).resolves.toBeNull();

    await writeFile(
      join(inbox, "match.ready.csv"),
      [
        "sourceRecordId,firstName,lastName,dateOfBirth,sexOrGender,phone,email,insuranceMemberId",
        `desktop-created,${patient.firstName},${patient.lastName},${patient.dateOfBirth},${patient.sexOrGender},${patient.phone},${patient.email},${patient.insuranceMemberId}`,
      ].join("\n"),
      "utf8",
    );

    await expect(detectNewReadyFileForPatient(inbox, before, patient)).resolves.toBe(join(inbox, "match.ready.csv"));
  });

  it("returns an empty snapshot for a missing inbox", async () => {
    const inbox = join(tmpdir(), "missing-computer-use-ready-files");

    await expect(readyFileSnapshot(inbox)).resolves.toEqual(new Set());
    await expect(detectNewReadyFile(inbox, new Set())).resolves.toBeNull();
  });

  it("builds a prompt that requires Computer Use against the visible app and blocks internals", () => {
    const patient = syntheticComputerUsePatient(new Date("2026-05-04T14:03:27.000Z"));
    const prompt = buildComputerUsePrompt({ patient, inbox: "/tmp/intake inbox" });

    expect(prompt).toContain("already-running visible Intake Queue desktop app");
    expect(prompt).toContain("Use Codex Computer Use");
    expect(prompt).toContain("Do not use Playwright");
    expect(prompt).toMatch(/do not launch Electron/i);
    expect(prompt).toMatch(/do not use IPC/i);
    expect(prompt).toContain("preload APIs");
    expect(prompt).toContain("window.intakeApp");
    expect(prompt).toContain("application internals");
    expect(prompt).toContain("/tmp/intake inbox");
    expect(prompt).toContain('"firstName": "Computer"');
    expect(prompt).toContain('"notes": "Created by the Computer Use desktop patient flow."');
  });

  it("keeps the desktop patient-flow npm command out of the Electron build path", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["desktop:patient-flow"]).toBe("tsx scripts/run-electron-patient-flow.mjs");
    expect(packageJson.scripts["desktop:patient-flow"]).not.toContain("desktop:build");
    expect(packageJson.scripts["desktop:patient-flow"]).not.toMatch(/(^|&&|\s)electron(\s|$)/);
  });

  it("keeps npm lifecycle banners out of command stdout", async () => {
    await expect(readFile(".npmrc", "utf8")).resolves.toContain("loglevel=silent");
  });

  it("keeps runner stdout reserved for the final success JSON", async () => {
    const script = await readFile("scripts/run-electron-patient-flow.mjs", "utf8");

    expect(script).not.toContain('stdio: "inherit"');
    expect(script).toContain('stdio: ["ignore", "pipe", "pipe"]');
    expect(script).toContain("process.stderr.write(codexResult.output)");
    expect(script).toContain('JSON.stringify({ status: "exported", patient, readyPath }');
  });

  it("detects whether codex output shows Computer Use activity", () => {
    expect(codexOutputShowsComputerUse('{"type":"tool_call","name":"mcp__computer_use__get_app_state"}')).toBe(true);
    expect(codexOutputShowsComputerUse("called get_app_state for Intake Queue")).toBe(true);
    expect(codexOutputShowsComputerUse('failed to load plugin="computer-use@openai-bundled"')).toBe(false);
    expect(codexOutputShowsComputerUse("completed without tools")).toBe(false);
  });
});
