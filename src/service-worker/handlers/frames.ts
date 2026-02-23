import { cdp, frameContexts, getFrameIdForTab } from "../shared";
import type { ServiceWorkerHandlerMap } from "../shared";

const cdpFrameContexts = new Map<number, string>();

function installLensHelpers() {
  const page = window as Window & { lensHelpers?: unknown; __lensHelpers?: unknown };
  if (page.lensHelpers) return;
  const visible = (element: Element | null) => !!element &&
    getComputedStyle(element).display !== "none" &&
    getComputedStyle(element).visibility !== "hidden" &&
    getComputedStyle(element).opacity !== "0" &&
    (element as HTMLElement).offsetWidth > 0 && (element as HTMLElement).offsetHeight > 0;
  const lensHelpers = {
    wait: (milliseconds: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    async waitForSelector(
      selector: string,
      options: { state?: "visible" | "hidden" | "attached" | "detached"; timeout?: number } = {},
    ): Promise<Element | null> {
      const { state = "visible", timeout = 20000 } = options;
      const find = () => {
        const element = document.querySelector(selector);
        if (state === "attached") return element;
        if (state === "detached") return element ? null : document.body;
        if (state === "hidden") return !visible(element) ? element || document.body : null;
        return visible(element) ? element : null;
      };
      const current = find();
      if (current) return state === "detached" || state === "hidden" ? null : current;
      return new Promise((resolve, reject) => {
        const observer = new MutationObserver(() => {
          const match = find();
          if (match) {
            observer.disconnect();
            clearTimeout(timer);
            resolve(state === "detached" || state === "hidden" ? null : match);
          }
        });
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error("Timeout"));
        }, timeout);
        observer.observe(document.documentElement, {
          childList: true, subtree: true, attributes: true,
          attributeFilter: ["style", "class", "hidden"],
        });
      });
    },
    async waitForText(text: string, options: { selector?: string; timeout?: number } = {}): Promise<Element | null> {
      const find = () => {
        const root = options.selector ? document.querySelector(options.selector) : document.body;
        if (!root) return null;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (walker.currentNode.textContent?.includes(text)) return walker.currentNode.parentElement;
        }
        return null;
      };
      const current = find();
      if (current) return current;
      return new Promise<Element | null>((resolve, reject) => {
        const observer = new MutationObserver(() => {
          const match = find();
          if (match) {
            observer.disconnect();
            clearTimeout(timer);
            resolve(match);
          }
        });
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error("Timeout"));
        }, options.timeout ?? 20000);
        observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      });
    },
    async waitForHidden(selector: string, timeout = 20000) {
      await this.waitForSelector(selector, { state: "hidden", timeout });
    },
    getByRole(role: string, options: { name?: string } = {}) {
      const selectors: Record<string, string[]> = {
        button: ["button", "input[type=button]", "input[type=submit]", "input[type=reset]"],
        link: ["a[href]"],
        textbox: ["input:not([type])", "input[type=text]", "input[type=email]", "input[type=password]", "textarea"],
        checkbox: ["input[type=checkbox]"], radio: ["input[type=radio]"], combobox: ["select"],
        heading: ["h1", "h2", "h3", "h4", "h5", "h6"],
      };
      const candidates = [...document.querySelectorAll(`[role="${role}"]`)];
      for (const selector of selectors[role] || []) {
        candidates.push(...document.querySelectorAll(`${selector}:not([role])`));
      }
      const name = options.name?.toLowerCase().trim();
      if (!name) return candidates[0] || null;
      return candidates.find((element) => {
        const label = element.getAttribute("aria-label")?.toLowerCase().trim();
        const text = element.textContent?.toLowerCase().trim();
        return label === name || text === name || label?.includes(name) || text?.includes(name);
      }) || null;
    },
  };
  page.__lensHelpers = lensHelpers;
  page.lensHelpers = lensHelpers;
}

export const frameHandlers: ServiceWorkerHandlerMap = {
  "frame.list": async (message) => {
    const tabId = message.tabId;
    if (!tabId) {
      throw new Error("No tabId provided");
    }

    const result = await cdp.getFrames(tabId);
    if (!result.success) {
      throw new Error(result.error);
    }

    return { success: true, frames: result.frames };
  },

  "frame.switch": async (message) => {
    const tabId = message.tabId;
    if (!tabId) {
      throw new Error("No tabId provided");
    }
    frameContexts.delete(tabId);
    cdpFrameContexts.delete(tabId);

    const { selector, name, index } = message;
    if (!selector && !name && index === undefined) {
      throw new Error("--selector, --name, or --index required");
    }

    const chromeFrames = await chrome.webNavigation.getAllFrames({ tabId });
    if (!chromeFrames || chromeFrames.length === 0) {
      throw new Error("No frames found in tab");
    }

    const childFrames = chromeFrames.filter((frame) => frame.frameId !== 0);
    if (childFrames.length === 0) {
      throw new Error("No iframes found on this page");
    }

    let targetFrame: chrome.webNavigation.GetAllFrameResultDetails | null = null;

    if (index !== undefined) {
      if (index < 0 || index >= childFrames.length) {
        throw new Error(`Frame index ${index} out of range. Found ${childFrames.length} frame(s).`);
      }
      targetFrame = childFrames[index];
    } else if (name) {
      for (const frame of childFrames) {
        try {
          const result = await chrome.tabs.sendMessage(
            tabId,
            { type: "lens.frame.getName" },
            { frameId: frame.frameId },
          );
          if (result?.name === name) {
            targetFrame = frame;
            break;
          }
        } catch {}
      }
      if (!targetFrame) {
        throw new Error(`Frame with name "${name}" not found`);
      }
    } else if (selector) {
      try {
        const selectorResult = await chrome.tabs.sendMessage(
          tabId,
          { type: "lens.frame.getBySelector", selector },
          { frameId: 0 },
        );

        if (selectorResult?.error) {
          throw new Error(selectorResult.error);
        }

        if (selectorResult?.url) {
          targetFrame = childFrames.find((frame) => frame.url === selectorResult.url) || null;
        }

        if (!targetFrame && childFrames.length === 1) {
          targetFrame = childFrames[0];
        }
      } catch {
        throw new Error(`Could not find frame with selector "${selector}"`);
      }
    }

    if (!targetFrame) {
      throw new Error("Frame not found");
    }

    const cdpFrames = await cdp.getFrames(tabId);
    if (!cdpFrames.success || !Array.isArray(cdpFrames.frames)) {
      frameContexts.delete(tabId);
      throw new Error("Could not map the selected frame to a CDP frame");
    }
    const cdpMatches = cdpFrames.frames.filter((frame) => frame.url === targetFrame.url);
    if (cdpMatches.length !== 1) {
      frameContexts.delete(tabId);
      throw new Error(
        cdpMatches.length === 0
          ? `Could not map frame ${targetFrame.frameId} to a CDP frame`
          : `Could not uniquely map frame ${targetFrame.frameId} to CDP (${cdpMatches.length} matching URLs)`,
      );
    }
    const cdpFrame = cdpMatches[0];
    frameContexts.set(tabId, targetFrame.frameId);
    cdpFrameContexts.set(tabId, cdpFrame.frameId);
    return { success: true, frameId: targetFrame.frameId, cdpFrameId: cdpFrame.frameId, url: targetFrame.url };
  },

  "frame.main": async (message) => {
    const tabId = message.tabId;
    if (!tabId) {
      throw new Error("No tabId provided");
    }

    frameContexts.delete(tabId);
    cdpFrameContexts.delete(tabId);
    return { success: true, message: "Returned to main frame" };
  },

  "frame.js": async (message) => {
    const tabId = message.tabId;
    if (!tabId) {
      throw new Error("No tabId provided");
    }
    const frameId = message.frameId ?? cdpFrameContexts.get(tabId) ?? getFrameIdForTab(tabId);
    if (!frameId) {
      throw new Error("No frameId provided");
    }
    if (!message.code) {
      throw new Error("No code provided");
    }

    const result = await cdp.evaluateInFrame(tabId, String(frameId), message.code);
    if (!result.success) {
      throw new Error(result.error);
    }

    return { value: result.result };
  },

  "lens.page.execute": async (message) => {
    const tabId = message.tabId;
    if (!tabId) throw new Error("No tabId provided");
    if (!message.code) throw new Error("No code provided");
    try {
      await cdp.evaluateScript(tabId, `(${installLensHelpers.toString()})()`);
      const code = message.code.replace(/`/g, "\\`").replace(/\$/g, "\\$");
      const statement = /\b(return|var|let|const|if|for|while|do|switch|try|class|function|throw|import|export)\b/.test(code);
      const expression = `(async () => { 'use strict'; ${statement ? code : `return (${code})`} })()`;
      const result = await cdp.evaluateScript(tabId, expression);
      if (result.exceptionDetails) {
        return { error: result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Script execution failed" };
      }
      const value = result.result?.value;
      return { output: value === undefined ? "undefined" : JSON.stringify(value, null, 2).substring(0, 50000) };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Script execution failed";
      return { error: reason.includes("Cannot access") || reason.includes("Cannot attach")
        ? "Cannot execute JavaScript on this page (restricted URL)" : reason };
    }
  },
};
