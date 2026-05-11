#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command, Option } from "commander";
import { ZodError } from "zod";
import { buildRunConfig, type CliRunConfig } from "./config.js";
import { OpenAiIntakeParser } from "./parsing/aiIntakeParser.js";
import { loadSourceRecords } from "./parsing/loadRecords.js";
import { applySyntheticSuffix } from "./parsing/syntheticRecords.js";
import { runWorkflow, type TargetRunner } from "./orchestrator/runWorkflow.js";
import { defaultIntakeInbox } from "./handoff/intakeHandoff.js";
import { processReadyIntakeFiles, watchIntakeInbox, type IntakeWatchJobResult } from "./watcher/intakeWatcher.js";
import { AiWebTargetRunner, type AiWebTargetResult } from "./targets/aiWebTargetRunner.js";
import { OpenAiAiWebPlanner } from "./targets/aiWebPlanner.js";
import { buildTargetProfiles, type TargetProfile } from "./targets/profiles.js";
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
  buildTargetRunner?: (options: { profiles: TargetProfile[] }) => TargetRunner;
  buildAiTargetRunner?: () => TargetRunner;
}

interface ResolvedCliDependencies {
  startViewerServer: (options: {
    runsDir: string;
    port?: number;
    stdout?: CliWritable;
  }) => Promise<ViewerServer>;
  buildTargetRunner: (options: { profiles: TargetProfile[] }) => TargetRunner;
}

interface RunCommandOptions {
  input: string;
  targets: string;
  runsDir?: string;
  parser?: CliRunConfig["parser"];
  parserModel?: string;
  syntheticSuffix?: string;
  confidenceThreshold?: number;
  fieldConfirmation?: CliRunConfig["fieldConfirmation"];
  openmrsConcurrency?: number;
  openkairoConcurrency?: number;
}

interface WatchCommandOptions {
  inbox?: string;
  targets: string;
  runsDir?: string;
  syntheticSuffix?: string;
  confidenceThreshold?: number;
  fieldConfirmation?: CliRunConfig["fieldConfirmation"];
  openmrsConcurrency?: number;
  openkairoConcurrency?: number;
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
  const buildAiTargetRunner = dependencies.buildAiTargetRunner ?? buildDefaultAiTargetRunner;
  const program = createProgram(resolvedIo, {
    startViewerServer: dependencies.startViewerServer ?? defaultStartViewerServer,
    buildTargetRunner: dependencies.buildTargetRunner ?? ((options) => buildDefaultTargetRunner(options.profiles, buildAiTargetRunner)),
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

function createProgram(io: Required<CliIo>, dependencies: ResolvedCliDependencies): Command {
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
    .option("--targets <targets>", "Comma-separated target profiles to run.", "fake")
    .option("--runs-dir <path>", "Directory where run artifacts are written.")
    .addOption(new Option("--parser <parser>", "Input parser to use.").choices(["openai", "deterministic"]))
    .option("--parser-model <model>", "OpenAI model to use for AI source parsing.")
    .option("--synthetic-suffix <suffix>", "Suffix valid synthetic records before running targets; use 'auto' to generate one.")
    .option(
      "--confidence-threshold <threshold>",
      "Minimum AI planner confidence for field mapping highlighting.",
      parseConfidenceThresholdOption,
    )
    .addOption(
      new Option("--field-confirmation <mode>", "Operator confirmation mode for AI-planned field mappings.")
        .choices(["auto", "prompt-on-low-confidence"])
        .default("auto"),
    )
    .option(
      "--openmrs-concurrency <count>",
      "Maximum concurrent OpenMRS records.",
      parsePositiveIntegerOption("--openmrs-concurrency"),
    )
    .option(
      "--openkairo-concurrency <count>",
      "Maximum concurrent OpenKairo records.",
      parsePositiveIntegerOption("--openkairo-concurrency"),
    )
    .action(async (options: RunCommandOptions) => {
      await runCommand(options, io.stdout, dependencies);
    });

  program
    .command("watch")
    .description("Watch an intake handoff folder and run workflows for ready exports.")
    .option("--inbox <path>", "Folder to watch for *.ready.csv or *.ready.json intake handoff files.")
    .option("--targets <targets>", "Comma-separated target profiles to run.", "openmrs")
    .option("--runs-dir <path>", "Directory where run artifacts are written.")
    .option(
      "--synthetic-suffix <suffix>",
      "Suffix valid synthetic records before running targets; use 'auto' to generate one.",
      "auto",
    )
    .option(
      "--confidence-threshold <threshold>",
      "Minimum AI planner confidence for field mapping highlighting.",
      parseConfidenceThresholdOption,
    )
    .addOption(
      new Option("--field-confirmation <mode>", "Operator confirmation mode for AI-planned field mappings.")
        .choices(["auto", "prompt-on-low-confidence"])
        .default("auto"),
    )
    .option(
      "--openmrs-concurrency <count>",
      "Maximum concurrent OpenMRS records.",
      parsePositiveIntegerOption("--openmrs-concurrency"),
    )
    .option(
      "--openkairo-concurrency <count>",
      "Maximum concurrent OpenKairo records.",
      parsePositiveIntegerOption("--openkairo-concurrency"),
    )
    .option("--once", "Process currently ready files once and exit.")
    .action(async (options: WatchCommandOptions) => {
      await watchCommand(options, io.stdout, dependencies);
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

async function runCommand(
  options: RunCommandOptions,
  stdout: CliWritable,
  dependencies: ResolvedCliDependencies,
): Promise<void> {
  const config = buildRunConfig({
    ...options,
    openMrsConcurrency: options.openmrsConcurrency,
    openKairoConcurrency: options.openkairoConcurrency,
  });
  const records = applySyntheticSuffix(await loadRecords(config), resolveSyntheticSuffix(config.syntheticSuffix));
  const profiles = buildTargetProfiles(config);
  const result = await runWorkflow({
    runsDir: config.runsDir,
    sourceInputPath: config.input,
    records,
    profiles,
    targetRunner: dependencies.buildTargetRunner({ profiles }),
  });

  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function watchCommand(
  options: WatchCommandOptions,
  stdout: CliWritable,
  dependencies: ResolvedCliDependencies,
): Promise<void> {
  const config = buildRunConfig({
    input: options.inbox ?? defaultIntakeInbox(),
    targets: options.targets,
    runsDir: options.runsDir,
    parser: "deterministic",
    syntheticSuffix: options.syntheticSuffix,
    confidenceThreshold: options.confidenceThreshold,
    fieldConfirmation: options.fieldConfirmation,
    openMrsConcurrency: options.openmrsConcurrency,
    openKairoConcurrency: options.openkairoConcurrency,
  });
  const inbox = options.inbox ?? defaultIntakeInbox();
  const watcherInput = {
    inbox,
    runsDir: config.runsDir,
    targets: config.targets,
    syntheticSuffix: config.syntheticSuffix,
    buildProfiles: () => buildTargetProfiles(config),
    buildTargetRunner: (profiles: TargetProfile[]) => dependencies.buildTargetRunner({ profiles }),
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

function buildDefaultTargetRunner(profiles: TargetProfile[], buildAiTargetRunner: () => TargetRunner): TargetRunner {
  const fakeProfiles = profiles.filter((profile) => profile.name === "fake");
  const aiProfiles = profiles.filter((profile) => profile.name !== "fake");

  if (aiProfiles.length === 0) {
    return new DryRunTargetRunner();
  }

  if (fakeProfiles.length === 0) {
    return buildAiTargetRunner();
  }

  return new ProfileDispatchingTargetRunner([
    { profiles: fakeProfiles, runner: new DryRunTargetRunner() },
    { profiles: aiProfiles, runner: buildAiTargetRunner() },
  ]);
}

function buildDefaultAiTargetRunner(): TargetRunner {
  return new AiWebTargetRunner({
    planner: new OpenAiAiWebPlanner({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
    }),
  });
}

class ProfileDispatchingTargetRunner implements TargetRunner {
  private readonly routes: Array<{ profileNames: Set<string>; runner: TargetRunner }>;

  constructor(routes: Array<{ profiles: TargetProfile[]; runner: TargetRunner }>) {
    this.routes = routes.map((route) => ({
      profileNames: new Set(route.profiles.map((profile) => profile.name)),
      runner: route.runner,
    }));
  }

  async prepare(profiles: TargetProfile[], plannedRecords: number): Promise<void> {
    for (const route of this.routes) {
      const routeProfiles = profiles.filter((profile) => route.profileNames.has(profile.name));
      if (routeProfiles.length > 0) {
        await route.runner.prepare?.(routeProfiles, plannedRecords);
      }
    }
  }

  async runRecord(context: Parameters<TargetRunner["runRecord"]>[0]): Promise<AiWebTargetResult> {
    return this.runnerForProfile(context.profile).runRecord(context);
  }

  async close(): Promise<void> {
    let firstError: unknown;
    for (const route of this.routes) {
      try {
        await route.runner.close?.();
      } catch (error) {
        firstError ??= error;
      }
    }

    if (firstError !== undefined) {
      throw firstError;
    }
  }

  private runnerForProfile(profile: TargetProfile): TargetRunner {
    const route = this.routes.find((candidate) => candidate.profileNames.has(profile.name));
    if (!route) {
      throw new Error(`No target runner is configured for profile ${profile.name}.`);
    }
    return route.runner;
  }
}

class DryRunTargetRunner implements TargetRunner {
  async prepare(_profiles: TargetProfile[], _plannedRecords: number): Promise<void> {}

  async runRecord(context: Parameters<TargetRunner["runRecord"]>[0]): Promise<AiWebTargetResult> {
    await context.audit.writeEvent({
      recordId: context.record.sourceRecordId,
      target: context.profile.name,
      phase: "target",
      actionType: "dry-run",
      rationale: "Dry-run target accepted the normalized intake record without browser automation.",
      result: "dry run accepted",
    });

    return {
      status: "succeeded",
      targetRecordId: `${context.profile.name}-${context.record.sourceRecordId}`,
    };
  }

  async close(): Promise<void> {}
}

function parsePositiveIntegerOption(optionName: string): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`${optionName} must be a positive integer.`);
    }
    return parsed;
  };
}

function parseConfidenceThresholdOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("--confidence-threshold must be a number from 0 through 1.");
  }
  return parsed;
}

function parseViewerPort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("--port must be zero or a positive integer.");
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
