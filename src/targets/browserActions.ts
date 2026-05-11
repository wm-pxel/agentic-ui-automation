import { z } from "zod";

const BROWSER_ACTION_TIMEOUT_MS = 5000;

export const AiWebActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("fill"),
      elementId: z.string(),
      field: z.string(),
      value: z.string(),
      rationale: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("select"),
      elementId: z.string(),
      field: z.string(),
      value: z.string(),
      rationale: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("click"),
      elementId: z.string(),
      purpose: z.string(),
      rationale: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("wait"),
      reason: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("screenshot"),
      label: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("verify"),
      criteria: z.string(),
      rationale: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("stop"),
      code: z.enum(["ui_state_unexpected", "possible_duplicate", "verification_failed"]),
      message: z.string(),
    })
    .strict(),
]);

export type AiWebAction = z.infer<typeof AiWebActionSchema>;
export type BrowserExecutableAiWebAction = Extract<AiWebAction, { type: "fill" | "select" | "click" | "wait" }>;

interface BrowserActionPage {
  locator(selector: string): BrowserActionLocator;
  waitForTimeout?(timeoutMs: number): Promise<unknown>;
}

interface BrowserActionLocator {
  fill(value: string, options?: { timeout: number }): Promise<unknown>;
  selectOption(option: { label?: string; value?: string }, options?: { timeout: number }): Promise<unknown>;
  click(options?: { timeout: number }): Promise<unknown>;
}

export async function executeBrowserAction(
  page: BrowserActionPage,
  elementSelectors: Map<string, string>,
  action: BrowserExecutableAiWebAction,
): Promise<void> {
  switch (action.type) {
    case "fill": {
      const selector = selectorForElement(elementSelectors, action.elementId);
      await page.locator(selector).fill(action.value, { timeout: BROWSER_ACTION_TIMEOUT_MS });
      return;
    }
    case "select": {
      const selector = selectorForElement(elementSelectors, action.elementId);
      await selectOptionWithFallbacks(page, selector, action.value);
      return;
    }
    case "click": {
      const selector = selectorForElement(elementSelectors, action.elementId);
      await page.locator(selector).click({ timeout: BROWSER_ACTION_TIMEOUT_MS });
      return;
    }
    case "wait":
      await page.waitForTimeout?.(1000);
      return;
  }

  throw new Error(`unsupported browser action: ${(action as AiWebAction).type}`);
}

async function selectOptionWithFallbacks(page: BrowserActionPage, selector: string, value: string): Promise<void> {
  const locator = page.locator(selector);
  const candidates = optionCandidates(value);
  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      await locator.selectOption(candidate, { timeout: BROWSER_ACTION_TIMEOUT_MS });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  try {
    await locator.click({ timeout: BROWSER_ACTION_TIMEOUT_MS });
    await clickCustomOption(page, value);
    return;
  } catch (error) {
    lastError = error;
  }

  throw lastError instanceof Error ? lastError : new Error(`Could not select option ${value}`);
}

async function clickCustomOption(page: BrowserActionPage, value: string): Promise<void> {
  let lastError: unknown;
  for (const selector of customOptionSelectors(value)) {
    try {
      await page.locator(selector).click({ timeout: BROWSER_ACTION_TIMEOUT_MS });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Could not click custom option ${value}`);
}

function customOptionSelectors(value: string): string[] {
  const text = JSON.stringify(value);
  return [
    `[role="option"]:has-text(${text})`,
    `[role="menuitemradio"]:has-text(${text})`,
    `[role="menuitem"]:has-text(${text})`,
    `[cmdk-item]:has-text(${text})`,
    `text=${text}`,
  ];
}

function optionCandidates(value: string): Array<{ label?: string; value?: string }> {
  const normalized = value.trim().toLowerCase();
  const candidates: Array<{ label?: string; value?: string }> = [{ label: value }];

  if (normalized === "female") {
    candidates.push({ value: "F" }, { label: "F" });
  } else if (normalized === "male") {
    candidates.push({ value: "M" }, { label: "M" });
  }

  candidates.push({ value });
  return dedupeCandidates(candidates);
}

function dedupeCandidates(candidates: Array<{ label?: string; value?: string }>): Array<{ label?: string; value?: string }> {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.label ?? ""}\u0000${candidate.value ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function selectorForElement(elementSelectors: Map<string, string>, elementId: string): string {
  const selector = elementSelectors.get(elementId);
  if (!selector) {
    throw new Error(`stale element id: ${elementId}`);
  }
  return selector;
}
