import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runDevAll, type DevAllChildProcess } from "../../src/dev/runAll.js";

describe("runDevAll", () => {
  it("starts the watcher with interactive field confirmation, desktop app, and viewer npm scripts", async () => {
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
      [
        "npm",
        "run",
        "watch:intake",
        "--",
        "--openmrs-interactive-field-confirmation",
        "--openmrs-field-confidence-threshold",
        "0.9",
      ],
      ["npm", "run", "desktop:dev"],
      ["npm", "run", "viewer"],
    ]);

    spawned[0]?.child.exit(0);
    await expect(running).resolves.toBe(0);
  });

  it("forwards a custom OpenMRS field confidence threshold to the watcher", async () => {
    const spawned: Array<{ command: string; args: string[]; child: FakeChildProcess }> = [];
    const running = runDevAll({
      args: ["--openmrs-field-confidence-threshold", "0.97"],
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
      [
        "npm",
        "run",
        "watch:intake",
        "--",
        "--openmrs-interactive-field-confirmation",
        "--openmrs-field-confidence-threshold",
        "0.97",
      ],
      ["npm", "run", "desktop:dev"],
      ["npm", "run", "viewer"],
    ]);

    spawned[0]?.child.exit(0);
    await expect(running).resolves.toBe(0);
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
