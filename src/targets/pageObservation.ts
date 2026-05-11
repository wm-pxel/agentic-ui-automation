export interface PageObservationControl {
  elementId: string;
  tag: string;
  role: string;
  label: string;
  value: string;
  visibleText: string;
}

export interface PageObservation {
  currentUrl: string;
  title: string;
  visibleText: string;
  screenshotPath: string;
  controls: PageObservationControl[];
  elementSelectors: Map<string, string>;
}

interface ObservationPage {
  url(): string;
  title(): Promise<string>;
  locator(selector: string): {
    innerText(): Promise<string>;
  };
  evaluate(pageFunction?: unknown): Promise<ObservedPageControl[]>;
}

interface ObservedPageControl {
  selector: string;
  tag: string;
  role?: string;
  label?: string;
  value?: string;
  visibleText?: string;
}

export async function createObservationSnapshot({
  page,
  screenshotPath,
}: {
  page: ObservationPage;
  screenshotPath: string;
}): Promise<PageObservation> {
  const [title, visibleText, observedControls] = await Promise.all([
    page.title(),
    page.locator("body").innerText().catch(() => ""),
    page.evaluate(() => {
      const controls = Array.from(
        document.querySelectorAll("input, select, textarea, button, a, [onclick], [role='button'], [role='link'], [tabindex]"),
      );

      return controls
        .filter((element) => {
          const htmlElement = element as HTMLElement;
          const rect = htmlElement.getBoundingClientRect();
          return (
            isElementVisible(htmlElement) &&
            htmlElement.getAttribute("aria-hidden") !== "true" &&
            rect.width > 0 &&
            rect.height > 0
          );
        })
        .flatMap((element) => {
          try {
            const htmlElement = element as HTMLElement;
            const formElement = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
            const tag = element.tagName.toLowerCase();
            const label = controlLabel(element);
            const role = htmlElement.getAttribute("role") || inferredRole(element);
            const text = normalizedText(htmlElement.innerText || htmlElement.textContent || "");

            return [
              {
                selector: elementSelector(element),
                tag,
                role,
                label,
                value: "value" in formElement ? String(formElement.value) : "",
                visibleText: text || label || buttonValue(element),
              },
            ];
          } catch {
            return [];
          }
        });

      function controlLabel(element: Element): string {
        const htmlElement = element as HTMLElement;
        const formElement = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        const id = htmlElement.id;
        const labels = "labels" in formElement && formElement.labels ? Array.from(formElement.labels) : [];
        const labelsText = labels.map((labelElement) => labelElement.textContent ?? "").join(" ");
        const explicitLabel = labelsText || labelForId(id);
        const wrappingLabel = htmlElement.closest("label")?.textContent;
        const ariaLabel = htmlElement.getAttribute("aria-label");
        const title = htmlElement.getAttribute("title");
        const placeholder = htmlElement.getAttribute("placeholder");
        const text = htmlElement.innerText || htmlElement.textContent;
        const value = buttonValue(element);
        const descriptor = controlDescriptor(element);

        return firstNormalizedText([
          explicitLabel,
          wrappingLabel,
          ariaLabel,
          title,
          semanticPlaceholderLabel(placeholder),
          placeholder,
          text,
          value,
          descriptor,
        ]);
      }

      function semanticPlaceholderLabel(value: string | null): string {
        const normalized = normalizedText(value ?? "").toLowerCase();
        if (/^(jane|john)$/.test(normalized)) {
          return "First Name";
        }
        if (/^(smith|doe)$/.test(normalized)) {
          return "Last Name";
        }
        return "";
      }

      function labelForId(id: string): string {
        if (!id) {
          return "";
        }
        try {
          return document.querySelector(`label[for="${cssString(id)}"]`)?.textContent ?? "";
        } catch {
          return "";
        }
      }

      function inferredRole(element: Element): string {
        const htmlElement = element as HTMLElement;
        const tag = element.tagName.toLowerCase();
        const type = (element as HTMLInputElement).type?.toLowerCase();

        if (tag === "button") {
          return "button";
        }
        if (htmlElement.getAttribute("onclick")) {
          return "button";
        }
        if (tag === "a") {
          return "link";
        }
        if (tag === "select") {
          return "combobox";
        }
        if (tag === "textarea") {
          return "textbox";
        }
        if (tag === "input") {
          if (type === "checkbox") {
            return "checkbox";
          }
          if (type === "radio") {
            return "radio";
          }
          if (type === "submit" || type === "button") {
            return "button";
          }
          return "textbox";
        }
        return "";
      }

      function buttonValue(element: Element): string {
        const tag = element.tagName.toLowerCase();
        const type = (element as HTMLInputElement).type?.toLowerCase();
        if (tag !== "input" || (type !== "submit" && type !== "button")) {
          return "";
        }
        return (element as HTMLInputElement).value ?? "";
      }

      function controlDescriptor(element: Element): string {
        const htmlElement = element as HTMLElement;
        const id = htmlElement.id;
        const className = htmlElement.getAttribute("class") || "";
        if (id === "next-button" || /\bright\b/.test(className)) {
          return "forward next button";
        }
        if (id === "prev-button") {
          return "previous back button";
        }

        const descriptor = id || htmlElement.getAttribute("name") || className || "";
        return descriptor.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
      }

      function isElementVisible(element: HTMLElement): boolean {
        let current: HTMLElement | null = element;
        while (current && current.nodeType === Node.ELEMENT_NODE) {
          const style = window.getComputedStyle(current);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            current.getAttribute("aria-hidden") === "true"
          ) {
            return false;
          }
          current = current.parentElement;
        }
        return true;
      }

      function elementSelector(element: Element): string {
        const htmlElement = element as HTMLElement;
        const tag = element.tagName.toLowerCase();
        const id = htmlElement.id;
        const name = htmlElement.getAttribute("name");
        const testId = htmlElement.getAttribute("data-testid");
        const className = htmlElement.getAttribute("class");
        const ariaLabel = htmlElement.getAttribute("aria-label");
        const type = (element as HTMLInputElement).type?.toLowerCase();

        const candidates: string[] = [];

        if (tag === "input" && (type === "radio" || type === "checkbox") && id) {
          const labelSelector = `label[for="${cssString(id)}"]`;
          const labels = document.querySelectorAll(labelSelector);
          if (labels.length === 1) {
            return labelSelector;
          }
        }

        if (id) {
          candidates.push(`#${cssIdent(id)}`);
        }
        if (name) {
          candidates.push(`${tag}[name="${cssString(name)}"]`);
        }
        if (testId) {
          candidates.push(`${tag}[data-testid="${cssString(testId)}"]`);
        }
        if (className) {
          const classes = className
            .split(/\s+/)
            .map((classPart) => classPart.trim())
            .filter(Boolean);
          if (classes.length > 0) {
            candidates.push(`${tag}.${classes.map(cssIdent).join(".")}`);
          }
        }
        if (ariaLabel) {
          candidates.push(`${tag}[aria-label="${cssString(ariaLabel)}"]`);
        }

        for (const candidate of candidates) {
          if (uniquelySelects(candidate, element)) {
            return candidate;
          }
        }
        return selectorPath(element);
      }

      function uniquelySelects(selector: string, element: Element): boolean {
        try {
          const matches = document.querySelectorAll(selector);
          return matches.length === 1 && matches[0] === element;
        } catch {
          return false;
        }
      }

      function selectorPath(element: Element): string {
        const segments: string[] = [];
        let current: Element | null = element;

        while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
          const tag = current.tagName.toLowerCase();
          const parent: Element | null = current.parentElement;
          if (!parent) {
            segments.unshift(tag);
            break;
          }
          const currentTag = current.tagName;
          const sameTagSiblings = Array.from(parent.children).filter((sibling) => sibling.tagName === currentTag);
          const index = sameTagSiblings.indexOf(current) + 1;
          segments.unshift(sameTagSiblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
          current = parent;
        }

        segments.unshift("body");
        return segments.join(" > ");
      }

      function cssIdent(value: string): string {
        return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : cssString(value);
      }

      function cssString(value: string): string {
        return Array.from(value)
          .map((character) => {
            const codePoint = character.codePointAt(0) ?? 0;
            if (character === "\\") {
              return "\\\\";
            }
            if (character === '"') {
              return '\\"';
            }
            if (character === "\n") {
              return "\\a ";
            }
            if (character === "\r") {
              return "\\d ";
            }
            if (character === "\t") {
              return "\\9 ";
            }
            if (character === "\f") {
              return "\\c ";
            }
            if (codePoint < 0x20 || codePoint === 0x7f) {
              return `\\${codePoint.toString(16)} `;
            }
            return character;
          })
          .join("");
      }

      function normalizedText(value: string): string {
        return value.replace(/\s+/g, " ").trim();
      }

      function firstNormalizedText(values: Array<string | null | undefined>): string {
        for (const value of values) {
          const normalized = normalizedText(value ?? "");
          if (normalized) {
            return normalized;
          }
        }
        return "";
      }
    }),
  ]);

  const elementSelectors = new Map<string, string>();
  const controls = observedControls.map((control, index) => {
    const elementId = `control-${index + 1}`;
    elementSelectors.set(elementId, control.selector);

    return {
      elementId,
      tag: control.tag,
      role: control.role ?? "",
      label: control.label ?? "",
      value: control.value ?? "",
      visibleText: control.visibleText ?? control.label ?? "",
    };
  });

  return {
    currentUrl: page.url(),
    title,
    visibleText,
    screenshotPath,
    controls,
    elementSelectors,
  };
}
