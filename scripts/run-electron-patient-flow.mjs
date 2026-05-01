#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const appMain = resolve("dist/src/desktop/main.js");

if (!existsSync(appMain)) {
  console.error("Electron desktop build not found. Run `npm run desktop:build` first.");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const patient = {
  firstName: "Computer",
  lastName: `Use ${stamp}`,
  dateOfBirth: "1992-09-23",
  sexOrGender: "female",
  phone: `312555${stamp.slice(-4)}`,
  email: `computer.use.${stamp}@example.test`,
  streetAddress: "500 West Monroe Street",
  city: "Chicago",
  state: "IL",
  zip: "60661",
  insurancePayer: "Aetna",
  insuranceMemberId: `CU${stamp.slice(-8)}`,
  insuranceGroupId: "GRP4",
  reasonForVisit: "New patient wellness visit",
  preferredContactMethod: "email",
  notes: "Created by the scripted Electron patient flow.",
};

const app = await electron.launch({ args: [appMain] });

try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => document.getElementById("total-count")?.textContent !== "0");

  const selectAll = page.locator("#select-all");
  if (await selectAll.isChecked()) {
    await selectAll.click();
  }

  await page.getByRole("button", { name: "New Patient" }).click();
  await page.locator("#patient-dialog").waitFor({ state: "visible" });

  await page.locator('input[name="firstName"]').fill(patient.firstName);
  await page.locator('input[name="lastName"]').fill(patient.lastName);
  await page.locator('input[name="dateOfBirth"]').fill(patient.dateOfBirth);
  await page.locator('select[name="sexOrGender"]').selectOption(patient.sexOrGender);
  await page.locator('input[name="phone"]').fill(patient.phone);
  await page.locator('input[name="email"]').fill(patient.email);
  await page.locator('input[name="streetAddress"]').fill(patient.streetAddress);
  await page.locator('input[name="city"]').fill(patient.city);
  await page.locator('input[name="state"]').fill(patient.state);
  await page.locator('input[name="zip"]').fill(patient.zip);
  await page.locator('input[name="insurancePayer"]').fill(patient.insurancePayer);
  await page.locator('input[name="insuranceMemberId"]').fill(patient.insuranceMemberId);
  await page.locator('input[name="insuranceGroupId"]').fill(patient.insuranceGroupId);
  await page.locator('select[name="preferredContactMethod"]').selectOption(patient.preferredContactMethod);
  await page.locator('input[name="reasonForVisit"]').fill(patient.reasonForVisit);
  await page.locator('textarea[name="notes"]').fill(patient.notes);

  await page.getByRole("button", { name: "Add Patient" }).click();
  await page.locator("#detail-name").filter({ hasText: `${patient.firstName} ${patient.lastName}` }).waitFor();
  await page.locator("#selected-count").filter({ hasText: "1" }).waitFor();

  await page.getByRole("button", { name: "Export Selected" }).click();
  const handoffLabel = page.locator("#handoff-label");
  await handoffLabel.filter({ hasText: "Exported 1 records to " }).waitFor();
  const label = (await handoffLabel.textContent()) ?? "";
  const readyPath = label.replace(/^Exported 1 records to /, "").trim();

  if (!readyPath || readyPath === label) {
    throw new Error(`Could not parse exported ready path from status text: ${label}`);
  }

  console.log(JSON.stringify({ patient, readyPath }, null, 2));
} finally {
  await app.close();
}
