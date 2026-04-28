import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAuditStore } from "../../src/audit/auditStore.js";
import { renderSummary } from "../../src/audit/summary.js";

describe("FileAuditStore", () => {
  it("writes events, screenshots, exceptions, and summary artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-"));
    const store = await FileAuditStore.create({
      runsDir: root,
      runId: "run-test",
      now: () => "2026-04-28T12:00:00.000Z",
    });

    await store.writeEvent({
      phase: "adapter",
      actionType: "click",
      recordId: "demo-001",
      target: "fake",
      result: "clicked Save",
    });
    const screenshotPath = await store.writeScreenshot("demo-001", "fake", "after-save", Buffer.from("png"));
    const exceptionPath = await store.writeException("demo-001", {
      code: "verification_failed",
      severity: "error",
      message: "Could not verify save.",
      suggestedRemediation: "Review target screen.",
    });
    await store.writeSummary("# Summary\n");

    expect(screenshotPath).toContain("screenshots/demo-001/fake/after-save.png");

    const events = await readFile(join(root, "run-test", "events.jsonl"), "utf8");
    expect(events).toContain("\"actionType\":\"click\"");
    expect(events).toContain("\"timestamp\":\"2026-04-28T12:00:00.000Z\"");

    const exception = await readFile(join(root, "run-test", exceptionPath), "utf8");
    expect(exception).toContain("verification_failed");

    const summary = await readFile(join(root, "run-test", "summary.md"), "utf8");
    expect(summary).toBe("# Summary\n");
  });

  it("writes parseable JSONL events with the expected fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-jsonl-"));
    const store = await FileAuditStore.create({
      runsDir: root,
      runId: "run-test",
      now: () => "2026-04-28T12:00:00.000Z",
    });

    await store.writeEvent({
      phase: "adapter",
      actionType: "verify",
      recordId: "demo-001",
      target: "fake",
      result: "verified save",
      exceptionCode: "verification_failed",
    });

    const events = await readFile(join(root, "run-test", "events.jsonl"), "utf8");
    const lines = events.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      timestamp: "2026-04-28T12:00:00.000Z",
      runId: "run-test",
      phase: "adapter",
      actionType: "verify",
      recordId: "demo-001",
      target: "fake",
      result: "verified save",
      exceptionCode: "verification_failed",
    });
  });

  it("rejects traversal run IDs and nested input artifact names", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-paths-"));

    await expect(FileAuditStore.create({ runsDir: root, runId: "../escape" })).rejects.toThrow("runId");
    await expect(FileAuditStore.create({ runsDir: root, runId: "///" })).rejects.toThrow("runId");

    const store = await FileAuditStore.create({ runsDir: root, runId: "run-test" });

    await expect(store.writeInputArtifact("../x", "bad")).rejects.toThrow("input artifact name");
    await expect(store.writeInputArtifact("folder/x", "bad")).rejects.toThrow("input artifact name");
  });

  it("keeps repeated screenshots with unique paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-screenshots-"));
    const store = await FileAuditStore.create({ runsDir: root, runId: "run-test" });

    const first = await store.writeScreenshot("demo-001", "fake", "after-save", Buffer.from("one"));
    const second = await store.writeScreenshot("demo-001", "fake", "after-save", Buffer.from("two"));

    expect(first).not.toBe(second);
    expect(first).toContain("screenshots/demo-001/fake/after-save");
    expect(second).toContain("screenshots/demo-001/fake/after-save");
    await expect(readFile(join(root, "run-test", first), "utf8")).resolves.toBe("one");
    await expect(readFile(join(root, "run-test", second), "utf8")).resolves.toBe("two");
  });

  it("keeps repeated exceptions with unique paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-exceptions-"));
    const store = await FileAuditStore.create({ runsDir: root, runId: "run-test" });

    const first = await store.writeException("demo-001", {
      code: "verification_failed",
      severity: "error",
      message: "First failure.",
    });
    const second = await store.writeException("demo-001", {
      code: "environment_not_ready",
      severity: "error",
      message: "Second failure.",
    });

    expect(first).not.toBe(second);
    await expect(readFile(join(root, "run-test", first), "utf8")).resolves.toContain("First failure.");
    await expect(readFile(join(root, "run-test", second), "utf8")).resolves.toContain("Second failure.");
  });

  it("validates audit events at runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-events-"));
    const store = await FileAuditStore.create({ runsDir: root, runId: "run-test" });

    await expect(
      store.writeEvent({
        phase: "adapter",
        actionType: "verify",
        result: "invalid exception code",
        exceptionCode: "not-a-code" as never,
      }),
    ).rejects.toThrow();
  });

  it("renders status counts in Markdown", () => {
    const summary = renderSummary({
      runId: "run-test",
      totalRecords: 2,
      targetCounts: {
        openemr: { succeeded: 1, exception: 1, skipped: 0 },
        excel: { succeeded: 2, exception: 0, skipped: 0 },
      },
      preflightExceptions: 1,
    });

    expect(summary).toContain("# Workflow Run run-test");
    expect(summary).toContain("| openemr | 1 | 1 | 0 |");
    expect(summary).toContain("Preflight exceptions: 1");
  });

  it("renders target rows in deterministic order", () => {
    const summary = renderSummary({
      runId: "run-test",
      totalRecords: 3,
      targetCounts: {
        fake: { succeeded: 3, exception: 0, skipped: 0 },
        excel: { succeeded: 2, exception: 1, skipped: 0 },
        openemr: { succeeded: 1, exception: 2, skipped: 0 },
      },
      preflightExceptions: 0,
    });

    expect(summary.indexOf("| openemr | 1 | 2 | 0 |")).toBeLessThan(summary.indexOf("| excel | 2 | 1 | 0 |"));
    expect(summary.indexOf("| excel | 2 | 1 | 0 |")).toBeLessThan(summary.indexOf("| fake | 3 | 0 | 0 |"));
  });
});
