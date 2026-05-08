import { chromium } from "@playwright/test";
import type { FileAuditStore } from "../audit/auditStore.js";
import type { ReportFieldMapping } from "../audit/auditStore.js";
import type { NormalizedIntakeRecord, ValidationException } from "../domain/schema.js";
import type { AiWebPlanner } from "./aiWebPlanner.js";
import type { AiWebAction, BrowserExecutableAiWebAction } from "./browserActions.js";
import { executeBrowserAction } from "./browserActions.js";
import { createObservationSnapshot } from "./pageObservation.js";
import type { TargetProfile } from "./profiles.js";

const DEFAULT_MAX_STEPS = 30;

export type AiWebTargetResult =
  | {
      status: "succeeded";
      targetRecordId?: string;
    }
  | {
      status: "skipped";
      reason: string;
    }
  | {
      status: "exception";
      exception: ValidationException & Record<string, unknown>;
    };

export interface AiWebTargetRunContext {
  runId: string;
  profile: TargetProfile;
  record: NormalizedIntakeRecord;
  audit: FileAuditStore;
}

export interface AiWebTargetRunnerDependencies {
  planner: AiWebPlanner;
  launchBrowser?: (options: Parameters<typeof chromium.launch>[0]) => Promise<AiWebTargetBrowser>;
  maxSteps?: number;
}

interface AiWebTargetBrowser {
  close(): Promise<void>;
  newPage(options: { viewport: { width: number; height: number } }): Promise<AiWebTargetPage>;
}

interface AiWebTargetPage {
  goto(url: string, options: { waitUntil: "domcontentloaded" }): Promise<unknown>;
  screenshot(options: { fullPage: boolean }): Promise<Buffer>;
  url(): string;
  title(): Promise<string>;
  locator(selector: string): {
    innerText(): Promise<string>;
    fill(value: string, options?: { timeout: number }): Promise<unknown>;
    selectOption(option: { label: string }, options?: { timeout: number }): Promise<unknown>;
    click(options?: { timeout: number }): Promise<unknown>;
  };
  evaluate<T>(pageFunction?: unknown): Promise<T>;
  waitForTimeout?(timeoutMs: number): Promise<unknown>;
}

export class AiWebTargetRunner {
  private readonly launchBrowser: (options: Parameters<typeof chromium.launch>[0]) => Promise<AiWebTargetBrowser>;
  private readonly maxSteps: number;

  constructor(private readonly dependencies: AiWebTargetRunnerDependencies) {
    this.launchBrowser = dependencies.launchBrowser ?? ((options) => chromium.launch(options));
    this.maxSteps = dependencies.maxSteps ?? DEFAULT_MAX_STEPS;
  }

  async runRecord(context: AiWebTargetRunContext): Promise<AiWebTargetResult> {
    let browser: AiWebTargetBrowser | undefined;
    let latestScreenshotPath: string | undefined;
    let latestFieldScreenshotPath: string | undefined;
    const completedFields: string[] = [];
    const skippedFields: string[] = [];

    try {
      browser = await this.launchBrowser({
        headless: false,
        chromiumSandbox: true,
        env: {},
      });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.goto(context.profile.baseUrl, { waitUntil: "domcontentloaded" });

      for (let stepCount = 1; stepCount <= this.maxSteps; stepCount += 1) {
        latestScreenshotPath = await captureScreenshot(context, page, `ai-step-${stepCount}`);
        const observation = await createObservationSnapshot({ page, screenshotPath: latestScreenshotPath });
        const plan = await this.dependencies.planner.plan({
          profile: context.profile,
          record: context.record,
          observation,
          completedFields,
          skippedFields,
          stepCount,
        });
        const action = plan.action;

        await context.audit.writeEvent({
          recordId: context.record.sourceRecordId,
          target: context.profile.name,
          phase: "target",
          actionType: `ai-${action.type}`,
          rationale: rationaleForAction(action),
          screenshotPath: latestScreenshotPath,
          result: action.type,
          exceptionCode: action.type === "stop" ? action.code : undefined,
        });

        if (action.type === "stop") {
          const exception = exceptionForStop(action, latestScreenshotPath);
          await context.audit.writeTargetEvidence({
            recordId: context.record.sourceRecordId,
            target: context.profile.name,
            status: "exception",
            screenshotPath: latestScreenshotPath,
            fieldScreenshotPath: latestFieldScreenshotPath,
            message: exception.message,
          });
          return { status: "exception", exception };
        }

        if (action.type === "verify") {
          const targetRecordId = aiTargetRecordId(context);
          await context.audit.writeTargetEvidence({
            recordId: context.record.sourceRecordId,
            target: context.profile.name,
            status: "succeeded",
            screenshotPath: latestScreenshotPath,
            fieldScreenshotPath: latestFieldScreenshotPath,
            targetRecordId,
            message: action.criteria,
          });
          return { status: "succeeded", targetRecordId };
        }

        if (action.type === "screenshot") {
          latestScreenshotPath = await captureScreenshot(context, page, `ai-${action.label}`);
          continue;
        }

        await executeBrowserAction(page, observation.elementSelectors, action);

        if (action.type === "fill" || action.type === "select") {
          completedFields.push(action.field);
          latestFieldScreenshotPath = await captureScreenshot(context, page, `ai-field-${action.field}`);
          const mapping = {
            recordId: context.record.sourceRecordId,
            target: context.profile.name,
            sourceField: action.field,
            targetField: action.field,
            normalizedValue: action.value,
            selectorCandidates: selectorCandidatesForAction(observation.elementSelectors, action),
            selectedSelector: observation.elementSelectors.get(action.elementId),
            action: action.type,
            status: "succeeded",
            agentConfidence: plan.confidence,
            agentRationale: action.rationale,
            approvalSource: "agent",
            finalValue: action.value,
            fieldScreenshotPath: latestFieldScreenshotPath,
          } satisfies ReportFieldMapping;
          await context.audit.writeFieldMapping(mapping);
        }
      }

      const exception = {
        code: "ui_state_unexpected",
        severity: "error",
        message: `AI web target runner exceeded ${this.maxSteps} steps without verification.`,
        screenshotPath: latestScreenshotPath,
      } satisfies ValidationException & { screenshotPath?: string };
      await context.audit.writeTargetEvidence({
        recordId: context.record.sourceRecordId,
        target: context.profile.name,
        status: "exception",
        screenshotPath: latestScreenshotPath,
        fieldScreenshotPath: latestFieldScreenshotPath,
        message: exception.message,
      });
      return { status: "exception", exception };
    } catch (error) {
      const exception = exceptionFromError(error, latestScreenshotPath);
      await context.audit.writeTargetEvidence({
        recordId: context.record.sourceRecordId,
        target: context.profile.name,
        status: "exception",
        screenshotPath: latestScreenshotPath,
        fieldScreenshotPath: latestFieldScreenshotPath,
        message: exception.message,
      });
      return { status: "exception", exception };
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }
}

async function captureScreenshot(context: AiWebTargetRunContext, page: AiWebTargetPage, step: string): Promise<string> {
  const bytes = await page.screenshot({ fullPage: true });
  return context.audit.writeScreenshot(context.record.sourceRecordId, context.profile.name, step, bytes);
}

function aiTargetRecordId(context: AiWebTargetRunContext): string {
  return `ai-${context.profile.name}-${context.record.sourceRecordId}`;
}

function selectorCandidatesForAction(
  elementSelectors: Map<string, string>,
  action: Extract<BrowserExecutableAiWebAction, { type: "fill" | "select" }>,
): string[] {
  const selector = elementSelectors.get(action.elementId);
  return selector ? [selector] : [];
}

function rationaleForAction(action: AiWebAction): string | undefined {
  switch (action.type) {
    case "fill":
    case "select":
    case "click":
    case "verify":
      return action.rationale;
    case "wait":
      return action.reason;
    case "screenshot":
      return action.label;
    case "stop":
      return action.message;
  }
}

function exceptionForStop(
  action: Extract<AiWebAction, { type: "stop" }>,
  screenshotPath: string | undefined,
): ValidationException & { screenshotPath?: string } {
  return {
    code: action.code,
    severity: "error",
    message: action.message,
    screenshotPath,
  };
}

function exceptionFromError(error: unknown, screenshotPath: string | undefined): ValidationException & { screenshotPath?: string } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "ui_state_unexpected",
    severity: "error",
    message,
    screenshotPath,
  };
}
