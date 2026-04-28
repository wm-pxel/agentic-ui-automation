import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSourceRecords } from "../../src/parsing/loadRecords.js";

describe("loadSourceRecords", () => {
  it("loads JSON records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intake-json-"));
    const path = join(dir, "records.json");
    await writeFile(path, JSON.stringify([{ sourceRecordId: "json-1", firstName: "Ava" }]));

    const records = await loadSourceRecords(path);

    expect(records).toMatchObject([
      {
        sourceRecordId: "json-1",
        firstName: "Ava",
        sourceFormat: "json",
      },
    ]);
    expect(records[0].rawSourceExcerpt).toContain("json-1");
  });

  it("loads CSV records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intake-csv-"));
    const path = join(dir, "records.csv");
    await writeFile(path, "sourceRecordId,firstName,lastName\ncsv-1,Sam,Rivera\n");

    const records = await loadSourceRecords(path);

    expect(records).toMatchObject([
      {
        sourceRecordId: "csv-1",
        firstName: "Sam",
        lastName: "Rivera",
        sourceFormat: "csv",
      },
    ]);
  });

  it("loads semi-structured text records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intake-text-"));
    const path = join(dir, "records.txt");
    await writeFile(
      path,
      [
        "Record: text-1",
        "Name: Jordan Patel",
        "DOB: 1975-04-22",
        "Phone: 312-555-0123",
        "Reason: Follow-up visit",
      ].join("\n"),
    );

    const records = await loadSourceRecords(path);

    expect(records[0]).toMatchObject({
      sourceRecordId: "text-1",
      firstName: "Jordan",
      lastName: "Patel",
      dateOfBirth: "1975-04-22",
      phone: "312-555-0123",
      reasonForVisit: "Follow-up visit",
      sourceFormat: "text",
    });
  });
});
