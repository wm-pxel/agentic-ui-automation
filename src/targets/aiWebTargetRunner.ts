import { chromium } from "@playwright/test";
import type { FileAuditStore } from "../audit/auditStore.js";
import type { ReportFieldMapping } from "../audit/auditStore.js";
import type { NormalizedIntakeRecord, ValidationException } from "../domain/schema.js";
import type { AiWebPlanner, AiWebRecentAction } from "./aiWebPlanner.js";
import type { AiWebAction, BrowserExecutableAiWebAction } from "./browserActions.js";
import { executeBrowserAction } from "./browserActions.js";
import { createObservationSnapshot } from "./pageObservation.js";
import type { TargetProfile } from "./profiles.js";

const DEFAULT_MAX_STEPS = 50;
const FIELD_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;

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
  confirmFieldMapping?: FieldMappingConfirmer;
}

export type FieldMappingConfirmation =
  | { type: "confirm" }
  | { type: "edit"; value: string }
  | { type: "skip"; reason: string }
  | { type: "stop"; reason: string };

export type FieldMappingConfirmationInput = {
  profile: TargetProfile;
  record: NormalizedIntakeRecord;
  action: Extract<AiWebAction, { type: "fill" | "select" }>;
  confidence: number;
  threshold: number;
  selectedSelector?: string;
  screenshotPath?: string;
};

export type FieldMappingConfirmer = (input: FieldMappingConfirmationInput) => Promise<FieldMappingConfirmation>;

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
    const recentActions: AiWebRecentAction[] = [];

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
          recentActions: [...recentActions],
          stepCount,
        });
        const action = plan.action;

        if (action.type === "stop") {
          if (shouldWaitInsteadOfStopping(action, observation, stepCount, this.maxSteps)) {
            const waitAction: AiWebAction = { type: "wait", reason: "Observed page has no actionable controls yet." };
            await executeBrowserAction(page, observation.elementSelectors, waitAction);
            await writeAiActionEvent(context, waitAction, latestScreenshotPath, "succeeded");
            rememberRecentAction(recentActions, waitAction, "succeeded");
            continue;
          }

          await writeAiActionEvent(context, action, latestScreenshotPath, "stopped", action.code);
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
          const verificationFailure = verificationFailureMessage(context.record, observation);
          if (verificationFailure) {
            await writeAiActionEvent(
              context,
              action,
              latestScreenshotPath,
              verificationFailure.eventResult,
              "verification_failed",
            );
            rememberRecentAction(recentActions, action, verificationFailure.eventResult);
            if (stepCount < this.maxSteps) {
              continue;
            }

            const exception = verificationException(verificationFailure, latestScreenshotPath);
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
          await writeAiActionEvent(context, action, latestScreenshotPath, "succeeded");
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
          await writeAiActionEvent(context, action, latestScreenshotPath, "captured");
          rememberRecentAction(recentActions, action, "captured");
          continue;
        }

        const forbiddenOperation = forbiddenOperationForAction(action, observation, context.profile);
        if (forbiddenOperation) {
          const exception = {
            code: "ui_state_unexpected",
            severity: "error",
            message: `AI action matched a forbidden target operation: ${forbiddenOperation}.`,
            screenshotPath: latestScreenshotPath,
          } satisfies ValidationException & { screenshotPath?: string };
          await writeAiActionEvent(
            context,
            action,
            latestScreenshotPath,
            "failed: forbidden target operation",
            "ui_state_unexpected",
          );
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

        let executableAction = executableActionForObservedControl(action, observation);
        let approvalSource: ReportFieldMapping["approvalSource"] = "agent";
        let originalProposedValue: string | undefined;
        let finalValue: string | undefined;
        if (action.type === "fill" || action.type === "select") {
          const selectedSelector = observation.elementSelectors.get(action.elementId);
          const confirmation = await confirmLowConfidenceFieldIfNeeded({
            dependencies: this.dependencies,
            context,
            page,
            action,
            confidence: plan.confidence,
            selectedSelector,
            screenshotPath: latestScreenshotPath,
          });

          if (confirmation.type === "stop") {
            const exception = {
              code: "ui_state_unexpected",
              severity: "error",
              field: action.field,
              message: confirmation.reason,
              suggestedRemediation: action.rationale,
              screenshotPath: latestScreenshotPath,
              proposedValue: action.value,
              confidenceThreshold: context.profile.confidenceThreshold,
              agentConfidence: plan.confidence,
            } satisfies ValidationException & Record<string, unknown>;
            await context.audit.writeFieldMapping({
              recordId: context.record.sourceRecordId,
              target: context.profile.name,
              sourceField: action.field,
              targetField: action.field,
              normalizedValue: action.value,
              selectorCandidates: selectorCandidatesForAction(observation.elementSelectors, action),
              selectedSelector,
              action: action.type,
              status: "failed",
              agentConfidence: plan.confidence,
              confidenceThreshold: context.profile.confidenceThreshold,
              agentRationale: action.rationale,
              approvalSource: "operator_stopped",
              originalProposedValue: action.value,
              finalValue: action.value,
              errorMessage: confirmation.reason,
              fieldScreenshotPath: latestScreenshotPath,
            });
            await writeAiActionEvent(context, action, latestScreenshotPath, "stopped by operator", "ui_state_unexpected");
            await context.audit.writeTargetEvidence({
              recordId: context.record.sourceRecordId,
              target: context.profile.name,
              status: "exception",
              screenshotPath: latestScreenshotPath,
              fieldScreenshotPath: latestFieldScreenshotPath,
              message: confirmation.reason,
            });
            return { status: "exception", exception };
          }

          if (confirmation.type === "skip") {
            skippedFields.push(action.field);
            await context.audit.writeFieldMapping({
              recordId: context.record.sourceRecordId,
              target: context.profile.name,
              sourceField: action.field,
              targetField: action.field,
              normalizedValue: action.value,
              selectorCandidates: selectorCandidatesForAction(observation.elementSelectors, action),
              selectedSelector,
              action: action.type,
              status: "skipped",
              agentConfidence: plan.confidence,
              confidenceThreshold: context.profile.confidenceThreshold,
              agentRationale: action.rationale,
              approvalSource: "operator_skipped",
              originalProposedValue: action.value,
              skipReason: confirmation.reason,
              fieldScreenshotPath: latestScreenshotPath,
            });
            await writeAiActionEvent(context, action, latestScreenshotPath, "skipped by operator");
            rememberRecentAction(recentActions, action, "skipped by operator");
            continue;
          }

          if (confirmation.type === "confirm") {
            approvalSource = shouldPromptForField(context.profile, plan.confidence) ? "operator_confirmed" : "agent";
            finalValue = action.value;
          } else {
            approvalSource = "operator_edited";
            originalProposedValue = action.value;
            finalValue = confirmation.value;
            executableAction = executableActionForObservedControl({ ...action, value: confirmation.value }, observation);
          }
        }

        try {
          await executeBrowserAction(page, observation.elementSelectors, executableAction);
        } catch (error) {
          const exception = exceptionFromError(error, latestScreenshotPath);
          const failedResult = `failed: ${exception.message}`;
          await writeAiActionEvent(
            context,
            action,
            latestScreenshotPath,
            failedResult,
            "ui_state_unexpected",
          );
          rememberRecentAction(recentActions, action, failedResult);
          if (stepCount < this.maxSteps) {
            continue;
          }
          throw error;
        }

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
            confidenceThreshold: context.profile.confidenceThreshold,
            agentRationale: action.rationale,
            approvalSource,
            originalProposedValue,
            finalValue: finalValue ?? action.value,
            fieldScreenshotPath: latestFieldScreenshotPath,
          } satisfies ReportFieldMapping;
          await context.audit.writeFieldMapping(mapping);
          await writeAiActionEvent(context, action, latestFieldScreenshotPath, "succeeded");
          rememberRecentAction(recentActions, action, "succeeded");
        } else {
          await writeAiActionEvent(context, action, latestScreenshotPath, "succeeded");
          rememberRecentAction(recentActions, action, "succeeded");
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

function shouldWaitInsteadOfStopping(
  action: Extract<AiWebAction, { type: "stop" }>,
  observation: { controls: readonly unknown[]; visibleText: string },
  stepCount: number,
  maxSteps: number,
): boolean {
  if (stepCount >= maxSteps) {
    return false;
  }

  if (observation.controls.length === 0 && normalizeForVerification(observation.visibleText).length === 0) {
    return true;
  }

  const stopText = normalizeForVerification(action.message);
  return (
    observation.controls.length <= 3 &&
    /\b(no safe|no observable|only help|only .* controls|not currently available)\b/.test(stopText)
  );
}

async function confirmLowConfidenceFieldIfNeeded(input: {
  dependencies: AiWebTargetRunnerDependencies;
  context: AiWebTargetRunContext;
  page: AiWebTargetPage;
  action: Extract<AiWebAction, { type: "fill" | "select" }>;
  confidence: number;
  selectedSelector?: string;
  screenshotPath?: string;
}): Promise<FieldMappingConfirmation> {
  const threshold = input.context.profile.confidenceThreshold;
  if (!shouldPromptForField(input.context.profile, input.confidence) || threshold === undefined) {
    return { type: "confirm" };
  }

  const confirmationInput = {
    profile: input.context.profile,
    record: input.context.record,
    action: input.action,
    confidence: input.confidence,
    threshold,
    selectedSelector: input.selectedSelector,
    screenshotPath: input.screenshotPath,
  };

  if (input.dependencies.confirmFieldMapping) {
    return input.dependencies.confirmFieldMapping(confirmationInput);
  }

  return promptForFieldMappingInBrowser(input.page, confirmationInput);
}

function shouldPromptForField(profile: TargetProfile, confidence: number): boolean {
  return (
    profile.fieldConfirmation === "prompt-on-low-confidence" &&
    profile.confidenceThreshold !== undefined &&
    confidence < profile.confidenceThreshold
  );
}

async function promptForFieldMappingInBrowser(
  page: AiWebTargetPage,
  input: FieldMappingConfirmationInput,
): Promise<FieldMappingConfirmation> {
  const result = await withFieldPromptTimeout(page.evaluate(fieldConfirmationPromptScript(input)));
  if (!isFieldMappingConfirmation(result)) {
    return { type: "stop", reason: "Field confirmation prompt returned an invalid response." };
  }
  return result;
}

function withFieldPromptTimeout<T>(prompt: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Field confirmation prompt timed out.")), FIELD_CONFIRMATION_TIMEOUT_MS);
  });
  return Promise.race([prompt, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function isFieldMappingConfirmation(value: unknown): value is FieldMappingConfirmation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "confirm") return true;
  if (candidate.type === "edit") return typeof candidate.value === "string";
  if (candidate.type === "skip" || candidate.type === "stop") return typeof candidate.reason === "string";
  return false;
}

function fieldConfirmationPromptScript(input: FieldMappingConfirmationInput): string {
  const encoded = encodeURIComponent(
    JSON.stringify({
      target: input.profile.displayName,
      recordId: input.record.sourceRecordId,
      sourceField: input.action.field,
      proposedValue: input.action.value,
      selectedSelector: input.selectedSelector ?? input.action.elementId,
      confidence: formatPercent(input.confidence),
      threshold: formatPercent(input.threshold),
      rationale: input.action.rationale,
    }),
  );

  return `/* agentic-field-confirmation-input:${encoded} */
(function () {
  var input = JSON.parse(decodeURIComponent("${encoded}"));
  var existing = document.querySelector("#agentic-field-confirmation");
  if (existing) existing.remove();

  return new Promise(function (resolve) {
    var overlay = document.createElement("div");
    overlay.id = "agentic-field-confirmation";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.72);display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif;color:#111827;";

    var form = document.createElement("form");
    form.style.cssText = "width:min(560px,calc(100vw - 32px));background:#fff;border-radius:8px;box-shadow:0 24px 80px rgba(0,0,0,.35);padding:24px;display:grid;gap:14px;";

    var title = document.createElement("h2");
    title.textContent = "Review Low-Confidence Field";
    title.style.cssText = "margin:0;font-size:20px;line-height:1.25;";

    var details = document.createElement("dl");
    details.style.cssText = "display:grid;grid-template-columns:max-content 1fr;gap:8px 12px;margin:0;font-size:14px;";
    function addDetail(label, value) {
      var term = document.createElement("dt");
      term.textContent = label;
      term.style.cssText = "font-weight:700;color:#374151;";
      var description = document.createElement("dd");
      description.textContent = value || "";
      description.style.cssText = "margin:0;overflow-wrap:anywhere;";
      details.appendChild(term);
      details.appendChild(description);
    }
    addDetail("Target", input.target);
    addDetail("Record", input.recordId);
    addDetail("Field", input.sourceField);
    addDetail("Confidence", input.confidence + " below " + input.threshold);
    addDetail("Selector", input.selectedSelector);
    addDetail("Rationale", input.rationale);

    var valueInput = document.createElement("input");
    valueInput.value = input.proposedValue;
    valueInput.setAttribute("aria-label", "Field value");
    valueInput.style.cssText = "width:100%;box-sizing:border-box;border:1px solid #9ca3af;border-radius:6px;padding:10px 12px;font-size:16px;";

    var buttons = document.createElement("div");
    buttons.style.cssText = "display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;";
    function finish(result) {
      overlay.remove();
      resolve(result);
    }
    function addButton(label, onClick, primary, danger) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.style.cssText = "border:1px solid #9ca3af;background:#fff;border-radius:6px;padding:9px 12px;font-size:14px;cursor:pointer;";
      if (primary) button.style.cssText += "background:#2563eb;border-color:#2563eb;color:#fff;";
      if (danger) button.style.cssText += "background:#b91c1c;border-color:#b91c1c;color:#fff;";
      button.addEventListener("click", onClick);
      buttons.appendChild(button);
    }
    addButton("Use AI-Mapped Value", function () {
      var value = valueInput.value;
      finish(value === input.proposedValue ? { type: "confirm" } : { type: "edit", value: value });
    }, true, false);
    addButton("Apply Typed Value", function () { finish({ type: "edit", value: valueInput.value }); }, false, false);
    addButton("Skip Field", function () { finish({ type: "skip", reason: "Operator skipped low-confidence field." }); }, false, false);
    addButton("Stop Record", function () { finish({ type: "stop", reason: "Operator stopped low-confidence field confirmation." }); }, false, true);

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var value = valueInput.value;
      finish(value === input.proposedValue ? { type: "confirm" } : { type: "edit", value: value });
    });
    form.appendChild(title);
    form.appendChild(details);
    form.appendChild(valueInput);
    form.appendChild(buttons);
    overlay.appendChild(form);
    document.body.appendChild(overlay);
    valueInput.focus();
  });
})()`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function executableActionForObservedControl(
  action: BrowserExecutableAiWebAction,
  observation: { controls: Array<{ elementId: string; tag: string; label?: string; visibleText?: string; role?: string }> },
): BrowserExecutableAiWebAction {
  if (action.type === "click") {
    const forwardAction = forwardNavigationActionForIntent(action, observation.controls);
    if (forwardAction) {
      return forwardAction;
    }
  }

  if (action.type !== "select") {
    return action;
  }

  const control = observation.controls.find((item) => item.elementId === action.elementId);
  if (control?.tag === "select") {
    return action;
  }

  return {
    type: "click",
    elementId: action.elementId,
    purpose: `select ${action.value}`,
    rationale: action.rationale,
  };
}

function forwardNavigationActionForIntent(
  action: Extract<BrowserExecutableAiWebAction, { type: "click" }>,
  controls: Array<{ elementId: string; label?: string; visibleText?: string; role?: string }>,
): Extract<BrowserExecutableAiWebAction, { type: "click" }> | undefined {
  const intent = normalizeForVerification(`${action.purpose} ${action.rationale}`);
  if (!/\b(forward|next|continue|proceed|advance)\b/.test(intent)) {
    return undefined;
  }

  const selectedControl = controls.find((control) => control.elementId === action.elementId);
  if (controlTextMatches(selectedControl, /\b(forward next|next button|continue|proceed|advance)\b/)) {
    return undefined;
  }

  const forwardControl = controls.find(
    (control) => control.role === "button" && controlTextMatches(control, /\b(forward next|next button|continue|proceed|advance)\b/),
  );
  if (!forwardControl) {
    return undefined;
  }

  return {
    ...action,
    elementId: forwardControl.elementId,
  };
}

function controlTextMatches(
  control: { label?: string; visibleText?: string } | undefined,
  pattern: RegExp,
): boolean {
  if (!control) {
    return false;
  }
  return pattern.test(normalizeForVerification(`${control.label ?? ""} ${control.visibleText ?? ""}`));
}

function rememberRecentAction(recentActions: AiWebRecentAction[], action: AiWebAction, result: string): void {
  recentActions.push({
    actionType: action.type,
    target: targetForRecentAction(action),
    result,
  });

  if (recentActions.length > 8) {
    recentActions.splice(0, recentActions.length - 8);
  }
}

function targetForRecentAction(action: AiWebAction): string {
  switch (action.type) {
    case "fill":
    case "select":
      return action.field;
    case "click":
      return action.purpose;
    case "wait":
      return action.reason;
    case "screenshot":
      return action.label;
    case "verify":
      return action.criteria;
    case "stop":
      return action.message;
  }
}

async function captureScreenshot(context: AiWebTargetRunContext, page: AiWebTargetPage, step: string): Promise<string> {
  const bytes = await page.screenshot({ fullPage: true });
  return context.audit.writeScreenshot(context.record.sourceRecordId, context.profile.name, step, bytes);
}

async function writeAiActionEvent(
  context: AiWebTargetRunContext,
  action: AiWebAction,
  screenshotPath: string | undefined,
  result: string,
  exceptionCode?: ValidationException["code"],
): Promise<void> {
  await context.audit.writeEvent({
    recordId: context.record.sourceRecordId,
    target: context.profile.name,
    phase: "target",
    actionType: `ai-${action.type}`,
    rationale: rationaleForAction(action),
    screenshotPath,
    result,
    exceptionCode,
  });
}

function aiTargetRecordId(context: AiWebTargetRunContext): string {
  return `ai-${context.profile.name}-${context.record.sourceRecordId}`;
}

function verificationFailureMessage(
  record: NormalizedIntakeRecord,
  observation: { currentUrl: string; title: string; visibleText: string; controls?: Array<{ label: string; value: string; visibleText: string }> },
): { message: string; eventResult: string } | undefined {
  if (!syntheticPatientNameVisible(record, verificationEvidenceText(observation))) {
    return {
      message: "AI verification did not find the synthetic patient name in the observed page.",
      eventResult: "failed: synthetic patient name not visible",
    };
  }

  if (!savedPatientStateVisible(observation)) {
    return {
      message: "AI verification did not find a saved patient state in the observed page.",
      eventResult: "failed: saved patient state not visible",
    };
  }

  return undefined;
}

function verificationEvidenceText(observation: {
  visibleText: string;
  controls?: Array<{ label: string; value: string; visibleText: string }>;
}): string {
  const controlText =
    observation.controls?.map((control) => [control.label, control.value, control.visibleText].filter(Boolean).join(" ")).join(" ") ?? "";
  return `${observation.visibleText} ${controlText}`;
}

function verificationException(
  failure: { message: string },
  screenshotPath: string | undefined,
): ValidationException & { screenshotPath?: string } {
  return {
    code: "verification_failed",
    severity: "error",
    message: failure.message,
    screenshotPath,
  };
}

function syntheticPatientNameVisible(record: NormalizedIntakeRecord, visibleText: string): boolean {
  const normalizedText = normalizeForVerification(visibleText);
  const nameParts = [record.firstName, record.lastName].map(normalizeForVerification).filter(Boolean);
  return nameParts.length > 0 && nameParts.every((part) => normalizedText.includes(part));
}

function savedPatientStateVisible(observation: { currentUrl: string; title: string; visibleText: string }): boolean {
  const stateText = normalizeForVerification(`${observation.currentUrl} ${observation.title} ${observation.visibleText}`);
  const savedStateTerms = [
    "patient details",
    "patient detail",
    "patient dashboard",
    "patient summary",
    "patient profile",
    "patient record",
    "patient chart",
    "patient summary",
    "patient id",
    "diagnoses",
    "recent visits",
    "general actions",
    "resumen del paciente",
    "resumen",
    "visitas",
    "alergias",
    "medicamentos",
    "condiciones",
    "mrn-",
    "new encounter",
    "start first encounter",
    "created",
    "registered",
    "saved",
    "success",
  ];
  return savedStateTerms.some((term) => stateText.includes(term));
}

function forbiddenOperationForAction(
  action: BrowserExecutableAiWebAction,
  observation: { controls: Array<{ elementId: string; label: string; visibleText: string; role: string }> },
  profile: TargetProfile,
): string | undefined {
  if (action.type !== "click") {
    return undefined;
  }

  const control = observation.controls.find((item) => item.elementId === action.elementId);
  const visibleDescription = [control?.label, control?.visibleText, action.purpose].filter(Boolean).join(" ");
  const normalized = normalizeForVerification(visibleDescription);
  if (!normalized) {
    return undefined;
  }

  const forbiddenTerms = forbiddenTermsForProfile(profile);
  return forbiddenTerms.some((term) => normalized.includes(term)) ? (control?.visibleText || control?.label || action.purpose) : undefined;
}

function forbiddenTermsForProfile(profile: TargetProfile): string[] {
  const profileText = profile.forbiddenActions.map(normalizeForVerification).join(" ");
  const terms = new Set<string>();
  const candidates = [
    "delete",
    "remove",
    "purge",
    "deactivate",
    "void",
    "admin settings",
    "settings",
    "export",
    "patient lists",
    "unrelated records",
    "real patient data",
  ];
  for (const candidate of candidates) {
    if (profileText.includes(candidate) || ["delete", "remove", "purge", "settings", "export"].includes(candidate)) {
      terms.add(candidate);
    }
  }
  return [...terms];
}

function normalizeForVerification(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
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
