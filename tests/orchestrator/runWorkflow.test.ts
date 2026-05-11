import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AiWebTargetResult, AiWebTargetRunContext } from "../../src/targets/aiWebTargetRunner.js";
import type { TargetProfile } from "../../src/targets/profiles.js";
import { runWorkflow } from "../../src/orchestrator/runWorkflow.js";

describe("runWorkflow", () => {
  it("runs valid records through target profiles and writes audit artifacts", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "workflow-"));
    const result = await runWorkflow({
      runId: "run-orchestrator",
      runsDir,
      records: [
        cleanRecord("demo-001"),
        { ...cleanRecord("demo-missing"), dateOfBirth: "" },
      ],
      profiles: [fakeProfile()],
      targetRunner: new FakeTargetRunner(),
      now: () => "2026-04-28T12:00:00.000Z",
    });

    expect(result.status).toBe("completed_with_exceptions");
    expect(result.preflightExceptions).toBe(1);
    expect(result.environmentExceptions).toBe(0);
    expect(result.closeExceptions).toBe(0);
    expect(result.targetCounts.fake).toEqual({ succeeded: 1, exception: 0, skipped: 0 });

    const summary = await readFile(join(runsDir, "run-orchestrator", "summary.md"), "utf8");
    expect(summary).toContain("# Fake Target Workflow Run run-orchestrator");
    expect(summary).toContain("| Fake Target | fake | 1 | 0 | 0 |");
    expect(summary).toContain("Environment exceptions: 0");
    expect(summary).toContain("Close exceptions: 0");

    const executiveSummary = await readFile(join(runsDir, "run-orchestrator", "executive-summary.md"), "utf8");
    expect(executiveSummary).toContain("# Fake Target Executive Summary run-orchestrator");
    expect(executiveSummary).toContain("| Status | completed_with_exceptions |");
    expect(executiveSummary).toContain("| Destination target | Fake Target (fake) |");
    expect(executiveSummary).toContain("| Fake Target | fake | 1 | 0 | 0 |");
    expect(executiveSummary).toContain("| Full summary |");

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
      profiles: [fakeProfile()],
      targetRunner: new ThrowingPrepareTargetRunner(),
      now: () => "2026-04-28T12:00:00.000Z",
    });

    expect(result.status).toBe("completed_with_exceptions");
    expect(result.environmentExceptions).toBe(1);
    expect(result.closeExceptions).toBe(0);

    const runMetadata = JSON.parse(await readFile(join(runsDir, "run-prepare-failed", "run.json"), "utf8"));
    expect(runMetadata.status).toBe("completed_with_exceptions");

    const exceptionFiles = await readdir(join(runsDir, "run-prepare-failed", "exceptions"));
    expect(exceptionFiles.length).toBeGreaterThan(0);

    const events = await readFile(join(runsDir, "run-prepare-failed", "events.jsonl"), "utf8");
    expect(events).toContain("environment_not_ready");
  });

  it("converts target runner runRecord throws into target exceptions", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "workflow-run-throw-"));
    const result = await runWorkflow({
      runId: "run-record-throws",
      runsDir,
      records: [cleanRecord("demo-throw")],
      profiles: [fakeProfile()],
      targetRunner: new ThrowingRunRecordTargetRunner(),
      now: () => "2026-04-28T12:00:00.000Z",
    });

    expect(result.status).toBe("completed_with_exceptions");
    expect(result.targetCounts.fake).toEqual({ succeeded: 0, exception: 1, skipped: 0 });
    await expect(readExceptions(runsDir, "run-record-throws")).resolves.toContain("ui_state_unexpected");
  });

  it("writes report JSON and issue sections for validation and target exceptions", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "workflow-report-"));
    const result = await runWorkflow({
      runId: "run-report",
      runsDir,
      records: [cleanRecord("demo-target-exception"), { ...cleanRecord("demo-validation-exception"), dateOfBirth: "" }],
      profiles: [fakeProfile()],
      targetRunner: new ThrowingRunRecordTargetRunner(),
      now: () => "2026-04-28T12:00:00.000Z",
    });

    expect(result.status).toBe("completed_with_exceptions");

    const report = JSON.parse(await readFile(join(runsDir, "run-report", "report.json"), "utf8"));
    expect(report).toMatchObject({
      runId: "run-report",
      status: "completed_with_exceptions",
      totalRecords: 2,
      counts: {
        preflightExceptions: 1,
        environmentExceptions: 0,
        closeExceptions: 0,
      },
    });
    expect(report.details.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordId: "demo-validation-exception",
          phase: "validation",
          severity: "error",
          exceptionCode: "missing_required_field",
          message: expect.stringContaining("dateOfBirth"),
        }),
        expect.objectContaining({
          recordId: "demo-target-exception",
          target: "fake",
          phase: "target",
          severity: "error",
          exceptionCode: "ui_state_unexpected",
          message: "Run record failed.",
        }),
      ]),
    );
    expect(report.details.recordInputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordId: "demo-target-exception",
          sourceFormat: "json",
          rawInput: expect.objectContaining({
            firstName: "Ava",
            lastName: "Nguyen",
          }),
        }),
        expect.objectContaining({
          recordId: "demo-validation-exception",
          sourceFormat: "json",
        }),
      ]),
    );

    const summary = await readFile(join(runsDir, "run-report", "summary.md"), "utf8");
    expect(summary).toContain("## Issues");
    expect(summary).toContain("| demo-validation-exception |  | validation | missing_required_field |");
    expect(summary).toContain("| demo-target-exception | fake | target | ui_state_unexpected | Run record failed. |");

    const executiveSummary = await readFile(join(runsDir, "run-report", "executive-summary.md"), "utf8");
    expect(executiveSummary).toContain("- 2 issues recorded.");
    expect(executiveSummary).toContain("| demo-validation-exception |  | validation | missing_required_field |");
    expect(executiveSummary).toContain("| demo-target-exception | fake | target | ui_state_unexpected | Run record failed. |");
  });

  it("audits target exceptions for path-unsafe record IDs without failing the run", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "workflow-path-unsafe-record-"));
    const result = await runWorkflow({
      runId: "run-path-unsafe-record",
      runsDir,
      records: [cleanRecord("case/001")],
      profiles: [fakeProfile()],
      targetRunner: new ThrowingRunRecordTargetRunner(),
      now: () => "2026-04-28T12:00:00.000Z",
    });

    expect(result.status).toBe("completed_with_exceptions");
    expect(result.targetCounts.fake).toEqual({ succeeded: 0, exception: 1, skipped: 0 });
    const exceptionFiles = await readdir(join(runsDir, "run-path-unsafe-record", "exceptions"));
    expect(exceptionFiles).toContain("case-001-fake.json");
  });

  it("converts malformed target runner results into target exceptions", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "workflow-malformed-"));
    const result = await runWorkflow({
      runId: "run-malformed",
      runsDir,
      records: [cleanRecord("demo-malformed")],
      profiles: [fakeProfile()],
      targetRunner: new MalformedResultTargetRunner(),
      now: () => "2026-04-28T12:00:00.000Z",
    });

    expect(result.status).toBe("completed_with_exceptions");
    expect(result.targetCounts.fake).toEqual({ succeeded: 0, exception: 1, skipped: 0 });
    await expect(readExceptions(runsDir, "run-malformed")).resolves.toContain("ui_state_unexpected");
  });

  it("records skipped target runner result reasons in completion events", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "workflow-skipped-"));
    const result = await runWorkflow({
      runId: "run-skipped",
      runsDir,
      records: [cleanRecord("demo-skipped")],
      profiles: [fakeProfile()],
      targetRunner: new SkippingTargetRunner(),
      now: () => "2026-04-28T12:00:00.000Z",
    });

    expect(result.status).toBe("completed");
    expect(result.targetCounts.fake).toEqual({ succeeded: 0, exception: 0, skipped: 1 });

    const events = await readFile(join(runsDir, "run-skipped", "events.jsonl"), "utf8");
    expect(events).toContain("Record did not meet fake target criteria.");
  });

  it("runs records for profiles up to the profile concurrency limit", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "workflow-concurrent-target-"));
    const targetRunner = new ConcurrentTargetRunner();
    const result = await runWorkflow({
      runId: "run-concurrent-target",
      runsDir,
      records: [cleanRecord("demo-001"), cleanRecord("demo-002"), cleanRecord("demo-003")],
      profiles: [fakeProfile({ concurrency: 2 })],
      targetRunner,
      now: () => "2026-04-28T12:00:00.000Z",
    });

    expect(result.status).toBe("completed");
    expect(result.targetCounts.fake).toEqual({ succeeded: 3, exception: 0, skipped: 0 });
    expect(targetRunner.maxActive).toBe(2);
  });

  it("runs different target profiles at the same time", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "workflow-concurrent-profiles-"));
    const targetRunner = new ConcurrentTargetRunner();
    const result = await runWorkflow({
      runId: "run-concurrent-profiles",
      runsDir,
      records: [cleanRecord("demo-001")],
      profiles: [
        fakeProfile({ name: "openmrs", displayName: "OpenMRS", concurrency: 1 }),
        fakeProfile({ name: "openkairo", displayName: "OpenKairo", concurrency: 1 }),
      ],
      targetRunner,
      now: () => "2026-04-28T12:00:00.000Z",
    });

    expect(result.status).toBe("completed");
    expect(result.targetCounts.openmrs).toEqual({ succeeded: 1, exception: 0, skipped: 0 });
    expect(result.targetCounts.openkairo).toEqual({ succeeded: 1, exception: 0, skipped: 0 });
    expect(targetRunner.maxActive).toBe(2);
  });

  it("passes all profiles and the planned record count when preparing the target runner", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "workflow-prepare-planned-records-"));
    const targetRunner = new PrepareContextTargetRunner();
    const profiles = [fakeProfile(), fakeProfile({ name: "openkairo", displayName: "OpenKairo" })];

    await runWorkflow({
      runId: "run-prepare-planned-records",
      runsDir,
      records: [cleanRecord("demo-001")],
      profiles,
      targetRunner,
      now: () => "2026-04-28T12:00:00.000Z",
    });

    expect(targetRunner.prepareContexts).toEqual([{ profiles, plannedRecords: 1 }]);
  });

  it("closes ready target runners after successful runs", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "workflow-close-success-"));
    const targetRunner = new CloseTrackingTargetRunner();

    await runWorkflow({
      runId: "run-close-success",
      runsDir,
      records: [cleanRecord("demo-close")],
      profiles: [fakeProfile()],
      targetRunner,
      now: () => "2026-04-28T12:00:00.000Z",
    });

    expect(targetRunner.closed).toBe(true);
  });

  it("marks close failures as completed with exceptions without crashing the run", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "workflow-close-failure-"));
    const result = await runWorkflow({
      runId: "run-close-failure",
      runsDir,
      records: [cleanRecord("demo-close-failure")],
      profiles: [fakeProfile()],
      targetRunner: new ThrowingCloseTargetRunner(),
      now: () => "2026-04-28T12:00:00.000Z",
    });

    expect(result.status).toBe("completed_with_exceptions");
    expect(result.closeExceptions).toBe(1);
    expect(result.targetCounts.fake).toEqual({ succeeded: 1, exception: 0, skipped: 0 });
    await expect(readExceptions(runsDir, "run-close-failure")).resolves.toContain("Close failed.");

    const events = await readFile(join(runsDir, "run-close-failure", "events.jsonl"), "utf8");
    expect(events).toContain("close");
    expect(events).toContain("ui_state_unexpected");
  });

  it("closes the target runner and reports close failures after prepare throws", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "workflow-prepare-close-failure-"));
    const result = await runWorkflow({
      runId: "run-prepare-close-failure",
      runsDir,
      records: [],
      profiles: [fakeProfile()],
      targetRunner: new ThrowingPrepareAndCloseTargetRunner(),
      now: () => "2026-04-28T12:00:00.000Z",
    });

    expect(result.status).toBe("completed_with_exceptions");
    expect(result.environmentExceptions).toBe(1);
    expect(result.closeExceptions).toBe(1);
    await expect(readExceptions(runsDir, "run-prepare-close-failure")).resolves.toContain("Close failed.");

    const events = await readFile(join(runsDir, "run-prepare-close-failure", "events.jsonl"), "utf8");
    expect(events).toContain("prepare");
    expect(events).toContain("close");
  });

  it("treats audit failures after prepare as orchestrator failures and still closes ready target runners", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "workflow-audit-failure-"));
    const targetRunner = new AuditSabotagePrepareTargetRunner(runsDir, "run-audit-failure");

    await expect(
      runWorkflow({
        runId: "run-audit-failure",
        runsDir,
        records: [],
        profiles: [fakeProfile()],
        targetRunner,
        now: () => "2026-04-28T12:00:00.000Z",
      }),
    ).rejects.toThrow();

    expect(targetRunner.closed).toBe(true);
    const runMetadata = JSON.parse(await readFile(join(runsDir, "run-audit-failure", "run.json"), "utf8"));
    expect(runMetadata.status).toBe("failed");

    const exceptionFiles = await readdir(join(runsDir, "run-audit-failure", "exceptions"));
    expect(exceptionFiles).toHaveLength(0);
  });

  it("writes a failed report when the workflow fails after initial audit artifacts start", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "workflow-failed-report-"));
    const targetRunner = new AuditSabotagePrepareTargetRunner(runsDir, "run-failed-report");

    await expect(
      runWorkflow({
        runId: "run-failed-report",
        runsDir,
        records: [],
        profiles: [fakeProfile()],
        targetRunner,
        now: () => "2026-04-28T12:00:00.000Z",
      }),
    ).rejects.toThrow();

    const report = JSON.parse(await readFile(join(runsDir, "run-failed-report", "report.json"), "utf8"));
    expect(report.status).toBe("failed");
    expect(report.details.issues).toContainEqual(
      expect.objectContaining({
        phase: "run",
        exceptionCode: "ui_state_unexpected",
      }),
    );

    const executiveSummary = await readFile(join(runsDir, "run-failed-report", "executive-summary.md"), "utf8");
    expect(executiveSummary).toContain("| Status | failed |");
    expect(executiveSummary).toContain("|  |  | run | ui_state_unexpected |");
  });
});

class FakeTargetRunner {
  async prepare(_profiles: TargetProfile[], _plannedRecords: number): Promise<void> {}

  async runRecord(context: AiWebTargetRunContext): Promise<AiWebTargetResult> {
    await context.audit.writeEvent({
      recordId: context.record.sourceRecordId,
      target: context.profile.name,
      phase: "target",
      actionType: "inspect",
      rationale: "Fake target runner inspected the normalized intake record.",
      result: "inspect complete",
    });
    return {
      status: "succeeded",
      targetRecordId: `${context.profile.name}-${context.record.sourceRecordId}`,
    };
  }

  async close(): Promise<void> {}
}

class ThrowingPrepareTargetRunner extends FakeTargetRunner {
  override async prepare(_profiles: TargetProfile[], _plannedRecords: number): Promise<void> {
    throw new Error("Target application is unavailable.");
  }
}

class ThrowingRunRecordTargetRunner extends FakeTargetRunner {
  override async runRecord(_context: AiWebTargetRunContext): Promise<AiWebTargetResult> {
    throw new Error("Run record failed.");
  }
}

class MalformedResultTargetRunner extends FakeTargetRunner {
  override async runRecord(_context: AiWebTargetRunContext): Promise<AiWebTargetResult> {
    return { status: "unknown" } as never;
  }
}

class SkippingTargetRunner extends FakeTargetRunner {
  override async runRecord(_context: AiWebTargetRunContext): Promise<AiWebTargetResult> {
    return { status: "skipped", reason: "Record did not meet fake target criteria." };
  }
}

class ConcurrentTargetRunner extends FakeTargetRunner {
  active = 0;
  maxActive = 0;

  override async runRecord(_context: AiWebTargetRunContext): Promise<AiWebTargetResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await sleep(20);
    this.active -= 1;
    return { status: "succeeded" };
  }

}

class PrepareContextTargetRunner extends FakeTargetRunner {
  readonly prepareContexts: Array<{ profiles: TargetProfile[]; plannedRecords: number }> = [];

  override async prepare(profiles: TargetProfile[], plannedRecords: number): Promise<void> {
    this.prepareContexts.push({ profiles, plannedRecords });
  }
}

class CloseTrackingTargetRunner extends FakeTargetRunner {
  closed = false;

  override async close(): Promise<void> {
    this.closed = true;
  }
}

class ThrowingCloseTargetRunner extends FakeTargetRunner {
  override async close(): Promise<void> {
    throw new Error("Close failed.");
  }
}

class ThrowingPrepareAndCloseTargetRunner extends ThrowingPrepareTargetRunner {
  override async close(): Promise<void> {
    throw new Error("Close failed.");
  }
}

class AuditSabotagePrepareTargetRunner extends FakeTargetRunner {
  closed = false;

  constructor(
    private readonly runsDir: string,
    private readonly runId: string,
  ) {
    super();
  }

  override async prepare(_profiles: TargetProfile[], _plannedRecords: number): Promise<void> {
    const eventsPath = join(this.runsDir, this.runId, "events.jsonl");
    await rm(eventsPath);
    await mkdir(eventsPath);
  }

  override async close(): Promise<void> {
    this.closed = true;
  }
}

function fakeProfile(overrides: Partial<TargetProfile> = {}): TargetProfile {
  return {
    name: "fake",
    displayName: "Fake Target",
    baseUrl: "local://dry-run",
    credentials: { username: "", password: "" },
    task: "Validate orchestration and audit output without entering an EMR.",
    workflowHints: [],
    successCriteria: ["The normalized record is accepted by the dry-run target."],
    forbiddenActions: ["Do not use real patient data."],
    concurrency: 1,
    ...overrides,
  };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
