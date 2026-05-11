import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runDevAll, type DevAllChildProcess } from "../../src/dev/runAll.js";

describe("runDevAll", () => {
  it("starts the watcher, desktop app, and viewer npm scripts", async () => {
    const spawned: Array<{ command: string; args: string[]; child: FakeChildProcess }> = [];
    const running = runDevAll({
      cwd: "/repo",
      spawnProcess: (command, args) => {
        const child = new FakeChildProcess();
        spawned.push({ command, args, child });
        return child;
      },
      stdout: writable(),
      stderr: writable(),
    });

    expect(spawned.map(({ command, args }) => [command, ...args])).toEqual([
      ["npm", "run", "watch:intake"],
      ["npm", "run", "desktop:dev"],
      ["npm", "run", "viewer", "--", "--port", "4173"],
    ]);

    spawned[0]?.child.exit(0);
    await expect(running).resolves.toBe(0);
  });

  it("passes target overrides to the watcher while starting the full stack", async () => {
    const spawned: Array<{ command: string; args: string[]; child: FakeChildProcess }> = [];
    const running = runDevAll({
      args: ["--targets", "openkairo"],
      cwd: "/repo",
      spawnProcess: (command, args) => {
        const child = new FakeChildProcess();
        spawned.push({ command, args, child });
        return child;
      },
      stdout: writable(),
      stderr: writable(),
    });

    expect(spawned.map(({ command, args }) => [command, ...args])).toEqual([
      ["npm", "run", "watch:intake", "--", "--targets", "openkairo"],
      ["npm", "run", "desktop:dev"],
      ["npm", "run", "viewer", "--", "--port", "4173"],
    ]);

    spawned[0]?.child.exit(0);
    await expect(running).resolves.toBe(0);
  });

  it("passes confidence threshold overrides to the watcher", async () => {
    const spawned: Array<{ command: string; args: string[]; child: FakeChildProcess }> = [];
    const running = runDevAll({
      args: ["--targets", "openmrs", "--confidence-threshold", ".99"],
      cwd: "/repo",
      spawnProcess: (command, args) => {
        const child = new FakeChildProcess();
        spawned.push({ command, args, child });
        return child;
      },
      stdout: writable(),
      stderr: writable(),
    });

    expect(spawned.map(({ command, args }) => [command, ...args])).toEqual([
      ["npm", "run", "watch:intake", "--", "--targets", "openmrs", "--confidence-threshold", "0.99"],
      ["npm", "run", "desktop:dev"],
      ["npm", "run", "viewer", "--", "--port", "4173"],
    ]);

    spawned[0]?.child.exit(0);
    await expect(running).resolves.toBe(0);
  });

  it("rejects invalid confidence thresholds before starting services", async () => {
    const spawned: Array<{ command: string; args: string[]; child: FakeChildProcess }> = [];

    await expect(
      runDevAll({
        args: ["--confidence-threshold", "1.1"],
        cwd: "/repo",
        spawnProcess: (command, args) => {
          const child = new FakeChildProcess();
          spawned.push({ command, args, child });
          return child;
        },
        stdout: writable(),
        stderr: writable(),
      }),
    ).rejects.toThrow("--confidence-threshold must be a number from 0 through 1.");

    expect(spawned).toEqual([]);
  });

  it("auto-imports the demo intake JSON after starting the full stack when requested", async () => {
    const spawned: Array<{ command: string; args: string[]; child: FakeChildProcess }> = [];
    const autoImports: Array<{ cwd: string; inputPath: string }> = [];
    const running = runDevAll({
      args: ["--targets", "openkairo", "--intake-trigger", "auto-import"],
      cwd: "/repo",
      autoImportHandoff: async (input) => {
        autoImports.push({ cwd: input.cwd, inputPath: input.inputPath });
        return { readyPath: "/home/user/Downloads/agentic-ui-intake/intake-export.ready.json", recordCount: 6 };
      },
      spawnProcess: (command, args) => {
        const child = new FakeChildProcess();
        spawned.push({ command, args, child });
        return child;
      },
      stdout: writable(),
      stderr: writable(),
    });

    await Promise.resolve();

    expect(spawned.map(({ command, args }) => [command, ...args])).toEqual([
      ["npm", "run", "watch:intake", "--", "--targets", "openkairo"],
      ["npm", "run", "desktop:dev"],
      ["npm", "run", "viewer", "--", "--port", "4173"],
    ]);
    expect(autoImports).toEqual([{ cwd: "/repo", inputPath: "data/demo/intake-records-normalized.json" }]);

    spawned[0]?.child.exit(0);
    await expect(running).resolves.toBe(0);
  });

  it("lets auto-import mode use a custom intake JSON path", async () => {
    const autoImports: Array<{ inputPath: string }> = [];
    const spawned: FakeChildProcess[] = [];
    const running = runDevAll({
      args: ["--intake-trigger=auto-import", "--auto-import-input", "data/demo/custom.json"],
      cwd: "/repo",
      autoImportHandoff: async (input) => {
        autoImports.push({ inputPath: input.inputPath });
        return { readyPath: "/tmp/intake.ready.json", recordCount: 1 };
      },
      spawnProcess: () => {
        const child = new FakeChildProcess();
        spawned.push(child);
        return child;
      },
      stdout: writable(),
      stderr: writable(),
    });

    await Promise.resolve();

    expect(autoImports).toEqual([{ inputPath: "data/demo/custom.json" }]);
    spawned[0]?.exit(0);
    await expect(running).resolves.toBe(0);
  });

  it("lets callers choose a random or custom viewer port", async () => {
    const spawned: Array<{ command: string; args: string[]; child: FakeChildProcess }> = [];
    const running = runDevAll({
      args: ["--viewer-port", "0"],
      cwd: "/repo",
      spawnProcess: (command, args) => {
        const child = new FakeChildProcess();
        spawned.push({ command, args, child });
        return child;
      },
      stdout: writable(),
      stderr: writable(),
    });

    expect(spawned.map(({ command, args }) => [command, ...args])).toEqual([
      ["npm", "run", "watch:intake"],
      ["npm", "run", "desktop:dev"],
      ["npm", "run", "viewer", "--", "--port", "0"],
    ]);

    spawned[0]?.child.exit(0);
    await expect(running).resolves.toBe(0);
  });

  it("rejects unknown intake trigger modes before starting services", async () => {
    const spawned: Array<{ command: string; args: string[]; child: FakeChildProcess }> = [];

    await expect(
      runDevAll({
        args: ["--intake-trigger", "immediate"],
        cwd: "/repo",
        spawnProcess: (command, args) => {
          const child = new FakeChildProcess();
          spawned.push({ command, args, child });
          return child;
        },
        stdout: writable(),
        stderr: writable(),
      }),
    ).rejects.toThrow("--intake-trigger must be either 'watcher' or 'auto-import'.");

    expect(spawned).toEqual([]);
  });

  it("rejects invalid viewer ports before starting services", async () => {
    const spawned: Array<{ command: string; args: string[]; child: FakeChildProcess }> = [];

    await expect(
      runDevAll({
        args: ["--viewer-port", "-1"],
        cwd: "/repo",
        spawnProcess: (command, args) => {
          const child = new FakeChildProcess();
          spawned.push({ command, args, child });
          return child;
        },
        stdout: writable(),
        stderr: writable(),
      }),
    ).rejects.toThrow("--viewer-port must be zero or a positive integer.");

    expect(spawned).toEqual([]);
  });

  it("rejects removed agent options before starting services", async () => {
    const spawned: Array<{ command: string; args: string[]; child: FakeChildProcess }> = [];

    await expect(
      runDevAll({
        args: ["--agent", "openai"],
        cwd: "/repo",
        spawnProcess: (command, args) => {
          const child = new FakeChildProcess();
          spawned.push({ command, args, child });
          return child;
        },
        stdout: writable(),
        stderr: writable(),
      }),
    ).rejects.toThrow("Unknown dev:all option: --agent");

    expect(spawned).toEqual([]);
  });

  it("stops the remaining dev services when one command fails", async () => {
    const spawned: FakeChildProcess[] = [];
    const running = runDevAll({
      cwd: "/repo",
      spawnProcess: () => {
        const child = new FakeChildProcess();
        spawned.push(child);
        return child;
      },
      stdout: writable(),
      stderr: writable(),
    });

    spawned[1]?.exit(1);

    await expect(running).resolves.toBe(1);
    expect(spawned[0]?.killedWith).toEqual(["SIGTERM"]);
    expect(spawned[2]?.killedWith).toEqual(["SIGTERM"]);
  });

  it("stops all dev services when interrupted", async () => {
    const spawned: FakeChildProcess[] = [];
    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    const running = runDevAll({
      cwd: "/repo",
      registerSignalHandler: (signal, handler) => {
        signalHandlers.set(signal, handler);
        return () => signalHandlers.delete(signal);
      },
      spawnProcess: () => {
        const child = new FakeChildProcess();
        spawned.push(child);
        return child;
      },
      stdout: writable(),
      stderr: writable(),
    });

    signalHandlers.get("SIGINT")?.();

    await expect(running).resolves.toBe(130);
    expect(spawned.map((child) => child.killedWith)).toEqual([["SIGINT"], ["SIGINT"], ["SIGINT"]]);
    expect(signalHandlers.size).toBe(0);
  });
});

class FakeChildProcess extends EventEmitter implements DevAllChildProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killedWith: string[] = [];
  private exited = false;

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killedWith.push(signal);
    this.exit(null, signal);
    return true;
  }
}

function writable(): NodeJS.WritableStream {
  return new PassThrough();
}
