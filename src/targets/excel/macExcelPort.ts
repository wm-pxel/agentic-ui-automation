import { execFile, spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
type ExecuteCommand = (command: string, args: string[]) => Promise<void>;

export interface ExcelDesktopPort {
  openWorkbook(path: string): Promise<void>;
  pasteRow(rowNumber: number, tsv: string): Promise<void>;
  screenshot(label: string): Promise<Buffer>;
  close(): Promise<void>;
}

export interface MacExcelPortOptions {
  execute?: ExecuteCommand;
  writeClipboard?: (value: string) => Promise<void>;
  readFile?: (path: string) => Promise<Buffer>;
  unlink?: (path: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  screenshotDir?: string;
}

export class MacExcelPort implements ExcelDesktopPort {
  private readonly execute: ExecuteCommand;
  private readonly writeClipboard: (value: string) => Promise<void>;
  private readonly readScreenshotFile: (path: string) => Promise<Buffer>;
  private readonly removeFile: (path: string) => Promise<void>;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly screenshotDir: string;
  private openedWorkbookName?: string;

  constructor(options: MacExcelPortOptions = {}) {
    this.execute = options.execute ?? defaultExecute;
    this.writeClipboard = options.writeClipboard ?? copyToClipboard;
    this.readScreenshotFile = options.readFile ?? readFile;
    this.removeFile = options.unlink ?? unlink;
    this.delay = options.sleep ?? sleep;
    this.now = options.now ?? Date.now;
    this.screenshotDir = options.screenshotDir ?? tmpdir();
  }

  async openWorkbook(path: string): Promise<void> {
    this.openedWorkbookName = basename(path);
    await this.execute("open", ["-a", "Microsoft Excel", path]);
    await this.delay(1500);
  }

  async pasteRow(rowNumber: number, tsv: string): Promise<void> {
    const workbookName = this.requireOpenedWorkbookName();
    await this.writeClipboard(tsv);
    try {
      await this.execute("osascript", ["-e", pasteScript(workbookName, rowNumber)]);
      await this.delay(500);
    } finally {
      await this.writeClipboard("");
    }
  }

  async screenshot(label: string): Promise<Buffer> {
    const path = join(this.screenshotDir, `${safeLabel(label)}-${this.now()}.png`);
    await this.execute("/usr/sbin/screencapture", ["-x", path]);

    try {
      return await this.readScreenshotFile(path);
    } finally {
      await this.removeFile(path).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (!this.openedWorkbookName) {
      return;
    }

    await this.execute("osascript", ["-e", `tell application "Microsoft Excel" to save workbook ${appleScriptString(this.openedWorkbookName)}`]);
  }

  private requireOpenedWorkbookName(): string {
    if (!this.openedWorkbookName) {
      throw new Error("Excel workbook has not been opened.");
    }

    return this.openedWorkbookName;
  }
}

async function defaultExecute(command: string, args: string[]): Promise<void> {
  await execFileAsync(command, args);
}

async function copyToClipboard(value: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pbcopy");
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`pbcopy exited with code ${code}`));
    });
    child.stdin.end(value);
  });
}

function safeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function pasteScript(workbookName: string, rowNumber: number): string {
  return `
      tell application "Microsoft Excel"
        activate
        tell workbook ${appleScriptString(workbookName)}
          tell active sheet
            select range "A${rowNumber}"
          end tell
        end tell
      end tell
      tell application "System Events"
        keystroke "v" using command down
      end tell
      `;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
