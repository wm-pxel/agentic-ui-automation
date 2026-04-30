import { chromium, type Browser } from "@playwright/test";
import type { TargetAdapter, TargetAdapterResult, TargetRunContext } from "../../adapters/contract.js";
import type { ValidationException } from "../../domain/schema.js";
import {
  OPENMRS_CONTACT_SECTION_CANDIDATES,
  OPENMRS_CONFIRM_CREATE_CANDIDATES,
  OPENMRS_LOGIN_SELECTORS,
  OPENMRS_NEW_PATIENT_CANDIDATES,
  OPENMRS_NEXT_CANDIDATES,
  OPENMRS_PATIENT_DASHBOARD_CONTACT_CANDIDATES,
  OPENMRS_PATIENT_MENU_CANDIDATES,
  OPENMRS_SAVE_CANDIDATES,
  type FieldMapping,
  openMrsFieldMappings,
} from "./selectors.js";

const DEFAULT_OPENMRS_BASE_URL = "https://o2.openmrs.org/openmrs";
const DEFAULT_OPENMRS_USERNAME = "admin";
const DEFAULT_OPENMRS_PASSWORD = "Admin123";

export interface OpenMrsConfig {
  baseUrl?: string;
  username?: string;
  password?: string;
  location?: string;
}

export interface OpenMrsAdapterDependencies {
  launchBrowser?: (options: Parameters<typeof chromium.launch>[0]) => Promise<OpenMrsBrowser>;
}

interface OpenMrsBrowser {
  close(): Promise<void>;
  newPage(options: { viewport: { width: number; height: number } }): Promise<OpenMrsPage>;
}

interface OpenMrsPage {
  goto(url: string, options: { waitUntil: "domcontentloaded" }): Promise<unknown>;
  locator(selector: string): OpenMrsLocator;
  screenshot(options: { fullPage: boolean }): Promise<Buffer>;
  waitForLoadState(state: "networkidle"): Promise<unknown>;
  frames?(): OpenMrsSearchContext[];
}

interface OpenMrsSearchContext {
  locator(selector: string): OpenMrsLocator;
}

interface OpenMrsLocator {
  first(): OpenMrsLocator;
  count(): Promise<number>;
  evaluate<T>(pageFunction: (element: Element) => T | Promise<T>): Promise<T>;
  selectOption(option: { label: string } | string): Promise<unknown>;
  fill(value: string): Promise<unknown>;
  click(): Promise<unknown>;
  hover?(): Promise<unknown>;
  isVisible?(): Promise<boolean>;
  innerText(options: { timeout: number }): Promise<string>;
}

interface FillResult {
  selectedSelector: string;
  action: "fill" | "select";
}

export class OpenMrsAdapter implements TargetAdapter {
  readonly name = "openmrs" as const;
  private browser?: OpenMrsBrowser;
  private page?: OpenMrsPage;
  private readonly launchBrowser: (options: Parameters<typeof chromium.launch>[0]) => Promise<OpenMrsBrowser>;

  constructor(
    private readonly config: OpenMrsConfig,
    dependencies: OpenMrsAdapterDependencies = {},
  ) {
    this.launchBrowser = dependencies.launchBrowser ?? ((options) => chromium.launch(options));
  }

  async prepare(): Promise<void> {
    await this.openSession();
  }

  async runRecord(context: TargetRunContext): Promise<TargetAdapterResult> {
    const page = this.page ?? (await this.openSession());
    try {
      const before = await page.screenshot({ fullPage: true });
      const beforePath = await context.audit.writeScreenshot(context.record.sourceRecordId, this.name, "before-navigation", before);
      await context.audit.writeEvent({
        recordId: context.record.sourceRecordId,
        target: this.name,
        phase: "web",
        actionType: "screenshot",
        screenshotPath: beforePath,
        result: "captured OpenMRS before-navigation screenshot",
      });

      const decision = await context.agent.decide({
        target: this.name,
        recordId: context.record.sourceRecordId,
        step: "navigate-new-patient",
        screenshotPath: beforePath,
        visibleText: await visibleText(page),
        allowedActions: [{ id: "navigate-new-patient", description: "Navigate to the OpenMRS new patient form." }],
      });

      if (decision.actionId !== "navigate-new-patient" || decision.confidence < 0.5) {
        return {
          status: "exception",
          exception: {
            code: "ui_state_unexpected",
            severity: "error",
            message: "Agent did not approve OpenMRS navigation.",
            suggestedRemediation: decision.rationale,
          },
        };
      }

      try {
        await navigateToNewPatient(page, this.config.baseUrl);
      } catch (error) {
        const exception = {
          code: "ui_state_unexpected",
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
          suggestedRemediation: "Review the OpenMRS navigation screenshot and demo environment state.",
          screenshotPath: beforePath,
        } satisfies ValidationException & { screenshotPath: string };
        await context.audit.writeTargetEvidence({
          recordId: context.record.sourceRecordId,
          target: this.name,
          status: "exception",
          screenshotPath: beforePath,
          message: exception.message,
        });
        return {
          status: "exception",
          exception,
        };
      }
      await context.audit.writeEvent({
        recordId: context.record.sourceRecordId,
        target: this.name,
        phase: "web",
        actionType: "navigate",
        rationale: decision.rationale,
        screenshotPath: beforePath,
        result: "navigated toward new patient form",
      });

      await expandOptionalSection(page, OPENMRS_CONTACT_SECTION_CANDIDATES);
      for (const mapping of openMrsFieldMappings(context.record)) {
        await fillMappedField(context, page, mapping);
      }

      const filled = await page.screenshot({ fullPage: true });
      const filledPath = await context.audit.writeScreenshot(context.record.sourceRecordId, this.name, "after-fill", filled);
      await context.audit.writeEvent({
        recordId: context.record.sourceRecordId,
        target: this.name,
        phase: "web",
        actionType: "fill",
        screenshotPath: filledPath,
        result: "filled OpenMRS patient fields",
      });

      const saveDecision = await context.agent.decide({
        target: this.name,
        recordId: context.record.sourceRecordId,
        step: "save-patient",
        screenshotPath: filledPath,
        visibleText: await visibleText(page),
        allowedActions: [{ id: "save-patient", description: "Save the OpenMRS patient form." }],
      });

      if (saveDecision.actionId !== "save-patient" || saveDecision.confidence < 0.5) {
        return {
          status: "exception",
          exception: {
            code: "ui_state_unexpected",
            severity: "error",
            message: "Agent did not approve OpenMRS save.",
            suggestedRemediation: saveDecision.rationale,
          },
        };
      }

      await submitPatient(page);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await sleep(1000);

      const text = await visibleText(page);
      if (isDuplicateText(text) || (await hasAnyVisible(page, OPENMRS_CONFIRM_CREATE_CANDIDATES))) {
        const after = await page.screenshot({ fullPage: true });
        const afterPath = await context.audit.writeScreenshot(context.record.sourceRecordId, this.name, "after-save", after);
        await writePossibleDuplicate(context, afterPath, saveDecision.rationale);
        return possibleDuplicateResult(afterPath);
      }

      if (await hasAnyVisible(page, OPENMRS_SAVE_CANDIDATES)) {
        const after = await page.screenshot({ fullPage: true });
        const afterPath = await context.audit.writeScreenshot(context.record.sourceRecordId, this.name, "after-save", after);
        await context.audit.writeEvent({
          recordId: context.record.sourceRecordId,
          target: this.name,
          phase: "web",
          actionType: "save",
          rationale: saveDecision.rationale,
          screenshotPath: afterPath,
          result: "OpenMRS still showed the new-patient form after save",
          exceptionCode: "verification_failed",
        });
        await writeTargetIssue(context, {
          code: "verification_failed",
          severity: "error",
          message: "OpenMRS still showed the new-patient form after save.",
          suggestedRemediation: "Review required fields and the after-save screenshot before retrying.",
          screenshotPath: afterPath,
        });
        return {
          status: "exception",
          exception: {
            code: "verification_failed",
            severity: "error",
            message: "OpenMRS still showed the new-patient form after save.",
            suggestedRemediation: "Review required fields and the after-save screenshot before retrying.",
            screenshotPath: afterPath,
          },
        };
      }

      if (!(await waitForPatientDashboard(page, context.record, text))) {
        const after = await page.screenshot({ fullPage: true });
        const afterPath = await context.audit.writeScreenshot(context.record.sourceRecordId, this.name, "after-save", after);
        await context.audit.writeEvent({
          recordId: context.record.sourceRecordId,
          target: this.name,
          phase: "web",
          actionType: "save",
          rationale: saveDecision.rationale,
          screenshotPath: afterPath,
          result: "OpenMRS did not show the patient dashboard after save",
          exceptionCode: "verification_failed",
        });
        await writeTargetIssue(context, {
          code: "verification_failed",
          severity: "error",
          message: "OpenMRS did not show the patient dashboard after save.",
          suggestedRemediation: "Review the after-save screenshot and confirm the patient registration completed.",
          screenshotPath: afterPath,
        });
        return {
          status: "exception",
          exception: {
            code: "verification_failed",
            severity: "error",
            message: "OpenMRS did not show the patient dashboard after save.",
            suggestedRemediation: "Review the after-save screenshot and confirm the patient registration completed.",
            screenshotPath: afterPath,
          },
        };
      }

      await expandPatientDashboardContactInfo(page);
      const after = await page.screenshot({ fullPage: true });
      const afterPath = await context.audit.writeScreenshot(context.record.sourceRecordId, this.name, "after-save", after);
      await context.audit.writeEvent({
        recordId: context.record.sourceRecordId,
        target: this.name,
        phase: "web",
        actionType: "save",
        rationale: saveDecision.rationale,
        screenshotPath: afterPath,
        result: "submitted OpenMRS patient form",
      });

      const targetRecordId = `openmrs-${context.record.sourceRecordId}`;
      await context.audit.writeTargetEvidence({
        recordId: context.record.sourceRecordId,
        target: this.name,
        status: "succeeded",
        screenshotPath: afterPath,
        fieldScreenshotPath: filledPath,
        targetRecordId,
        message: "submitted OpenMRS patient form and opened the patient dashboard",
      });

      return { status: "succeeded", targetRecordId };
    } finally {
      await this.closeSession();
    }
  }

  async close(): Promise<void> {
    await this.closeSession();
  }

  private async openSession(): Promise<OpenMrsPage> {
    const config = resolveOpenMrsConfig(this.config);

    this.browser = await this.launchBrowser({
      headless: false,
      chromiumSandbox: true,
      env: {},
      args: ["--disable-extensions", "--disable-file-system"],
    });

    try {
      this.page = await this.browser.newPage({ viewport: { width: 1280, height: 720 } });
      await this.page.goto(openMrsLoginUrl(config.baseUrl), { waitUntil: "domcontentloaded" });
      await fillFirst(this.page, OPENMRS_LOGIN_SELECTORS.username, config.username, "login username");
      await fillFirst(this.page, OPENMRS_LOGIN_SELECTORS.password, config.password, "login password");
      await clickOptional(this.page, locationSelectors(config.location));
      await clickFirst(this.page, OPENMRS_LOGIN_SELECTORS.submit, "login submit");
      await this.page.waitForLoadState("networkidle");
    } catch (error) {
      await this.browser.close().catch(() => undefined);
      this.browser = undefined;
      this.page = undefined;
      throw error;
    }
    if (!this.page) throw new Error("OpenMRS session did not create a page.");
    return this.page;
  }

  private async closeSession(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
    this.page = undefined;
  }
}

async function fillMappedField(context: TargetRunContext, page: OpenMrsPage, mapping: FieldMapping): Promise<void> {
  try {
    await revealField(page, mapping.selectors, mapping.targetField);
    const result = await fillFirst(page, mapping.selectors, mapping.value, mapping.targetField);
    await context.audit.writeFieldMapping({
      recordId: context.record.sourceRecordId,
      target: "openmrs",
      sourceField: mapping.sourceField,
      targetField: mapping.targetField,
      normalizedValue: mapping.value,
      selectorCandidates: mapping.selectors,
      selectedSelector: result.selectedSelector,
      action: result.action,
      status: "succeeded",
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await context.audit.writeFieldMapping({
      recordId: context.record.sourceRecordId,
      target: "openmrs",
      sourceField: mapping.sourceField,
      targetField: mapping.targetField,
      normalizedValue: mapping.value,
      selectorCandidates: mapping.selectors,
      status: "failed",
      errorMessage,
    });
    if (!mapping.required) {
      return;
    }
    throw error;
  }
}

async function fillFirst(page: OpenMrsPage, selectors: string[], value: string, label: string): Promise<FillResult> {
  const match = await findFirstVisible(page, selectors, label);
  const locator = match.locator;
  const tagName = await locator.evaluate((element) => element.tagName.toLowerCase()).catch(() => "input");
  if (tagName === "select") {
    await locator.selectOption({ label: value }).catch(() => locator.selectOption(value));
    return { selectedSelector: match.selector, action: "select" };
  } else {
    await locator.fill(value);
    return { selectedSelector: match.selector, action: "fill" };
  }
}

async function clickFirst(page: OpenMrsPage, selectors: string[], label: string): Promise<void> {
  await (await findFirstVisible(page, selectors, label)).locator.click();
}

async function submitPatient(page: OpenMrsPage): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await hasAnyVisible(page, OPENMRS_SAVE_CANDIDATES)) {
      await clickFirst(page, OPENMRS_SAVE_CANDIDATES, "save patient");
      return;
    }
    if (!(await clickOptional(page, OPENMRS_NEXT_CANDIDATES))) break;
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await sleep(250);
  }

  await clickFirst(page, OPENMRS_SAVE_CANDIDATES, "save patient");
}

async function revealField(page: OpenMrsPage, selectors: string[], label: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await hasAnyVisible(page, selectors)) return;
    if (!(await clickOptional(page, OPENMRS_NEXT_CANDIDATES))) break;
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await sleep(250);
  }

  await waitForAnyVisible(page, selectors, label);
}

async function clickOptional(page: OpenMrsPage, selectors: string[]): Promise<boolean> {
  for (const context of contextsFor(page)) {
    for (const selector of selectors) {
      const locator = context.locator(selector).first();
      if ((await locator.count().catch(() => 0)) > 0 && (await isVisible(locator))) {
        await locator.click();
        return true;
      }
    }
  }

  return false;
}

async function hasAnyVisible(page: OpenMrsPage, selectors: string[]): Promise<boolean> {
  for (const context of contextsFor(page)) {
    for (const selector of selectors) {
      const locator = context.locator(selector).first();
      if ((await locator.count().catch(() => 0)) > 0 && (await isVisible(locator))) {
        return true;
      }
    }
  }

  return false;
}

async function hoverFirst(page: OpenMrsPage, selectors: string[], label: string): Promise<void> {
  const locator = (await findFirstVisible(page, selectors, label)).locator;
  if (!locator.hover) {
    throw new Error(`OpenMRS selector matched for ${label}, but hover is unavailable.`);
  }
  await locator.hover();
}

async function navigateToNewPatient(page: OpenMrsPage, baseUrl?: string): Promise<void> {
  const normalizedBaseUrl = resolveOpenMrsBaseUrl(baseUrl);
  const openedFromMenu =
    (await clickOptional(page, OPENMRS_PATIENT_MENU_CANDIDATES)) ||
    (await clickOptional(page, OPENMRS_NEW_PATIENT_CANDIDATES));

  if (!openedFromMenu) {
    await page.goto(openMrsRegistrationUrl(normalizedBaseUrl), {
      waitUntil: "domcontentloaded",
    });
  }
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await waitForAnyVisible(page, openMrsFieldMappingsProbe(), "new patient form");
}

async function hoverOptional(page: OpenMrsPage, selectors: string[]): Promise<boolean> {
  for (const context of contextsFor(page)) {
    for (const selector of selectors) {
      const locator = context.locator(selector).first();
      if ((await locator.count().catch(() => 0)) > 0 && (await isVisible(locator)) && locator.hover) {
        await locator.hover();
        return true;
      }
    }
  }

  return false;
}

async function expandOptionalSection(page: OpenMrsPage, selectors: string[]): Promise<void> {
  await clickOptional(page, selectors);
}

async function expandPatientDashboardContactInfo(page: OpenMrsPage): Promise<void> {
  if (await clickOptional(page, OPENMRS_PATIENT_DASHBOARD_CONTACT_CANDIDATES)) {
    await sleep(500);
  }
}

async function visibleText(page: OpenMrsPage): Promise<string> {
  const texts = await Promise.all(
    contextsFor(page).map((context) => context.locator("body").innerText({ timeout: 5000 }).catch(() => "")),
  );
  return texts.filter(Boolean).join("\n");
}

async function waitForPatientDashboard(page: OpenMrsPage, record: TargetRunContext["record"], initialText: string): Promise<boolean> {
  if (looksLikePatientDashboard(initialText, record)) return true;

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await sleep(250);
    const text = await visibleText(page);
    if (isDuplicateText(text)) return false;
    if (looksLikePatientDashboard(text, record)) return true;
  }

  return false;
}

function looksLikePatientDashboard(text: string, record: TargetRunContext["record"]): boolean {
  const normalizedText = text.replace(/\s+/g, " ");
  const hasPatientName = normalizedText.includes(record.firstName) && normalizedText.includes(record.lastName);
  return hasPatientName && /patient|dashboard|visits|vitals|conditions|allergies|diagnoses|chart/i.test(normalizedText);
}

function isDuplicateText(text: string): boolean {
  return /duplicate|already exists|similar patient/i.test(text);
}

async function findFirstVisible(
  page: OpenMrsPage,
  selectors: string[],
  label: string,
): Promise<{ locator: OpenMrsLocator; selector: string }> {
  for (const context of contextsFor(page)) {
    for (const selector of selectors) {
      const locator = context.locator(selector).first();
      if ((await locator.count().catch(() => 0)) > 0 && (await isVisible(locator))) {
        return { locator, selector };
      }
    }
  }

  throw new Error(`No visible OpenMRS selector matched for ${label}: ${selectors.join(", ")}`);
}

async function waitForAnyVisible(page: OpenMrsPage, selectors: string[], label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    for (const context of contextsFor(page)) {
      for (const selector of selectors) {
        const locator = context.locator(selector).first();
        if ((await locator.count().catch(() => 0)) > 0 && (await isVisible(locator))) {
          return;
        }
      }
    }
    await sleep(250);
  }

  throw new Error(`Timed out waiting for visible OpenMRS ${label}: ${selectors.join(", ")}`);
}

function contextsFor(page: OpenMrsPage): OpenMrsSearchContext[] {
  return [page, ...(page.frames?.() ?? [])];
}

async function isVisible(locator: OpenMrsLocator): Promise<boolean> {
  return locator.isVisible ? locator.isVisible().catch(() => false) : true;
}

function openMrsFieldMappingsProbe(): string[] {
  return [
    'input[name="givenName"]',
    'input[name="familyName"]',
  ];
}

function resolveOpenMrsConfig(config: OpenMrsConfig): Required<OpenMrsConfig> {
  return {
    baseUrl: resolveOpenMrsBaseUrl(config.baseUrl),
    username: config.username ?? DEFAULT_OPENMRS_USERNAME,
    password: config.password ?? DEFAULT_OPENMRS_PASSWORD,
    location: config.location ?? "Registration Desk",
  };
}

function resolveOpenMrsBaseUrl(baseUrl: string | undefined): string {
  if (!baseUrl) return DEFAULT_OPENMRS_BASE_URL;
  try {
    const url = new URL(baseUrl);
    if (url.hostname === "openmrs.org" && url.pathname.replace(/\/$/, "") === "/demo") {
      return DEFAULT_OPENMRS_BASE_URL;
    }
  } catch {
    return baseUrl;
  }
  return baseUrl;
}

function openMrsLoginUrl(baseUrl: string): string {
  return new URL("login.htm", `${baseUrl.replace(/\/$/, "")}/`).toString();
}

function openMrsRegistrationUrl(baseUrl: string): string {
  return new URL(
    "registrationapp/registerPatient.page?appId=referenceapplication.registrationapp.registerPatient",
    `${baseUrl.replace(/\/$/, "")}/`,
  ).toString();
}

function locationSelectors(location: string): string[] {
  if (location === "Registration Desk") return OPENMRS_LOGIN_SELECTORS.location;
  return [`#${cssEscape(location)}`, `#sessionLocation li:has-text("${location}")`, ...OPENMRS_LOGIN_SELECTORS.location];
}

function cssEscape(value: string): string {
  return value.replace(/([ #.;?+*~':"!^$[\]()=>|/@])/g, "\\$1");
}

async function writePossibleDuplicate(
  context: TargetRunContext,
  screenshotPath: string,
  rationale: string | undefined,
): Promise<void> {
  await context.audit.writeEvent({
    recordId: context.record.sourceRecordId,
    target: "openmrs",
    phase: "web",
    actionType: "save",
    rationale,
    screenshotPath,
    result: "OpenMRS indicated a possible duplicate patient",
    exceptionCode: "possible_duplicate",
  });
  await writeTargetIssue(context, {
    code: "possible_duplicate",
    severity: "error",
    message: "OpenMRS indicated a possible duplicate patient.",
    suggestedRemediation: "Review the patient match screen and decide whether to merge, update, or skip.",
    screenshotPath,
  });
  await context.audit.writeTargetEvidence({
    recordId: context.record.sourceRecordId,
    target: "openmrs",
    status: "exception",
    screenshotPath,
    message: "OpenMRS indicated a possible duplicate patient.",
  });
}

function possibleDuplicateResult(screenshotPath: string): TargetAdapterResult {
  return {
    status: "exception",
    exception: {
      code: "possible_duplicate",
      severity: "error",
      message: "OpenMRS indicated a possible duplicate patient.",
      suggestedRemediation: "Review the patient match screen and decide whether to merge, update, or skip.",
      screenshotPath,
    },
  };
}

async function writeTargetIssue(
  context: TargetRunContext,
  exception: ValidationException & { screenshotPath?: string },
): Promise<void> {
  await context.audit.writeReportIssue({
    phase: "target",
    target: "openmrs",
    recordId: context.record.sourceRecordId,
    exceptionCode: exception.code,
    message: exception.message,
    suggestedRemediation: exception.suggestedRemediation,
    screenshotPath: exception.screenshotPath,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
