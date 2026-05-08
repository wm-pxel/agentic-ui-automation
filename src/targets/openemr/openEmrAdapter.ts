import { chromium } from "@playwright/test";
import type { TargetAdapter, TargetAdapterResult, TargetPrepareContext, TargetRunContext } from "../../adapters/contract.js";
import type { ValidationException } from "../../domain/schema.js";
import { OPENEMR_LOGIN_SELECTORS, OPENEMR_SAVE_CANDIDATES, type OpenEmrFieldMapping, openEmrFieldMappings } from "./selectors.js";

const DEFAULT_OPENEMR_BASE_URL = "https://demo.openemr.io/openemr";
const DEFAULT_OPENEMR_USERNAME = "admin";
const DEFAULT_OPENEMR_PASSWORD = "pass";
const OPENEMR_ACTION_TIMEOUT_MS = 5000;

export interface OpenEmrConfig {
  baseUrl?: string;
  username?: string;
  password?: string;
  concurrency?: number;
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
  evaluate<T, Arg>(pageFunction: string | ((input: Arg) => T | Promise<T>), arg: Arg): Promise<T>;
  locator(selector: string): OpenEmrLocator;
  screenshot(options: { fullPage: boolean }): Promise<Buffer>;
  waitForLoadState(state: "networkidle"): Promise<unknown>;
}

interface OpenEmrLocator {
  first(): OpenEmrLocator;
  count(): Promise<number>;
  evaluate<T>(pageFunction: (element: Element) => T | Promise<T>): Promise<T>;
  selectOption(option: { label: string } | string, options?: { timeout: number }): Promise<unknown>;
  fill(value: string, options?: { timeout: number }): Promise<unknown>;
  click(): Promise<unknown>;
  isVisible?(): Promise<boolean>;
  innerText(options: { timeout: number }): Promise<string>;
}

interface OpenEmrSession {
  browser: OpenEmrBrowser;
  page: OpenEmrPage;
}

interface FillResult {
  selectedSelector: string;
  action: "fill" | "select";
}

export class OpenEmrAdapter implements TargetAdapter {
  readonly name = "openemr" as const;
  readonly maxConcurrency: number;
  private readonly activeBrowsers = new Set<OpenEmrBrowser>();
  private readonly readySessions: OpenEmrSession[] = [];
  private readonly launchBrowser: (options: Parameters<typeof chromium.launch>[0]) => Promise<OpenEmrBrowser>;

  constructor(
    private readonly config: OpenEmrConfig,
    dependencies: OpenEmrAdapterDependencies = {},
  ) {
    this.launchBrowser = dependencies.launchBrowser ?? ((options) => chromium.launch(options));
    this.maxConcurrency = effectiveOpenEmrConcurrency(config);
  }

  async prepare(context?: TargetPrepareContext): Promise<void> {
    try {
      const sessionCount = eagerSessionCount(this.maxConcurrency, context?.plannedRecords);
      const sessions = await Promise.all(Array.from({ length: sessionCount }, () => this.openSession()));
      this.readySessions.push(...sessions);
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  async runRecord(context: TargetRunContext): Promise<TargetAdapterResult> {
    const session = await this.acquireSession();
    const page = session.page;
    let reusable = false;
    let latestScreenshotPath: string | undefined;

    try {
      const before = await page.screenshot({ fullPage: true });
      latestScreenshotPath = await context.audit.writeScreenshot(context.record.sourceRecordId, this.name, "before-navigation", before);
      await context.audit.writeEvent({
        recordId: context.record.sourceRecordId,
        target: this.name,
        phase: "web",
        actionType: "screenshot",
        screenshotPath: latestScreenshotPath,
        result: "captured OpenEMR before-navigation screenshot",
      });

      const decision = await context.agent.decide({
        target: this.name,
        recordId: context.record.sourceRecordId,
        step: "navigate-new-patient",
        screenshotPath: latestScreenshotPath,
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
      await visibleText(page);

      for (const mapping of openEmrFieldMappings(context.record)) {
        await fillMappedField(context, mapping, page);
      }

      const afterFill = await page.screenshot({ fullPage: true });
      const afterFillPath = await context.audit.writeScreenshot(context.record.sourceRecordId, this.name, "after-fill", afterFill);
      latestScreenshotPath = afterFillPath;
      await context.audit.writeEvent({
        recordId: context.record.sourceRecordId,
        target: this.name,
        phase: "web",
        actionType: "screenshot",
        screenshotPath: afterFillPath,
        result: "captured OpenEMR after-fill screenshot",
      });

      await clickFirst(page, OPENEMR_SAVE_CANDIDATES, "OpenEMR save button");
      await page.waitForLoadState("networkidle").catch(() => undefined);

      const afterSave = await page.screenshot({ fullPage: true });
      const afterSavePath = await context.audit.writeScreenshot(context.record.sourceRecordId, this.name, "after-save", afterSave);
      latestScreenshotPath = afterSavePath;
      const savedText = await visibleText(page);

      if (/duplicate|already exists|possible duplicate/i.test(savedText)) {
        const exception = {
          code: "possible_duplicate",
          severity: "warning",
          message: "OpenEMR reported a possible duplicate patient.",
          suggestedRemediation: "Review the OpenEMR after-save screenshot and search for the synthetic patient before retrying.",
          screenshotPath: afterSavePath,
        } satisfies ValidationException & { screenshotPath: string };
        await context.audit.writeTargetEvidence({
          recordId: context.record.sourceRecordId,
          target: this.name,
          status: "exception",
          screenshotPath: afterSavePath,
          fieldScreenshotPath: afterFillPath,
          message: exception.message,
        });
        return { status: "exception", exception };
      }

      const targetRecordId = extractOpenEmrRecordId(savedText) ?? `openemr-${context.record.sourceRecordId}`;
      await context.audit.writeTargetEvidence({
        recordId: context.record.sourceRecordId,
        target: this.name,
        status: "succeeded",
        screenshotPath: afterSavePath,
        fieldScreenshotPath: afterFillPath,
        targetRecordId,
        message: "submitted OpenEMR patient form",
      });
      reusable = true;
      return { status: "succeeded", targetRecordId };
    } catch (error) {
      const exception = exceptionFromError(error, latestScreenshotPath);
      await context.audit.writeTargetEvidence({
        recordId: context.record.sourceRecordId,
        target: this.name,
        status: "exception",
        screenshotPath: latestScreenshotPath,
        message: exception.message,
      });
      return { status: "exception", exception };
    } finally {
      if (reusable) {
        this.readySessions.push(session);
      } else {
        await session.browser.close().catch(() => undefined);
        this.activeBrowsers.delete(session.browser);
      }
    }
  }

  async close(): Promise<void> {
    const browsers = [...this.activeBrowsers];
    this.activeBrowsers.clear();
    this.readySessions.length = 0;
    await Promise.all(browsers.map((browser) => browser.close()));
  }

  private async openSession(): Promise<OpenEmrSession> {
    const browser = await this.launchBrowser({
      headless: false,
      chromiumSandbox: true,
      env: {},
    });
    this.activeBrowsers.add(browser);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await login(page, this.config);
    return { browser, page };
  }

  private async acquireSession(): Promise<OpenEmrSession> {
    const session = this.readySessions.shift();
    if (session) return session;
    return this.openSession();
  }
}

async function login(page: OpenEmrPage, config: OpenEmrConfig): Promise<void> {
  await page.goto(openEmrBaseUrl(config.baseUrl), { waitUntil: "domcontentloaded" });
  await fillFirst(page, OPENEMR_LOGIN_SELECTORS.username, config.username ?? DEFAULT_OPENEMR_USERNAME, "OpenEMR username");
  await fillFirst(page, OPENEMR_LOGIN_SELECTORS.password, config.password ?? DEFAULT_OPENEMR_PASSWORD, "OpenEMR password");
  await clickFirst(page, OPENEMR_LOGIN_SELECTORS.submit, "OpenEMR login button");
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

async function navigateToNewPatient(page: OpenEmrPage, baseUrl: string | undefined): Promise<void> {
  await page.goto(`${openEmrBaseUrl(baseUrl).replace(/\/$/, "")}/interface/new/new.php`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

async function fillMappedField(context: TargetRunContext, mapping: OpenEmrFieldMapping, page: OpenEmrPage): Promise<void> {
  try {
    const result = await fillFirstMapped(page, mapping);
    await context.audit.writeFieldMapping({
      recordId: context.record.sourceRecordId,
      target: "openemr",
      sourceField: String(mapping.sourceField),
      targetField: mapping.targetField,
      normalizedValue: mapping.value,
      mappingConfidence: mapping.mappingConfidence,
      selectorCandidates: mapping.selectors,
      selectedSelector: result.selectedSelector,
      action: result.action,
      status: "succeeded",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await context.audit.writeFieldMapping({
      recordId: context.record.sourceRecordId,
      target: "openemr",
      sourceField: String(mapping.sourceField),
      targetField: mapping.targetField,
      normalizedValue: mapping.value,
      mappingConfidence: mapping.mappingConfidence,
      selectorCandidates: mapping.selectors,
      status: "failed",
      errorMessage: message,
    });
    throw error;
  }
}

async function fillFirstMapped(page: OpenEmrPage, mapping: OpenEmrFieldMapping): Promise<FillResult> {
  const selectedSelector = await findFirstVisibleSelector(page, mapping.selectors);
  if (!selectedSelector) {
    throw new Error(`Timed out waiting for visible OpenEMR ${mapping.targetField}.`);
  }

  const locator = page.locator(selectedSelector).first();
  const tagName = String(await locator.evaluate((element) => element.tagName)).toLowerCase();
  if (tagName === "select") {
    await locator.selectOption({ label: mapping.value }, { timeout: OPENEMR_ACTION_TIMEOUT_MS });
    return { selectedSelector, action: "select" };
  }

  await locator.fill(mapping.value, { timeout: OPENEMR_ACTION_TIMEOUT_MS });
  return { selectedSelector, action: "fill" };
}

async function fillFirst(page: OpenEmrPage, selectors: string[], value: string, description: string): Promise<string> {
  const selector = await findFirstVisibleSelector(page, selectors);
  if (!selector) {
    throw new Error(`Timed out waiting for visible ${description}.`);
  }
  await page.locator(selector).first().fill(value, { timeout: OPENEMR_ACTION_TIMEOUT_MS });
  return selector;
}

async function clickFirst(page: OpenEmrPage, selectors: string[], description: string): Promise<string> {
  const selector = await findFirstVisibleSelector(page, selectors);
  if (!selector) {
    throw new Error(`Timed out waiting for visible ${description}.`);
  }
  await page.locator(selector).first().click();
  return selector;
}

async function findFirstVisibleSelector(page: OpenEmrPage, selectors: string[]): Promise<string | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) continue;
    if (locator.isVisible && !(await locator.isVisible())) continue;
    return selector;
  }
  return null;
}

async function visibleText(page: OpenEmrPage): Promise<string> {
  try {
    return await page.locator("body").innerText({ timeout: OPENEMR_ACTION_TIMEOUT_MS });
  } catch {
    return "";
  }
}

function openEmrBaseUrl(value: string | undefined): string {
  return value?.replace(/\/$/, "") || DEFAULT_OPENEMR_BASE_URL;
}

function effectiveOpenEmrConcurrency(config: OpenEmrConfig): number {
  return Math.max(1, Math.floor(config.concurrency ?? 1));
}

function eagerSessionCount(maxConcurrency: number, plannedRecords: number | undefined): number {
  return Math.max(1, Math.min(maxConcurrency, plannedRecords ?? maxConcurrency));
}

function extractOpenEmrRecordId(text: string): string | undefined {
  return /Record ID\s+([a-z0-9._-]+)/i.exec(text)?.[1];
}

function exceptionFromError(error: unknown, screenshotPath?: string): ValidationException & { screenshotPath?: string } {
  return {
    code: "ui_state_unexpected",
    severity: "error",
    message: error instanceof Error ? error.message : String(error),
    suggestedRemediation: "Review the OpenEMR screenshots and current demo UI before retrying.",
    screenshotPath,
  };
}
