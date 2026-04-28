import { z } from "zod";
import { TargetNameSchema, type TargetName } from "./domain/schema.js";

export const CliRunConfigSchema = z.object({
  input: z.string(),
  targets: z.array(TargetNameSchema).min(1),
  runsDir: z.string().default(process.env.RUNS_DIR ?? "runs"),
  agent: z.enum(["scripted", "openai"]).default("scripted"),
  excelWorkbookPath: z.string().default(process.env.EXCEL_WORKBOOK_PATH ?? "runs/intake-workbook.xlsx"),
  openEmr: z.object({
    baseUrl: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
  }),
});

export type CliRunConfig = z.infer<typeof CliRunConfigSchema>;

export interface BuildRunConfigOptions {
  input: string;
  target?: string;
  targets?: string | string[];
  runsDir?: string;
  agent?: "scripted" | "openai";
  excelWorkbookPath?: string;
}

export function parseTargets(value: string): TargetName[] {
  return value
    .split(",")
    .map((target) => target.trim())
    .map((target) => TargetNameSchema.parse(target));
}

export function buildRunConfig(options: BuildRunConfigOptions): CliRunConfig {
  const targets =
    options.targets === undefined
      ? [TargetNameSchema.parse(options.target)]
      : typeof options.targets === "string"
        ? parseTargets(options.targets)
        : options.targets.map((target) => TargetNameSchema.parse(target));

  return CliRunConfigSchema.parse({
    input: options.input,
    targets,
    runsDir: options.runsDir,
    agent: options.agent,
    excelWorkbookPath: options.excelWorkbookPath,
    openEmr: {
      baseUrl: process.env.OPENEMR_BASE_URL,
      username: process.env.OPENEMR_USERNAME,
      password: process.env.OPENEMR_PASSWORD,
    },
  });
}
