import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportReadyRecords, loadSeedIntakeQueue } from "../../src/desktop/intakeQueue.js";
import { loadSourceRecords } from "../../src/parsing/loadRecords.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("desktop intake queue", () => {
  it("opens with a seeded synthetic queue containing ready and review records", async () => {
    const queue = await loadSeedIntakeQueue();

    expect(queue.sourceName).toBe("intake-seed-records.json");
    expect(queue.items.length).toBeGreaterThanOrEqual(7);
    expect(queue.items.filter((item) => item.exportReady)).toHaveLength(4);
    expect(queue.items.filter((item) => !item.exportReady)).toHaveLength(3);
    expect(queue.items.some((item) => item.lowestConfidence !== undefined && item.lowestConfidence < 0.75)).toBe(true);
    expect(queue.items.some((item) => item.aiIssues.length > 0)).toBe(true);
  });

  it("exports only selected export-ready records as a ready handoff file", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "intake-handoff-"));
    tempDirs.push(inbox);
    const queue = await loadSeedIntakeQueue();

    const result = await exportReadyRecords({
      queue,
      inbox,
      selectedRecordIds: ["seed-complete-001", "seed-missing-dob-005"],
    });

    expect(result.readyPath.endsWith(".ready.csv")).toBe(true);
    expect(result.recordCount).toBe(1);
    await expect(readFile(result.readyPath, "utf8")).resolves.toContain("sourceRecordId,firstName,lastName");
    const exported = await loadSourceRecords(result.readyPath);
    expect(exported).toMatchObject([{ sourceRecordId: "seed-complete-001", firstName: "Ava", lastName: "Nguyen" }]);
  });

  it("fails clearly when no export-ready records are selected", async () => {
    const queue = await loadSeedIntakeQueue();

    await expect(
      exportReadyRecords({
        queue,
        selectedRecordIds: ["seed-missing-dob-005"],
      }),
    ).rejects.toThrow("No export-ready intake records were selected.");
  });
});
