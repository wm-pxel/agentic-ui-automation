import { contextBridge, ipcRenderer } from "electron";
import type { IntakeQueue } from "./intakeQueue.js";
import type { WriteIntakeHandoffResult } from "../handoff/intakeHandoff.js";

export interface ImportResult {
  canceled: boolean;
  queue?: IntakeQueue;
}

export interface IntakeDesktopApi {
  loadSeed: () => Promise<IntakeQueue>;
  importFile: () => Promise<ImportResult>;
  exportReady: (input: {
    queue: IntakeQueue;
    selectedRecordIds: string[];
    inbox?: string;
  }) => Promise<WriteIntakeHandoffResult>;
  defaultInbox: () => Promise<string>;
  showPath: (path: string) => Promise<void>;
}

const api: IntakeDesktopApi = {
  loadSeed: () => ipcRenderer.invoke("intake:load-seed") as Promise<IntakeQueue>,
  importFile: () => ipcRenderer.invoke("intake:import") as Promise<ImportResult>,
  exportReady: (input) => ipcRenderer.invoke("intake:export", input) as Promise<WriteIntakeHandoffResult>,
  defaultInbox: () => ipcRenderer.invoke("intake:default-inbox") as Promise<string>,
  showPath: (path) => ipcRenderer.invoke("intake:show-path", path) as Promise<void>,
};

contextBridge.exposeInMainWorld("intakeApp", api);
