import { chromium, type Browser } from "@playwright/test";
import type { TargetAdapter, TargetAdapterResult, TargetRunContext } from "../../adapters/contract.js";
import {
  OPENEMR_LOGIN_SELECTORS,
  OPENEMR_NEW_PATIENT_CANDIDATES,
  OPENEMR_SAVE_CANDIDATES,
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
}

interface OpenEmrLocator {
  first(): OpenEmrLocator;
  count(): Promise<number>;
  evaluate<T>(pageFunction: (element: Element) => T | Promise<T>): Promise<T>;
  selectOption(option: { label: string } | string): Promise<unknown>;
  fill(value: string): Promise<unknown>;
  click(): Promise<unknown>;
  innerText(options: { timeout: number }): Promise<string>;
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
    if (!this.config.baseUrl || !this.config.username || !this.config.password) {
      throw new Error("OPENEMR_BASE_URL, OPENEMR_USERNAME, and OPENEMR_PASSWORD are required for OpenEMR runs.");
    }

    this.browser = await this.launchBrowser({
      headless: false,
      chromiumSandbox: true,
      env: {},
      args: ["--disable-extensions", "--disable-file-system"],
    });
    this.page = await this.browser.newPage({ viewport: { width: 1280, height: 720 } });
    await this.page.goto(this.config.baseUrl, { waitUntil: "domcontentloaded" });
    await fillFirst(this.page, OPENEMR_LOGIN_SELECTORS.username, this.config.username);
    await fillFirst(this.page, OPENEMR_LOGIN_SELECTORS.password, this.config.password);
    await clickFirst(this.page, OPENEMR_LOGIN_SELECTORS.submit);
    await this.page.waitForLoadState("networkidle");
  }

  async runRecord(context: TargetRunContext): Promise<TargetAdapterResult> {
    const page = this.requirePage();
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

    await navigateToNewPatient(page);
    await context.audit.writeEvent({
      recordId: context.record.sourceRecordId,
      target: this.name,
      phase: "web",
      actionType: "navigate",
      rationale: decision.rationale,
      screenshotPath: beforePath,
      result: "navigated toward new patient form",
    });

    for (const mapping of openEmrFieldMappings(context.record)) {
      await fillFirst(page, mapping.selectors, mapping.value);
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

    await clickFirst(page, OPENEMR_SAVE_CANDIDATES);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    const after = await page.screenshot({ fullPage: true });
    const afterPath = await context.audit.writeScreenshot(context.record.sourceRecordId, this.name, "after-save", after);
    const text = await visibleText(page);

    if (/duplicate|already exists|similar patient/i.test(text)) {
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

    await context.audit.writeEvent({
      recordId: context.record.sourceRecordId,
      target: this.name,
      phase: "web",
      actionType: "save",
      rationale: saveDecision.rationale,
      screenshotPath: afterPath,
      result: "submitted OpenEMR patient form",
    });

    return { status: "succeeded", targetRecordId: `openemr-${context.record.sourceRecordId}` };
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }

  private requirePage(): OpenEmrPage {
    if (!this.page) throw new Error("OpenEMR adapter was not prepared.");
    return this.page;
  }
}

async function fillFirst(page: OpenEmrPage, selectors: string[], value: string): Promise<void> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) {
      const tagName = await locator.evaluate((element) => element.tagName.toLowerCase()).catch(() => "input");
      if (tagName === "select") {
        await locator.selectOption({ label: value }).catch(() => locator.selectOption(value));
      } else {
        await locator.fill(value);
      }
      return;
    }
  }
  throw new Error(`No OpenEMR selector matched for value ${value}.`);
}

async function clickFirst(page: OpenEmrPage, selectors: string[]): Promise<void> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) {
      await locator.click();
      return;
    }
  }
  throw new Error(`No OpenEMR click selector matched: ${selectors.join(", ")}`);
}

async function navigateToNewPatient(page: OpenEmrPage): Promise<void> {
  await clickFirst(page, OPENEMR_NEW_PATIENT_CANDIDATES);
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

async function visibleText(page: OpenEmrPage): Promise<string> {
  return page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
}
