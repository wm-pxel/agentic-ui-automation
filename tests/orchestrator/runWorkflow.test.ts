import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TargetAdapter, TargetRunContext } from "../../src/adapters/contract.js";
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
