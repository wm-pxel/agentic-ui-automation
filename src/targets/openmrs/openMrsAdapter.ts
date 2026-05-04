import { chromium, type Browser } from "@playwright/test";
import type { TargetAdapter, TargetAdapterResult, TargetPrepareContext, TargetRunContext } from "../../adapters/contract.js";
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
  OPENMRS_STATE_LABELS,
  type FieldMapping,
  openMrsFieldMappings,
  openMrsStateLabel,
} from "./selectors.js";

const DEFAULT_OPENMRS_BASE_URL = "https://o2.openmrs.org/openmrs";
const DEFAULT_OPENMRS_USERNAME = "admin";
const DEFAULT_OPENMRS_PASSWORD = "Admin123";
const OPENMRS_ACTION_TIMEOUT_MS = 5000;
const OPENMRS_FIELD_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;
const OPENMRS_FIELD_CONFIRMATION_TIMEOUT_MESSAGE = "OpenMRS field confirmation prompt timed out.";
const OPENMRS_FIELD_CONFIRMATION_RETRY_DELAY_MS = 250;
const OPENMRS_FIELD_CONFIRMATION_MAX_ATTEMPTS = 3;
const OPENMRS_OPERATOR_VALUE_ACTION_PREFIX = "use-openmrs-operator-value:";

export interface OpenMrsConfig {
  baseUrl?: string;
  username?: string;
  password?: string;
  location?: string;
  concurrency?: number;
  interactiveFieldConfirmation?: boolean;
  fieldConfidenceThreshold?: number;
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
  evaluate<T, Arg>(pageFunction: string | ((input: Arg) => T | Promise<T>), arg: Arg): Promise<T>;
  locator(selector: string): OpenMrsLocator;
  screenshot(options: { fullPage: boolean }): Promise<Buffer>;
  waitForLoadState(state: "networkidle"): Promise<unknown>;
  frames?(): OpenMrsSearchContext[];
}

interface OpenMrsSearchContext {
  locator(selector: string): OpenMrsLocator;
}

interface OpenMrsSession {
  browser: OpenMrsBrowser;
  page: OpenMrsPage;
}

interface OpenMrsLocator {
  first(): OpenMrsLocator;
  count(): Promise<number>;
  evaluate<T>(pageFunction: (element: Element) => T | Promise<T>): Promise<T>;
  selectOption(option: { label: string } | string, options?: { timeout: number }): Promise<unknown>;
  fill(value: string, options?: { timeout: number }): Promise<unknown>;
  click(): Promise<unknown>;
  hover?(): Promise<unknown>;
  isVisible?(): Promise<boolean>;
  innerText(options: { timeout: number }): Promise<string>;
}

interface FillResult {
  selectedSelector: string;
  action: "fill" | "select";
}

interface ApprovedFieldMapping {
  value: string;
  approvalSource: "agent" | "operator_confirmed" | "operator_edited" | "operator_skipped" | "operator_stopped";
  agentConfidence?: number;
  confidenceThreshold: number;
  agentRationale: string;
  originalProposedValue?: string;
  skipReason?: string;
}

type OperatorPromptAction = "confirm" | "edit" | "skip" | "stop";

interface OperatorPromptResult {
  action: OperatorPromptAction;
  value: string;
}

interface OperatorPromptInput {
  sourceField: string;
  targetField: string;
  proposedValue: string;
  required: boolean;
  confidence: number;
  threshold: number;
  rationale: string;
}

interface FieldSkippedError {
  kind: "field-skipped";
  approval: ApprovedFieldMapping;
}

class OpenMrsFieldApprovalRequiredError extends Error {
  readonly code = "ui_state_unexpected";
  readonly severity = "error";
  readonly approvalSource = "operator_stopped" as const;
  readonly agentRationale: string;

  constructor(
    readonly field: string,
    readonly targetField: string,
    message: string,
    readonly suggestedRemediation: string,
    readonly screenshotPath: string,
    readonly proposedValue: string,
    readonly agentConfidence: number | undefined,
    readonly confidenceThreshold: number,
  ) {
    super(message);
    this.name = "OpenMrsFieldApprovalRequiredError";
    this.agentRationale = suggestedRemediation;
  }
}

export class OpenMrsAdapter implements TargetAdapter {
  readonly name = "openmrs" as const;
  readonly maxConcurrency: number;
  private readonly activeBrowsers = new Set<OpenMrsBrowser>();
  private readonly readySessions: OpenMrsSession[] = [];
  private readonly launchBrowser: (options: Parameters<typeof chromium.launch>[0]) => Promise<OpenMrsBrowser>;

  constructor(
    private readonly config: OpenMrsConfig,
    dependencies: OpenMrsAdapterDependencies = {},
  ) {
    this.launchBrowser = dependencies.launchBrowser ?? ((options) => chromium.launch(options));
    this.maxConcurrency = effectiveOpenMrsConcurrency(config);
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
      try {
        for (const mapping of openMrsFieldMappings(context.record)) {
          await fillMappedField(context, page, mapping, this.config);
        }
      } catch (error) {
        if (isValidationExceptionLike(error)) {
          await writeTargetIssue(context, error);
          return { status: "exception", exception: error };
        }
        throw error;
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

      reusable = true;
      return { status: "succeeded", targetRecordId };
    } finally {
      if (reusable) {
        this.releaseSession(session);
      } else {
        await this.closeSession(session);
      }
    }
  }

  async close(): Promise<void> {
    this.readySessions.length = 0;
    const browsers = [...this.activeBrowsers];
    this.activeBrowsers.clear();
    await Promise.all(browsers.map((browser) => browser.close()));
  }

  private async acquireSession(): Promise<OpenMrsSession> {
    return this.readySessions.pop() ?? this.openSession();
  }

  private releaseSession(session: OpenMrsSession): void {
    if (this.activeBrowsers.has(session.browser)) {
      this.readySessions.push(session);
    }
  }

  private async openSession(): Promise<OpenMrsSession> {
    const config = resolveOpenMrsConfig(this.config);

    const browser = await this.launchBrowser({
      headless: false,
      chromiumSandbox: true,
      env: {},
      args: ["--disable-extensions", "--disable-file-system"],
    });
    this.activeBrowsers.add(browser);

    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.goto(openMrsLoginUrl(config.baseUrl), { waitUntil: "domcontentloaded" });
      await fillFirst(page, OPENMRS_LOGIN_SELECTORS.username, config.username, "login username");
      await fillFirst(page, OPENMRS_LOGIN_SELECTORS.password, config.password, "login password");
      await clickOptional(page, locationSelectors(config.location));
      await clickFirst(page, OPENMRS_LOGIN_SELECTORS.submit, "login submit");
      await page.waitForLoadState("networkidle");
      return { browser, page };
    } catch (error) {
      this.activeBrowsers.delete(browser);
      await browser.close().catch(() => undefined);
      throw error;
    }
  }

  private async closeSession(session: OpenMrsSession): Promise<void> {
    this.activeBrowsers.delete(session.browser);
    await session.browser.close();
  }
}

async function fillMappedField(context: TargetRunContext, page: OpenMrsPage, mapping: FieldMapping, config: OpenMrsConfig): Promise<void> {
  let approval: ApprovedFieldMapping | undefined;
  try {
    await revealField(page, mapping.selectors, mapping.targetField);
    approval = await approveMappedField(context, page, mapping, config);
    const result = await fillFirst(page, mapping.selectors, approval.value, mapping.targetField);
    await context.audit.writeFieldMapping({
      recordId: context.record.sourceRecordId,
      target: "openmrs",
      sourceField: mapping.sourceField,
      targetField: mapping.targetField,
      normalizedValue: mapping.value,
      mappingConfidence: mapping.mappingConfidence,
      selectorCandidates: mapping.selectors,
      selectedSelector: result.selectedSelector,
      action: result.action,
      status: "succeeded",
      agentConfidence: approval.agentConfidence,
      confidenceThreshold: approval.confidenceThreshold,
      agentRationale: approval.agentRationale,
      approvalSource: approval.approvalSource,
      originalProposedValue: approval.originalProposedValue,
      finalValue: approval.value,
    });
  } catch (error) {
    if (isFieldSkippedError(error)) {
      await context.audit.writeFieldMapping({
        recordId: context.record.sourceRecordId,
        target: "openmrs",
        sourceField: mapping.sourceField,
        targetField: mapping.targetField,
        normalizedValue: mapping.value,
        mappingConfidence: mapping.mappingConfidence,
        selectorCandidates: mapping.selectors,
        status: "skipped",
        agentConfidence: error.approval.agentConfidence,
        confidenceThreshold: error.approval.confidenceThreshold,
        agentRationale: error.approval.agentRationale,
        approvalSource: error.approval.approvalSource,
        originalProposedValue: mapping.value,
        skipReason: error.approval.skipReason,
      });
      return;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    const failedApproval = approval ?? approvalFromError(error);
    await context.audit.writeFieldMapping({
      recordId: context.record.sourceRecordId,
      target: "openmrs",
      sourceField: mapping.sourceField,
      targetField: mapping.targetField,
      normalizedValue: mapping.value,
      mappingConfidence: mapping.mappingConfidence,
      selectorCandidates: mapping.selectors,
      status: "failed",
      errorMessage,
      agentConfidence: failedApproval?.agentConfidence,
      confidenceThreshold: failedApproval?.confidenceThreshold,
      agentRationale: failedApproval?.agentRationale,
      approvalSource: failedApproval?.approvalSource,
      originalProposedValue: failedApproval?.originalProposedValue,
      finalValue: failedApproval?.value,
    });
    if (isOpenMrsFieldApprovalRequiredError(error)) {
      throw error;
    }
    if (!mapping.required) {
      return;
    }
    throw error;
  }
}

async function approveMappedField(
  context: TargetRunContext,
  page: OpenMrsPage,
  mapping: FieldMapping,
  config: OpenMrsConfig,
): Promise<ApprovedFieldMapping> {
  const threshold = fieldConfidenceThreshold(config);
  if (!config.interactiveFieldConfirmation) {
    return {
      value: mapping.value,
      approvalSource: "agent",
      confidenceThreshold: threshold,
      agentRationale: "Interactive OpenMRS field confirmation is disabled.",
    };
  }

  if (mapping.mappingConfidence >= threshold) {
    return {
      value: mapping.value,
      approvalSource: "agent",
      confidenceThreshold: threshold,
      agentRationale: `OpenMRS mapping confidence ${mapping.mappingConfidence} meets threshold ${threshold}.`,
    };
  }

  const reviewScreenshot = await page.screenshot({ fullPage: true });
  const reviewScreenshotPath = await context.audit.writeScreenshot(
    context.record.sourceRecordId,
    "openmrs",
    `field-review-${safeStepName(mapping.targetField)}`,
    reviewScreenshot,
  );

  return promptForMappedField(
    context,
    page,
    mapping,
    {
      confidence: mapping.mappingConfidence,
      rationale: `OpenMRS mapping confidence ${mapping.mappingConfidence} is below threshold ${threshold}.`,
    },
    threshold,
    reviewScreenshotPath,
  );
}

async function promptForMappedField(
  _context: TargetRunContext,
  page: OpenMrsPage,
  mapping: FieldMapping,
  decision: { confidence: number; rationale: string },
  threshold: number,
  screenshotPath: string,
): Promise<ApprovedFieldMapping> {
  const input: OperatorPromptInput = {
    sourceField: String(mapping.sourceField),
    targetField: mapping.targetField,
    proposedValue: mapping.value,
    required: mapping.required === true,
    confidence: decision.confidence,
    threshold,
    rationale: decision.rationale,
  };

  let result: unknown;
  try {
    result = await evaluateFieldPromptWithRetry(page, input);
  } catch (error) {
    if (isPromptTimeoutError(error)) {
      await page.evaluate(cleanupOpenMrsFieldConfirmationPrompt, undefined).catch(() => undefined);
      return stopFieldMapping(mapping, decision, threshold, screenshotPath, OPENMRS_FIELD_CONFIRMATION_TIMEOUT_MESSAGE);
    }
    return stopFieldMapping(
      mapping,
      decision,
      threshold,
      screenshotPath,
      `OpenMRS field confirmation prompt failed: ${errorMessage(error)}`,
    );
  }

  if (!isOperatorPromptResult(result)) {
    return stopFieldMapping(mapping, decision, threshold, screenshotPath, "OpenMRS field confirmation prompt returned an invalid response.");
  }

  if (result.action === "confirm") {
    const rawValue = result.value.trim();
    const interpretation = rawValue === mapping.value ? { value: mapping.value } : await interpretOpenMrsOperatorValue(_context, mapping, rawValue);
    const value = interpretation.value;
    if (mapping.required && value.length === 0) {
      return stopFieldMapping(mapping, decision, threshold, screenshotPath, "Required OpenMRS field confirmation returned a blank value.");
    }
    return {
      value,
      approvalSource: value === mapping.value ? "operator_confirmed" : "operator_edited",
      agentConfidence: decision.confidence,
      confidenceThreshold: threshold,
      agentRationale: fieldApprovalRationale(decision.rationale, interpretation.rationale),
      originalProposedValue: value === mapping.value ? undefined : mapping.value,
    };
  }

  if (result.action === "edit") {
    const interpretation = await interpretOpenMrsOperatorValue(_context, mapping, result.value.trim());
    const value = interpretation.value;
    if (mapping.required && value.length === 0) {
      return stopFieldMapping(mapping, decision, threshold, screenshotPath, "Required OpenMRS field confirmation returned a blank value.");
    }
    return {
      value,
      approvalSource: value === mapping.value ? "operator_confirmed" : "operator_edited",
      agentConfidence: decision.confidence,
      confidenceThreshold: threshold,
      agentRationale: fieldApprovalRationale(decision.rationale, interpretation.rationale),
      originalProposedValue: mapping.value,
    };
  }

  if (result.action === "skip" && !mapping.required) {
    throw {
      kind: "field-skipped",
      approval: {
        value: mapping.value,
        approvalSource: "operator_skipped",
        agentConfidence: decision.confidence,
        confidenceThreshold: threshold,
        agentRationale: decision.rationale,
        skipReason: "Operator skipped optional OpenMRS field.",
      },
    } satisfies FieldSkippedError;
  }

  return stopFieldMapping(mapping, decision, threshold, screenshotPath, "Operator stopped OpenMRS field confirmation.");
}

async function interpretOpenMrsOperatorValue(
  context: TargetRunContext,
  mapping: FieldMapping,
  operatorInput: string,
): Promise<{ value: string; rationale?: string }> {
  const candidates = openMrsOperatorEditedValueCandidates(mapping, operatorInput);
  const fallbackValue = candidates[0] ?? operatorInput;
  if (candidates.length <= 1) {
    return { value: fallbackValue };
  }

  const allowedActions = candidates.map((value, index) => ({
    id: `${OPENMRS_OPERATOR_VALUE_ACTION_PREFIX}${index}`,
    description: `Use ${JSON.stringify(value)} as the OpenMRS ${mapping.targetField} value.`,
  }));
  const decision = await context.agent.decide({
    target: "openmrs",
    recordId: context.record.sourceRecordId,
    step: `interpret-openmrs-field-value:${mapping.targetField}`,
    allowedActions,
    metadata: {
      sourceField: mapping.sourceField,
      targetField: mapping.targetField,
      proposedValue: mapping.value,
      operatorInput,
      candidateValues: candidates,
      selectorCandidates: mapping.selectors,
      required: mapping.required === true,
    },
  });
  const selectedIndex = selectedOperatorValueIndex(decision.actionId);
  if (selectedIndex === undefined || selectedIndex < 0 || selectedIndex >= candidates.length) {
    return {
      value: fallbackValue,
      rationale: `Operator input ${JSON.stringify(operatorInput)} fell back to ${JSON.stringify(fallbackValue)} because the agent did not choose a valid interpretation.`,
    };
  }

  return {
    value: candidates[selectedIndex] ?? fallbackValue,
    rationale: decision.rationale,
  };
}

function selectedOperatorValueIndex(actionId: string): number | undefined {
  if (!actionId.startsWith(OPENMRS_OPERATOR_VALUE_ACTION_PREFIX)) return undefined;
  const index = Number(actionId.slice(OPENMRS_OPERATOR_VALUE_ACTION_PREFIX.length));
  return Number.isInteger(index) ? index : undefined;
}

function openMrsOperatorEditedValueCandidates(mapping: FieldMapping, value: string): string[] {
  if (mapping.targetField === "Gender") {
    return uniqueValues([openMrsOperatorEditedValue(mapping, value), "Female", "Male", "Unknown"]);
  }
  if (mapping.targetField === "Birthdate Month") {
    return uniqueValues([
      openMrsOperatorEditedValue(mapping, value),
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
    ]);
  }
  if (mapping.targetField === "State/Province") {
    return uniqueValues([openMrsOperatorEditedValue(mapping, value), ...OPENMRS_STATE_LABELS, value]);
  }
  return uniqueValues([openMrsOperatorEditedValue(mapping, value), value]);
}

function openMrsOperatorEditedValue(mapping: FieldMapping, value: string): string {
  if (mapping.targetField === "Gender") {
    return openMrsSelectLabel(value, ["Female", "Male", "Unknown"]);
  }
  if (mapping.targetField === "Birthdate Month") {
    return openMrsSelectLabel(value, [
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
    ]);
  }
  if (mapping.targetField === "State/Province") {
    return openMrsStateLabel(value);
  }
  return value;
}

function openMrsSelectLabel(value: string, labels: string[]): string {
  const normalizedValue = value.trim().toLowerCase();
  const exactMatch = labels.find((label) => label.toLowerCase() === normalizedValue);
  if (exactMatch) return exactMatch;

  const prefixMatches = labels.filter((label) => label.toLowerCase().startsWith(normalizedValue));
  return prefixMatches.length === 1 ? prefixMatches[0] : value;
}

function uniqueValues(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function fieldApprovalRationale(mappingRationale: string, interpretationRationale: string | undefined): string {
  return interpretationRationale ? `${mappingRationale} ${interpretationRationale}` : mappingRationale;
}

async function evaluateFieldPromptWithRetry(page: OpenMrsPage, input: OperatorPromptInput): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= OPENMRS_FIELD_CONFIRMATION_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await withFieldPromptTimeout(page.evaluate(fieldPromptEvaluationScript(input), undefined));
    } catch (error) {
      if (isPromptTimeoutError(error) || !isTransientPromptEvaluationError(error) || attempt === OPENMRS_FIELD_CONFIRMATION_MAX_ATTEMPTS) {
        throw error;
      }
      lastError = error;
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await delay(OPENMRS_FIELD_CONFIRMATION_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

function stopFieldMapping(
  mapping: FieldMapping,
  decision: { confidence: number; rationale: string },
  threshold: number,
  screenshotPath: string,
  message: string,
): ApprovedFieldMapping {
  throw new OpenMrsFieldApprovalRequiredError(
    String(mapping.sourceField),
    mapping.targetField,
    message,
    decision.rationale,
    screenshotPath,
    mapping.value,
    decision.confidence,
    threshold,
  );
}

function withFieldPromptTimeout<T>(prompt: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(OPENMRS_FIELD_CONFIRMATION_TIMEOUT_MESSAGE)), OPENMRS_FIELD_CONFIRMATION_TIMEOUT_MS);
  });
  return Promise.race([prompt, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function cleanupOpenMrsFieldConfirmationPrompt(): void {
  document.querySelector("#agentic-openmrs-field-confirmation")?.remove();
}

function fieldPromptEvaluationScript(input: OperatorPromptInput): string {
  const encodedInput = encodeURIComponent(JSON.stringify(input));
  return `/* agentic-openmrs-field-confirmation-input:${encodedInput} */
(function () {
  var input = JSON.parse(decodeURIComponent("${encodedInput}"));
  return new Promise(function (resolve) {
    var existing = document.querySelector("#agentic-openmrs-field-confirmation");
    if (existing) existing.remove();

    var overlay = document.createElement("div");
    overlay.id = "agentic-openmrs-field-confirmation";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.72);display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif;color:#111827;";

    var form = document.createElement("form");
    form.style.cssText =
      "width:min(560px,calc(100vw - 32px));background:#fff;border-radius:8px;box-shadow:0 24px 80px rgba(0,0,0,.35);padding:24px;display:grid;gap:16px;";

    var title = document.createElement("h2");
    title.textContent = "Confirm OpenMRS Field";
    title.style.cssText = "margin:0;font-size:22px;line-height:1.2;";

    var details = document.createElement("dl");
    details.style.cssText = "margin:0;display:grid;grid-template-columns:max-content 1fr;gap:8px 12px;font-size:14px;";
    function addDetail(label, value) {
      var term = document.createElement("dt");
      term.textContent = label;
      term.style.cssText = "font-weight:700;color:#374151;";
      var description = document.createElement("dd");
      description.textContent = value;
      description.style.cssText = "margin:0;color:#111827;overflow-wrap:anywhere;";
      details.appendChild(term);
      details.appendChild(description);
    }
    addDetail("Target field", input.targetField);
    addDetail("Source field", input.sourceField);
    addDetail("Confidence", String(input.confidence));
    addDetail("Threshold", String(input.threshold));
    addDetail("Rationale", input.rationale);

    var valueInput = document.createElement("input");
    valueInput.value = input.proposedValue;
    valueInput.style.cssText = "width:100%;box-sizing:border-box;border:1px solid #9ca3af;border-radius:6px;padding:10px 12px;font-size:16px;";
    valueInput.setAttribute("aria-label", "OpenMRS field value");

    var error = document.createElement("div");
    error.style.cssText = "min-height:18px;color:#b91c1c;font-size:13px;";

    var buttons = document.createElement("div");
    buttons.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;";
    function finish(action) {
      var value = valueInput.value;
      if ((action === "confirm" || action === "edit") && input.required && value.trim().length === 0) {
        error.textContent = "Required fields cannot be blank.";
        valueInput.focus();
        return;
      }
      overlay.remove();
      resolve({ action, value });
    }
    function addButton(label, action, kind) {
      if (kind === undefined) kind = "secondary";
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.style.cssText =
        "border:1px solid #9ca3af;border-radius:6px;padding:9px 12px;font-size:14px;cursor:pointer;background:#fff;color:#111827;";
      if (kind === "primary") button.style.cssText += "background:#2563eb;border-color:#2563eb;color:#fff;";
      if (kind === "danger") button.style.cssText += "background:#b91c1c;border-color:#b91c1c;color:#fff;";
      button.addEventListener("click", function () { finish(action); });
      buttons.appendChild(button);
    }

    addButton("Use AI-Mapped Value", "confirm", "primary");
    addButton("Apply Typed Value", "edit");
    if (!input.required) addButton("Skip", "skip");
    addButton("Stop Record", "stop", "danger");

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      finish(valueInput.value === input.proposedValue ? "confirm" : "edit");
    });
    form.appendChild(title);
    form.appendChild(details);
    form.appendChild(valueInput);
    form.appendChild(error);
    form.appendChild(buttons);
    overlay.appendChild(form);
    document.body.append(overlay);
    valueInput.focus();
    valueInput.select();
  });
})()`;
}

function isOperatorPromptResult(value: unknown): value is OperatorPromptResult {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Record<string, unknown>;
  return ["confirm", "edit", "skip", "stop"].includes(String(input.action)) && typeof input.value === "string";
}

function eagerSessionCount(maxConcurrency: number, plannedRecords: number | undefined): number {
  if (plannedRecords === undefined) return maxConcurrency;
  return Math.max(1, Math.min(maxConcurrency, plannedRecords));
}

function isFieldSkippedError(value: unknown): value is FieldSkippedError {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "field-skipped";
}

function isOpenMrsFieldApprovalRequiredError(value: unknown): value is OpenMrsFieldApprovalRequiredError {
  return value instanceof OpenMrsFieldApprovalRequiredError;
}

function isPromptTimeoutError(value: unknown): value is Error {
  return value instanceof Error && value.message === OPENMRS_FIELD_CONFIRMATION_TIMEOUT_MESSAGE;
}

function isTransientPromptEvaluationError(value: unknown): boolean {
  const message = errorMessage(value).toLowerCase();
  return (
    message.includes("execution context was destroyed") ||
    message.includes("cannot find context with specified id") ||
    message.includes("most likely because of a navigation")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isValidationExceptionLike(value: unknown): value is ValidationException & Record<string, unknown> {
  return typeof value === "object" && value !== null && "code" in value && "message" in value;
}

function approvalFromError(error: unknown): ApprovedFieldMapping | undefined {
  if (!(error instanceof OpenMrsFieldApprovalRequiredError)) return undefined;
  return {
    value: error.proposedValue,
    approvalSource: error.approvalSource,
    agentConfidence: error.agentConfidence,
    confidenceThreshold: error.confidenceThreshold,
    agentRationale: error.agentRationale,
    originalProposedValue: error.proposedValue,
  };
}

async function fillFirst(page: OpenMrsPage, selectors: string[], value: string, label: string): Promise<FillResult> {
  const match = await findFirstVisible(page, selectors, label);
  const locator = match.locator;
  const tagName = await locator.evaluate((element) => element.tagName.toLowerCase()).catch(() => "input");
  const actionOptions = { timeout: OPENMRS_ACTION_TIMEOUT_MS };
  if (tagName === "select") {
    await locator.selectOption({ label: value }, actionOptions).catch(() => locator.selectOption(value, actionOptions));
    return { selectedSelector: match.selector, action: "select" };
  } else {
    await locator.fill(value, actionOptions);
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
    concurrency: effectiveOpenMrsConcurrency(config),
    interactiveFieldConfirmation: config.interactiveFieldConfirmation ?? false,
    fieldConfidenceThreshold: fieldConfidenceThreshold(config),
  };
}

function effectiveOpenMrsConcurrency(config: OpenMrsConfig): number {
  if (config.interactiveFieldConfirmation) return 1;
  return normalizeConcurrency(config.concurrency);
}

function fieldConfidenceThreshold(config: OpenMrsConfig): number {
  const value = config.fieldConfidenceThreshold;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.8;
}

function normalizeConcurrency(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 2;
}

function safeStepName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "field";
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
