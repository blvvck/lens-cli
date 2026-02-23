import { generateAccessibilityTree } from "../snapshot";
import { findVisibleTextMatch, getInteractivePageState, getVisibleTextObserverOptions } from "../../page-state";
import { isVisible } from "../dom";
import { validatePayload, requestHandler, type MessageHandler, type ResponseSender } from "./shared";

type Outcome<T = unknown> = { success: boolean; waited: number; value?: T; error?: string };
type Condition<T = unknown> = {
  description: string;
  timeout: number;
  interval?: number;
  check: () => T | null | false;
  observe?: (wake: () => void) => () => void;
  timeoutMessage: () => string;
};

function poll<T>(condition: Condition<T>): Promise<Outcome<T>> {
  const started = Date.now();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setInterval> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
    let stopWatching = () => {}, settled = false;
    const finish = (value: Outcome<T>) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(deadline);
      stopWatching();
      resolve({ ...value, waited: Date.now() - started });
    };
    const check = () => {
      const value = condition.check();
      if (value) finish({ success: true, value, waited: 0 });
    };
    check();
    if (settled) return;
    stopWatching = condition.observe?.(check) || (() => {});
    timer = setInterval(check, condition.interval || 100);
    deadline = setTimeout(() => finish({ success: false, error: condition.timeoutMessage(), waited: 0 }), condition.timeout);
  });
}

function visible(element: Element | null): boolean {
  return !!element && isVisible(element);
}

function watchDom(wake: () => void, options: MutationObserverInit): () => void {
  const observer = new MutationObserver(wake);
  observer.observe(document.documentElement, options);
  return () => observer.disconnect();
}

function urlMatch(pattern: string): (url: string) => boolean {
  if (!pattern.includes("*")) return (url) => url.includes(pattern);
  const source = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "<<<GLOBSTAR>>>").replace(/\*/g, "[^/]*").replace(/<<<GLOBSTAR>>>/g, ".*");
  const matcher = new RegExp(`^${source}$`);
  return (url) => matcher.test(url);
}

const tracking = ["doubleclick.net", "googlesyndication.com", "googletagmanager.com", "google-analytics.com", "facebook.net", "connect.facebook.net", "analytics", "ads", "tracking", "pixel", "hotjar.com", "clarity.ms", "mixpanel.com", "segment.com", "newrelic.com", "nr-data.net", "/tracker/", "/collector/", "/beacon/", "/telemetry/", "/log/", "/events/", "/track.", "/metrics/"];
const passive = new Set(["img", "image", "font", "icon"]);

function pendingRequests(): PerformanceResourceTiming[] {
  const now = performance.now();
  return (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter((entry) => {
    if (entry.responseEnd !== 0 || entry.name.startsWith("data:") || entry.name.length > 500 || tracking.some((part) => entry.name.includes(part))) return false;
    const age = now - entry.startTime;
    if (age > 10000) return false;
    return !(passive.has(entry.initiatorType || "unknown") || /\.(jpg|jpeg|png|gif|webp|svg|ico|woff|woff2|ttf|eot)(\?|$)/i.test(entry.name)) || age <= 3000;
  });
}

function conditions(message: Record<string, any>) {
  const startedAt = Date.now();
  const registry: Record<string, () => Condition<any>> = {
    element: () => {
      const { selector, state = "visible", timeout = 20000 } = message, limit = Math.min(timeout, 60000);
      return {
        description: `element ${selector} ${state}`,
        timeout: limit,
        check: () => {
          const element = document.querySelector(selector), shown = visible(element);
          return state === "attached" ? element : state === "detached" || state === "hidden" ? !element || !shown : shown;
        },
        observe: (wake) => watchDom(wake, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "hidden", "disabled"] }),
        timeoutMessage: () => `Timeout waiting for "${selector}" to be ${state}`,
      };
    },
    url: () => {
      const { pattern, timeout = 20000 } = message, limit = Math.min(timeout, 60000), matches = urlMatch(pattern);
      return {
        description: `URL matching ${pattern}`, timeout: limit,
        check: () => matches(window.location.href),
        observe: (wake) => {
          window.addEventListener("popstate", wake); window.addEventListener("hashchange", wake);
          return () => { window.removeEventListener("popstate", wake); window.removeEventListener("hashchange", wake); };
        },
        timeoutMessage: () => `Timeout waiting for URL to match "${pattern}". Current: ${window.location.href}`,
      };
    },
    stable: () => {
      const { stable = 100, timeout = 5000 } = message, limit = Math.min(timeout, 30000);
      let changed = Date.now();
      return {
        description: `DOM stable for ${stable}ms`, timeout: limit, interval: Math.max(10, Math.min(50, stable / 2)),
        check: () => Date.now() - changed >= stable,
        observe: (wake) => watchDom(() => { changed = Date.now(); wake(); }, { childList: true, subtree: true, attributes: true, characterData: true }),
        timeoutMessage: () => `Timeout: DOM did not stabilize within ${limit}ms`,
      };
    },
    text: () => {
      const { text, selector, timeout = 20000 } = message, value = String(text);
      return {
        description: `text ${value}`, timeout: Math.min(timeout, 60000),
        check: () => findVisibleTextMatch(selector ? document.querySelector(selector) : document.body, value),
        observe: (wake) => watchDom(wake, getVisibleTextObserverOptions()),
        timeoutMessage: () => `Timeout waiting for text "${value}"`,
      };
    },
    network: () => {
      const { timeout = 10000 } = message, limit = Math.min(timeout, 60000);
      return {
        description: "network idle", timeout: limit,
        check: () => pendingRequests().length === 0,
        timeoutMessage: () => `Network not idle after ${Math.min(Date.now() - startedAt, limit)}ms (${pendingRequests().length} requests pending)`,
      };
    },
  };
  return registry;
}

function treeResponse(sendResponse: ResponseSender, result: Outcome): void {
  if (!result.success) {
    sendResponse({ error: result.error, waited: result.waited, pageContent: "", viewport: { width: innerWidth, height: innerHeight } });
    return;
  }
  sendResponse({ ...generateAccessibilityTree("interactive", 15, undefined, true), waited: result.waited });
}

export const waitsHandlers: Record<string, MessageHandler> = {
  ["lens.wait.element"]: requestHandler((message, sendResponse) => {
    message = validatePayload(message, ["selector", "state", "timeout"]);
    poll(conditions(message).element()).then((result) => treeResponse(sendResponse, result));
    return true;
  }),
  ["wait.url"]: requestHandler((message, sendResponse) => {
    message = validatePayload(message, ["pattern", "timeout"]);
    poll(conditions(message).url()).then((result) => treeResponse(sendResponse, result));
    return true;
  }),
  ["wait.dom"]: requestHandler((message, sendResponse) => {
    message = validatePayload(message, ["stable", "timeout"]);
    poll(conditions(message).stable()).then((result) => treeResponse(sendResponse, result));
    return true;
  }),
  ["wait.text"]: requestHandler((message, sendResponse) => {
    message = validatePayload(message, ["text", "selector", "timeout"]);
    if (!message.text) {
      sendResponse({ error: "No text provided" });
      return true;
    }
    poll(conditions(message).text()).then((result) => sendResponse(result.success ? {
      success: true, waited: result.waited, matchedText: (result.value as Element)?.textContent?.trim()?.substring(0, 200) || null,
    } : { success: false, waited: result.waited, error: result.error }));
    return true;
  }),
  ["lens.page.getState"]: requestHandler((message, sendResponse) => {
    message = validatePayload(message, []);
    sendResponse(getInteractivePageState(document));
    return true;
  }),
  ["wait.network"]: requestHandler((message, sendResponse) => {
    message = validatePayload(message, ["timeout"]);
    poll(conditions(message).network()).then((result) => treeResponse(sendResponse, result));
    return true;
  }),
};
