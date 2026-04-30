import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import {
  exportReadyRecords,
  loadIntakeQueueFromFile,
  loadSeedIntakeQueue,
  type IntakeQueue,
} from "./intakeQueue.js";
import { defaultIntakeInbox } from "../handoff/intakeHandoff.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "Intake Queue",
    backgroundColor: "#f6f7f9",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "preload.cjs"),
    },
  });

  await window.loadURL(pathToFileURL(rendererIndexPath()).toString());
}

function rendererIndexPath(): string {
  const distPath = join(__dirname, "renderer", "index.html");
  if (existsSync(distPath)) return distPath;
  return resolve(process.cwd(), "src/desktop/renderer/index.html");
}

ipcMain.handle("intake:load-seed", async () => loadSeedIntakeQueue());

ipcMain.handle("intake:import", async () => {
  const result = await dialog.showOpenDialog({
    title: "Import synthetic intake source",
    properties: ["openFile"],
    filters: [
      { name: "Intake sources", extensions: ["json", "csv", "txt", "pdf", "docx"] },
      { name: "All files", extensions: ["*"] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  return {
    canceled: false,
    queue: await loadIntakeQueueFromFile(result.filePaths[0]),
  };
});

ipcMain.handle(
  "intake:export",
  async (_event, input: { queue: IntakeQueue; selectedRecordIds: string[]; inbox?: string }) =>
    exportReadyRecords({
      queue: input.queue,
      selectedRecordIds: input.selectedRecordIds,
      inbox: input.inbox,
    }),
);

ipcMain.handle("intake:default-inbox", () => defaultIntakeInbox());

ipcMain.handle("intake:show-path", async (_event, path: string) => {
  shell.showItemInFolder(path);
});

app.whenReady().then(async () => {
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
