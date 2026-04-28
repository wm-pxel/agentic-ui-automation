import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TargetAdapter, TargetAdapterResult, TargetRunContext } from "../../src/adapters/contract.js";
import { FakeAdapter } from "../../src/adapters/fakeAdapter.js";
import { ScriptedAgentDriver } from "../../src/agent/scriptedAgent.js";
import { runWorkflow } from "../../src/orchestrator/runWorkflow.js";

describe("runWorkflow", () => {
  it("runs valid records through adapters and writes audit artifacts", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "workflow-"));
    const result = await runWorkflow({
      runId: "run-orchestrator",
      runsDir,
      records: [
        cleanRecord("demo-001"),
        { ...cleanRecord("demo-missing"), dateOfBirth: "" },
      ],
      adapters: [new FakeAdapter("success")],
      agent: new ScriptedAgentDriver(),
      now: () => "2026-04-28T12:00:00.000Z",
    });

    expect(result.status).toBe("completed_with_exceptions");
    expect(result.preflightExceptions).toBe(1);
    expect(result.targetCounts.fake).toEqual({ succeeded: 1, exception: 0, skipped: 0 });

    const summary = await readFile(join(runsDir, "run-orchestrator", "summary.md"), "utf8");
    expect(summary).toContain("| fake | 1 | 0 | 0 |");

    const exceptionDir = join(runsDir, "run-orchestrator", "exceptions");
    const exceptionFile = (await readdir(exceptionDir)).find((name) => name.startsWith("demo-missing"));
    expect(exceptionFile).toBeDefined();
    const exception = await readFile(join(exceptionDir, exceptionFile!), "utf8");
    expect(exception).toContain("missing_required_field");
  });

  it("marks runs with prepare exceptions as completed with exceptions even with no records", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "workflow-prepare-"));
    const result = await runWorkflow({
      runId: "run-prepare-failed",
      runsDir,
      records: [],
      adapters: [new ThrowingPrepareAdapter()],
      agent: new ScriptedAgentDriver(),
      now: () => "2026-04-28T12:00:00.000Z",
    });

    expect(result.status).toBe("completed_with_exceptions");

    const runMetadata = JSON.parse(await readFile(join(runsDir, "run-prepare-failed", "run.json"), "utf8"));
    expect(runMetadata.status).toBe("completed_with_exceptions");

    const exceptionFiles = await readdir(join(runsDir, "run-prepare-failed", "exceptions"));
    expect(exceptionFiles.length).toBeGreaterThan(0);

    const events = await readFile(join(runsDir, "run-prepare-failed", "events.jsonl"), "utf8");
    expect(events).toContain("environment_not_ready");
  });

  it("converts adapter runRecord throws into target exceptions", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "workflow-run-throw-"));
    const result = await runWorkflow({
      runId: "run-record-throws",
      runsDir,
      records: [cleanRecord("demo-throw")],
      adapters: [new ThrowingRunRecordAdapter()],
      agent: new ScriptedAgentDriver(),
      now: () => "2026-04-28T12:00:00.000Z",
    });

    expect(result.status).toBe("completed_with_exceptions");
    expect(result.targetCounts.fake).toEqual({ succeeded: 0, exception: 1, skipped: 0 });
    await expect(readExceptions(runsDir, "run-record-throws")).resolves.toContain("ui_state_unexpected");
  });

  it("converts malformed adapter results into target exceptions", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "workflow-malformed-"));
    const result = await runWorkflow({
      runId: "run-malformed",
      runsDir,
      records: [cleanRecord("demo-malformed")],
      adapters: [new MalformedResultAdapter()],
      agent: new ScriptedAgentDriver(),
      now: () => "2026-04-28T12:00:00.000Z",
    });

    expect(result.status).toBe("completed_with_exceptions");
    expect(result.targetCounts.fake).toEqual({ succeeded: 0, exception: 1, skipped: 0 });
    await expect(readExceptions(runsDir, "run-malformed")).resolves.toContain("ui_state_unexpected");
  });

  it("records skipped adapter result reasons in completion events", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "workflow-skipped-"));
    const result = await runWorkflow({
      runId: "run-skipped",
      runsDir,
      records: [cleanRecord("demo-skipped")],
      adapters: [new SkippingAdapter()],
      agent: new ScriptedAgentDriver(),
      now: () => "2026-04-28T12:00:00.000Z",
    });

    expect(result.status).toBe("completed");
    expect(result.targetCounts.fake).toEqual({ succeeded: 0, exception: 0, skipped: 1 });

    const events = await readFile(join(runsDir, "run-skipped", "events.jsonl"), "utf8");
    expect(events).toContain("Record did not meet fake target criteria.");
  });

  it("closes ready adapters after successful runs", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "workflow-close-success-"));
    const adapter = new CloseTrackingAdapter();

    await runWorkflow({
      runId: "run-close-success",
      runsDir,
      records: [cleanRecord("demo-close")],
      adapters: [adapter],
      agent: new ScriptedAgentDriver(),
      now: () => "2026-04-28T12:00:00.000Z",
    });

    expect(adapter.closed).toBe(true);
  });

  it("marks close failures as completed with exceptions without crashing the run", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "workflow-close-failure-"));
    const result = await runWorkflow({
      runId: "run-close-failure",
      runsDir,
      records: [cleanRecord("demo-close-failure")],
      adapters: [new ThrowingCloseAdapter()],
      agent: new ScriptedAgentDriver(),
      now: () => "2026-04-28T12:00:00.000Z",
    });

    expect(result.status).toBe("completed_with_exceptions");
    expect(result.targetCounts.fake).toEqual({ succeeded: 1, exception: 0, skipped: 0 });
    await expect(readExceptions(runsDir, "run-close-failure")).resolves.toContain("Close failed.");

    const events = await readFile(join(runsDir, "run-close-failure", "events.jsonl"), "utf8");
    expect(events).toContain("close");
    expect(events).toContain("ui_state_unexpected");
  });

  it("treats audit failures after prepare as orchestrator failures and still closes ready adapters", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "workflow-audit-failure-"));
    const adapter = new AuditSabotagePrepareAdapter(runsDir, "run-audit-failure");

    await expect(
      runWorkflow({
        runId: "run-audit-failure",
        runsDir,
        records: [],
        adapters: [adapter],
        agent: new ScriptedAgentDriver(),
        now: () => "2026-04-28T12:00:00.000Z",
      }),
    ).rejects.toThrow();

    expect(adapter.closed).toBe(true);
    const runMetadata = JSON.parse(await readFile(join(runsDir, "run-audit-failure", "run.json"), "utf8"));
    expect(runMetadata.status).toBe("failed");

    const exceptionFiles = await readdir(join(runsDir, "run-audit-failure", "exceptions"));
    expect(exceptionFiles).toHaveLength(0);
  });
});

class ThrowingPrepareAdapter implements TargetAdapter {
  readonly name = "fake";

  async prepare(): Promise<void> {
    throw new Error("Target application is unavailable.");
  }

  async runRecord(_context: TargetRunContext) {
    return { status: "succeeded" as const };
  }

  async close(): Promise<void> {}
}

class ThrowingRunRecordAdapter implements TargetAdapter {
  readonly name = "fake";

  async prepare(): Promise<void> {}

  async runRecord(_context: TargetRunContext): Promise<TargetAdapterResult> {
    throw new Error("Run record failed.");
  }

  async close(): Promise<void> {}
}

class MalformedResultAdapter implements TargetAdapter {
  readonly name = "fake";

  async prepare(): Promise<void> {}

  async runRecord(_context: TargetRunContext): Promise<TargetAdapterResult> {
    return { status: "unknown" } as never;
  }

  async close(): Promise<void> {}
}

class SkippingAdapter implements TargetAdapter {
  readonly name = "fake";

  async prepare(): Promise<void> {}

  async runRecord(_context: TargetRunContext): Promise<TargetAdapterResult> {
    return { status: "skipped", reason: "Record did not meet fake target criteria." };
  }

  async close(): Promise<void> {}
}

class CloseTrackingAdapter implements TargetAdapter {
  readonly name = "fake";
  closed = false;

  async prepare(): Promise<void> {}

  async runRecord(_context: TargetRunContext): Promise<TargetAdapterResult> {
    return { status: "succeeded" };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class ThrowingCloseAdapter implements TargetAdapter {
  readonly name = "fake";

  async prepare(): Promise<void> {}

  async runRecord(_context: TargetRunContext): Promise<TargetAdapterResult> {
    return { status: "succeeded" };
  }

  async close(): Promise<void> {
    throw new Error("Close failed.");
  }
}

class AuditSabotagePrepareAdapter implements TargetAdapter {
  readonly name = "fake";
  closed = false;

  constructor(
    private readonly runsDir: string,
    private readonly runId: string,
  ) {}

  async prepare(): Promise<void> {
    const eventsPath = join(this.runsDir, this.runId, "events.jsonl");
    await rm(eventsPath);
    await mkdir(eventsPath);
  }

  async runRecord(_context: TargetRunContext): Promise<TargetAdapterResult> {
    return { status: "succeeded" };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function cleanRecord(sourceRecordId: string) {
  return {
    sourceRecordId,
    firstName: "Ava",
    lastName: "Nguyen",
    dateOfBirth: "1987-03-14",
    sexOrGender: "Female",
    phone: "3125550198",
    email: "ava.nguyen@example.test",
    streetAddress: "1200 West Lake Street",
    city: "Chicago",
    state: "IL",
    zip: "60607",
    insurancePayer: "Aetna",
    insuranceMemberId: "AET123456",
    reasonForVisit: "Annual wellness visit",
    preferredContactMethod: "phone",
    sourceFormat: "json" as const,
    rawSourceExcerpt: "Ava Nguyen intake",
  };
}

async function readExceptions(runsDir: string, runId: string): Promise<string> {
  const exceptionDir = join(runsDir, runId, "exceptions");
  const exceptionFiles = await readdir(exceptionDir);
  const contents = await Promise.all(exceptionFiles.map((file) => readFile(join(exceptionDir, file), "utf8")));
  return contents.join("\n");
}
