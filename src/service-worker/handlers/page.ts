import {
  ACCESSIBILITY_MESSAGE_TYPES,
  buildGenerateAccessibilityTreeMessage,
  cdp,
  getFrameIdForTab,
  getPageStateSnapshot,
  injectedTabs,
  performLocateAction,
  resolveFrameIdForTab,
  requireTabId,
  type ServiceWorkerHandlerMap,
  type ServiceWorkerMessage,
} from "../shared";
import { waitHandlers } from "./waits";

// Track tabs where we've attempted content script injection to avoid redundant attempts
// Listen for tab removal to clean up tracking
chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
});

// Helper to check if content script is loaded via ping
async function isContentScriptLoaded(tabId: number, frameId: number): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "lens.ping" }, { frameId });
    return true;
  } catch {
    return false;
  }
}

function getInjectionTarget(tabId: number, frameId: number): chrome.scripting.InjectionTarget {
  return frameId === 0 ? { tabId } : { tabId, frameIds: [frameId] };
}

async function locateElement(
  tabId: number,
  frameId: number,
  type: string,
  criteria: Record<string, unknown>,
  message: ServiceWorkerMessage,
): Promise<unknown> {
  const result = await chrome.tabs.sendMessage(tabId, { type, ...criteria }, { frameId });
  if (result.error) return result;
  if (message.action && result.ref) {
    const value = message.value !== undefined ? String(message.value) : undefined;
    return performLocateAction(tabId, result.ref, message.action, value, cdp, frameId);
  }
  return result;
}

async function getLayoutFallbackSnapshot(tabId: number, frameId: number, options: Record<string, unknown>) {
  const results = await chrome.scripting.executeScript({
    target: getInjectionTarget(tabId, frameId),
    func: (rawOptions: Record<string, unknown>) => {
      const options = rawOptions || {};
      const selector = typeof options.selector === "string" ? options.selector : null;
      const filter = options.filter === "all" || options.filter === "interactive" ? options.filter : "visual";
      const maxNodes = 400;
      const startElement = selector ? document.querySelector(selector) : document.body;

      if (!startElement) {
        return {
          error: `Selector not found: ${selector}`,
          layoutContent: "",
          viewport: { width: window.innerWidth, height: window.innerHeight },
        };
      }

      const isVisible = (element: Element) => {
        const htmlElement = element as HTMLElement;
        const rect = htmlElement.getBoundingClientRect();
        const style = window.getComputedStyle(htmlElement);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0"
        );
      };

      const isInteractive = (element: Element) =>
        element.matches(
          'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], [tabindex]:not([tabindex="-1"])',
        );

      const shouldInclude = (element: Element) => {
        if (filter === "all") return true;
        if (filter === "interactive") return isInteractive(element);
        return isVisible(element) || isInteractive(element);
      };

      const getName = (element: Element) => {
        const htmlElement = element as HTMLElement;
        const name =
          element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          element.getAttribute("placeholder") ||
          element.getAttribute("alt") ||
          htmlElement.innerText ||
          htmlElement.textContent ||
          "";
        return name.replace(/\s+/g, " ").trim().slice(0, 60);
      };

      const getDepth = (element: Element) => {
        let depth = 0;
        let current = element.parentElement;
        while (current && current !== startElement) {
          depth += 1;
          current = current.parentElement;
        }
        return depth;
      };

      const lines: string[] = [];
      let truncated = false;
      const walker = document.createTreeWalker(startElement, NodeFilter.SHOW_ELEMENT);
      let current: Node | null = startElement;

      while (current) {
        const element = current as Element;
        if (shouldInclude(element)) {
          if (lines.length >= maxNodes) {
            truncated = true;
            break;
          }

          const htmlElement = element as HTMLElement;
          const rect = htmlElement.getBoundingClientRect();
          const style = window.getComputedStyle(htmlElement);
          let line = `${"  ".repeat(Math.min(getDepth(element), 10))}${element.tagName.toLowerCase()}`;
          const role = element.getAttribute("role");
          if (role && role !== element.tagName.toLowerCase()) {
            line += ` [${role}]`;
          }
          const name = getName(element);
          if (name) {
            line += ` "${name}"`;
          }
          line += ` {x:${Math.round(rect.left)} y:${Math.round(rect.top)} w:${Math.round(rect.width)} h:${Math.round(rect.height)} display:${style.display} position:${style.position}}`;
          lines.push(line);
        }

        current = walker.nextNode();
      }

      const suffix = truncated ? "\n... truncated ..." : "";
      return {
        layoutContent: `${lines.join("\n")}${suffix}\n\n[Viewport: ${window.innerWidth}x${window.innerHeight}]`,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        fallback: "Direct DOM layout snapshot",
      };
    },
    args: [options],
  });

  return results[0]?.result || {
    error: "Could not build fallback layout snapshot",
    layoutContent: "",
    viewport: { width: 0, height: 0 },
  };
}

export const pageHandlers: ServiceWorkerHandlerMap = {
  "lens.ping": async () => ({ success: true, status: "connected" }),
  "wait.ready": waitHandlers["wait.ready"],

  "search": async (message) => {
    const tabId = requireTabId(message);
    if (!message.term) throw new Error("Search term required");
    try {
      return await chrome.tabs.sendMessage(tabId, {
        type: "search",
        term: message.term,
        caseSensitive: message.caseSensitive || false,
        limit: message.limit || 10,
      }, { frameId: getFrameIdForTab(tabId) });
    } catch {
      return { error: "Content script not loaded. Try refreshing the page." };
    }
  },

  "page.layout": async (message) => {
    const tabId = requireTabId(message);
    const layoutFrameId = await resolveFrameIdForTab(tabId);

    try {
      await chrome.tabs.sendMessage(tabId, { type: "lens.indicator.hideForToolUse" }, { frameId: 0 });
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));

    let layoutResult;
    try {
      layoutResult = await chrome.tabs.sendMessage(
        tabId,
        {
          type: "lens.page.generateLayoutTree",
          options: message.options || {},
        },
        { frameId: layoutFrameId },
      );
      if (!layoutResult || !layoutResult.layoutContent) {
        throw new Error("Content script not responding");
      }
    } catch {
      // Content script not loaded - try injection if we haven't attempted this tab
      const shouldAttemptInjection = !injectedTabs.has(tabId);

      if (shouldAttemptInjection) {
        // Method 1: Try chrome.scripting.executeScript with the actual content script file
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tabId as number, allFrames: layoutFrameId !== 0 },
            files: ["content/tree/index.js"],
          });
          injectedTabs.add(tabId);
        } catch (fileErr) {
          console.debug(`[Lens] File injection failed for tab ${tabId}:`, fileErr);

          // Method 2: Try inline bootstrap via executeScript
          try {
            const injectBootstrap = () => {
              if ((window as { __lensInjected?: boolean }).__lensInjected) {
                return { alreadyLoaded: true };
              }
              const scriptUrl = chrome.runtime.getURL("content/tree/index.js");
              const script = document.createElement("script");
              script.src = scriptUrl;
              script.type = "text/javascript";
              (document.head || document.documentElement).appendChild(script);
              (window as { __lensInjected?: boolean }).__lensInjected = true;
              return { injected: true, url: scriptUrl };
            };

            await chrome.scripting.executeScript({
              target: { tabId: tabId as number },
              func: injectBootstrap,
            });
            injectedTabs.add(tabId);
          } catch (bootstrapErr) {
            console.debug(`[Lens] Bootstrap injection failed for tab ${tabId}:`, bootstrapErr);
          }
        }
      }

      // Wait for script to initialize with exponential backoff
      let retries = 0;
      const maxRetries = 10;
      while (retries < maxRetries) {
        const isLoaded = await isContentScriptLoaded(tabId, layoutFrameId);
        if (isLoaded) break;
        await new Promise((resolve) => setTimeout(resolve, 50 * Math.pow(1.5, retries)));
        retries++;
      }

      // Retry the message
      try {
        layoutResult = await chrome.tabs.sendMessage(
          tabId,
          {
            type: "lens.page.generateLayoutTree",
            options: message.options || {},
          },
          { frameId: layoutFrameId },
        );
        if (!layoutResult || !layoutResult.layoutContent) {
          throw new Error("Content script not responding after retry");
        }
      } catch (retryErr) {
        return await getLayoutFallbackSnapshot(tabId, layoutFrameId, message.options || {});
      }
    } finally {
      try {
        await chrome.tabs.sendMessage(tabId, { type: "lens.indicator.showAfterToolUse" });
      } catch {}
    }

    return layoutResult;
  },

  "page.state": async (message) => {
    const tabId = requireTabId(message);
    const frameId = await resolveFrameIdForTab(tabId);
    return await getPageStateSnapshot(tabId, frameId);
  },

  "lens.page.scroll": async (message) => {
    const tabId = requireTabId(message);
    const deltaX = message.deltaX || 0;
    const deltaY = message.deltaY || 0;

    try {
      const viewport = await cdp.getViewportSize(tabId);
      const x = message.x ?? viewport.width / 2;
      const y = message.y ?? viewport.height / 2;
      await cdp.scroll(tabId, x, y, deltaX, deltaY);
    } catch {
      try {
        const scrollFallback = (dx: number, dy: number) => {
          window.scrollBy(dx, dy);
          return { scrollX: window.scrollX, scrollY: window.scrollY };
        };
        await chrome.scripting.executeScript({
          target: { tabId },
          func: scrollFallback,
          args: [deltaX, deltaY],
        });
      } catch {
        return { error: "Cannot scroll on this page (restricted)" };
      }
    }
    return { success: true };
  },

  "lens.input.key": async (message) => {
    const tabId = requireTabId(message);
    const key = message.key;
    if (!key) throw new Error("No key provided");
    if (key.includes("+")) {
      await cdp.pressKeyChord(tabId, key);
    } else {
      await cdp.pressKey(tabId, key);
    }
    return { success: true };
  },

  "lens.page.getViewportSize": async (message) => {
    const tabId = requireTabId(message);
    return await cdp.getViewportSize(tabId);
  },

  "page.inspect": async (message) => {
    const tabId = requireTabId(message);
    const readFrameId = await resolveFrameIdForTab(tabId);

    if (typeof message.wait === "number" && message.wait > 0) {
      const waitMs = message.wait;
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 5000)));
    }

    try {
      await chrome.tabs.sendMessage(tabId, { type: "lens.indicator.hideForToolUse" }, { frameId: 0 });
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));

    let result;
    const treeMessage = buildGenerateAccessibilityTreeMessage(message.options || {});
    try {
      result = await chrome.tabs.sendMessage(tabId, treeMessage, { frameId: readFrameId });
      // visual-indicator.js returns false for unknown message types, which causes
      // sendMessage to resolve with undefined instead of rejecting. Treat as not loaded.
      if (!result || !result.pageContent) {
        throw new Error("Content script not responding");
      }
    } catch (sendErr) {
      // Content script not loaded - try injection if we haven't attempted this tab
      const shouldAttemptInjection = !injectedTabs.has(tabId);

      if (shouldAttemptInjection) {
        // Method 1: Try chrome.scripting.executeScript with the actual content script file
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tabId as number, allFrames: readFrameId !== 0 },
            files: ["content/tree/index.js"],
          });
          injectedTabs.add(tabId);
        } catch (fileErr) {
          console.debug(`[Lens] File injection failed for tab ${tabId}:`, fileErr);

          // Method 2: Try inline bootstrap via executeScript
          try {
            const injectBootstrap = () => {
              if ((window as { __lensInjected?: boolean }).__lensInjected) {
                return { alreadyLoaded: true };
              }
              const scriptUrl = chrome.runtime.getURL("content/tree/index.js");
              const script = document.createElement("script");
              script.src = scriptUrl;
              script.type = "text/javascript";
              (document.head || document.documentElement).appendChild(script);
              (window as { __lensInjected?: boolean }).__lensInjected = true;
              return { injected: true, url: scriptUrl };
            };

            await chrome.scripting.executeScript({
              target: { tabId: tabId as number },
              func: injectBootstrap,
            });
            injectedTabs.add(tabId);
          } catch (bootstrapErr) {
            console.debug(`[Lens] Bootstrap injection failed for tab ${tabId}:`, bootstrapErr);
            // Both injection methods failed - will fall through to CDP fallback
          }
        }
      }

      // Wait for script to initialize with exponential backoff
      let retries = 0;
      const maxRetries = 10;
      while (retries < maxRetries) {
        const isLoaded = await isContentScriptLoaded(tabId, readFrameId);
        if (isLoaded) break;
        await new Promise((resolve) => setTimeout(resolve, 50 * Math.pow(1.5, retries)));
        retries++;
      }

      // Retry the message
      try {
        result = await chrome.tabs.sendMessage(tabId, treeMessage, { frameId: readFrameId });
        if (!result || !result.pageContent) {
          throw new Error("Content script not responding after retry");
        }
      } catch (retryErr) {
        // Fallback: Use CDP to get basic page content (for restricted pages like chrome://, about:, etc.)
        console.debug(`[Lens] Content script unavailable for tab ${tabId}, using CDP fallback`);
        try {
          const cdpResult = await cdp.evaluateScript(tabId, `
            (() => {
              const title = document.title;
              const url = window.location.href;
              const viewport = { width: window.innerWidth, height: window.innerHeight };

              // Simple text extraction
              const getText = () => {
                const walker = document.createTreeWalker(
                  document.body,
                  NodeFilter.SHOW_TEXT,
                  null,
                  false
                );
                const texts = [];
                let node;
                while (node = walker.nextNode()) {
                  const text = node.textContent?.trim();
                  if (text && text.length > 0) {
                    texts.push(text);
                  }
                }
                return texts.join('\\n');
              };

              // Simple element extraction
              const getElements = () => {
                const elements = [];
                const interactive = document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="link"]');
                interactive.forEach((el, i) => {
                  const rect = el.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    elements.push({
                      ref: 'e' + (i + 1),
                      tag: el.tagName.toLowerCase(),
                      text: el.textContent?.trim().slice(0, 100) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '',
                      role: el.getAttribute('role') || el.tagName.toLowerCase(),
                      x: Math.round(rect.x),
                      y: Math.round(rect.y),
                      width: Math.round(rect.width),
                      height: Math.round(rect.height)
                    });
                  }
                });
                return elements;
              };

              return {
                title,
                url,
                viewport,
                text: getText(),
                elements: getElements()
              };
            })()
          `);

          if (cdpResult.result?.value) {
            const data = cdpResult.result.value as {
              elements: Array<{
                ref: string;
                tag: string;
                text: string;
                role: string;
                x: number;
                y: number;
                width: number;
                height: number;
              }>;
              title: string;
              url: string;
              viewport: { width: number; height: number };
              text: string;
            };
            const { elements, ...rest } = data;
            result = {
              pageContent: elements.map((e) =>
                `- ${e.ref}: ${e.tag}${e.role !== e.tag ? ` [${e.role}]` : ''} "${e.text}" (${e.x},${e.y})`
              ).join('\\n'),
              ...rest,
              fallback: 'CDP-based extraction (content script not available)'
            };
          } else {
            throw new Error('CDP returned no data');
          }
        } catch (cdpErr) {
          console.error(`[Lens] CDP fallback failed for tab ${tabId}:`, cdpErr);
          return {
            error: `Content script not loaded and CDP fallback failed: ${(cdpErr as Error).message}. Try refreshing the page.`,
            pageContent: "",
            viewport: { width: 0, height: 0 },
          };
        }
      }
    } finally {
      try {
        await chrome.tabs.sendMessage(tabId, { type: "lens.indicator.showAfterToolUse" });
      } catch {}
    }

    if (treeMessage.options.includeText) {
      try {
        const textResult = await chrome.tabs.sendMessage(
          tabId,
          { type: ACCESSIBILITY_MESSAGE_TYPES.GET_PAGE_TEXT },
          { frameId: readFrameId },
        );
        if (textResult?.text) {
          result.text = textResult.text;
        }
      } catch {}
    }

    if (message.options?.includeScreenshot) {
      try {
        const screenshot = await cdp.captureScreenshot(tabId);
        return { ...result, screenshot };
      } catch {
        return { ...result, screenshotError: "Failed to capture screenshot" };
      }
    }

    return result;
  },

  "lens.form.formInput": async (message) => {
    const tabId = requireTabId(message);
    const frameId = await resolveFrameIdForTab(tabId);
    try {
      return await chrome.tabs.sendMessage(
        tabId,
        {
          type: "lens.form.formInput",
          ref: message.ref,
          value: message.value,
        },
        { frameId },
      );
    } catch {
      return { error: "Content script not loaded. Try refreshing the page." };
    }
  },

  "lens.element.getCoordinates": async (message) => {
    const tabId = requireTabId(message);
    try {
      return await chrome.tabs.sendMessage(tabId, {
        type: ACCESSIBILITY_MESSAGE_TYPES.GET_ELEMENT_COORDINATES,
        ref: message.ref,
      }, { frameId: getFrameIdForTab(tabId) });
    } catch {
      return { error: "Content script not loaded. Try refreshing the page." };
    }
  },

  "locate.role": async (message) => {
    const tabId = requireTabId(message);
    if (!message.role) throw new Error("role required");
    const frameId = getFrameIdForTab(tabId);
    try {
      return await locateElement(tabId, frameId, "locate.role", {
        role: message.role,
        name: message.name,
        all: message.all,
      }, message);
    } catch {
      return { error: "Content script not loaded. Try refreshing the page." };
    }
  },

  "locate.text": async (message) => {
    const tabId = requireTabId(message);
    if (!message.text) throw new Error("text required");
    const frameId = getFrameIdForTab(tabId);
    try {
      return await locateElement(tabId, frameId, "locate.text", {
        text: message.text,
        exact: message.exact,
      }, message);
    } catch {
      return { error: "Content script not loaded. Try refreshing the page." };
    }
  },

  "locate.label": async (message) => {
    const tabId = requireTabId(message);
    if (!message.label) throw new Error("label required");
    const frameId = getFrameIdForTab(tabId);
    try {
      return await locateElement(tabId, frameId, "locate.label", { label: message.label }, message);
    } catch {
      return { error: "Content script not loaded. Try refreshing the page." };
    }
  },

  "element.styles": async (message) => {
    const tabId = requireTabId(message);
    if (!message.selector) throw new Error("selector required");
    try {
      return await chrome.tabs.sendMessage(tabId, {
        type: "element.styles",
        selector: message.selector,
      }, { frameId: getFrameIdForTab(tabId) });
    } catch {
      return { error: "Content script not loaded. Try refreshing the page." };
    }
  },

  "run": async (message) => {
    const tabId = requireTabId(message);
    if (!message.code) throw new Error("No code provided");
    const frameId = await resolveFrameIdForTab(tabId);
    try {
      return await chrome.tabs.sendMessage(
        tabId,
        {
          type: "run",
          code: message.code,
        },
        { frameId },
      );
    } catch {
      return { error: "Content script not loaded. Try refreshing the page." };
    }
  },

  "scroll.to": async (message) => {
    const tabId = requireTabId(message);
    const frameId = await resolveFrameIdForTab(tabId);
    try {
      return await chrome.tabs.sendMessage(
        tabId,
        {
          type: "scroll.to",
          ref: message.ref,
        },
        { frameId },
      );
    } catch {
      return { error: "Content script not loaded. Try refreshing the page." };
    }
  },

  "lens.scroll.position": async (message) => {
    const tabId = requireTabId(message);
    const position = message.position;
    if (position === undefined) throw new Error('position required ("top", "bottom", or number)');
    const selector = message.selector;

    const scrollScript = (pos: string | number, sel: string | null) => {
      const findScrollable = (): Element => {
        let largest: Element | undefined;
        for (const element of document.querySelectorAll("*")) {
          if (element.scrollHeight <= element.clientHeight || element.clientHeight <= 200) continue;
          if (!largest || element.scrollHeight > largest.scrollHeight) largest = element;
        }
        return largest || document.documentElement;
      };

      const container = sel ? document.querySelector(sel) || findScrollable() : findScrollable();
      if (!container) return { error: "No scrollable container found" };

      const destination = pos === "bottom" ? container.scrollHeight : pos === "top" ? 0 : pos;
      if (typeof destination === "number") container.scrollTop = destination;

      return {
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
        atBottom: container.scrollTop + container.clientHeight >= container.scrollHeight - 10,
        atTop: container.scrollTop < 10,
      };
    };

    try {
      const script = `(${scrollScript.toString()})(${JSON.stringify(position)}, ${JSON.stringify(selector)})`;
      const result = await cdp.evaluateScript(tabId, script);
      return result.result?.value || { error: "Script failed" };
    } catch {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: scrollScript,
          args: [position, selector ?? null],
        });
        return results[0]?.result || { error: "Script failed" };
      } catch {
        return { error: "Cannot scroll on this page (restricted)" };
      }
    }
  },

  "scroll.info": async (message) => {
    const tabId = requireTabId(message);
    const selector = message.selector;

    const scrollInfoScript = (sel: string | null) => {
      const findScrollable = (): Element => {
        let largest: Element | undefined;
        for (const element of document.querySelectorAll("*")) {
          if (element.scrollHeight <= element.clientHeight || element.clientHeight <= 200) continue;
          if (!largest || element.scrollHeight > largest.scrollHeight) largest = element;
        }
        return largest || document.documentElement;
      };

      const container = sel ? document.querySelector(sel) || findScrollable() : findScrollable();
      if (!container) return { error: "No scrollable container found" };

      const maxScroll = container.scrollHeight - container.clientHeight;
      return {
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
        atBottom: container.scrollTop + container.clientHeight >= container.scrollHeight - 10,
        atTop: container.scrollTop < 10,
        scrollPercentage: maxScroll > 0 ? Math.round((container.scrollTop / maxScroll) * 100) : 100,
      };
    };

    try {
      const script = `(${scrollInfoScript.toString()})(${JSON.stringify(selector)})`;
      const result = await cdp.evaluateScript(tabId, script);
      return result.result?.value || { error: "Script failed" };
    } catch {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: scrollInfoScript,
          args: [selector ?? null],
        });
        return results[0]?.result || { error: "Script failed" };
      } catch {
        return { error: "Cannot get scroll info on this page (restricted)" };
      }
    }
  },

  "page.text": async (message) => {
    const tabId = requireTabId(message);
    const frameId = await resolveFrameIdForTab(tabId);
    try {
      const textResult = await chrome.tabs.sendMessage(
        tabId,
        { type: ACCESSIBILITY_MESSAGE_TYPES.GET_PAGE_TEXT },
        { frameId },
      );
      if (!textResult || !textResult.text) {
        throw new Error("Content script not responding");
      }
      return textResult;
    } catch {
      // Fallback: Use CDP to get page text
      try {
        const cdpResult = await cdp.evaluateScript(tabId, `
          (() => {
            const walker = document.createTreeWalker(
              document.body,
              NodeFilter.SHOW_TEXT,
              null,
              false
            );
            const texts = [];
            let node;
            while (node = walker.nextNode()) {
              const text = node.textContent?.trim();
              if (text && text.length > 0) {
                texts.push(text);
              }
            }
            return { text: texts.join('\\n') };
          })()
        `);
        if (cdpResult.result?.value?.text) {
          return { text: cdpResult.result.value.text };
        }
        return { error: "Could not extract text via CDP" };
      } catch {
        return { error: "Content script not loaded and CDP fallback failed. Try refreshing the page." };
      }
    }
  },
};
