import { findVisibleTextMatch, getVisibleTextObserverOptions } from "../page-state";

declare global {
  interface Window {
    __lensElementMap?: Record<string, { element: WeakRef<Element>; role: string; name: string }>;
    __lensLastSnapshot?: { content: string; timestamp: number };
    __lensPageApi?: InjectedPageApi;
    __lensHelpers?: InjectedPageApi["helpers"];
    lensHelpers?: InjectedPageApi["helpers"];
    __lensRefs?: Record<string, Element>;
  }
}

type InjectedPageApi = {
  helpers: typeof pageHelpers;
  refs: () => Record<string, Element>;
  elementMap: () => NonNullable<Window["__lensElementMap"]>;
};

function waitForMatch(check: () => Element | null, timeout: number, error: string, options: MutationObserverInit): Promise<Element> {
  return new Promise((resolve, reject) => {
    const found = check();
    if (found) return resolve(found);
    const observer = new MutationObserver(() => {
      const match = check();
      if (!match) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve(match);
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(error));
    }, timeout);
    observer.observe(document.documentElement, options);
  });
}

const pageHelpers = {
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  async waitForSelector(
    selector: string,
    options: { state?: "visible" | "hidden" | "attached" | "detached"; timeout?: number } = {},
  ): Promise<Element | null> {
    const { state = "visible", timeout = 20000 } = options;
    const check = (): Element | null => {
      const element = document.querySelector(selector);
      const style = element && window.getComputedStyle(element);
      const visible = !!element && style?.display !== "none" && style?.visibility !== "hidden" && style?.opacity !== "0" &&
        (element as HTMLElement).offsetWidth > 0 && (element as HTMLElement).offsetHeight > 0;
      return state === "attached" ? element : state === "detached" ? element ? null : document.body :
        state === "hidden" ? !visible ? document.body : null : visible ? element : null;
    };
    const result = await waitForMatch(check, timeout, `Timeout waiting for "${selector}" to be ${state}`, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "hidden"],
    });
    return state === "detached" || state === "hidden" ? null : result;
  },

  async waitForText(
    text: string,
    options: { selector?: string; timeout?: number } = {},
  ): Promise<Element | null> {
    const { selector, timeout = 20000 } = options;
    return waitForMatch(() => {
      const root = selector ? document.querySelector(selector) : document.body;
      return root ? findVisibleTextMatch(root, text) : null;
    }, timeout, `Timeout waiting for text "${text}"`, getVisibleTextObserverOptions());
  },

  async waitForHidden(selector: string, timeout = 20000): Promise<void> {
    await pageHelpers.waitForSelector(selector, { state: "hidden", timeout });
  },

  getByRole(role: string, options: { name?: string } = {}): Element | null {
    const { name } = options;

    const implicitRoles = new Map<string, string[]>([
      ["button", ["button", 'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]']],
      ["link", ["a[href]"]],
      ["textbox", [
        "input:not([type])",
        'input[type="text"]',
        'input[type="email"]',
        'input[type="password"]',
        'input[type="search"]',
        'input[type="tel"]',
        'input[type="url"]',
        "textarea",
      ]],
      ["checkbox", ['input[type="checkbox"]']], ["radio", ['input[type="radio"]']], ["combobox", ["select"]],
      ["heading", ["h1", "h2", "h3", "h4", "h5", "h6"]], ["list", ["ul", "ol"]], ["listitem", ["li"]],
      ["navigation", ["nav"]], ["main", ["main"]], ["banner", ["header"]], ["contentinfo", ["footer"]],
      ["form", ["form"]], ["img", ["img"]], ["table", ["table"]],
    ]);

    const candidates: Element[] = [];
    candidates.push(...document.querySelectorAll(`[role="${role}"]`));

    const implicitSelectors = implicitRoles.get(role);
    if (implicitSelectors) {
      for (const sel of implicitSelectors) {
        candidates.push(...document.querySelectorAll(`${sel}:not([role])`));
      }
    }

    if (!name) return candidates[0] || null;

    const normalizedName = name.toLowerCase().trim();
    for (const el of candidates) {
      const ariaLabel = el.getAttribute("aria-label")?.toLowerCase().trim();
      const textContent = el.textContent?.toLowerCase().trim();
      const title = el.getAttribute("title")?.toLowerCase().trim();
      const placeholder = el.getAttribute("placeholder")?.toLowerCase().trim();

      if (
        ariaLabel === normalizedName ||
        textContent === normalizedName ||
        title === normalizedName ||
        placeholder === normalizedName
      ) {
        return el;
      }
      if (ariaLabel?.includes(normalizedName) || textContent?.includes(normalizedName)) {
        return el;
      }
    }

    return null;
  },
};

export const injectedPageApi: InjectedPageApi = {
  helpers: pageHelpers,
  refs: () => (window.__lensRefs ??= {}),
  elementMap: () => (window.__lensElementMap ??= {}),
};

export function installPageBridge(): void {
  window.__lensPageApi ??= injectedPageApi;
  window.__lensHelpers ??= window.__lensPageApi.helpers;
  window.lensHelpers ??= window.__lensPageApi.helpers;
}
