#!/usr/bin/env node
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
import { loadSourceRecords } from "./parsing/loadRecords.js";
import { runWorkflow } from "./orchestrator/runWorkflow.js";
import { ExcelAdapter } from "./targets/excel/excelAdapter.js";
import { MacExcelPort } from "./targets/excel/macExcelPort.js";
import { OpenEmrAdapter } from "./targets/openemr/openEmrAdapter.js";

interface CliWritable {
  write(chunk: string): unknown;
}

export interface CliIo {
  stdout?: CliWritable;
  stderr?: CliWritable;
}

interface RunCommandOptions {
  input: string;
  targets: string;
  runsDir?: string;
  agent?: CliRunConfig["agent"];
  excelWorkbookPath?: string;
}

const defaultIo = {
  stdout: process.stdout,
  stderr: process.stderr,
} satisfies Required<CliIo>;

export async function runCli(argv: string[] = process.argv, io: CliIo = {}): Promise<number> {
  const resolvedIo = {
    stdout: io.stdout ?? defaultIo.stdout,
    stderr: io.stderr ?? defaultIo.stderr,
  };
  const program = createProgram(resolvedIo);

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    if (isCommanderSuccessExit(error)) {
      return 0;
    }

    resolvedIo.stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
}

function createProgram(io: Required<CliIo>): Command {
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
      writeErr: () => undefined,
    });

  program
    .command("run")
    .description("Run an intake automation workflow.")
    .requiredOption("--input <path>", "Path to the intake source file.")
    .option("--targets <targets>", "Comma-separated target adapters to run.", "fake")
    .option("--runs-dir <path>", "Directory where run artifacts are written.")
    .addOption(new Option("--agent <agent>", "Agent driver to use.").choices(["scripted", "openai"]))
    .option("--excel-workbook-path <path>", "Workbook path for the Excel target.")
    .action(async (options: RunCommandOptions) => {
      await runCommand(options, io.stdout);
    });

  return program;
}

async function runCommand(options: RunCommandOptions, stdout: CliWritable): Promise<void> {
  const config = buildRunConfig(options);
  const records = await loadSourceRecords(config.input);
  const result = await runWorkflow({
    runsDir: config.runsDir,
    records,
    adapters: buildAdapters(config),
    agent: buildAgent(config.agent),
  });

  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
      case "openemr":
        return new OpenEmrAdapter(config.openEmr);
      case "excel":
        return new ExcelAdapter({ workbookPath: config.excelWorkbookPath, port: new MacExcelPort() });
    }
  });
}

function formatCliError(error: unknown): string {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    return `Invalid CLI options: ${issue?.message ?? "configuration did not pass validation."}`;
  }

  return error instanceof Error ? error.message : String(error);
}

function isCommanderSuccessExit(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "exitCode" in error &&
    error.exitCode === 0
  );
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href);
}

if (isDirectRun()) {
  process.exitCode = await runCli();
}
