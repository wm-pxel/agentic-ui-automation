import { z } from "zod";
import { TargetNameSchema, type TargetName } from "./domain/schema.js";

export const CliRunConfigSchema = z.object({
  input: z.string(),
  targets: z.array(TargetNameSchema).min(1),
  runsDir: z.string().default("runs"),
  agent: z.enum(["scripted", "openai"]).default("scripted"),
  parser: z.enum(["openai", "deterministic"]).default("openai"),
  parserModel: z.string().optional(),
  syntheticSuffix: z.string().optional(),
  openMrs: z.object({
    baseUrl: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    concurrency: z.number().int().min(1).default(2),
  }),
  openEmr: z.object({
    baseUrl: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    concurrency: z.number().int().min(1).default(1),
  }),
});

export type CliRunConfig = z.infer<typeof CliRunConfigSchema>;

export interface BuildRunConfigOptions {
  input: string;
  targets: string;
  runsDir?: string;
  agent?: "scripted" | "openai";
  parser?: "openai" | "deterministic";
  parserModel?: string;
  syntheticSuffix?: string;
  openMrsConcurrency?: number;
  openEmrConcurrency?: number;
}

export function parseTargets(value: string): TargetName[] {
  return value
    .split(",")
    .map((target) => target.trim())
    .map((target) => TargetNameSchema.parse(target));
}

export function buildRunConfig(options: BuildRunConfigOptions): CliRunConfig {
  const requestedOpenMrsConcurrency = options.openMrsConcurrency ?? numberFromEnv(process.env.OPENMRS_CONCURRENCY);
  const requestedOpenEmrConcurrency = options.openEmrConcurrency ?? numberFromEnv(process.env.OPENEMR_CONCURRENCY);

  return CliRunConfigSchema.parse({
    input: options.input,
    targets: parseTargets(options.targets),
    runsDir: options.runsDir ?? process.env.RUNS_DIR,
    agent: options.agent,
    parser: options.parser,
    parserModel: options.parserModel ?? process.env.OPENAI_PARSER_MODEL ?? process.env.OPENAI_MODEL,
    syntheticSuffix: options.syntheticSuffix,
    openMrs: {
      baseUrl: process.env.OPENMRS_BASE_URL ?? "https://o2.openmrs.org/openmrs",
      username: process.env.OPENMRS_USERNAME ?? "admin",
      password: process.env.OPENMRS_PASSWORD ?? "Admin123",
      concurrency: requestedOpenMrsConcurrency,
    },
    openEmr: {
      baseUrl: process.env.OPENEMR_BASE_URL ?? "https://demo.openemr.io/openemr",
      username: process.env.OPENEMR_USERNAME ?? "admin",
      password: process.env.OPENEMR_PASSWORD ?? "pass",
      concurrency: requestedOpenEmrConcurrency,
    },
  });
}

function numberFromEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
