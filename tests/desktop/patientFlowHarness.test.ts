import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildComputerUsePrompt,
  buildCodexExecArgs,
  codexOutputShowsComputerUseDenied,
  codexOutputShowsForbiddenAutomation,
  codexOutputShowsComputerUse,
  detectNewReadyFile,
  detectNewReadyFileForPatient,
  handoffCsvSnapshot,
  readyFileSnapshot,
  resolveComputerUseMcpCommand,
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
        "sourceRecordId,firstName,lastName,dateOfBirth,sexOrGender,phone,email,streetAddress,city,state,zip,insurancePayer,insuranceMemberId,insuranceGroupId,reasonForVisit,preferredContactMethod,notes",
        "wrong,Ava,Nguyen,1990-01-01,female,3125550000,ava@example.test,1 Main,Chicago,IL,60601,Aetna,WRONG,GRP,Visit,email,Wrong",
      ].join("\n"),
      "utf8",
    );
    await expect(detectNewReadyFileForPatient(inbox, before, patient)).resolves.toBeNull();

    await writeFile(
      join(inbox, "match.ready.csv"),
      [
        "sourceRecordId,firstName,lastName,dateOfBirth,sexOrGender,phone,email,streetAddress,city,state,zip,insurancePayer,insuranceMemberId,insuranceGroupId,reasonForVisit,preferredContactMethod,notes",
        [
          "desktop-created",
          patient.firstName,
          patient.lastName,
          patient.dateOfBirth,
          patient.sexOrGender,
          patient.phone,
          patient.email,
          patient.streetAddress,
          patient.city,
          patient.state,
          patient.zip,
          patient.insurancePayer,
          patient.insuranceMemberId,
          patient.insuranceGroupId,
          patient.reasonForVisit,
          patient.preferredContactMethod,
          patient.notes,
        ].join(","),
      ].join("\n"),
      "utf8",
    );

    await expect(detectNewReadyFileForPatient(inbox, before, patient)).resolves.toBe(join(inbox, "match.ready.csv"));
  });

  it("detects a generated patient CSV after the watcher moves it to processed", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "computer-use-processed-patient-"));
    tempDirs.push(inbox);
    await mkdir(join(inbox, "processed"), { recursive: true });
    const patient = syntheticComputerUsePatient(new Date("2026-05-04T14:03:27.000Z"));
    const before = await handoffCsvSnapshot(inbox);

    await writeFile(
      join(inbox, "processed", "run-2026-05-04T14-03-27-000Z.csv"),
      [
        "sourceRecordId,firstName,lastName,dateOfBirth,sexOrGender,phone,email,streetAddress,city,state,zip,insurancePayer,insuranceMemberId,insuranceGroupId,reasonForVisit,preferredContactMethod,notes",
        [
          "desktop-created",
          patient.firstName,
          patient.lastName,
          patient.dateOfBirth,
          patient.sexOrGender,
          patient.phone,
          patient.email,
          patient.streetAddress,
          patient.city,
          patient.state,
          patient.zip,
          patient.insurancePayer,
          patient.insuranceMemberId,
          patient.insuranceGroupId,
          patient.reasonForVisit,
          patient.preferredContactMethod,
          patient.notes,
        ].join(","),
      ].join("\n"),
      "utf8",
    );

    await expect(detectNewReadyFileForPatient(inbox, before, patient)).resolves.toBe(
      join(inbox, "processed", "run-2026-05-04T14-03-27-000Z.csv"),
    );
  });

  it("does not treat watcher failed files as successful exports", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "computer-use-failed-patient-"));
    tempDirs.push(inbox);
    await mkdir(join(inbox, "failed"), { recursive: true });
    const patient = syntheticComputerUsePatient(new Date("2026-05-04T14:03:27.000Z"));
    const before = await handoffCsvSnapshot(inbox);

    await writeFile(
      join(inbox, "failed", "failed-run.csv"),
      [
        "sourceRecordId,firstName,lastName,dateOfBirth,sexOrGender,phone,email,streetAddress,city,state,zip,insurancePayer,insuranceMemberId,insuranceGroupId,reasonForVisit,preferredContactMethod,notes",
        [
          "desktop-created",
          patient.firstName,
          patient.lastName,
          patient.dateOfBirth,
          patient.sexOrGender,
          patient.phone,
          patient.email,
          patient.streetAddress,
          patient.city,
          patient.state,
          patient.zip,
          patient.insurancePayer,
          patient.insuranceMemberId,
          patient.insuranceGroupId,
          patient.reasonForVisit,
          patient.preferredContactMethod,
          patient.notes,
        ].join(","),
      ].join("\n"),
      "utf8",
    );

    await expect(detectNewReadyFileForPatient(inbox, before, patient)).resolves.toBeNull();
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
    expect(prompt).toContain("First clear any already-selected seed records");
    expect(prompt).toContain("Select ready");
    expect(prompt).toContain("If Computer Use approval is denied via MCP elicitation, stop immediately");
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
    expect(script).toContain("codex exec transcript:");
    expect(script).toContain("Computer Use app access was denied");
    expect(script).toContain('JSON.stringify({ status: "exported", patient, readyPath }');
  });

  it("bounds the nested codex execution with the configured timeout", async () => {
    const script = await readFile("scripts/run-electron-patient-flow.mjs", "utf8");

    expect(script).toContain("runCodex(prompt, computerUseMcpCommand, pollTimeoutMs)");
    expect(script).toContain("child.kill(\"SIGTERM\")");
    expect(script).toContain("process.exit(124)");
  });

  it("detects whether codex output shows Computer Use activity", () => {
    expect(codexOutputShowsComputerUse('{"type":"tool_call","name":"mcp__computer_use__click"}')).toBe(true);
    expect(codexOutputShowsComputerUse('failed to load plugin="computer-use@openai-bundled"')).toBe(false);
    expect(codexOutputShowsComputerUse("Computer Use approval denied via MCP elicitation for app 'com.github.Electron'.")).toBe(false);
    expect(
      codexOutputShowsComputerUse(
        'failed to load plugin="computer-use@openai-bundled"\n{"type":"mcp_tool_call","server":"computer_use","tool":"click"}',
      ),
    ).toBe(true);
    expect(
      codexOutputShowsComputerUse(
        '{"type":"mcp_tool_call","server":"computer_use","tool":"click"}\nComputer Use approval denied via MCP elicitation for app',
      ),
    ).toBe(false);
    expect(codexOutputShowsComputerUse('{"type":"mcp_tool_call","server":"computer_use","tool":"list_apps"}')).toBe(false);
    expect(codexOutputShowsComputerUse('{"type":"mcp_tool_call","server":"computer_use","tool":"get_app_state"}')).toBe(false);
    expect(codexOutputShowsComputerUse('{"type":"tool_call","name":"mcp__computer_use__click"}\n{"type":"tool_call","name":"exec_command"}')).toBe(false);
    expect(codexOutputShowsComputerUse('{"type":"tool_call","name":"mcp__computer_use__click"}\n{"type":"item.completed","item":{"type":"command_execution","command":"touch fake.ready.csv"}}')).toBe(false);
    expect(codexOutputShowsComputerUse('{"type":"tool_call","name":"mcp__computer_use__click"}\n{"type":"item.completed","item":{"type":"agent_message","text":"I did not use Playwright."}}')).toBe(true);
    expect(codexOutputShowsComputerUse("completed without tools")).toBe(false);
  });

  it("detects Computer Use app access denial", () => {
    expect(codexOutputShowsComputerUseDenied("Computer Use approval denied via MCP elicitation for app 'com.github.Electron'.")).toBe(true);
    expect(codexOutputShowsComputerUseDenied("Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.")).toBe(true);
    expect(codexOutputShowsComputerUseDenied('{"type":"mcp_tool_call","server":"computer_use","tool":"click"}')).toBe(false);
  });

  it("detects forbidden non-UI automation in codex output", () => {
    expect(codexOutputShowsForbiddenAutomation('{"type":"tool_call","name":"exec_command"}')).toBe(true);
    expect(codexOutputShowsForbiddenAutomation('{"type":"item.completed","item":{"type":"command_execution","command":"touch fake.ready.csv"}}')).toBe(true);
    expect(codexOutputShowsForbiddenAutomation('{"type":"tool_call","name":"window.intakeApp.exportReady"}')).toBe(true);
    expect(codexOutputShowsForbiddenAutomation('{"type":"item.completed","item":{"type":"agent_message","text":"No shell command or Playwright was used."}}')).toBe(false);
    expect(codexOutputShowsForbiddenAutomation("used only mcp__computer_use__click")).toBe(false);
  });

  it("resolves the newest installed Computer Use MCP helper from the Codex plugin cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "computer-use-plugin-cache-"));
    tempDirs.push(root);
    const older = join(root, "1.0.9", "Codex Computer Use.app", "Contents", "SharedSupport", "SkyComputerUseClient.app", "Contents", "MacOS");
    const newer = join(root, "1.0.10", "Codex Computer Use.app", "Contents", "SharedSupport", "SkyComputerUseClient.app", "Contents", "MacOS");
    await mkdir(older, { recursive: true });
    await mkdir(newer, { recursive: true });
    await writeFile(join(older, "SkyComputerUseClient"), "", "utf8");
    await writeFile(join(newer, "SkyComputerUseClient"), "", "utf8");

    await expect(resolveComputerUseMcpCommand(root)).resolves.toBe(join(newer, "SkyComputerUseClient"));
  });

  it("allows the Computer Use MCP helper path to be overridden from the environment", async () => {
    const previous = process.env.COMPUTER_USE_MCP_COMMAND;
    process.env.COMPUTER_USE_MCP_COMMAND = "/custom/SkyComputerUseClient";
    try {
      await expect(resolveComputerUseMcpCommand()).resolves.toBe("/custom/SkyComputerUseClient");
    } finally {
      if (previous === undefined) {
        delete process.env.COMPUTER_USE_MCP_COMMAND;
      } else {
        process.env.COMPUTER_USE_MCP_COMMAND = previous;
      }
    }
  });

  it("builds a codex exec command with an explicit Computer Use MCP server and no shell fallback", () => {
    const args = buildCodexExecArgs({
      prompt: "drive the visible app",
      computerUseMcpCommand: "/tmp/Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient",
      cwd: "/repo",
    });

    expect(args).toContain("--disable");
    expect(args).toContain("shell_tool");
    expect(args).toContain("plugins");
    expect(args).toContain("mcp_servers.computer_use.command=\"/tmp/Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient\"");
    expect(args).toContain('mcp_servers.computer_use.args=["mcp"]');
    expect(args).toContain("-C");
    expect(args).toContain("/repo");
    expect(args.at(-1)).toBe("drive the visible app");
    expect(args.join(" ")).not.toContain('mcp_servers."computer-use"');
  });
});
