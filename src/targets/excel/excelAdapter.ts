import type { TargetAdapter, TargetAdapterResult, TargetRunContext } from "../../adapters/contract.js";
import type { ExcelDesktopPort } from "./macExcelPort.js";
import { ensureWorkbook, nextExcelRow, recordToTsv } from "./workbook.js";

export interface ExcelAdapterOptions {
  workbookPath: string;
  port: ExcelDesktopPort;
}

export class ExcelAdapter implements TargetAdapter {
  readonly name = "excel" as const;
  private nextRow?: number;

  constructor(private readonly options: ExcelAdapterOptions) {}

  async prepare(): Promise<void> {
    await ensureWorkbook(this.options.workbookPath);
    this.nextRow = await nextExcelRow(this.options.workbookPath);
    await this.options.port.openWorkbook(this.options.workbookPath);
  }

  async runRecord(context: TargetRunContext): Promise<TargetAdapterResult> {
    const before = await this.options.port.screenshot(`before-${context.record.sourceRecordId}`);
    const beforePath = await context.audit.writeScreenshot(context.record.sourceRecordId, this.name, "before-entry", before);
    await context.audit.writeEvent({
      recordId: context.record.sourceRecordId,
      target: this.name,
      phase: "desktop",
      actionType: "screenshot",
      screenshotPath: beforePath,
      result: "captured Excel before-entry screenshot",
    });

    const decision = await context.agent.decide({
      target: this.name,
      recordId: context.record.sourceRecordId,
      step: "paste-row",
      screenshotPath: beforePath,
      visibleText: "Microsoft Excel Intake sheet",
      allowedActions: [{ id: "paste-row", description: "Paste normalized intake row into the first empty table row." }],
    });

    if (decision.actionId !== "paste-row" || decision.confidence < 0.5) {
      return {
        status: "exception",
        exception: {
          code: "ui_state_unexpected",
          severity: "error",
          message: "Agent did not approve Excel row entry.",
          suggestedRemediation: decision.rationale,
        },
      };
    }

    const rowNumber = this.nextRow ?? (await nextExcelRow(this.options.workbookPath));
    await this.options.port.pasteRow(rowNumber, recordToTsv(context.record));
    this.nextRow = rowNumber + 1;

    const after = await this.options.port.screenshot(`after-${context.record.sourceRecordId}`);
    const afterPath = await context.audit.writeScreenshot(context.record.sourceRecordId, this.name, "after-entry", after);
    await context.audit.writeEvent({
      recordId: context.record.sourceRecordId,
      target: this.name,
      phase: "desktop",
      actionType: "paste",
      rationale: decision.rationale,
      screenshotPath: afterPath,
      result: `pasted record into Excel row ${rowNumber}`,
    });

    return { status: "succeeded", targetRecordId: `excel-row-${rowNumber}` };
  }

  async close(): Promise<void> {
    await this.options.port.close();
  }
}
