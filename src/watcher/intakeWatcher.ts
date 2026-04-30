import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import { applySyntheticSuffix } from "../parsing/syntheticRecords.js";
import { loadSourceRecords } from "../parsing/loadRecords.js";
import { runWorkflow, type RunWorkflowResult } from "../orchestrator/runWorkflow.js";
import type { AgentDriver } from "../agent/types.js";
import type { TargetAdapter } from "../adapters/contract.js";
import type { TargetName } from "../domain/schema.js";
import { isReadyHandoffFile } from "../handoff/intakeHandoff.js";

export interface ProcessReadyIntakeFilesInput {
  inbox: string;
  runsDir: string;
  targets: TargetName[];
  syntheticSuffix?: string;
  buildAgent: () => AgentDriver;
  buildAdapters: () => TargetAdapter[];
  onResult?: (result: IntakeWatchJobResult) => void;
}

export type IntakeWatchJobResult =
  | {
      status: "processed";
      sourcePath: string;
      processingPath: string;
      finalPath: string;
      run: RunWorkflowResult;
    }
  | {
      status: "failed";
      sourcePath: string;
      processingPath?: string;
      finalPath: string;
      error: string;
    };

export async function processReadyIntakeFiles(input: ProcessReadyIntakeFilesInput): Promise<IntakeWatchJobResult[]> {
  await ensureWatcherDirs(input.inbox);
  const readyFiles = await readyHandoffFiles(input.inbox);
  const results: IntakeWatchJobResult[] = [];

  for (const readyPath of readyFiles) {
    const result = await processReadyFile(readyPath, input);
    results.push(result);
    input.onResult?.(result);
  }

  return results;
}

export async function watchIntakeInbox(input: ProcessReadyIntakeFilesInput & { intervalMs?: number }): Promise<never> {
  let running = false;
  const scan = async () => {
    if (running) return;
    running = true;
    try {
      await processReadyIntakeFiles(input);
    } finally {
      running = false;
    }
  };

  await scan();
  const interval = setInterval(() => {
    void scan().catch((error) => {
      input.onResult?.({
        status: "failed",
        sourcePath: input.inbox,
        finalPath: join(input.inbox, "failed", `watcher-${Date.now()}.json`),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, input.intervalMs ?? 2000);

  await new Promise<never>((resolve) => {
    const stop = () => {
      clearInterval(interval);
      resolve(undefined as never);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return undefined as never;
}

async function processReadyFile(
  readyPath: string,
  input: ProcessReadyIntakeFilesInput,
): Promise<IntakeWatchJobResult> {
  let processingPath: string | undefined;
  try {
    processingPath = await moveIntoProcessing(input.inbox, readyPath);
    const records = applySyntheticSuffix(await loadSourceRecords(processingPath), resolveWatcherSyntheticSuffix(input.syntheticSuffix));
    const run = await runWorkflow({
      runsDir: input.runsDir,
      sourceInputPath: processingPath,
      records,
      adapters: input.buildAdapters(),
      agent: input.buildAgent(),
    });
    const finalPath = join(input.inbox, "processed", `${run.runId}${processedExtensionFor(processingPath)}`);
    await rename(processingPath, finalPath);
    return {
      status: "processed",
      sourcePath: readyPath,
      processingPath,
      finalPath,
      run,
    };
  } catch (error) {
    const finalPath = await moveFailedFile(input.inbox, readyPath, processingPath);
    return {
      status: "failed",
      sourcePath: readyPath,
      processingPath,
      finalPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readyHandoffFiles(inbox: string): Promise<string[]> {
  const names = await readdir(inbox).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return names
    .filter(isReadyHandoffFile)
    .sort()
    .map((name) => join(inbox, name));
}

async function ensureWatcherDirs(inbox: string): Promise<void> {
  await Promise.all([
    mkdir(inbox, { recursive: true }),
    mkdir(join(inbox, "processing"), { recursive: true }),
    mkdir(join(inbox, "processed"), { recursive: true }),
    mkdir(join(inbox, "failed"), { recursive: true }),
  ]);
}

async function moveIntoProcessing(inbox: string, readyPath: string): Promise<string> {
  const processingPath = join(inbox, "processing", basename(readyPath));
  await rename(readyPath, processingPath);
  return processingPath;
}

async function moveFailedFile(inbox: string, readyPath: string, processingPath: string | undefined): Promise<string> {
  const source = processingPath ?? readyPath;
  const finalPath = join(inbox, "failed", `${Date.now()}-${randomUUID().slice(0, 8)}-${basename(source)}`);
  await rename(source, finalPath).catch(() => undefined);
  return finalPath;
}

function resolveWatcherSyntheticSuffix(suffix: string | undefined): string | undefined {
  if (suffix !== "auto") return suffix;

  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `run-${timestamp}-${randomUUID().slice(0, 6)}`;
}

function processedExtensionFor(path: string): ".csv" | ".json" {
  return basename(path).endsWith(".ready.csv") ? ".csv" : ".json";
}
