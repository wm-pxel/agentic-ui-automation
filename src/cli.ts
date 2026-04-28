#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
  .name("agentic-ui")
  .description("Run audited agentic UI intake automation workflows.")
  .version("0.1.0");

program
  .command("run")
  .description("Run an intake automation workflow. Implemented in a later task.")
  .allowUnknownOption(true)
  .action(() => {
    console.error("The run command is implemented in a later task.");
    process.exitCode = 1;
  });

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
