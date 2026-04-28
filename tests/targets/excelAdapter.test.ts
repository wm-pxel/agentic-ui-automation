import ExcelJS from "exceljs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAuditStore } from "../../src/audit/auditStore.js";
import type { AgentDecision, AgentDecisionInput, AgentDriver } from "../../src/agent/types.js";
import { ScriptedAgentDriver } from "../../src/agent/scriptedAgent.js";
import { ExcelAdapter } from "../../src/targets/excel/excelAdapter.js";
import { MacExcelPort, type ExcelDesktopPort } from "../../src/targets/excel/macExcelPort.js";
import { ensureWorkbook, INTAKE_COLUMNS, nextExcelRow, recordToTsv } from "../../src/targets/excel/workbook.js";
import type { NormalizedIntakeRecord } from "../../src/domain/schema.js";

describe("ExcelAdapter", () => {
  it("prepares a workbook, pastes a normalized row, captures screenshots, and succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "excel-adapter-"));
    const workbookPath = join(root, "nested", "intake.xlsx");
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-excel" });
    const port = new FakeExcelPort();
    const adapter = new ExcelAdapter({ workbookPath, port });

    await adapter.prepare();
    const result = await adapter.runRecord({
      runId: "run-excel",
      record: record("demo-001", {
        notes: "Prefers\tmorning\nappointments.",
      }),
      audit,
      agent: new ScriptedAgentDriver(),
    });

    expect(result).toEqual({ status: "succeeded", targetRecordId: "excel-row-2" });
    expect(port.openedWorkbookPaths).toEqual([workbookPath]);
    expect(port.pastedRows).toEqual([
      {
        rowNumber: 2,
        tsv: [
          "demo-001",
          "Ava",
          "Nguyen",
          "1987-03-14",
          "female",
          "'+13125550198",
          "ava.nguyen@example.test",
          "1200 West Lake Street",
          "Chicago",
          "IL",
          "60607",
          "Aetna",
          "AET123456",
          "GRP9",
          "Annual wellness visit",
          "phone",
          "Prefers morning appointments.",
        ].join("\t"),
      },
    ]);
    expect(port.screenshotLabels).toEqual(["before-demo-001", "after-demo-001"]);

    const events = await readFile(join(root, "run-excel", "events.jsonl"), "utf8");
    expect(events).toContain("captured Excel before-entry screenshot");
    expect(events).toContain("pasted record into Excel row 2");
    expect(events).toContain("screenshots/demo-001/excel/before-entry.png");
    expect(events).toContain("screenshots/demo-001/excel/after-entry.png");
  });

  it("tracks rows across records without rereading unsaved workbook state", async () => {
    const root = await mkdtemp(join(tmpdir(), "excel-adapter-rows-"));
    const workbookPath = join(root, "intake.xlsx");
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-excel" });
    const port = new FakeExcelPort();
    const adapter = new ExcelAdapter({ workbookPath, port });

    await adapter.prepare();
    const first = await adapter.runRecord({
      runId: "run-excel",
      record: record("demo-001"),
      audit,
      agent: new ScriptedAgentDriver(),
    });
    const second = await adapter.runRecord({
      runId: "run-excel",
      record: record("demo-002"),
      audit,
      agent: new ScriptedAgentDriver(),
    });

    expect(first).toEqual({ status: "succeeded", targetRecordId: "excel-row-2" });
    expect(second).toEqual({ status: "succeeded", targetRecordId: "excel-row-3" });
    expect(port.pastedRows.map((row) => row.rowNumber)).toEqual([2, 3]);
    await expect(nextExcelRow(workbookPath)).resolves.toBe(2);
  });

  it("returns an exception when the agent has low confidence in row entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "excel-adapter-rejected-"));
    const workbookPath = join(root, "intake.xlsx");
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-excel" });
    const port = new FakeExcelPort();
    const adapter = new ExcelAdapter({ workbookPath, port });

    await adapter.prepare();
    const result = await adapter.runRecord({
      runId: "run-excel",
      record: record("demo-002"),
      audit,
      agent: new RejectingAgent("The sheet was not ready."),
    });

    expect(result).toEqual({
      status: "exception",
      exception: {
        code: "ui_state_unexpected",
        severity: "error",
        message: "Agent did not approve Excel row entry.",
        suggestedRemediation: "The sheet was not ready.",
      },
    });
    expect(port.pastedRows).toEqual([]);
    expect(port.screenshotLabels).toEqual(["before-demo-002"]);
  });

  it("returns an exception when the agent chooses a different action", async () => {
    const root = await mkdtemp(join(tmpdir(), "excel-adapter-wrong-action-"));
    const workbookPath = join(root, "intake.xlsx");
    const audit = await FileAuditStore.create({ runsDir: root, runId: "run-excel" });
    const port = new FakeExcelPort();
    const adapter = new ExcelAdapter({ workbookPath, port });

    await adapter.prepare();
    const result = await adapter.runRecord({
      runId: "run-excel",
      record: record("demo-003"),
      audit,
      agent: new WrongActionAgent("Excel was on another sheet."),
    });

    expect(result).toEqual({
      status: "exception",
      exception: {
        code: "ui_state_unexpected",
        severity: "error",
        message: "Agent did not approve Excel row entry.",
        suggestedRemediation: "Excel was on another sheet.",
      },
    });
    expect(port.pastedRows).toEqual([]);
  });

  it("delegates close to the Excel port", async () => {
    const port = new FakeExcelPort();
    const adapter = new ExcelAdapter({ workbookPath: "/tmp/intake.xlsx", port });

    await adapter.close();

    expect(port.closed).toBe(true);
  });
});

describe("Excel workbook helpers", () => {
  it("creates the Intake workbook and advances to the next empty row", async () => {
    const root = await mkdtemp(join(tmpdir(), "excel-workbook-"));
    const workbookPath = join(root, "nested", "intake.xlsx");

    await ensureWorkbook(workbookPath);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(workbookPath);
    const sheet = workbook.getWorksheet("Intake");
    expect(sheet).toBeDefined();
    expect(sheet!.getRow(1).values).toEqual([undefined, ...INTAKE_COLUMNS]);
    expect(sheet!.getRow(1).font.bold).toBe(true);
    expect(sheet!.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    await expect(nextExcelRow(workbookPath)).resolves.toBe(2);

    sheet!.addRow(recordToTsv(record("demo-003")).split("\t"));
    await workbook.xlsx.writeFile(workbookPath);
    await expect(nextExcelRow(workbookPath)).resolves.toBe(3);
  });

  it("preserves existing Intake rows when ensuring a workbook", async () => {
    const root = await mkdtemp(join(tmpdir(), "excel-workbook-existing-"));
    const workbookPath = join(root, "intake.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Intake");
    sheet.addRow([...INTAKE_COLUMNS]);
    sheet.addRow(["existing-001", "Existing"]);
    await workbook.xlsx.writeFile(workbookPath);

    await ensureWorkbook(workbookPath);

    const preserved = new ExcelJS.Workbook();
    await preserved.xlsx.readFile(workbookPath);
    const preservedSheet = preserved.getWorksheet("Intake");
    expect(preservedSheet!.getRow(2).getCell(1).value).toBe("existing-001");
    await expect(nextExcelRow(workbookPath)).resolves.toBe(3);
  });

  it("adds Intake to an existing workbook without deleting other sheets", async () => {
    const root = await mkdtemp(join(tmpdir(), "excel-workbook-add-sheet-"));
    const workbookPath = join(root, "intake.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Existing");
    sheet.addRow(["keep-me"]);
    await workbook.xlsx.writeFile(workbookPath);

    await ensureWorkbook(workbookPath);

    const preserved = new ExcelJS.Workbook();
    await preserved.xlsx.readFile(workbookPath);
    expect(preserved.getWorksheet("Existing")!.getCell("A1").value).toBe("keep-me");
    expect(preserved.getWorksheet("Intake")!.getRow(1).values).toEqual([undefined, ...INTAKE_COLUMNS]);
  });

  it("throws a clear error when the Intake sheet is missing during row lookup", async () => {
    const root = await mkdtemp(join(tmpdir(), "excel-workbook-missing-intake-"));
    const workbookPath = join(root, "intake.xlsx");
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Other").addRow(["not intake"]);
    await workbook.xlsx.writeFile(workbookPath);

    await expect(nextExcelRow(workbookPath)).rejects.toThrow("Workbook is missing Intake sheet.");
  });

  it("outputs TSV in intake column order and replaces tabs and newlines", () => {
    expect(
      recordToTsv(
        record("demo-004", {
          insuranceGroupId: undefined,
          notes: undefined,
          reasonForVisit: "Annual\twellness\nvisit",
        }),
      ),
    ).toBe(
      [
        "demo-004",
        "Ava",
        "Nguyen",
        "1987-03-14",
        "female",
        "'+13125550198",
        "ava.nguyen@example.test",
        "1200 West Lake Street",
        "Chicago",
        "IL",
        "60607",
        "Aetna",
        "AET123456",
        "",
        "Annual wellness visit",
        "phone",
        "",
      ].join("\t"),
    );
  });

  it("prefixes formula-like values with an apostrophe", () => {
    const tsv = recordToTsv(
      record("demo-005", {
        firstName: "=SUM(1,1)",
        lastName: "+Nguyen",
        insuranceMemberId: "-12345",
        notes: " @risky note",
      }),
    );

    expect(tsv.split("\t")).toEqual([
      "demo-005",
      "'=SUM(1,1)",
      "'+Nguyen",
      "1987-03-14",
      "female",
      "'+13125550198",
      "ava.nguyen@example.test",
      "1200 West Lake Street",
      "Chicago",
      "IL",
      "60607",
      "Aetna",
      "'-12345",
      "GRP9",
      "Annual wellness visit",
      "phone",
      "'@risky note",
    ]);
  });
});

describe("MacExcelPort", () => {
  it("targets the opened workbook and clears the clipboard after paste", async () => {
    const executed: Array<{ command: string; args: string[] }> = [];
    const clipboardValues: string[] = [];
    const port = new MacExcelPort({
      execute: async (command, args) => {
        executed.push({ command, args });
      },
      writeClipboard: async (value) => {
        clipboardValues.push(value);
      },
      readFile: async () => Buffer.from("png"),
      unlink: async () => {},
      sleep: async () => {},
      now: () => 123,
      screenshotDir: "/tmp",
    });

    await port.openWorkbook("/tmp/Intake Book.xlsx");
    await port.pasteRow(4, "secret\trow");
    await port.close();

    const pasteScript = executed.find((call) => call.command === "osascript" && call.args.join("\n").includes("A4"))?.args.join("\n");
    const closeScript = executed.at(-1)?.args.join("\n");
    expect(pasteScript).toContain('workbook "Intake Book.xlsx"');
    expect(pasteScript).toContain('worksheet "Intake"');
    expect(closeScript).toContain('save workbook "Intake Book.xlsx"');
    expect(clipboardValues).toEqual(["secret\trow", ""]);
  });

  it("does not fail a completed paste when clipboard cleanup fails", async () => {
    const executed: Array<{ command: string; args: string[] }> = [];
    const clipboardValues: string[] = [];
    const port = new MacExcelPort({
      execute: async (command, args) => {
        executed.push({ command, args });
      },
      writeClipboard: async (value) => {
        clipboardValues.push(value);
        if (value === "") {
          throw new Error("clipboard clear failed");
        }
      },
      readFile: async () => Buffer.from("png"),
      unlink: async () => {},
      sleep: async () => {},
    });

    await port.openWorkbook("/tmp/Intake Book.xlsx");
    await expect(port.pasteRow(4, "secret\trow")).resolves.toBeUndefined();

    expect(executed.some((call) => call.command === "osascript" && call.args.join("\n").includes("A4"))).toBe(true);
    expect(clipboardValues).toEqual(["secret\trow", ""]);
  });
});

class FakeExcelPort implements ExcelDesktopPort {
  openedWorkbookPaths: string[] = [];
  pastedRows: Array<{ rowNumber: number; tsv: string }> = [];
  screenshotLabels: string[] = [];
  closed = false;

  async openWorkbook(path: string): Promise<void> {
    this.openedWorkbookPaths.push(path);
  }

  async pasteRow(rowNumber: number, tsv: string): Promise<void> {
    this.pastedRows.push({ rowNumber, tsv });
  }

  async screenshot(label: string): Promise<Buffer> {
    this.screenshotLabels.push(label);
    return Buffer.from(`png-${label}`);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class RejectingAgent implements AgentDriver {
  constructor(private readonly rationale: string) {}

  async decide(_input: AgentDecisionInput): Promise<AgentDecision> {
    return {
      actionId: "paste-row",
      confidence: 0.49,
      rationale: this.rationale,
    };
  }
}

class WrongActionAgent implements AgentDriver {
  constructor(private readonly rationale: string) {}

  async decide(_input: AgentDecisionInput): Promise<AgentDecision> {
    return {
      actionId: "inspect-only",
      confidence: 1,
      rationale: this.rationale,
    };
  }
}

function record(sourceRecordId: string, overrides: Partial<NormalizedIntakeRecord> = {}): NormalizedIntakeRecord {
  return {
    sourceRecordId,
    firstName: "Ava",
    lastName: "Nguyen",
    dateOfBirth: "1987-03-14",
    sexOrGender: "female",
    phone: "+13125550198",
    email: "ava.nguyen@example.test",
    streetAddress: "1200 West Lake Street",
    city: "Chicago",
    state: "IL",
    zip: "60607",
    insurancePayer: "Aetna",
    insuranceMemberId: "AET123456",
    insuranceGroupId: "GRP9",
    reasonForVisit: "Annual wellness visit",
    preferredContactMethod: "phone",
    notes: "Prefers morning appointments.",
    sourceFormat: "json",
    rawSourceExcerpt: "Ava Nguyen intake",
    ...overrides,
  };
}
