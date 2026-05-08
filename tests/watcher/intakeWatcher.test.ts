import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeIntakeHandoff } from "../../src/handoff/intakeHandoff.js";
import type { AiWebTargetResult, AiWebTargetRunContext } from "../../src/targets/aiWebTargetRunner.js";
import type { TargetProfile } from "../../src/targets/profiles.js";
import { processReadyIntakeFiles } from "../../src/watcher/intakeWatcher.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("processReadyIntakeFiles", () => {
  it("processes ready handoff files once and preserves audit artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "intake-watch-"));
    tempDirs.push(root);
    const inbox = join(root, "inbox");
    const runsDir = join(root, "runs");
    await writeIntakeHandoff({
      inbox,
      records: [
        {
          sourceRecordId: "watch-001",
          firstName: "Ava",
          lastName: "Nguyen",
          dateOfBirth: "1987-03-14",
          sexOrGender: "female",
          phone: "312-555-0198",
          email: "ava.nguyen@example.test",
          streetAddress: "1200 West Lake Street",
          city: "Chicago",
          state: "IL",
          zip: "60607",
          insurancePayer: "Aetna",
          insuranceMemberId: "AET123456",
          reasonForVisit: "Annual wellness visit",
          preferredContactMethod: "phone",
          sourceFormat: "json",
          rawSourceExcerpt: "watch-001",
        },
      ],
    });

    const results = await processReadyIntakeFiles({
      inbox,
      runsDir,
      targets: ["fake"],
      buildProfiles: () => [fakeProfile()],
      buildTargetRunner: () => new FakeTargetRunner(),
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "processed" });
    if (results[0].status !== "processed") throw new Error("expected processed result");
    expect(await readdir(inbox)).not.toContain(expect.stringContaining(".ready.json"));
    expect(await readdir(join(inbox, "processed"))).toEqual([`${results[0].run.runId}.csv`]);
    await expect(readJson(join(runsDir, results[0].run.runId, "run.json"))).resolves.toMatchObject({
      status: "completed",
      targetCounts: {
        fake: {
          succeeded: 1,
        },
      },
    });
    await expect(readFile(join(runsDir, results[0].run.runId, "events.jsonl"), "utf8")).resolves.toContain(
      "workflow run started",
    );
  });

  it("ignores non-ready files", async () => {
    const root = await mkdtemp(join(tmpdir(), "intake-watch-idle-"));
    tempDirs.push(root);
    const inbox = join(root, "inbox");
    await mkdir(inbox, { recursive: true });
    await writeFile(join(inbox, "not-ready.pending"), "[]\n");

    const results = await processReadyIntakeFiles({
      inbox,
      runsDir: join(root, "runs"),
      targets: ["fake"],
      buildProfiles: () => [fakeProfile()],
      buildTargetRunner: () => new FakeTargetRunner(),
    });

    expect(results).toEqual([]);
    expect(await readdir(inbox)).toContain("not-ready.pending");
  });

  it("moves invalid ready files to failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "intake-watch-failed-"));
    tempDirs.push(root);
    const inbox = join(root, "inbox");
    await mkdir(inbox, { recursive: true });
    await writeFile(join(inbox, "bad.ready.json"), "{bad json");

    const results = await processReadyIntakeFiles({
      inbox,
      runsDir: join(root, "runs"),
      targets: ["fake"],
      buildProfiles: () => [fakeProfile()],
      buildTargetRunner: () => new FakeTargetRunner(),
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "failed" });
    expect(await readdir(join(inbox, "failed"))).toHaveLength(1);
  });
});

class FakeTargetRunner {
  async prepare(_profiles: TargetProfile[], _plannedRecords: number): Promise<void> {}

  async runRecord(_context: AiWebTargetRunContext): Promise<AiWebTargetResult> {
    return { status: "succeeded" };
  }

  async close(): Promise<void> {}
}

function fakeProfile(): TargetProfile {
  return {
    name: "fake",
    displayName: "Fake Target",
    baseUrl: "local://dry-run",
    credentials: { username: "", password: "" },
    task: "Validate orchestration and audit output without entering an EMR.",
    successCriteria: ["The normalized record is accepted by the dry-run target."],
    forbiddenActions: ["Do not use real patient data."],
    concurrency: 1,
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}
