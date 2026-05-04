import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

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

type DevAllCommand = {
  name: string;
  script: string;
  args?: (config: DevAllConfig) => string[];
};

type DevAllOptions = {
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  spawnProcess?: DevAllSpawnProcess;
  registerSignalHandler?: (signal: NodeJS.Signals, handler: () => void) => () => void;
};

type DevAllConfig = {
  agent?: AgentDriver;
  openMrsInteractiveFieldConfirmation: boolean;
  openMrsFieldConfidenceThreshold: string;
};

type AgentDriver = "scripted" | "openai";

const devAllCommands: DevAllCommand[] = [
  {
    name: "watch",
    script: "watch:intake",
    args: (config) => [
      ...(config.openMrsInteractiveFieldConfirmation ? ["--openmrs-interactive-field-confirmation"] : []),
      "--openmrs-field-confidence-threshold",
      config.openMrsFieldConfidenceThreshold,
      ...(config.agent ? ["--agent", config.agent] : []),
    ],
  },
  { name: "desktop", script: "desktop:dev" },
  { name: "viewer", script: "viewer" },
];

export async function runDevAll(options: DevAllOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const spawnProcess = options.spawnProcess ?? spawnDevCommand;
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
  });
}

function parseDevAllArgs(args: string[]): DevAllConfig {
  let agent: AgentDriver | undefined;
  let openMrsInteractiveFieldConfirmation = true;
  let openMrsFieldConfidenceThreshold = "0.9";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--agent") {
      const value = args[index + 1];
      validateAgentDriver(value);
      agent = value;
      index += 1;
      continue;
    }

    const agentPrefix = "--agent=";
    if (arg.startsWith(agentPrefix)) {
      const value = arg.slice(agentPrefix.length);
      validateAgentDriver(value);
      agent = value;
      continue;
    }

    if (arg === "--openmrs-interactive-field-confirmation") {
      openMrsInteractiveFieldConfirmation = true;
      continue;
    }
    if (arg === "--no-openmrs-interactive-field-confirmation") {
      openMrsInteractiveFieldConfirmation = false;
      continue;
    }

    if (arg === "--openmrs-field-confidence-threshold") {
      const value = args[index + 1];
      validateOpenMrsFieldConfidenceThreshold(value);
      openMrsFieldConfidenceThreshold = value;
      index += 1;
      continue;
    }

    const prefix = "--openmrs-field-confidence-threshold=";
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length);
      validateOpenMrsFieldConfidenceThreshold(value);
      openMrsFieldConfidenceThreshold = value;
      continue;
    }

    throw new Error(`Unknown dev:all option: ${arg}`);
  }

  return { agent, openMrsInteractiveFieldConfirmation, openMrsFieldConfidenceThreshold };
}

function validateAgentDriver(value: string | undefined): asserts value is AgentDriver {
  if (value !== "scripted" && value !== "openai") {
    throw new Error("--agent must be either scripted or openai.");
  }
}

function validateOpenMrsFieldConfidenceThreshold(value: string | undefined): asserts value is string {
  const parsed = value === undefined || value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("--openmrs-field-confidence-threshold must be a number from 0 through 1.");
  }
}

function npmRunArgs(command: DevAllCommand, config: DevAllConfig): string[] {
  const args = command.args?.(config) ?? [];
  return args.length > 0 ? ["run", command.script, "--", ...args] : ["run", command.script];
}

function spawnDevCommand(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): DevAllChildProcess {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
