import { chromium, type Browser } from "@playwright/test";
import type { TargetAdapter, TargetAdapterResult, TargetRunContext } from "../../adapters/contract.js";
import type { ValidationException } from "../../domain/schema.js";
import {
  OPENEMR_CONTACT_SECTION_CANDIDATES,
  OPENEMR_CONFIRM_CREATE_CANDIDATES,
  OPENEMR_LOGIN_SELECTORS,
  OPENEMR_NEW_PATIENT_CANDIDATES,
  OPENEMR_PATIENT_MENU_CANDIDATES,
  OPENEMR_SAVE_CANDIDATES,
  type FieldMapping,
  openEmrFieldMappings,
} from "./selectors.js";

export interface OpenEmrConfig {
  baseUrl?: string;
  username?: string;
  password?: string;
}

export interface OpenEmrAdapterDependencies {
  launchBrowser?: (options: Parameters<typeof chromium.launch>[0]) => Promise<OpenEmrBrowser>;
}

interface OpenEmrBrowser {
  close(): Promise<void>;
  newPage(options: { viewport: { width: number; height: number } }): Promise<OpenEmrPage>;
}

interface OpenEmrPage {
  goto(url: string, options: { waitUntil: "domcontentloaded" }): Promise<unknown>;
  locator(selector: string): OpenEmrLocator;
  screenshot(options: { fullPage: boolean }): Promise<Buffer>;
  waitForLoadState(state: "networkidle"): Promise<unknown>;
  frames?(): OpenEmrSearchContext[];
}

interface OpenEmrSearchContext {
  locator(selector: string): OpenEmrLocator;
}

interface OpenEmrLocator {
  first(): OpenEmrLocator;
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

export class OpenEmrAdapter implements TargetAdapter {
  readonly name = "openemr" as const;
  private browser?: OpenEmrBrowser;
  private page?: OpenEmrPage;
  private readonly launchBrowser: (options: Parameters<typeof chromium.launch>[0]) => Promise<OpenEmrBrowser>;

  constructor(
    private readonly config: OpenEmrConfig,
    dependencies: OpenEmrAdapterDependencies = {},
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
        result: "captured OpenEMR before-navigation screenshot",
      });

      const decision = await context.agent.decide({
        target: this.name,
        recordId: context.record.sourceRecordId,
        step: "navigate-new-patient",
        screenshotPath: beforePath,
        visibleText: await visibleText(page),
        allowedActions: [{ id: "navigate-new-patient", description: "Navigate to the OpenEMR new patient form." }],
      });

      if (decision.actionId !== "navigate-new-patient" || decision.confidence < 0.5) {
        return {
          status: "exception",
          exception: {
            code: "ui_state_unexpected",
            severity: "error",
            message: "Agent did not approve OpenEMR navigation.",
            suggestedRemediation: decision.rationale,
          },
        };
      }

      await navigateToNewPatient(page, this.config.baseUrl);
      await context.audit.writeEvent({
        recordId: context.record.sourceRecordId,
        target: this.name,
        phase: "web",
        actionType: "navigate",
        rationale: decision.rationale,
        screenshotPath: beforePath,
        result: "navigated toward new patient form",
      });

      await expandOptionalSection(page, OPENEMR_CONTACT_SECTION_CANDIDATES);
      for (const mapping of openEmrFieldMappings(context.record)) {
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
        result: "filled OpenEMR patient fields",
      });

      const saveDecision = await context.agent.decide({
        target: this.name,
        recordId: context.record.sourceRecordId,
        step: "save-patient",
        screenshotPath: filledPath,
        visibleText: await visibleText(page),
        allowedActions: [{ id: "save-patient", description: "Save the OpenEMR patient form." }],
      });

      if (saveDecision.actionId !== "save-patient" || saveDecision.confidence < 0.5) {
        return {
          status: "exception",
          exception: {
            code: "ui_state_unexpected",
            severity: "error",
            message: "Agent did not approve OpenEMR save.",
            suggestedRemediation: saveDecision.rationale,
          },
        };
      }

      await clickFirst(page, OPENEMR_SAVE_CANDIDATES, "save patient");
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await sleep(1000);
      const confirmationText = await visibleText(page);

      if (await hasAnyVisible(page, OPENEMR_CONFIRM_CREATE_CANDIDATES)) {
        if (!/No matches were found/i.test(confirmationText)) {
          const after = await page.screenshot({ fullPage: true });
          const afterPath = await context.audit.writeScreenshot(context.record.sourceRecordId, this.name, "after-save", after);
          await context.audit.writeEvent({
            recordId: context.record.sourceRecordId,
            target: this.name,
            phase: "web",
            actionType: "save",
            rationale: saveDecision.rationale,
            screenshotPath: afterPath,
            result: "OpenEMR indicated a possible duplicate patient",
            exceptionCode: "possible_duplicate",
          });
          await writeTargetIssue(context, {
            code: "possible_duplicate",
            severity: "error",
            message: "OpenEMR indicated a possible duplicate patient.",
            suggestedRemediation: "Review the patient match screen and decide whether to merge, update, or skip.",
            screenshotPath: afterPath,
          });
          return {
            status: "exception",
            exception: {
              code: "possible_duplicate",
              severity: "error",
              message: "OpenEMR indicated a possible duplicate patient.",
              suggestedRemediation: "Review the patient match screen and decide whether to merge, update, or skip.",
              screenshotPath: afterPath,
            },
          };
        }

        await clickFirst(page, OPENEMR_CONFIRM_CREATE_CANDIDATES, "confirm create patient");
        await page.waitForLoadState("networkidle").catch(() => undefined);
        await sleep(1000);
      }

      const after = await page.screenshot({ fullPage: true });
      const afterPath = await context.audit.writeScreenshot(context.record.sourceRecordId, this.name, "after-save", after);
      const text = await visibleText(page);
      if (/duplicate|already exists|similar patient/i.test(text)) {
        await context.audit.writeEvent({
          recordId: context.record.sourceRecordId,
          target: this.name,
          phase: "web",
          actionType: "save",
          rationale: saveDecision.rationale,
          screenshotPath: afterPath,
          result: "OpenEMR indicated a possible duplicate patient",
          exceptionCode: "possible_duplicate",
        });
        await writeTargetIssue(context, {
          code: "possible_duplicate",
          severity: "error",
          message: "OpenEMR indicated a possible duplicate patient.",
          suggestedRemediation: "Review the patient match screen and decide whether to merge, update, or skip.",
          screenshotPath: afterPath,
        });
        return {
          status: "exception",
          exception: {
            code: "possible_duplicate",
            severity: "error",
            message: "OpenEMR indicated a possible duplicate patient.",
            suggestedRemediation: "Review the patient match screen and decide whether to merge, update, or skip.",
            screenshotPath: afterPath,
          },
        };
      }

      if (await hasAnyVisible(page, OPENEMR_SAVE_CANDIDATES)) {
        await context.audit.writeEvent({
          recordId: context.record.sourceRecordId,
          target: this.name,
          phase: "web",
          actionType: "save",
          rationale: saveDecision.rationale,
          screenshotPath: afterPath,
          result: "OpenEMR still showed the new-patient form after save",
          exceptionCode: "verification_failed",
        });
        await writeTargetIssue(context, {
          code: "verification_failed",
          severity: "error",
          message: "OpenEMR still showed the new-patient form after save.",
          suggestedRemediation: "Review required fields and the after-save screenshot before retrying.",
          screenshotPath: afterPath,
        });
        return {
          status: "exception",
          exception: {
            code: "verification_failed",
            severity: "error",
            message: "OpenEMR still showed the new-patient form after save.",
            suggestedRemediation: "Review required fields and the after-save screenshot before retrying.",
            screenshotPath: afterPath,
          },
        };
      }

      await context.audit.writeEvent({
        recordId: context.record.sourceRecordId,
        target: this.name,
        phase: "web",
        actionType: "save",
        rationale: saveDecision.rationale,
        screenshotPath: afterPath,
        result: "submitted OpenEMR patient form",
      });

      const targetRecordId = `openemr-${context.record.sourceRecordId}`;
      await context.audit.writeTargetEvidence({
        recordId: context.record.sourceRecordId,
        target: this.name,
        status: "succeeded",
        screenshotPath: afterPath,
        targetRecordId,
        message: "submitted OpenEMR patient form",
      });

      return { status: "succeeded", targetRecordId };
    } finally {
      await this.closeSession();
    }
  }

  async close(): Promise<void> {
    await this.closeSession();
  }

  private async openSession(): Promise<OpenEmrPage> {
    if (!this.config.baseUrl || !this.config.username || !this.config.password) {
      throw new Error("OPENEMR_BASE_URL, OPENEMR_USERNAME, and OPENEMR_PASSWORD are required for OpenEMR runs.");
    }

    this.browser = await this.launchBrowser({
      headless: false,
      chromiumSandbox: true,
      env: {},
      args: ["--disable-extensions", "--disable-file-system"],
    });

    try {
      this.page = await this.browser.newPage({ viewport: { width: 1280, height: 720 } });
      await this.page.goto(this.config.baseUrl, { waitUntil: "domcontentloaded" });
      await fillFirst(this.page, OPENEMR_LOGIN_SELECTORS.username, this.config.username, "login username");
      await fillFirst(this.page, OPENEMR_LOGIN_SELECTORS.password, this.config.password, "login password");
      await clickFirst(this.page, OPENEMR_LOGIN_SELECTORS.submit, "login submit");
      await this.page.waitForLoadState("networkidle");
    } catch (error) {
      await this.browser.close().catch(() => undefined);
      this.browser = undefined;
      this.page = undefined;
      throw error;
    }
    if (!this.page) throw new Error("OpenEMR session did not create a page.");
    return this.page;
  }

  private async closeSession(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
    this.page = undefined;
  }
}

async function fillMappedField(context: TargetRunContext, page: OpenEmrPage, mapping: FieldMapping): Promise<void> {
  try {
    const result = await fillFirst(page, mapping.selectors, mapping.value, mapping.targetField);
    await context.audit.writeFieldMapping({
      recordId: context.record.sourceRecordId,
      target: "openemr",
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
      target: "openemr",
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

async function fillFirst(page: OpenEmrPage, selectors: string[], value: string, label: string): Promise<FillResult> {
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

async function clickFirst(page: OpenEmrPage, selectors: string[], label: string): Promise<void> {
  await (await findFirstVisible(page, selectors, label)).locator.click();
}

async function clickOptional(page: OpenEmrPage, selectors: string[]): Promise<boolean> {
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

async function hasAnyVisible(page: OpenEmrPage, selectors: string[]): Promise<boolean> {
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

async function hoverFirst(page: OpenEmrPage, selectors: string[], label: string): Promise<void> {
  const locator = (await findFirstVisible(page, selectors, label)).locator;
  if (!locator.hover) {
    throw new Error(`OpenEMR selector matched for ${label}, but hover is unavailable.`);
  }
  await locator.hover();
}

async function navigateToNewPatient(page: OpenEmrPage, baseUrl?: string): Promise<void> {
  const openedFromMenu =
    (await hoverOptional(page, OPENEMR_PATIENT_MENU_CANDIDATES)) &&
    (await clickOptional(page, OPENEMR_NEW_PATIENT_CANDIDATES));

  if (!openedFromMenu && baseUrl) {
    await page.goto(new URL("interface/new/new.php", `${baseUrl.replace(/\/$/, "")}/`).toString(), {
      waitUntil: "domcontentloaded",
    });
  } else if (!openedFromMenu) {
    await hoverFirst(page, OPENEMR_PATIENT_MENU_CANDIDATES, "patient menu");
    await clickFirst(page, OPENEMR_NEW_PATIENT_CANDIDATES, "new patient navigation");
  }
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await waitForAnyVisible(page, openEmrFieldMappingsProbe(), "new patient form");
}

async function hoverOptional(page: OpenEmrPage, selectors: string[]): Promise<boolean> {
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

async function expandOptionalSection(page: OpenEmrPage, selectors: string[]): Promise<void> {
  await clickOptional(page, selectors);
}

async function visibleText(page: OpenEmrPage): Promise<string> {
  const texts = await Promise.all(
    contextsFor(page).map((context) => context.locator("body").innerText({ timeout: 5000 }).catch(() => "")),
  );
  return texts.filter(Boolean).join("\n");
}

async function findFirstVisible(
  page: OpenEmrPage,
  selectors: string[],
  label: string,
): Promise<{ locator: OpenEmrLocator; selector: string }> {
  for (const context of contextsFor(page)) {
    for (const selector of selectors) {
      const locator = context.locator(selector).first();
      if ((await locator.count().catch(() => 0)) > 0 && (await isVisible(locator))) {
        return { locator, selector };
      }
    }
  }

  throw new Error(`No visible OpenEMR selector matched for ${label}: ${selectors.join(", ")}`);
}

async function waitForAnyVisible(page: OpenEmrPage, selectors: string[], label: string): Promise<void> {
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

  throw new Error(`Timed out waiting for visible OpenEMR ${label}: ${selectors.join(", ")}`);
}

function contextsFor(page: OpenEmrPage): OpenEmrSearchContext[] {
  return [page, ...(page.frames?.() ?? [])];
}

async function isVisible(locator: OpenEmrLocator): Promise<boolean> {
  return locator.isVisible ? locator.isVisible().catch(() => false) : true;
}

function openEmrFieldMappingsProbe(): string[] {
  return [
    'input[name="form_fname"]',
    'input[name="fname"]',
    'input[id*="fname"]',
    'input[name="form_Fname"]',
    'input[id="form_Fname"]',
    'input[name="form_first"]',
    'input[id="form_first"]',
  ];
}

async function writeTargetIssue(
  context: TargetRunContext,
  exception: ValidationException & { screenshotPath?: string },
): Promise<void> {
  await context.audit.writeReportIssue({
    phase: "target",
    target: "openemr",
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
