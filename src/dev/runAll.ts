import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { defaultIntakeInbox, writeIntakeHandoff } from "../handoff/intakeHandoff.js";
import { loadSourceRecords } from "../parsing/loadRecords.js";

export type DevAllChildProcess = {
  stdout?: Readable | null;
  stderr?: Readable | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
};

export type DevAllSpawnProcess = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => DevAllChildProcess;

export type DevAllAutoImportInput = {
  cwd: string;
  inputPath: string;
  inbox: string;
};

export type DevAllAutoImportResult = {
  readyPath: string;
  recordCount: number;
};

export type DevAllAutoImportHandoff = (input: DevAllAutoImportInput) => Promise<DevAllAutoImportResult>;

type DevAllCommand = {
  name: string;
  script: string;
};

type DevAllOptions = {
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  spawnProcess?: DevAllSpawnProcess;
  autoImportHandoff?: DevAllAutoImportHandoff;
  registerSignalHandler?: (signal: NodeJS.Signals, handler: () => void) => () => void;
};

type IntakeTrigger = "watcher" | "auto-import";

type DevAllConfig = {
  targets?: string;
  intakeTrigger: IntakeTrigger;
  autoImportInput: string;
  viewerPort: number;
  confidenceThreshold?: number;
  fieldConfirmation: "auto" | "prompt-on-low-confidence";
};

const defaultAutoImportInput = "data/demo/intake-records-normalized.json";
const defaultViewerPort = 4173;

const devAllCommands: DevAllCommand[] = [
  { name: "watch", script: "watch:intake" },
  { name: "desktop", script: "desktop:dev" },
  { name: "viewer", script: "viewer" },
];

export async function runDevAll(options: DevAllOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const spawnProcess = options.spawnProcess ?? spawnDevCommand;
  const autoImportHandoff = options.autoImportHandoff ?? defaultAutoImportHandoff;
  const config = parseDevAllArgs(options.args ?? []);
  const children: Array<{ command: DevAllCommand; child: DevAllChildProcess; exited: boolean }> = [];
  const removeSignalHandlers: Array<() => void> = [];

  stdout.write(`Starting dev services: ${devAllCommands.map((command) => command.script).join(", ")}\n`);

  return await new Promise((resolve) => {
    let settled = false;

    const stopChildren = (signal: NodeJS.Signals = "SIGTERM") => {
      for (const child of children) {
        if (!child.exited) {
          child.child.kill(signal);
        }
      }
    };

    const settle = (exitCode: number, signal: NodeJS.Signals = "SIGTERM") => {
      if (settled) return;
      settled = true;
      for (const removeSignalHandler of removeSignalHandlers) {
        removeSignalHandler();
      }
      stopChildren(signal);
      resolve(exitCode);
    };

    const handleSignal = (signal: NodeJS.Signals) => {
      settle(signalExitCode(signal), signal);
    };

    const registerSignalHandler = options.registerSignalHandler ?? defaultRegisterSignalHandler;
    removeSignalHandlers.push(
      registerSignalHandler("SIGINT", () => handleSignal("SIGINT")),
      registerSignalHandler("SIGTERM", () => handleSignal("SIGTERM")),
    );

    for (const command of devAllCommands) {
      const child = spawnProcess("npm", npmRunArgs(command, config), { cwd, env });
      const tracked = { command, child, exited: false };
      children.push(tracked);

      pipeWithPrefix(child.stdout, stdout, command.name);
      pipeWithPrefix(child.stderr, stderr, command.name);

      child.on("exit", (code, signal) => {
        tracked.exited = true;
        if (settled) return;

        const exitCode = code ?? signalExitCode(signal);
        settle(exitCode);
      });
    }

    if (config.intakeTrigger === "auto-import") {
      void autoImportHandoff({
        cwd,
        inputPath: config.autoImportInput,
        inbox: defaultIntakeInbox(),
      })
        .then((result) => {
          stdout.write(`Auto-imported ${result.recordCount} intake records to ${result.readyPath}\n`);
        })
        .catch((error) => {
          stderr.write(`Auto-import failed: ${error instanceof Error ? error.message : String(error)}\n`);
          settle(1);
        });
    }
  });
}

function parseDevAllArgs(args: string[]): DevAllConfig {
  const config: DevAllConfig = {
    intakeTrigger: "watcher",
    autoImportInput: defaultAutoImportInput,
    viewerPort: defaultViewerPort,
    fieldConfirmation: "auto",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--targets") {
      const targets = args[index + 1];
      if (!targets || targets.startsWith("--")) {
        throw new Error("--targets requires a comma-separated target list.");
      }
      config.targets = targets;
      index += 1;
      continue;
    }

    if (arg.startsWith("--targets=")) {
      const targets = arg.slice("--targets=".length);
      if (!targets) {
        throw new Error("--targets requires a comma-separated target list.");
      }
      config.targets = targets;
      continue;
    }

    if (arg === "--intake-trigger") {
      const trigger = args[index + 1];
      if (!trigger || trigger.startsWith("--")) {
        throw new Error("--intake-trigger requires 'watcher' or 'auto-import'.");
      }
      config.intakeTrigger = parseIntakeTrigger(trigger);
      index += 1;
      continue;
    }

    if (arg.startsWith("--intake-trigger=")) {
      config.intakeTrigger = parseIntakeTrigger(arg.slice("--intake-trigger=".length));
      continue;
    }

    if (arg === "--auto-import-input") {
      const inputPath = args[index + 1];
      if (!inputPath || inputPath.startsWith("--")) {
        throw new Error("--auto-import-input requires a path.");
      }
      config.autoImportInput = inputPath;
      index += 1;
      continue;
    }

    if (arg.startsWith("--auto-import-input=")) {
      const inputPath = arg.slice("--auto-import-input=".length);
      if (!inputPath) {
        throw new Error("--auto-import-input requires a path.");
      }
      config.autoImportInput = inputPath;
      continue;
    }

    if (arg === "--viewer-port") {
      const port = args[index + 1];
      if (!port || port.startsWith("--")) {
        throw new Error("--viewer-port requires zero or a positive integer.");
      }
      config.viewerPort = parseViewerPort(port);
      index += 1;
      continue;
    }

    if (arg.startsWith("--viewer-port=")) {
      config.viewerPort = parseViewerPort(arg.slice("--viewer-port=".length));
      continue;
    }

    if (arg === "--confidence-threshold") {
      const threshold = args[index + 1];
      if (!threshold || threshold.startsWith("--")) {
        throw new Error("--confidence-threshold requires a number from 0 through 1.");
      }
      config.confidenceThreshold = parseConfidenceThreshold(threshold);
      index += 1;
      continue;
    }

    if (arg.startsWith("--confidence-threshold=")) {
      config.confidenceThreshold = parseConfidenceThreshold(arg.slice("--confidence-threshold=".length));
      continue;
    }

    if (arg === "--field-confirmation") {
      const mode = args[index + 1];
      if (!mode || mode.startsWith("--")) {
        throw new Error("--field-confirmation requires 'auto' or 'prompt-on-low-confidence'.");
      }
      config.fieldConfirmation = parseFieldConfirmation(mode);
      index += 1;
      continue;
    }

    if (arg.startsWith("--field-confirmation=")) {
      config.fieldConfirmation = parseFieldConfirmation(arg.slice("--field-confirmation=".length));
      continue;
    }

    throw new Error(`Unknown dev:all option: ${arg}`);
  }

  return config;
}

function parseIntakeTrigger(value: string): IntakeTrigger {
  if (value === "watcher" || value === "auto-import") return value;
  throw new Error("--intake-trigger must be either 'watcher' or 'auto-import'.");
}

function parseViewerPort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("--viewer-port must be zero or a positive integer.");
  }
  return parsed;
}

function parseConfidenceThreshold(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("--confidence-threshold must be a number from 0 through 1.");
  }
  return parsed;
}

function parseFieldConfirmation(value: string): DevAllConfig["fieldConfirmation"] {
  if (value === "auto" || value === "prompt-on-low-confidence") return value;
  throw new Error("--field-confirmation must be either 'auto' or 'prompt-on-low-confidence'.");
}

function npmRunArgs(command: DevAllCommand, config: DevAllConfig): string[] {
  const args = ["run", command.script];
  if (command.name === "watch" && config.targets) {
    args.push("--", "--targets", config.targets);
  }
  if (command.name === "watch" && config.confidenceThreshold !== undefined) {
    if (!args.includes("--")) {
      args.push("--");
    }
    args.push("--confidence-threshold", String(config.confidenceThreshold));
  }
  if (command.name === "watch" && config.fieldConfirmation !== "auto") {
    if (!args.includes("--")) {
      args.push("--");
    }
    args.push("--field-confirmation", config.fieldConfirmation);
  }
  if (command.name === "viewer") {
    args.push("--", "--port", String(config.viewerPort));
  }
  return args;
}

function spawnDevCommand(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): DevAllChildProcess {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function defaultAutoImportHandoff(input: DevAllAutoImportInput): Promise<DevAllAutoImportResult> {
  const records = await loadSourceRecords(resolve(input.cwd, input.inputPath));
  const result = await writeIntakeHandoff({
    records,
    inbox: input.inbox,
    format: "json",
  });
  return {
    readyPath: result.readyPath,
    recordCount: result.recordCount,
  };
}

function pipeWithPrefix(
  source: Readable | null | undefined,
  destination: NodeJS.WritableStream,
  label: string,
): void {
  if (!source) return;

  let atLineStart = true;
  source.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString();
    for (const char of text) {
      if (atLineStart) {
        destination.write(`[${label}] `);
        atLineStart = false;
      }
      destination.write(char);
      if (char === "\n") {
        atLineStart = true;
      }
    }
  });
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

function defaultRegisterSignalHandler(signal: NodeJS.Signals, handler: () => void): () => void {
  process.once(signal, handler);
  return () => process.off(signal, handler);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runDevAll({ args: process.argv.slice(2) })
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
