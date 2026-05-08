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
      const controls = Array.from(document.querySelectorAll("input, select, textarea, button, a"));

      return controls
        .filter((element) => {
          const htmlElement = element as HTMLElement;
          const style = window.getComputedStyle(htmlElement);
          const rect = htmlElement.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            htmlElement.getAttribute("aria-hidden") !== "true" &&
            rect.width > 0 &&
            rect.height > 0
          );
        })
        .map((element) => {
          const htmlElement = element as HTMLElement;
          const formElement = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
          const tag = element.tagName.toLowerCase();
          const label = controlLabel(element);
          const role = htmlElement.getAttribute("role") || inferredRole(element);
          const text = normalizedText(htmlElement.innerText || htmlElement.textContent || "");

          return {
            selector: elementSelector(element),
            tag,
            role,
            label,
            value: "value" in formElement ? formElement.value : "",
            visibleText: text || label,
          };
        });

      function controlLabel(element: Element): string {
        const htmlElement = element as HTMLElement;
        const id = htmlElement.id;
        const explicitLabel = id ? document.querySelector(`label[for="${cssString(id)}"]`)?.textContent : "";
        const wrappingLabel = htmlElement.closest("label")?.textContent;
        const ariaLabel = htmlElement.getAttribute("aria-label");
        const title = htmlElement.getAttribute("title");
        const placeholder = htmlElement.getAttribute("placeholder");
        const text = htmlElement.innerText || htmlElement.textContent;

        return normalizedText(explicitLabel || wrappingLabel || ariaLabel || title || placeholder || text || "");
      }

      function inferredRole(element: Element): string {
        const tag = element.tagName.toLowerCase();
        const type = (element as HTMLInputElement).type?.toLowerCase();

        if (tag === "button") {
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

      function elementSelector(element: Element): string {
        const htmlElement = element as HTMLElement;
        const tag = element.tagName.toLowerCase();
        const id = htmlElement.id;
        const name = htmlElement.getAttribute("name");
        const testId = htmlElement.getAttribute("data-testid");
        const ariaLabel = htmlElement.getAttribute("aria-label");

        if (id) {
          return `#${cssIdent(id)}`;
        }
        if (name) {
          return `${tag}[name="${cssString(name)}"]`;
        }
        if (testId) {
          return `${tag}[data-testid="${cssString(testId)}"]`;
        }
        if (ariaLabel) {
          return `${tag}[aria-label="${cssString(ariaLabel)}"]`;
        }

        return selectorPath(element);
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

        return segments.join(" > ");
      }

      function cssIdent(value: string): string {
        return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      }

      function cssString(value: string): string {
        return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      }

      function normalizedText(value: string): string {
        return value.replace(/\s+/g, " ").trim();
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
