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
  selectOption(option: { label: string }, options?: { timeout: number }): Promise<unknown>;
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
      await page.locator(selector).selectOption({ label: action.value }, { timeout: BROWSER_ACTION_TIMEOUT_MS });
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

function selectorForElement(elementSelectors: Map<string, string>, elementId: string): string {
  const selector = elementSelectors.get(elementId);
  if (!selector) {
    throw new Error(`stale element id: ${elementId}`);
  }
  return selector;
}
