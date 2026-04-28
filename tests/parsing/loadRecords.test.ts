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

  it.each([
    ["primitive", "not a record"],
    ["null", null],
    ["array", []],
  ])("rejects a JSON %s record item with its index", async (_name, invalidRecord) => {
    const dir = await mkdtemp(join(tmpdir(), "intake-json-invalid-"));
    const path = join(dir, "records.json");
    await writeFile(
      path,
      JSON.stringify([{ sourceRecordId: "json-1" }, { sourceRecordId: "json-2" }, invalidRecord]),
    );

    await expect(loadSourceRecords(path)).rejects.toThrow("JSON intake record at index 2 must be an object.");
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

  it("adds fallback CSV record IDs when sourceRecordId is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intake-csv-fallback-"));
    const path = join(dir, "records.csv");
    await writeFile(path, "firstName,lastName\nSam,Rivera\nAva,Nguyen\n");

    const records = await loadSourceRecords(path);

    expect(records).toMatchObject([
      { sourceRecordId: "csv-1", firstName: "Sam", lastName: "Rivera", sourceFormat: "csv" },
      { sourceRecordId: "csv-2", firstName: "Ava", lastName: "Nguyen", sourceFormat: "csv" },
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

  it("loads canonical text labels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intake-text-canonical-"));
    const path = join(dir, "records.txt");
    await writeFile(
      path,
      [
        "Record: text-canonical",
        "First Name: Jordan",
        "Last Name: Patel",
        "Street Address: 10 South Michigan Avenue",
        "Insurance Payer: Aetna",
        "Reason For Visit: Follow-up visit",
        "Preferred Contact Method: phone",
      ].join("\n"),
    );

    const records = await loadSourceRecords(path);

    expect(records[0]).toMatchObject({
      sourceRecordId: "text-canonical",
      firstName: "Jordan",
      lastName: "Patel",
      streetAddress: "10 South Michigan Avenue",
      insurancePayer: "Aetna",
      reasonForVisit: "Follow-up visit",
      preferredContactMethod: "phone",
      sourceFormat: "text",
    });
  });

  it("loads multiple semi-structured text record blocks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intake-text-blocks-"));
    const path = join(dir, "records.txt");
    await writeFile(
      path,
      [
        ["Record: text-1", "Name: Jordan Patel", "Reason: Follow-up visit"].join("\n"),
        ["Record: text-2", "Name: Ava Nguyen", "Reason: Annual wellness visit"].join("\n"),
      ].join("\n\n"),
    );

    const records = await loadSourceRecords(path);

    expect(records).toMatchObject([
      { sourceRecordId: "text-1", firstName: "Jordan", lastName: "Patel" },
      { sourceRecordId: "text-2", firstName: "Ava", lastName: "Nguyen" },
    ]);
  });

  it("rejects unsupported source extensions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intake-unsupported-"));
    const path = join(dir, "records.xml");
    await writeFile(path, "<records />");

    await expect(loadSourceRecords(path)).rejects.toThrow("Unsupported intake source extension");
  });
});
