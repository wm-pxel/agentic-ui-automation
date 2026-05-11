import { chromium } from "@playwright/test";
import type { FileAuditStore } from "../audit/auditStore.js";
import type { ReportFieldMapping } from "../audit/auditStore.js";
import type { NormalizedIntakeRecord, ValidationException } from "../domain/schema.js";
import type { AiWebPlanner, AiWebRecentAction } from "./aiWebPlanner.js";
import type { AiWebAction, BrowserExecutableAiWebAction } from "./browserActions.js";
import { executeBrowserAction } from "./browserActions.js";
import { normalizedIntakeFieldEntries } from "./intakeFieldCoverage.js";
import { createObservationSnapshot } from "./pageObservation.js";
import type { TargetProfile } from "./profiles.js";

const DEFAULT_MAX_STEPS = 50;
const FIELD_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_AUTONOMOUS_FIELD_CONFIDENCE = 0.5;

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
          if (!verificationFailureMessage(context.record, observation)) {
            const verifyAction: AiWebAction = {
              type: "verify",
              criteria: savedPatientProofMessage(context.record),
              rationale: "The deterministic verification checks found the synthetic patient in a saved patient state.",
            };
            latestScreenshotPath = await prepareSuccessfulVerificationScreenshot({
              context,
              page,
              observation,
              screenshotPath: latestScreenshotPath,
            });
            await writeSuccessfulVerificationEvidence(
              context,
              verifyAction,
              latestScreenshotPath,
              latestFieldScreenshotPath,
              completedFields,
              skippedFields,
            );
            return { status: "succeeded", targetRecordId: aiTargetRecordId(context) };
          }

          if (shouldWaitInsteadOfStoppingTransientOpenKairoLoading(action, observation, context.profile)) {
            const waitAction: AiWebAction = { type: "wait", reason: "OpenKairo New Patient dialog is still loading fields." };
            await executeBrowserAction(page, observation.elementSelectors, waitAction);
            await writeAiActionEvent(context, waitAction, latestScreenshotPath, "succeeded");
            rememberRecentAction(recentActions, waitAction, "succeeded");
            continue;
          }

          const reopenAction = reopenOpenKairoNewPatientAction(action, observation, context.profile);
          if (reopenAction) {
            completedFields.length = 0;
            skippedFields.length = 0;
            recentActions.length = 0;
            latestFieldScreenshotPath = undefined;
            await executeBrowserAction(page, observation.elementSelectors, reopenAction);
            await writeAiActionEvent(context, reopenAction, latestScreenshotPath, "succeeded");
            rememberRecentAction(recentActions, reopenAction, "succeeded");
            continue;
          }

          const continueAction = continueWizardInsteadOfStoppingAction(action, observation);
          if (continueAction) {
            await executeBrowserAction(page, observation.elementSelectors, continueAction);
            await writeAiActionEvent(context, continueAction, latestScreenshotPath, "succeeded");
            rememberRecentAction(recentActions, continueAction, "succeeded");
            continue;
          }

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
          latestScreenshotPath = await prepareSuccessfulVerificationScreenshot({
            context,
            page,
            observation,
            screenshotPath: latestScreenshotPath,
          });
          await writeSuccessfulVerificationEvidence(
            context,
            action,
            latestScreenshotPath,
            latestFieldScreenshotPath,
            completedFields,
            skippedFields,
          );
          return { status: "succeeded", targetRecordId: aiTargetRecordId(context) };
        }

        if (action.type === "screenshot") {
          latestScreenshotPath = await captureScreenshot(context, page, `ai-${action.label}`);
          await writeAiActionEvent(context, action, latestScreenshotPath, "captured");
          rememberRecentAction(recentActions, action, "captured");
          continue;
        }

        if (shouldWaitInsteadOfClickingTransientOpenKairoClose(action, observation, context.profile)) {
          const waitAction: AiWebAction = { type: "wait", reason: "OpenKairo New Patient dialog is still loading fields." };
          await executeBrowserAction(page, observation.elementSelectors, waitAction);
          await writeAiActionEvent(context, waitAction, latestScreenshotPath, "succeeded");
          rememberRecentAction(recentActions, waitAction, "succeeded");
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
        let targetField = "";
        let credentialAction = false;
        if (action.type === "fill" || action.type === "select") {
          const selectedSelector = observation.elementSelectors.get(action.elementId);
          targetField = targetFieldForAction(observation, action);
          credentialAction = isCredentialFieldAction(context.profile, action);
          if (!credentialAction && shouldSkipUnsafeAutonomousFieldAction(context.profile, plan.confidence)) {
            skippedFields.push(action.field);
            const skipReason = "AI confidence was too low to safely fill this field without operator input.";
            await context.audit.writeFieldMapping({
              recordId: context.record.sourceRecordId,
              target: context.profile.name,
              sourceField: action.field,
              targetField,
              normalizedValue: action.value,
              selectorCandidates: selectorCandidatesForAction(observation.elementSelectors, action),
              selectedSelector,
              action: action.type,
              status: "skipped",
              agentConfidence: plan.confidence,
              confidenceThreshold: context.profile.confidenceThreshold,
              agentRationale: action.rationale,
              approvalSource: "agent",
              originalProposedValue: action.value,
              skipReason,
              fieldScreenshotPath: latestScreenshotPath,
            });
            await writeAiActionEvent(context, action, latestScreenshotPath, `skipped: ${skipReason}`);
            rememberRecentAction(recentActions, action, `skipped: ${skipReason}`);
            continue;
          }

          const confirmation = credentialAction ? { type: "confirm" } satisfies FieldMappingConfirmation : await confirmLowConfidenceFieldIfNeeded({
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
              targetField,
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
              targetField,
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
          if (credentialAction) {
            await writeAiActionEvent(context, action, latestScreenshotPath, "succeeded");
            rememberRecentAction(recentActions, action, "succeeded");
            continue;
          }

          completedFields.push(action.field);
          latestFieldScreenshotPath = await captureScreenshot(context, page, `ai-field-${action.field}`);
          const mapping = {
            recordId: context.record.sourceRecordId,
            target: context.profile.name,
            sourceField: action.field,
            targetField,
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

function shouldSkipUnsafeAutonomousFieldAction(profile: TargetProfile, confidence: number): boolean {
  return (
    profile.fieldConfirmation !== "prompt-on-low-confidence" &&
    profile.confidenceThreshold !== undefined &&
    confidence < profile.confidenceThreshold &&
    confidence < MIN_AUTONOMOUS_FIELD_CONFIDENCE
  );
}

function isCredentialFieldAction(
  profile: TargetProfile,
  action: Extract<AiWebAction, { type: "fill" | "select" }>,
): boolean {
  const value = action.value.trim();
  if (!value) {
    return false;
  }

  return value === profile.credentials.username || value === profile.credentials.password;
}

function continueWizardInsteadOfStoppingAction(
  action: Extract<AiWebAction, { type: "stop" }>,
  observation: {
    controls: Array<{ elementId: string; label?: string; visibleText?: string; role?: string }>;
  },
): Extract<AiWebAction, { type: "click" }> | undefined {
  if (action.code !== "ui_state_unexpected") {
    return undefined;
  }

  const stopText = normalizeForVerification(action.message);
  if (!unsupportedDestinationFieldsStopMessage(stopText)) {
    return undefined;
  }

  const forwardControl = observation.controls.find(
    (control) => control.role === "button" && controlTextMatches(control, /\b(forward next|next button|continue|proceed|advance)\b/),
  );
  if (forwardControl) {
    return {
      type: "click",
      elementId: forwardControl.elementId,
      purpose: "continue registration wizard",
      rationale: "The destination has no visible matching field for the remaining intake data, but a forward navigation control can continue the save flow.",
    };
  }

  const submitControl = observation.controls.find(
    (control) =>
      control.role === "button" &&
      controlTextMatches(control, /\b(create patient|save patient|save|submit|register patient|register)\b/) &&
      !controlTextMatches(control, /\b(cancel|close|dismiss|back|previous)\b/),
  );
  if (!submitControl) {
    return undefined;
  }

  return {
    type: "click",
    elementId: submitControl.elementId,
    purpose: "save patient with supported destination fields",
    rationale: "The destination has no visible matching field for the remaining intake data, but a save/create control can persist the supported patient fields.",
  };
}

function unsupportedDestinationFieldsStopMessage(stopText: string): boolean {
  return /\b(no safe|no remaining|remaining intake|remaining pending intake|matching controls|unsupported|no editable|cannot safely continue|does not match the remaining)\b/.test(stopText);
}

function shouldWaitInsteadOfClickingTransientOpenKairoClose(
  action: AiWebAction,
  observation: {
    controls: Array<{ elementId: string; label?: string; visibleText?: string; role?: string }>;
    visibleText: string;
  },
  profile: TargetProfile,
): boolean {
  if (profile.name !== "openkairo" || action.type !== "click") {
    return false;
  }

  const control = observation.controls.find((item) => item.elementId === action.elementId);
  const actionText = normalizeForVerification(`${control?.label ?? ""} ${control?.visibleText ?? ""} ${action.purpose} ${action.rationale}`);
  return openKairoNewPatientStillLoading(observation, profile) && /\b(close|dismiss|cancel|x)\b/.test(actionText);
}

function shouldWaitInsteadOfStoppingTransientOpenKairoLoading(
  action: Extract<AiWebAction, { type: "stop" }>,
  observation: {
    controls: Array<{ label?: string; visibleText?: string; role?: string }>;
    visibleText: string;
  },
  profile: TargetProfile,
): boolean {
  return (
    action.code === "ui_state_unexpected" &&
    openKairoNewPatientStillLoading(observation, profile)
  );
}

function reopenOpenKairoNewPatientAction(
  action: Extract<AiWebAction, { type: "stop" }>,
  observation: {
    controls: Array<{ elementId: string; label?: string; visibleText?: string; role?: string }>;
    visibleText: string;
  },
  profile: TargetProfile,
): Extract<AiWebAction, { type: "click" }> | undefined {
  if (profile.name !== "openkairo" || action.code !== "ui_state_unexpected") {
    return undefined;
  }

  const stopText = normalizeForVerification(action.message);
  if (!/\bnew patient\b/.test(stopText) || !/\b(dialog|form).*\b(not|no)\b|\bnot currently visible\b/.test(stopText)) {
    return undefined;
  }

  const pageText = normalizeForVerification(observation.visibleText);
  if (!pageText.includes("patients") || !pageText.includes("new patient")) {
    return undefined;
  }

  const control = observation.controls.find((candidate) =>
    /\bnew patient\b/.test(normalizeForVerification(`${candidate.label ?? ""} ${candidate.visibleText ?? ""}`)),
  );
  if (!control) {
    return undefined;
  }

  return {
    type: "click",
    elementId: control.elementId,
    purpose: "reopen OpenKairo New Patient dialog",
    rationale: "The New Patient dialog disappeared before the record was saved, but the Patients page still exposes New Patient.",
  };
}

function openKairoNewPatientStillLoading(
  observation: {
    controls: Array<{ label?: string; visibleText?: string; role?: string }>;
    visibleText: string;
  },
  profile: TargetProfile,
): boolean {
  const pageText = normalizeForVerification(observation.visibleText);
  return (
    profile.name === "openkairo" &&
    pageText.includes("new patient") &&
    pageText.includes("loading fields") &&
    !openKairoNewPatientFieldsVisible(observation.controls)
  );
}

function openKairoNewPatientFieldsVisible(
  controls: Array<{ label?: string; visibleText?: string; role?: string }>,
): boolean {
  const controlsText = normalizeForVerification(
    controls.map((control) => `${control.label ?? ""} ${control.visibleText ?? ""} ${control.role ?? ""}`).join(" "),
  );
  return (
    /\b(first name|last name|birth|year|gender|create patient)\b/.test(controlsText) &&
    !/^\s*(new patient|close|dismiss|cancel|x)\s*$/.test(controlsText)
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
  let currentValue = input.action.value;
  let feedbackMessage: string | undefined;

  while (true) {
    const result = await withFieldPromptTimeout(page.evaluate(fieldConfirmationPromptScript({
      ...input,
      currentValue,
      feedbackMessage,
    })));
    if (!isFieldMappingConfirmation(result)) {
      return { type: "stop", reason: "Field confirmation prompt returned an invalid response." };
    }
    if (result.type !== "edit") {
      return result;
    }

    const interpretation = interpretOperatorEditedValue(input.action, result.value);
    if (interpretation.status === "mapped") {
      await cleanupFieldConfirmationPrompt(page);
      return { type: "edit", value: interpretation.value };
    }

    currentValue = result.value;
    feedbackMessage = interpretation.message;
  }
}

async function cleanupFieldConfirmationPrompt(page: AiWebTargetPage): Promise<void> {
  await page.evaluate(`
    var prompt = document.querySelector("#agentic-field-confirmation");
    prompt?.remove();
  `).catch(() => undefined);
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

type OperatorEditInterpretation =
  | { status: "mapped"; value: string }
  | { status: "retry"; message: string };

function interpretOperatorEditedValue(
  action: Extract<AiWebAction, { type: "fill" | "select" }>,
  operatorInput: string,
): OperatorEditInterpretation {
  const trimmedInput = operatorInput.trim();
  if (trimmedInput.length === 0) {
    return { status: "retry", message: "The typed value was blank. Enter a clearer value or stop the record." };
  }

  if (action.type === "fill") {
    return { status: "mapped", value: trimmedInput };
  }

  const labels = selectLabelsForOperatorInput(action);
  if (labels.length === 0) {
    return { status: "mapped", value: trimmedInput };
  }

  const mappedValue = selectLabelForOperatorInput(trimmedInput, labels);
  if (mappedValue) {
    return { status: "mapped", value: mappedValue };
  }

  return {
    status: "retry",
    message: `AI could not confidently map ${JSON.stringify(trimmedInput)} to ${labels.join(", ")}. Try a clearer value.`,
  };
}

function selectLabelsForOperatorInput(action: Extract<AiWebAction, { type: "select" }>): string[] {
  const context = normalizeForVerification(`${action.field} ${action.value} ${action.rationale}`);
  if (/\b(gender|sex)\b/.test(context) || ["female", "male", "unknown", "other"].includes(normalizeForVerification(action.value))) {
    return ["Female", "Male", "Unknown", "Other"];
  }
  if (/\b(month|birthdate month|date of birth)\b/.test(context) || MONTH_LABELS.includes(action.value)) {
    return MONTH_LABELS;
  }
  if (/\b(state|province)\b/.test(context) || stateLabel(action.value) !== undefined) {
    return US_STATE_LABELS;
  }
  return [];
}

function selectLabelForOperatorInput(value: string, labels: readonly string[]): string | undefined {
  const normalizedValue = normalizeForVerification(value);
  const exactMatch = labels.find((label) => normalizeForVerification(label) === normalizedValue);
  if (exactMatch) return exactMatch;

  const abbreviationMatch = commonSelectAbbreviation(normalizedValue, labels);
  if (abbreviationMatch) return abbreviationMatch;

  const stateMatch = stateLabel(value);
  if (stateMatch && labels.includes(stateMatch)) return stateMatch;

  const prefixMatches = labels.filter((label) => normalizeForVerification(label).startsWith(normalizedValue));
  return prefixMatches.length === 1 ? prefixMatches[0] : undefined;
}

function commonSelectAbbreviation(value: string, labels: readonly string[]): string | undefined {
  const aliases: Record<string, string> = {
    f: "Female",
    female: "Female",
    m: "Male",
    male: "Male",
    u: "Unknown",
    unknown: "Unknown",
    o: "Other",
    other: "Other",
  };
  const label = aliases[value];
  return label && labels.includes(label) ? label : undefined;
}

function stateLabel(value: string): string | undefined {
  const trimmedValue = value.trim();
  const upperValue = trimmedValue.toUpperCase();
  if (US_STATE_LABELS_BY_ABBREVIATION[upperValue]) {
    return US_STATE_LABELS_BY_ABBREVIATION[upperValue];
  }

  const lowerValue = trimmedValue.toLowerCase();
  return US_STATE_LABELS.find((label) => label.toLowerCase() === lowerValue);
}

const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const US_STATE_LABELS_BY_ABBREVIATION: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};

const US_STATE_LABELS = Object.values(US_STATE_LABELS_BY_ABBREVIATION);

type FieldConfirmationPromptInput = FieldMappingConfirmationInput & {
  currentValue?: string;
  feedbackMessage?: string;
};

function fieldConfirmationPromptScript(input: FieldConfirmationPromptInput): string {
  const encoded = encodeURIComponent(
    JSON.stringify({
      target: input.profile.displayName,
      recordId: input.record.sourceRecordId,
      sourceField: input.action.field,
      proposedValue: input.action.value,
      currentValue: input.currentValue ?? input.action.value,
      selectedSelector: input.selectedSelector ?? input.action.elementId,
      confidence: formatPercent(input.confidence),
      threshold: formatPercent(input.threshold),
      rationale: input.action.rationale,
      feedbackMessage: input.feedbackMessage,
    }),
  );

  return `/* agentic-field-confirmation-input:${encoded} */
(function () {
  var input = JSON.parse(decodeURIComponent("${encoded}"));
  var existing = document.querySelector("#agentic-field-confirmation");
  if (existing) {
    existing.remove();
  }

  return new Promise(function (resolve) {
    var overlay = document.createElement("div");
    overlay.id = "agentic-field-confirmation";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.72);display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif;color:#111827;pointer-events:auto;";
    ["click", "mousedown", "mouseup", "pointerdown", "pointerup"].forEach(function (eventName) {
      overlay.addEventListener(eventName, function (event) {
        event.stopPropagation();
      });
    });

    var form = document.createElement("form");
    form.style.cssText = "width:min(560px,calc(100vw - 32px));box-sizing:border-box;background:#fff;border-radius:8px;box-shadow:0 24px 80px rgba(0,0,0,.35);padding:24px;display:grid;gap:14px;";
    ["click", "mousedown", "mouseup", "pointerdown", "pointerup"].forEach(function (eventName) {
      form.addEventListener(eventName, function (event) {
        event.stopPropagation();
      });
    });

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
    valueInput.value = input.currentValue;
    valueInput.setAttribute("aria-label", "Field value");
    valueInput.style.cssText = "width:100%;box-sizing:border-box;border:1px solid #9ca3af;border-radius:6px;padding:10px 12px;font-size:16px;";

    var error = document.createElement("div");
    error.style.cssText = "min-height:18px;color:#b91c1c;font-size:13px;";
    error.textContent = input.feedbackMessage || "";

    var status = document.createElement("div");
    status.style.cssText = "min-height:20px;color:#374151;font-size:13px;display:flex;align-items:center;gap:8px;";
    var spinner = document.createElement("span");
    spinner.style.cssText = "display:none;width:14px;height:14px;border:2px solid #bfdbfe;border-top-color:#2563eb;border-radius:999px;animation:agentic-spin .8s linear infinite;";
    var style = document.createElement("style");
    style.textContent = "@keyframes agentic-spin{to{transform:rotate(360deg)}}";
    var statusText = document.createElement("span");
    status.appendChild(spinner);
    status.appendChild(statusText);

    var buttons = document.createElement("div");
    buttons.style.cssText = "display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;";
    var actionButtons = [];
    function setBusy(isBusy) {
      valueInput.disabled = isBusy;
      for (var index = 0; index < actionButtons.length; index += 1) actionButtons[index].disabled = isBusy;
      spinner.style.display = isBusy ? "inline-block" : "none";
      statusText.textContent = isBusy ? "AI is interpreting this value..." : "";
    }
    function finish(result, keepOpen) {
      if (keepOpen) {
        setBusy(true);
      } else {
        overlay.remove();
      }
      resolve(result);
    }
    function addButton(label, onClick, primary, danger) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.style.cssText = "border:1px solid #9ca3af;background:#fff;border-radius:6px;padding:9px 12px;font-size:14px;cursor:pointer;";
      if (primary) button.style.cssText += "background:#2563eb;border-color:#2563eb;color:#fff;";
      if (danger) button.style.cssText += "background:#b91c1c;border-color:#b91c1c;color:#fff;";
      button.addEventListener("click", function (event) {
        event.stopPropagation();
        onClick();
      });
      actionButtons.push(button);
      buttons.appendChild(button);
    }
    addButton("Use AI-Mapped Value", function () {
      finish({ type: "confirm" }, false);
    }, true, false);
    addButton("Apply Typed Value", function () { finish({ type: "edit", value: valueInput.value }, true); }, false, false);
    addButton("Skip Field", function () { finish({ type: "skip", reason: "Operator skipped low-confidence field." }, false); }, false, false);
    addButton("Stop Record", function () { finish({ type: "stop", reason: "Operator stopped low-confidence field confirmation." }, false); }, false, true);

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      event.stopPropagation();
      var value = valueInput.value;
      finish(value === input.proposedValue ? { type: "confirm" } : { type: "edit", value: value }, value !== input.proposedValue);
    });
    form.appendChild(style);
    form.appendChild(title);
    form.appendChild(details);
    form.appendChild(valueInput);
    form.appendChild(error);
    form.appendChild(status);
    form.appendChild(buttons);
    overlay.appendChild(form);
    var host = findFieldConfirmationHost();
    if (host !== document.body) {
      var hostStyle = window.getComputedStyle(host);
      if (hostStyle.position === "static") host.style.position = "relative";
      overlay.style.position = "absolute";
      overlay.style.inset = "0";
    }
    host.appendChild(overlay);
    valueInput.focus();

    function findFieldConfirmationHost() {
      var candidates = Array.from(document.querySelectorAll("[aria-modal='true'], [role='dialog'], dialog[open], .modal, .modal-dialog, [class*='modal']"))
        .filter(function (candidate) {
          return candidate.id !== "agentic-field-confirmation" && isVisible(candidate);
        });
      var newPatientCandidates = candidates.filter(function (candidate) {
        return /\\bnew patient\\b/i.test(candidate.textContent || "");
      });
      return newPatientCandidates[newPatientCandidates.length - 1] || candidates[candidates.length - 1] || document.body;
    }

    function isVisible(element) {
      var rect = element.getBoundingClientRect();
      var style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    }
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
  if (control?.role === "combobox" || controlTextMatches(control, /\b(select|choose|gender|sex|month|state|province)\b/)) {
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

async function prepareSuccessfulVerificationScreenshot(input: {
  context: AiWebTargetRunContext;
  page: AiWebTargetPage;
  observation: {
    controls: Array<{ elementId: string; label?: string; visibleText?: string; role?: string }>;
    elementSelectors: Map<string, string>;
  };
  screenshotPath: string | undefined;
}): Promise<string | undefined> {
  const contactAction = openMrsShowContactInfoAction(input.observation, input.context.profile);
  if (!contactAction) {
    return input.screenshotPath;
  }

  try {
    await executeBrowserAction(input.page, input.observation.elementSelectors, contactAction);
    await writeAiActionEvent(input.context, contactAction, input.screenshotPath, "succeeded");
    return await captureScreenshot(input.context, input.page, "ai-openmrs-contact-info");
  } catch (error) {
    await writeAiActionEvent(
      input.context,
      contactAction,
      input.screenshotPath,
      `failed: ${error instanceof Error ? error.message : String(error)}`,
      "ui_state_unexpected",
    );
    return input.screenshotPath;
  }
}

function openMrsShowContactInfoAction(
  observation: { controls: Array<{ elementId: string; label?: string; visibleText?: string; role?: string }> },
  profile: TargetProfile,
): Extract<AiWebAction, { type: "click" }> | undefined {
  if (profile.name !== "openmrs") {
    return undefined;
  }

  const control = observation.controls.find((candidate) =>
    /\bshow contact info\b/.test(normalizeForVerification(`${candidate.label ?? ""} ${candidate.visibleText ?? ""}`)),
  );
  if (!control) {
    return undefined;
  }

  return {
    type: "click",
    elementId: control.elementId,
    purpose: "show OpenMRS contact information before proof capture",
    rationale: "OpenMRS hides contact details behind a Show Contact Info control on the saved patient dashboard.",
  };
}

async function writeSuccessfulVerificationEvidence(
  context: AiWebTargetRunContext,
  action: Extract<AiWebAction, { type: "verify" }>,
  screenshotPath: string | undefined,
  fieldScreenshotPath: string | undefined,
  completedFields: readonly string[],
  skippedFields: readonly string[],
): Promise<void> {
  const targetRecordId = aiTargetRecordId(context);
  await writeUnmatchedIntakeFieldCoverage(context, completedFields, skippedFields);
  await writeAiActionEvent(context, action, screenshotPath, "succeeded");
  await context.audit.writeTargetEvidence({
    recordId: context.record.sourceRecordId,
    target: context.profile.name,
    status: "succeeded",
    screenshotPath,
    fieldScreenshotPath,
    targetRecordId,
    message: action.criteria,
  });
}

async function writeUnmatchedIntakeFieldCoverage(
  context: AiWebTargetRunContext,
  completedFields: readonly string[],
  skippedFields: readonly string[],
): Promise<void> {
  const completed = new Set(completedFields);
  const skipped = new Set(skippedFields);
  const existingMappings = context.audit
    .getReportDetails()
    .fieldMappings.filter((mapping) => mapping.recordId === context.record.sourceRecordId && mapping.target === context.profile.name);
  const existingSourceFields = new Set(existingMappings.map((mapping) => mapping.sourceField));

  for (const { field, value } of normalizedIntakeFieldEntries(context.record)) {
    if (completed.has(field) || skipped.has(field) || existingSourceFields.has(field)) {
      continue;
    }

    await context.audit.writeFieldMapping({
      recordId: context.record.sourceRecordId,
      target: context.profile.name,
      sourceField: field,
      targetField: "",
      normalizedValue: value,
      selectorCandidates: [],
      status: "no_matching_destination_field",
      skipReason: "No matching destination field was filled before verification.",
    });
  }
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

function savedPatientProofMessage(record: NormalizedIntakeRecord): string {
  return `Saved patient record is visible for ${[record.firstName, record.lastName].filter(Boolean).join(" ")}.`;
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

  if (unsavedPatientEntryFormVisible(observation)) {
    return {
      message: "AI verification found an unsaved patient entry form instead of a saved patient state.",
      eventResult: "failed: unsaved patient entry form visible",
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

function unsavedPatientEntryFormVisible(observation: {
  title: string;
  visibleText: string;
  controls?: Array<{ label: string; value: string; visibleText: string }>;
}): boolean {
  const text = normalizeForVerification(`${observation.title} ${verificationEvidenceText(observation)}`);
  return (
    /\bnew patient\b/.test(text) &&
    /\b(create patient|save|submit)\b/.test(text) &&
    /\b(first name|last name|date of birth|birth|gender)\b/.test(text)
  );
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

function targetFieldForAction(
  observation: { controls: Array<{ elementId: string; label?: string; visibleText?: string }>; elementSelectors: Map<string, string> },
  action: Extract<BrowserExecutableAiWebAction, { type: "fill" | "select" }>,
): string {
  const control = observation.controls.find((candidate) => candidate.elementId === action.elementId);
  const label = (control?.label ?? "").trim();
  if (label) {
    return label;
  }

  const visibleText = (control?.visibleText ?? "").trim();
  if (visibleText) {
    return visibleText;
  }

  return observation.elementSelectors.get(action.elementId) ?? action.field;
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
