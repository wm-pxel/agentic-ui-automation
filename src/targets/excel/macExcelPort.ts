import { execFile, spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExcelDesktopPort {
  openWorkbook(path: string): Promise<void>;
  pasteRow(rowNumber: number, tsv: string): Promise<void>;
  screenshot(label: string): Promise<Buffer>;
  close(): Promise<void>;
}

export class MacExcelPort implements ExcelDesktopPort {
  async openWorkbook(path: string): Promise<void> {
    await execFileAsync("open", ["-a", "Microsoft Excel", path]);
    await sleep(1500);
  }

  async pasteRow(rowNumber: number, tsv: string): Promise<void> {
    await copyToClipboard(tsv);
    await execFileAsync("osascript", [
      "-e",
      `
      tell application "Microsoft Excel"
        activate
        tell active sheet
          select range "A${rowNumber}"
        end tell
      end tell
      tell application "System Events"
        keystroke "v" using command down
      end tell
      `,
    ]);
    await sleep(500);
  }

  async screenshot(label: string): Promise<Buffer> {
    const path = join(tmpdir(), `${safeLabel(label)}-${Date.now()}.png`);
    await execFileAsync("/usr/sbin/screencapture", ["-x", path]);

    try {
      return await readFile(path);
    } finally {
      await unlink(path).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await execFileAsync("osascript", ["-e", 'tell application "Microsoft Excel" to save active workbook']);
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
