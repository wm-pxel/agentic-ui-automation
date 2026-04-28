import type { RawIntakeRecord } from "../domain/schema.js";

const FIELD_ALIASES: Record<string, string> = {
  record: "sourceRecordId",
  id: "sourceRecordId",
  name: "name",
  firstname: "firstName",
  lastname: "lastName",
  dob: "dateOfBirth",
  dateofbirth: "dateOfBirth",
  sex: "sexOrGender",
  gender: "sexOrGender",
  phone: "phone",
  email: "email",
  address: "streetAddress",
  streetaddress: "streetAddress",
  city: "city",
  state: "state",
  zip: "zip",
  insurance: "insurancePayer",
  insurancepayer: "insurancePayer",
  payer: "insurancePayer",
  memberid: "insuranceMemberId",
  groupid: "insuranceGroupId",
  reason: "reasonForVisit",
  reasonforvisit: "reasonForVisit",
  preferredcontact: "preferredContactMethod",
  preferredcontactmethod: "preferredContactMethod",
  notes: "notes",
};

export function parseTextRecords(content: string): RawIntakeRecord[] {
  const blocks = content
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.map((block, index) => {
    const record: Record<string, unknown> = {};
    for (const line of block.split(/\n/g)) {
      const match = /^([^:]+):\s*(.+)$/.exec(line.trim());
      if (!match) continue;
      const key = normalizeKey(match[1]);
      const field = FIELD_ALIASES[key];
      if (!field) continue;
      if (field === "name") {
        const parts = match[2].trim().split(/\s+/);
        record.firstName = parts[0] ?? "";
        record.lastName = parts.slice(1).join(" ");
      } else {
        record[field] = match[2].trim();
      }
    }

    const sourceRecordId = String(record.sourceRecordId ?? `text-${index + 1}`);
    return {
      ...record,
      sourceRecordId,
      sourceFormat: "text",
      rawSourceExcerpt: block,
    };
  });
}

function normalizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}
