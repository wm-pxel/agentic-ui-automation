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
    await store.writeException("demo-001", {
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

    const exception = await readFile(join(root, "run-test", "exceptions", "demo-001.json"), "utf8");
    expect(exception).toContain("verification_failed");

    const summary = await readFile(join(root, "run-test", "summary.md"), "utf8");
    expect(summary).toBe("# Summary\n");
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
});
