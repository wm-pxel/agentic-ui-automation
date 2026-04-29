import { z } from "zod";
import { TargetNameSchema, type TargetName } from "./domain/schema.js";

export const CliRunConfigSchema = z.object({
  input: z.string(),
  targets: z.array(TargetNameSchema).min(1),
  runsDir: z.string().default("runs"),
  agent: z.enum(["scripted", "openai"]).default("scripted"),
  excelWorkbookPath: z.string().default("runs/intake-workbook.xlsx"),
  syntheticSuffix: z.string().optional(),
  openEmr: z.object({
    baseUrl: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
  }),
});

export type CliRunConfig = z.infer<typeof CliRunConfigSchema>;

export interface BuildRunConfigOptions {
  input: string;
  targets: string;
  runsDir?: string;
  agent?: "scripted" | "openai";
  excelWorkbookPath?: string;
  syntheticSuffix?: string;
}

export function parseTargets(value: string): TargetName[] {
  return value
    .split(",")
    .map((target) => target.trim())
    .map((target) => TargetNameSchema.parse(target));
}

export function buildRunConfig(options: BuildRunConfigOptions): CliRunConfig {
  return CliRunConfigSchema.parse({
    input: options.input,
    targets: parseTargets(options.targets),
    runsDir: options.runsDir ?? process.env.RUNS_DIR,
    agent: options.agent,
    excelWorkbookPath: options.excelWorkbookPath ?? process.env.EXCEL_WORKBOOK_PATH,
    syntheticSuffix: options.syntheticSuffix,
    openEmr: {
      baseUrl: process.env.OPENEMR_BASE_URL,
      username: process.env.OPENEMR_USERNAME,
      password: process.env.OPENEMR_PASSWORD,
    },
  });
}
