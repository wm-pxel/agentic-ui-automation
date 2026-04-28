import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import ExcelJS from "exceljs";
import type { NormalizedIntakeRecord } from "../../domain/schema.js";

export const INTAKE_COLUMNS = [
  "Source Record ID",
  "First Name",
  "Last Name",
  "Date of Birth",
  "Sex/Gender",
  "Phone",
  "Email",
  "Street Address",
  "City",
  "State",
  "ZIP",
  "Insurance Payer",
  "Member ID",
  "Group ID",
  "Reason for Visit",
  "Preferred Contact",
  "Notes",
] as const;

export async function ensureWorkbook(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Intake");
  sheet.addRow([...INTAKE_COLUMNS]);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  await workbook.xlsx.writeFile(path);
}

export async function nextExcelRow(path: string): Promise<number> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);

  const sheet = workbook.getWorksheet("Intake");
  if (!sheet) {
    throw new Error("Workbook is missing Intake sheet.");
  }

  return sheet.rowCount + 1;
}

export function recordToTsv(record: NormalizedIntakeRecord): string {
  return [
    record.sourceRecordId,
    record.firstName,
    record.lastName,
    record.dateOfBirth,
    record.sexOrGender,
    record.phone,
    record.email,
    record.streetAddress,
    record.city,
    record.state,
    record.zip,
    record.insurancePayer,
    record.insuranceMemberId,
    record.insuranceGroupId ?? "",
    record.reasonForVisit,
    record.preferredContactMethod,
    record.notes ?? "",
  ]
    .map(sanitizeTsvValue)
    .join("\t");
}

function sanitizeTsvValue(value: string): string {
  return value.replace(/[\t\r\n]/g, " ");
}
