import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { RawIntakeRecord } from "../domain/schema.js";
import { parseCsvRecords, parseJsonRecords } from "./jsonCsvParser.js";
import { parseTextRecords } from "./textParser.js";

export async function loadSourceRecords(path: string): Promise<RawIntakeRecord[]> {
  const content = await readFile(path, "utf8");
  const extension = extname(path).toLowerCase();

  if (extension === ".json") return parseJsonRecords(content);
  if (extension === ".csv") return parseCsvRecords(content);
  if (extension === ".txt") return parseTextRecords(content);

  throw new Error(`Unsupported intake source extension: ${extension}`);
}
