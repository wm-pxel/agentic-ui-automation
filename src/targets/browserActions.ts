const BROWSER_ACTION_TIMEOUT_MS = 5000;

export type AiWebAction =
  | { type: "fill"; elementId: string; field: string; value: string; rationale: string }
  | { type: "select"; elementId: string; field: string; value: string; rationale: string }
  | { type: "click"; elementId: string; purpose: string; rationale: string }
  | { type: "wait"; rationale?: string }
  | { type: "screenshot"; rationale?: string }
  | { type: "verify"; rationale?: string }
  | { type: "stop"; rationale?: string };

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
  action: AiWebAction,
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
    case "screenshot":
    case "verify":
    case "stop":
      return;
  }
}

function selectorForElement(elementSelectors: Map<string, string>, elementId: string): string {
  const selector = elementSelectors.get(elementId);
  if (!selector) {
    throw new Error(`stale element id: ${elementId}`);
  }
  return selector;
}
