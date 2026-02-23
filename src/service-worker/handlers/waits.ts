import {
  cdp,
  ensureReadyForAction,
  resolveFrameIdForTab,
  type ServiceWorkerHandlerMap,
} from "../shared";

export const waitHandlers: ServiceWorkerHandlerMap = {
  "wait.ready": async (message) => {
    const tabId = message.tabId;
    if (!tabId) throw new Error("No tabId provided");
    const timeout = Number(message.timeout ?? 5000);
    const stable = Number(message.stable ?? 100);
    const dismiss = Boolean(message.dismiss);
    const selector = typeof message.selector === "string" ? message.selector : undefined;
    const frameId = await resolveFrameIdForTab(tabId);
    const { state } = await ensureReadyForAction(
      tabId,
      { timeout, stable, dismiss, selector },
      frameId,
    );
    return { success: true, state };
  },

  "lens.wait.element": async (message) => {
    const tabId = message.tabId;
    if (!tabId) throw new Error("No tabId provided");
    if (!message.selector) throw new Error("No selector provided");

    try {
      const waitFrameId = await resolveFrameIdForTab(tabId);
      const results = await chrome.scripting.executeScript({
        target: waitFrameId ? { tabId, frameIds: [waitFrameId] } : { tabId },
        func: async (selector: string, state: string, timeout: number) => {
          const maxTimeout = Math.min(timeout, 60000);

          const isElementVisible = (el: Element | null): boolean => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            return style.display !== "none" &&
              style.visibility !== "hidden" &&
              style.opacity !== "0" &&
              (el as HTMLElement).offsetWidth > 0 &&
              (el as HTMLElement).offsetHeight > 0;
          };

          const checkElement = (): boolean => {
            const el = document.querySelector(selector);
            switch (state) {
              case "attached": return !!el;
              case "detached": return !el;
              case "hidden": return !el || !isElementVisible(el);
              case "visible":
              default: return isElementVisible(el);
            }
          };

          const startTime = Date.now();

          if (checkElement()) {
            return { success: true, waited: 0 };
          }

          return new Promise<{ success: boolean; waited: number; error?: string }>((resolve) => {
            const observer = new MutationObserver(() => {
              if (checkElement()) {
                observer.disconnect();
                clearTimeout(timeoutId);
                resolve({ success: true, waited: Date.now() - startTime });
              }
            });

            const timeoutId = setTimeout(() => {
              observer.disconnect();
              resolve({
                success: false,
                waited: Date.now() - startTime,
                error: `Timeout waiting for "${selector}" to be ${state}`,
              });
            }, maxTimeout);

            observer.observe(document.documentElement, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ["style", "class", "hidden", "disabled"],
            });
          });
        },
        args: [message.selector as string, (message.state || "visible") as string, (message.timeout || 20000) as number],
      });
      const result = results?.[0]?.result as { success: boolean; waited: number; error?: string } | undefined;
      if (!result) return { error: "Wait execution failed" };
      if (!result.success) return { error: result.error, waited: result.waited };
      return { success: true, waited: result.waited };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Wait for element failed" };
    }
  },

  "wait.url": async (message) => {
    const tabId = message.tabId;
    if (!tabId) throw new Error("No tabId provided");
    if (!message.pattern) throw new Error("No URL pattern provided");

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (pattern: string, timeout: number) => {
          const maxTimeout = Math.min(timeout, 60000);

          const matchesPattern = (url: string): boolean => {
            if (pattern.includes("*")) {
              const regexPattern = pattern
                .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
                .replace(/\*\*/g, "<<<GLOBSTAR>>>")
                .replace(/\*/g, "[^/]*")
                .replace(/<<<GLOBSTAR>>>/g, ".*");
              return new RegExp(`^${regexPattern}$`).test(url);
            }
            return url.includes(pattern);
          };

          const startTime = Date.now();

          if (matchesPattern(window.location.href)) {
            return { success: true, waited: 0 };
          }

          return new Promise<{ success: boolean; waited: number; error?: string }>((resolve) => {
            let resolved = false;
            const checkUrl = () => {
              if (resolved) return;
              if (matchesPattern(window.location.href)) {
                resolved = true;
                clearInterval(intervalId);
                clearTimeout(timeoutId);
                window.removeEventListener("popstate", checkUrl);
                window.removeEventListener("hashchange", checkUrl);
                resolve({ success: true, waited: Date.now() - startTime });
              }
            };

            const intervalId = setInterval(checkUrl, 100);
            const timeoutId = setTimeout(() => {
              if (resolved) return;
              resolved = true;
              clearInterval(intervalId);
              window.removeEventListener("popstate", checkUrl);
              window.removeEventListener("hashchange", checkUrl);
              resolve({
                success: false,
                waited: Date.now() - startTime,
                error: `Timeout waiting for URL to match "${pattern}". Current: ${window.location.href}`,
              });
            }, maxTimeout);

            window.addEventListener("popstate", checkUrl);
            window.addEventListener("hashchange", checkUrl);
          });
        },
        args: [message.pattern as string, (message.timeout || 20000) as number],
      });
      const result = results?.[0]?.result as { success: boolean; waited: number; error?: string } | undefined;
      if (!result) return { error: "Wait execution failed" };
      if (!result.success) return { error: result.error, waited: result.waited };
      return { success: true, waited: result.waited };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Wait for URL failed" };
    }
  },

  "wait.network": async (message) => {
    const tabId = message.tabId;
    if (!tabId) throw new Error("No tabId provided");

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (timeout: number) => {
          const maxTimeout = Math.min(timeout, 60000);
          const adPatterns = [
            "doubleclick.net", "googlesyndication.com", "googletagmanager.com",
            "google-analytics.com", "facebook.net", "connect.facebook.net",
            "analytics", "ads", "tracking", "pixel", "hotjar.com", "clarity.ms",
            "mixpanel.com", "segment.com", "newrelic.com", "nr-data.net",
          ];

          const isAdOrTracking = (url: string): boolean => adPatterns.some(p => url.includes(p));

          const getPendingRequests = (): PerformanceResourceTiming[] => {
            const now = performance.now();
            const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
            return resources.filter(entry => {
              if (entry.responseEnd !== 0) return false;
              if (entry.name.startsWith("data:")) return false;
              if (isAdOrTracking(entry.name)) return false;
              const loadingDuration = now - entry.startTime;
              if (loadingDuration > 10000) return false;
              return true;
            });
          };

          const startTime = Date.now();

          return new Promise<{ success: boolean; waited: number; pendingCount?: number }>((resolve) => {
            const check = () => {
              const pending = getPendingRequests();
              const elapsed = Date.now() - startTime;
              if (pending.length === 0) {
                resolve({ success: true, waited: elapsed });
                return;
              }
              if (elapsed >= maxTimeout) {
                resolve({ success: false, waited: elapsed, pendingCount: pending.length });
                return;
              }
              setTimeout(check, 200);
            };
            check();
          });
        },
        args: [(message.timeout || 10000) as number],
      });
      const result = results?.[0]?.result as { success: boolean; waited: number; pendingCount?: number } | undefined;
      if (!result) return { error: "Wait execution failed" };
      if (!result.success) return { error: `Network not idle after ${result.waited}ms (${result.pendingCount} pending)`, waited: result.waited };
      return { success: true, waited: result.waited };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Wait for network idle failed" };
    }
  },

  "wait.dom": async (message) => {
    const tabId = message.tabId;
    if (!tabId) throw new Error("No tabId provided");

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (stable: number, timeout: number) => {
          const maxTimeout = Math.min(timeout, 30000);
          const startTime = Date.now();

          return new Promise<{ success: boolean; waited: number; error?: string }>((resolve) => {
            let lastMutationTime = Date.now();
            let resolved = false;

            const checkStability = () => {
              if (resolved) return;
              const timeSinceLastMutation = Date.now() - lastMutationTime;
              if (timeSinceLastMutation >= stable) {
                resolved = true;
                observer.disconnect();
                clearTimeout(timeoutId);
                clearInterval(checkInterval);
                resolve({ success: true, waited: Date.now() - startTime });
              }
            };

            const observer = new MutationObserver(() => {
              lastMutationTime = Date.now();
            });

            const timeoutId = setTimeout(() => {
              if (resolved) return;
              resolved = true;
              observer.disconnect();
              clearInterval(checkInterval);
              resolve({
                success: false,
                waited: Date.now() - startTime,
                error: `Timeout: DOM did not stabilize within ${maxTimeout}ms`,
              });
            }, maxTimeout);

            const checkInterval = setInterval(checkStability, Math.max(10, Math.min(50, stable / 2)));

            observer.observe(document.documentElement, {
              childList: true,
              subtree: true,
              attributes: true,
              characterData: true,
            });

            checkStability();
          });
        },
        args: [(message.stable || 100) as number, (message.timeout || 5000) as number],
      });
      const result = results?.[0]?.result as { success: boolean; waited: number; error?: string } | undefined;
      if (!result) return { error: "Wait execution failed" };
      if (!result.success) return { error: result.error, waited: result.waited };
      return { success: true, waited: result.waited };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Wait for DOM stable failed" };
    }
  },

  "wait.text": async (message) => {
    const tabId = message.tabId;
    if (!tabId) throw new Error("No tabId provided");
    if (!message.text) throw new Error("No text provided");

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (text: string, selector: string | null, timeout: number) => {
          const maxTimeout = Math.min(timeout, 60000);
          const startTime = Date.now();

          const findText = (): string | null => {
            const root = selector ? document.querySelector(selector) : document.body;
            if (!root) return null;
            const content = root.textContent || "";
            if (content.toLowerCase().includes(text.toLowerCase())) {
              const idx = content.toLowerCase().indexOf(text.toLowerCase());
              return content.substring(Math.max(0, idx - 20), idx + text.length + 20);
            }
            return null;
          };

          const found = findText();
          if (found) return { success: true, waited: 0, matchedText: found };

          return new Promise<{ success: boolean; waited: number; matchedText?: string; error?: string }>((resolve) => {
            const observer = new MutationObserver(() => {
              const match = findText();
              if (match) {
                observer.disconnect();
                clearTimeout(timeoutId);
                resolve({ success: true, waited: Date.now() - startTime, matchedText: match });
              }
            });

            const timeoutId = setTimeout(() => {
              observer.disconnect();
              resolve({
                success: false,
                waited: Date.now() - startTime,
                error: `Text "${text}" not found within ${maxTimeout}ms`,
              });
            }, maxTimeout);

            observer.observe(document.documentElement, {
              childList: true,
              subtree: true,
              characterData: true,
            });
          });
        },
        args: [message.text as string, (message.selector || null) as string | null, (message.timeout || 20000) as number],
      });
      const result = results?.[0]?.result as { success: boolean; waited: number; matchedText?: string; error?: string } | undefined;
      if (!result) return { error: "Wait execution failed" };
      if (!result.success) throw new Error(result.error || `Text "${message.text}" not found`);
      return { output: result.matchedText ? `Found: "${result.matchedText.trim().substring(0, 100)}"` : `Text "${message.text}" found` };
    } catch (err) {
      throw err instanceof Error ? err : new Error("Wait for text failed");
    }
  },

  "wait.load": async (message) => {
    const tabId = message.tabId;
    if (!tabId) throw new Error("No tabId provided");
    const result = await cdp.waitForLoad(tabId, message.timeout || 30000);
    if (!result.success) throw new Error(result.error);
    return { success: true, readyState: result.readyState };
  },
};
