#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command, Option } from "commander";
import { ZodError } from "zod";
import { FakeAdapter } from "./adapters/fakeAdapter.js";
import type { TargetAdapter } from "./adapters/contract.js";
import { OpenAiUiAgentDriver } from "./agent/openAiUiAgent.js";
import { ScriptedAgentDriver } from "./agent/scriptedAgent.js";
import type { AgentDriver } from "./agent/types.js";
import { buildRunConfig, type CliRunConfig } from "./config.js";
import { OpenAiIntakeParser } from "./parsing/aiIntakeParser.js";
import { loadSourceRecords } from "./parsing/loadRecords.js";
import { applySyntheticSuffix } from "./parsing/syntheticRecords.js";
import { runWorkflow } from "./orchestrator/runWorkflow.js";
import { defaultIntakeInbox } from "./handoff/intakeHandoff.js";
import { processReadyIntakeFiles, watchIntakeInbox, type IntakeWatchJobResult } from "./watcher/intakeWatcher.js";
import { OpenMrsAdapter } from "./targets/openmrs/openMrsAdapter.js";
import { startViewerServer as defaultStartViewerServer, type ViewerServer } from "./viewer/server.js";

interface CliWritable {
  write(chunk: string): unknown;
}

export interface CliIo {
  stdout?: CliWritable;
  stderr?: CliWritable;
}

export interface CliDependencies {
  startViewerServer?: (options: {
    runsDir: string;
    port?: number;
    stdout?: CliWritable;
  }) => Promise<ViewerServer>;
}

interface RunCommandOptions {
  input: string;
  targets: string;
  runsDir?: string;
  agent?: CliRunConfig["agent"];
  parser?: CliRunConfig["parser"];
  parserModel?: string;
  syntheticSuffix?: string;
  openmrsConcurrency?: number;
  openmrsInteractiveFieldConfirmation?: boolean;
  openmrsFieldConfidenceThreshold?: number;
}

interface WatchCommandOptions {
  inbox?: string;
  targets: string;
  runsDir?: string;
  agent?: CliRunConfig["agent"];
  syntheticSuffix?: string;
  openmrsConcurrency?: number;
  openmrsInteractiveFieldConfirmation?: boolean;
  openmrsFieldConfidenceThreshold?: number;
  once?: boolean;
}

interface ViewerCommandOptions {
  runsDir: string;
  port?: number;
}

const defaultIo = {
  stdout: process.stdout,
  stderr: process.stderr,
} satisfies Required<CliIo>;

export async function runCli(
  argv: string[] = process.argv,
  io: CliIo = {},
  dependencies: CliDependencies = {},
): Promise<number> {
  const resolvedIo = {
    stdout: io.stdout ?? defaultIo.stdout,
    stderr: io.stderr ?? defaultIo.stderr,
  };
  const program = createProgram(resolvedIo, {
    startViewerServer: dependencies.startViewerServer ?? defaultStartViewerServer,
  });

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    if (isCommanderSuccessExit(error)) {
      return 0;
    }

    if (!isCommanderExit(error)) {
      resolvedIo.stderr.write(`${formatCliError(error)}\n`);
    }
    return 1;
  }
}

function createProgram(io: Required<CliIo>, dependencies: Required<CliDependencies>): Command {
  const program = new Command();

  program
    .name("agentic-ui")
    .description("Run audited agentic UI intake automation workflows.")
    .version("0.1.0")
    .exitOverride()
    .showHelpAfterError(false)
    .showSuggestionAfterError(false)
    .configureOutput({
      writeOut: (chunk) => io.stdout.write(chunk),
      writeErr: (chunk) => io.stderr.write(chunk),
    });

  program
    .command("run")
    .description("Run an intake automation workflow.")
    .requiredOption("--input <path>", "Path to the intake source file.")
    .option("--targets <targets>", "Comma-separated target adapters to run.", "fake")
    .option("--runs-dir <path>", "Directory where run artifacts are written.")
    .addOption(new Option("--agent <agent>", "Agent driver to use.").choices(["scripted", "openai"]))
    .addOption(new Option("--parser <parser>", "Input parser to use.").choices(["openai", "deterministic"]))
    .option("--parser-model <model>", "OpenAI model to use for AI source parsing.")
    .option("--synthetic-suffix <suffix>", "Suffix valid synthetic records before running targets; use 'auto' to generate one.")
    .option("--openmrs-concurrency <count>", "Maximum concurrent OpenMRS records.", parseOpenMrsPositiveInteger)
    .option("--openmrs-interactive-field-confirmation", "Prompt in the OpenMRS browser before low-confidence field entry.")
    .option(
      "--openmrs-field-confidence-threshold <threshold>",
      "Minimum AI confidence for OpenMRS field entry before prompting.",
      parseConfidenceThreshold,
    )
    .action(async (options: RunCommandOptions) => {
      await runCommand(options, io.stdout);
    });

  program
    .command("watch")
    .description("Watch an intake handoff folder and run workflows for ready exports.")
    .option("--inbox <path>", "Folder to watch for *.ready.csv or *.ready.json intake handoff files.")
    .option("--targets <targets>", "Comma-separated target adapters to run.", "openmrs")
    .option("--runs-dir <path>", "Directory where run artifacts are written.")
    .addOption(new Option("--agent <agent>", "Agent driver to use.").choices(["scripted", "openai"]))
    .option("--synthetic-suffix <suffix>", "Suffix valid synthetic records before running targets; use 'auto' to generate one.")
    .option("--openmrs-concurrency <count>", "Maximum concurrent OpenMRS records.", parseOpenMrsPositiveInteger)
    .option("--openmrs-interactive-field-confirmation", "Prompt in the OpenMRS browser before low-confidence field entry.")
    .option(
      "--openmrs-field-confidence-threshold <threshold>",
      "Minimum AI confidence for OpenMRS field entry before prompting.",
      parseConfidenceThreshold,
    )
    .option("--once", "Process currently ready files once and exit.")
    .action(async (options: WatchCommandOptions) => {
      await watchCommand(options, io.stdout);
    });

  program
    .command("viewer")
    .description("serve local read-only viewer for workflow run Markdown artifacts.")
    .option("--runs-dir <path>", "Directory containing workflow run artifacts.", "runs")
    .option("--port <number>", "Port for the local viewer server.", parseViewerPort)
    .action(async (options: ViewerCommandOptions) => {
      await dependencies.startViewerServer({
        runsDir: options.runsDir,
        port: options.port,
        stdout: io.stdout,
      });
    });

  return program;
}

async function runCommand(options: RunCommandOptions, stdout: CliWritable): Promise<void> {
  const config = buildRunConfig({
    ...options,
    openMrsConcurrency: options.openmrsConcurrency,
    openMrsInteractiveFieldConfirmation: options.openmrsInteractiveFieldConfirmation,
    openMrsFieldConfidenceThreshold: options.openmrsFieldConfidenceThreshold,
  });
  const records = applySyntheticSuffix(await loadRecords(config), resolveSyntheticSuffix(config.syntheticSuffix));
  const result = await runWorkflow({
    runsDir: config.runsDir,
    sourceInputPath: config.input,
    records,
    adapters: buildAdapters(config),
    agent: buildAgent(config.agent),
  });

  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function watchCommand(options: WatchCommandOptions, stdout: CliWritable): Promise<void> {
  const config = buildRunConfig({
    input: options.inbox ?? defaultIntakeInbox(),
    targets: options.targets,
    runsDir: options.runsDir,
    agent: options.agent,
    parser: "deterministic",
    syntheticSuffix: options.syntheticSuffix,
    openMrsConcurrency: options.openmrsConcurrency,
    openMrsInteractiveFieldConfirmation: options.openmrsInteractiveFieldConfirmation,
    openMrsFieldConfidenceThreshold: options.openmrsFieldConfidenceThreshold,
  });
  const inbox = options.inbox ?? defaultIntakeInbox();
  const watcherInput = {
    inbox,
    runsDir: config.runsDir,
    targets: config.targets,
    syntheticSuffix: config.syntheticSuffix,
    buildAgent: () => buildAgent(config.agent),
    buildAdapters: () => buildAdapters(config),
    onResult: (result: IntakeWatchJobResult) => {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    },
  };

  if (options.once) {
    const results = await processReadyIntakeFiles(watcherInput);
    if (results.length === 0) {
      stdout.write(`${JSON.stringify({ status: "idle", inbox }, null, 2)}\n`);
    }
    return;
  }

  stdout.write(`${JSON.stringify({ status: "watching", inbox, targets: config.targets }, null, 2)}\n`);
  await watchIntakeInbox(watcherInput);
}

async function loadRecords(config: CliRunConfig) {
  if (config.parser === "deterministic") {
    return loadSourceRecords(config.input);
  }

  return new OpenAiIntakeParser({
    apiKey: process.env.OPENAI_API_KEY,
    model: config.parserModel ?? "gpt-5.4-mini",
  }).parseFile(config.input);
}

function resolveSyntheticSuffix(suffix: string | undefined): string | undefined {
  if (suffix !== "auto") return suffix;

  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `run-${timestamp}-${randomUUID().slice(0, 6)}`;
}

function buildAgent(agent: CliRunConfig["agent"]): AgentDriver {
  switch (agent) {
    case "scripted":
      return new ScriptedAgentDriver();
    case "openai":
      return new OpenAiUiAgentDriver({
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
      });
  }
}

function buildAdapters(config: CliRunConfig): TargetAdapter[] {
  return config.targets.map((target) => {
    switch (target) {
      case "fake":
        return new FakeAdapter("success");
      case "openmrs":
        return new OpenMrsAdapter(config.openMrs);
    }
  });
}

function parseOpenMrsPositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--openmrs-concurrency must be a positive integer.");
  }
  return parsed;
}

function parseViewerPort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--port must be a positive integer.");
  }
  return parsed;
}

function parseConfidenceThreshold(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("--openmrs-field-confidence-threshold must be a number from 0 through 1.");
  }
  return parsed;
}

function formatCliError(error: unknown): string {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    return `Invalid CLI options: ${issue?.message ?? "configuration did not pass validation."}`;
  }

  return error instanceof Error ? error.message : String(error);
}

function isCommanderSuccessExit(error: unknown): boolean {
  return isCommanderExit(error) && error.exitCode === 0;
}

function isCommanderExit(error: unknown): error is { exitCode: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "exitCode" in error &&
    typeof error.exitCode === "number"
  );
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href);
}

if (isDirectRun()) {
  process.exitCode = await runCli();
}
