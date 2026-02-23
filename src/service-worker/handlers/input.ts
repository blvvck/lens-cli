import {
  cdp,
  clickAtWithFallback,
  ensureReadyForAction,
  getFrameIdForTab,
  parsePositiveInt,
  requireTabId,
  runActionWithPolicy,
  type ServiceWorkerHandlerMap,
  type ServiceWorkerMessage,
  verifyActionResult,
  waitForNetworkSettle,
  waitForRuntimeReady,
  withRetry,
  withTimeout,
  agentWorkspace,
} from "../shared";
import {
  annotateScreenshot,
  captureFullPage,
  captureVisibleFallback,
  createScreenshotId,
  getScreenshot,
  storeScreenshot,
} from "../shared";

// These run inside the page through chrome.scripting.executeScript, so they must stay
// self-contained: no references to module scope.
function clickByRef(clickRef: string, clickButton: string, shouldScroll: boolean, timeout: number) {
  const el = (window as unknown as { __lensRefs?: Record<string, Element> }).__lensRefs?.[clickRef];
  if (!el) return { error: `Element ${clickRef} not found. Run page.inspect to get current elements.` };
  if (shouldScroll) el.scrollIntoView({ block: "center", behavior: "instant" });

  const deadline = Date.now() + Math.min(timeout, 60000);
  let lastBox = "";
  let settled = 0;

  const hiddenByAncestor = (): boolean => {
    let node: Element | null = el;
    while (node) {
      const s = window.getComputedStyle(node);
      if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return true;
      node = node.parentElement;
    }
    return false;
  };

  const isActionable = (): boolean => {
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    if (hiddenByAncestor()) return false;

    const box = `${rect.x},${rect.y},${rect.width},${rect.height}`;
    if (box === lastBox) settled += 1;
    else {
      lastBox = box;
      settled = 0;
    }
    if (settled < 2) return false;

    if (el.matches(":disabled") || el.closest('[aria-disabled="true"]')) {
      return false;
    }

    const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return !!top && (top === el || el.contains(top));
  };

  return (async () => {
    while (Date.now() < deadline) {
      if (isActionable()) {
        const htmlEl = el as HTMLElement;
        if (clickButton === "double") {
          htmlEl.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
        } else if (clickButton === "right") {
          htmlEl.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, view: window }));
        } else if (clickButton === "triple") {
          htmlEl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, detail: 3 }));
        } else if (typeof htmlEl.click === "function") {
          htmlEl.click();
        } else {
          htmlEl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        }
        return { success: true };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { error: `Element ${clickRef} is hidden, moving, disabled, or covered by another element` };
  })();
}

function hoverByRef(hoverRef: string, shouldScroll: boolean) {
  const el = (window as unknown as { __lensRefs?: Record<string, Element> }).__lensRefs?.[hoverRef];
  if (!el) return { error: `Element ${hoverRef} not found. Run page.inspect to get current elements.` };
  if (shouldScroll) el.scrollIntoView({ block: "center", behavior: "instant" });
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return { error: `Element ${hoverRef} is not visible` };
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

async function fillByRef(ref: string, value: unknown, shouldScroll: boolean, timeout: number) {
  const el = (window as unknown as { __lensRefs?: Record<string, Element> }).__lensRefs?.[ref] as HTMLElement | null;
  if (!el) return { success: false, error: `Element ${ref} not found. Run page.inspect to get current elements.` };
  if (shouldScroll) el.scrollIntoView({ block: "center", behavior: "instant" });

  const deadline = Date.now() + Math.min(timeout, 60000);
  let lastBox = "";
  let settled = 0;

  const hiddenByAncestor = (): boolean => {
    let node: Element | null = el;
    while (node) {
      const s = window.getComputedStyle(node);
      if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return true;
      node = node.parentElement;
    }
    return false;
  };

  const isUsable = (): boolean => {
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    if (hiddenByAncestor()) return false;

    const box = `${rect.x},${rect.y},${rect.width},${rect.height}`;
    if (box === lastBox) settled += 1;
    else {
      lastBox = box;
      settled = 0;
    }
    return settled >= 2;
  };

  while (!isUsable()) {
    if (Date.now() >= deadline) {
      return { success: false, error: `Element ${ref} is not fillable: hidden, detached, or still moving` };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const setNativeValue = (target: HTMLInputElement | HTMLTextAreaElement, val: string) => {
    const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (nativeSetter) nativeSetter.call(target, val);
    else target.value = val;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  };

  try {
    if (el instanceof HTMLInputElement) {
      const inputType = el.type.toLowerCase();
      if (inputType === "checkbox" || inputType === "radio") {
        const shouldCheck = value === true || value === "true" || value === "1" || value === "checked";
        el.checked = shouldCheck;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        el.focus();
        setNativeValue(el, String(value));
      }
      return { success: true };
    }
    if (el instanceof HTMLTextAreaElement) {
      el.focus();
      setNativeValue(el, String(value));
      return { success: true };
    }
    if (el instanceof HTMLSelectElement) {
      el.value = String(value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { success: true };
    }
    if (el.isContentEditable) {
      el.focus();
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, String(value));
      return { success: true };
    }
    return { success: false, error: "Element is not fillable" };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function clickAndType(
  tabId: number,
  message: ServiceWorkerMessage,
  doubleClick: boolean,
  submit: boolean,
): Promise<boolean> {
  let clicked = false;
  if (message.ref) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, {
        type: "lens.element.click",
        ref: message.ref,
        button: doubleClick && !submit ? "double" : "left",
      }, { frameId: getFrameIdForTab(tabId) });
      clicked = !result.error;
    } catch {}
  }
  if (!clicked && message.coordinate) {
    const [x, y] = message.coordinate as [number, number];
    await cdp.click(tabId, x, y, "left", doubleClick && !submit ? 2 : 1, 0);
    clicked = true;
  }
  if (!clicked) {
    const result = await cdp.evaluateScript(tabId, `(() => {
      const input = document.querySelector('textarea, input[type="text"], input[type="search"], input:not([type]), [contenteditable="true"]');
      if (input === null) return null;
      const { left, top, width, height } = input.getBoundingClientRect();
      return { x: left + width / 2, y: top + height / 2 };
    })()`);
    if (result.result?.value) {
      await cdp.click(tabId, result.result.value.x, result.result.value.y, "left", doubleClick ? 2 : 1, 0);
      clicked = true;
    }
  }
  return clicked;
}

export const inputHandlers: ServiceWorkerHandlerMap = {
  "lens.tabs.getCurrentId": async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return { tabId: tab?.id };
  },

  "lens.page.getScreenshot": async (message) => {
    if (!message.screenshotId) throw new Error("screenshotId required");
    const screenshot = getScreenshot(message.screenshotId);
    if (!screenshot) throw new Error(`Screenshot not found: ${message.screenshotId}`);
    return screenshot;
  },

  "lens.page.executeClick": async (message) => {
    const tabId = requireTabId(message);
    const retries = parsePositiveInt(message.retry, 0);
    const retryDelay = parsePositiveInt(message.retryDelay, 250);
    const timeout = parsePositiveInt(message.timeout, 5000);
    await runActionWithPolicy(tabId, {
      retries,
      retryDelay,
      timeout,
      waitReady: Boolean(message.waitReady),
      verify: Boolean(message.verify),
      verifySelector: typeof message.verifySelector === "string" ? message.verifySelector : undefined,
      verifyText: typeof message.verifyText === "string" ? message.verifyText : undefined,
      verifyTimeout: parsePositiveInt(message.verifyTimeout, 5000),
    }, async () => {
      const modifiers = message.modifiers ? cdp.parseModifiers(message.modifiers) : 0;
      if (modifiers) {
        await withTimeout(
          cdp.click(tabId, message.x as number, message.y as number, "left", 1, modifiers),
          3000,
          "CDP click",
        );
      } else {
        await clickAtWithFallback(tabId, message.x as number, message.y as number, 3000);
      }
      await waitForNetworkSettle(tabId);
    });
    return { success: true };
  },

  "lens.page.executeRightClick": async (message) => {
    const tabId = requireTabId(message);
    if (message.x === undefined || message.y === undefined) throw new Error("x and y are required");
    await cdp.rightClick(tabId, message.x, message.y, message.modifiers ? cdp.parseModifiers(message.modifiers) : 0);
    return { success: true };
  },

  "lens.page.executeDoubleClick": async (message) => {
    const tabId = requireTabId(message);
    if (message.x === undefined || message.y === undefined) throw new Error("x and y are required");
    await cdp.doubleClick(tabId, message.x, message.y, message.modifiers ? cdp.parseModifiers(message.modifiers) : 0);
    return { success: true };
  },

  "lens.page.executeTripleClick": async (message) => {
    const tabId = requireTabId(message);
    if (message.x === undefined || message.y === undefined) throw new Error("x and y are required");
    await cdp.tripleClick(tabId, message.x, message.y, message.modifiers ? cdp.parseModifiers(message.modifiers) : 0);
    return { success: true };
  },

  "lens.page.executeDrag": async (message) => {
    const tabId = requireTabId(message);
    if (message.startX === undefined || message.startY === undefined || message.endX === undefined || message.endY === undefined) {
      throw new Error("startX, startY, endX, and endY are required");
    }
    await cdp.drag(tabId, message.startX, message.startY, message.endX, message.endY, message.modifiers ? cdp.parseModifiers(message.modifiers) : 0);
    return { success: true };
  },

  "lens.page.executeHover": async (message) => {
    const tabId = requireTabId(message);
    if (message.x === undefined || message.y === undefined) throw new Error("x and y are required");
    await cdp.hover(tabId, message.x, message.y);
    return { success: true };
  },

  "lens.page.executeType": async (message) => {
    const tabId = requireTabId(message);
    if (message.text === undefined || message.text === null) throw new Error("No text provided");
    await runActionWithPolicy(tabId, {
      retries: parsePositiveInt(message.retry, 0),
      retryDelay: parsePositiveInt(message.retryDelay, 250),
      timeout: parsePositiveInt(message.timeout, 5000),
      waitReady: Boolean(message.waitReady),
      verify: Boolean(message.verify),
      verifySelector: typeof message.verifySelector === "string" ? message.verifySelector : undefined,
      verifyText: typeof message.verifyText === "string" ? message.verifyText : undefined,
      verifyTimeout: parsePositiveInt(message.verifyTimeout, 5000),
    }, async () => cdp.type(tabId, message.text as string));
    return { success: true };
  },

  "lens.input.paste": async (message) => {
    const tabId = requireTabId(message);
    if (message.text === undefined || message.text === null) throw new Error("No text provided");
    await cdp.sendCommand(tabId, "Input.insertText", { text: message.text });
    return { success: true };
  },

  "lens.input.typeSubmit": async (message) => {
    const tabId = requireTabId(message);
    if (!message.text) throw new Error("No text provided");
    await cdp.type(tabId, message.text);
    await cdp.pressKey(tabId, message.submitKey || "Enter");
    return { success: true };
  },

  "open": async (message) => {
    if (!message.url) throw new Error("No url provided");
    if (message.newTab) {
      const created = await chrome.tabs.create({ url: message.url, active: message.focus === true });
      if (!created.id) throw new Error("Failed to create tab");
      agentWorkspace.registerTab(created.id, message.workspace);
      agentWorkspace.setActiveTab(created.id, message.workspace);
      agentWorkspace.rememberTarget(created.id, created.windowId, message.workspace);
      await waitForRuntimeReady(created.id, 30000);
      return {
        success: true,
        tabId: created.id,
        url: message.url,
        hint: message.focus === true ? undefined : "Opened in the background; pass --focus to bring it forward.",
      };
    }
    const tabId = requireTabId(message);
    const timeoutMs = parsePositiveInt(message.timeout, 30000);
    let navigationObserved = false;
    const observeNavigation = (details: { tabId: number; frameId: number }) => {
      if (details.tabId === tabId && details.frameId === 0) navigationObserved = true;
    };
    chrome.webNavigation.onCompleted.addListener(observeNavigation);
    chrome.webNavigation.onErrorOccurred.addListener(observeNavigation);
    try {
      await chrome.tabs.update(tabId, { url: message.url });
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        try {
          if ((await chrome.tabs.get(tabId)).status === "complete") {
            await waitForRuntimeReady(tabId, Math.min(5000, timeoutMs));
            return { success: true };
          }
        } catch {}
        try {
          if ((await cdp.evaluateScript(tabId, "document.readyState"))?.result?.value === "complete") {
            await waitForRuntimeReady(tabId, Math.min(5000, timeoutMs));
            return { success: true };
          }
        } catch {}
        if (navigationObserved) {
          try {
            await waitForRuntimeReady(tabId, Math.min(5000, timeoutMs));
            return { success: true };
          } catch {}
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Timeout waiting for page load (${timeoutMs}ms)`);
    } finally {
      chrome.webNavigation.onCompleted.removeListener(observeNavigation);
      chrome.webNavigation.onErrorOccurred.removeListener(observeNavigation);
    }
  },

  "screenshot": async (message) => {
    const tabId = requireTabId(message);
    try { await chrome.tabs.sendMessage(tabId, { type: "lens.indicator.hideForToolUse" }); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      let result: { base64: string; width: number; height: number };
      let scaleInfo = { scaleX: 1, scaleY: 1 };
      let usedFallback = false;
      if (message.ref || message.selector) {
        let bounds: { x: number; y: number; width: number; height: number; error?: string } | null = null;
        if (message.ref) {
          try {
            bounds = await chrome.tabs.sendMessage(tabId, { type: "lens.element.getBounds", ref: message.ref }, { frameId: getFrameIdForTab(tabId) });
          } catch {
            throw new Error("Content script not loaded. Try refreshing the page.");
          }
        } else {
          const response = await cdp.evaluateScript(tabId, `(() => { const el = document.querySelector(${JSON.stringify(message.selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
          bounds = response.result?.value;
        }
        if (!bounds || bounds.error) throw new Error(bounds?.error || (message.ref ? `Element ref "${message.ref}" not found` : `Selector "${message.selector}" not found`));
        result = await cdp.captureRegion(tabId, bounds.x, bounds.y, bounds.width, bounds.height);
        const screenshotId = createScreenshotId();
        storeScreenshot(screenshotId, result);
        return { ...result, screenshotId };
      } else if (message.fullpage) {
        result = await captureFullPage(tabId, message.maxHeight || 4000);
        try {
          const viewport = await cdp.getViewportSize(tabId);
          const ratio = result.width / viewport.width;
          scaleInfo = { scaleX: ratio, scaleY: ratio };
        } catch {}
      } else {
        try {
          result = await cdp.captureScreenshot(tabId);
          try {
            const viewport = await cdp.getViewportSize(tabId);
            scaleInfo = {
              scaleX: result.width / viewport.width,
              scaleY: result.height / viewport.height,
            };
          } catch {}
        } catch (captureError) {
          result = await captureVisibleFallback(tabId, captureError);
          usedFallback = true;
        }
      }

      if (message.annotate && !usedFallback) {
        try {
          const tree = await chrome.tabs.sendMessage(
            tabId,
            { type: "lens.element.getBoundsForAnnotation" },
            { frameId: 0 },
          );
          if (tree?.elements?.length) {
            result = await annotateScreenshot(result, tree.elements, scaleInfo);
          }
        } catch {}
      }

      const screenshotId = createScreenshotId();
      storeScreenshot(screenshotId, result);
      return { ...result, screenshotId };
    } finally {
      try { await chrome.tabs.sendMessage(tabId, { type: "lens.indicator.showAfterToolUse" }); } catch {}
    }
  },

  "page.click": async (message) => {
    const tabId = requireTabId(message);
    const ref = message.ref as string;
    const button = (message.button || "left") as string;
    const scroll = message.scroll !== "off";
    const retries = parsePositiveInt(message.retry, 0);
    const retryDelay = parsePositiveInt(message.retryDelay, 250);
    const waitReady = Boolean(message.waitReady);
    const verify = Boolean(message.verify);
    const verifySelector = typeof message.verifySelector === "string" ? message.verifySelector : undefined;
    const verifyText = typeof message.verifyText === "string" ? message.verifyText : undefined;
    const verifyTimeout = parsePositiveInt(message.verifyTimeout, 5000);
    const timeout = parsePositiveInt(message.timeout, 5000);
    const frameId = getFrameIdForTab(tabId);

    try {
      await runActionWithPolicy(
        tabId,
        { retries, retryDelay, timeout, waitReady, verify, verifySelector, verifyText, verifyTimeout, frameId },
        async () => {
          const results = await chrome.scripting.executeScript({
            target: frameId ? { tabId, frameIds: [frameId] } : { tabId },
            func: clickByRef,
            args: [ref, button, scroll, timeout],
          });
          const result = results?.[0]?.result as { success?: boolean; error?: string } | undefined;
          if (!result || result.error || result.success === false) {
            throw new Error(result?.error || `Element ${ref} not found`);
          }
          await waitForNetworkSettle(tabId);
          await new Promise((resolve) => setTimeout(resolve, 150));
        },
      );
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Click failed" };
    }
  },

  "lens.page.hoverRef": async (message) => {
    const tabId = requireTabId(message);
    const ref = message.ref as string;
    const scroll = message.scroll !== "off";
    const frameId = getFrameIdForTab(tabId);
    try {
      const results = await chrome.scripting.executeScript({
        target: frameId ? { tabId, frameIds: [frameId] } : { tabId },
        func: hoverByRef,
        args: [ref, scroll],
      });
      const coords = results?.[0]?.result as { x?: number; y?: number; error?: string } | undefined;
      if (!coords || coords.error) {
        return { error: coords?.error || `Element ${ref} not found` };
      }
      await cdp.hover(tabId, coords.x!, coords.y!);
      await waitForNetworkSettle(tabId);
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Hover failed" };
    }
  },

  "form.fill": async (message) => {
    const tabId = requireTabId(message);
    if (!message.data) throw new Error("No data provided");
    if (!Array.isArray(message.data)) throw new Error("data must be an array of {ref, value} pairs");
    const retries = parsePositiveInt(message.retry, 0);
    const retryDelay = parsePositiveInt(message.retryDelay, 250);
    const waitReady = Boolean(message.waitReady);
    const verify = Boolean(message.verify);
    const verifySelector = typeof message.verifySelector === "string" ? message.verifySelector : undefined;
    const verifyText = typeof message.verifyText === "string" ? message.verifyText : undefined;
    const verifyTimeout = parsePositiveInt(message.verifyTimeout, 5000);
    const timeout = parsePositiveInt(message.timeout, 5000);
    const scrollEnabled = message.scroll !== "off";
    const formFrameId = getFrameIdForTab(tabId);

    if (waitReady) {
      await ensureReadyForAction(tabId, { timeout, stable: 100, dismiss: false }, formFrameId);
    }

    const target = formFrameId ? { tabId, frameIds: [formFrameId] } : { tabId };
    const formResults: { ref: string; success: boolean; error?: string }[] = [];

    for (const item of message.data as { ref: string; value: unknown }[]) {
      const { ref, value } = item;
      if (!ref) {
        formResults.push({ ref: "unknown", success: false, error: "Missing ref" });
        continue;
      }
      try {
        // One call per field, so a retry replays only the field that failed.
        await withRetry(async () => {
          const results = await chrome.scripting.executeScript({
            target,
            func: fillByRef,
            args: [ref, value, scrollEnabled, timeout],
          });
          const result = results?.[0]?.result as { success?: boolean; error?: string } | undefined;
          if (!result || result.success === false || result.error) {
            throw new Error(result?.error || `Failed to fill ${ref}`);
          }
        }, retries, retryDelay);
        formResults.push({ ref, success: true });
      } catch (e) {
        formResults.push({ ref, success: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    await waitForNetworkSettle(tabId);
    if (verify) {
      await withRetry(async () => {
        await verifyActionResult(tabId, { verifySelector, verifyText, verifyTimeout }, formFrameId);
      }, retries, retryDelay);
    }

    const failed = formResults.filter((r) => !r.success);
    return {
      success: failed.length === 0,
      filled: formResults.filter((r) => r.success).length,
      failed: failed.length,
      results: formResults,
    };
  },

  "select": async (message) => {
    const tabId = requireTabId(message);
    if (!message.selector) throw new Error("selector required");
    if (!message.values) throw new Error("values required");

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector: string, values: string[], by: string) => {
          let selectEl: HTMLSelectElement | null = null;

          if (/^e\d+$/.test(selector)) {
            const refs = (window as unknown as { __lensRefs?: Record<string, Element> }).__lensRefs;
            const element = refs?.[selector];
            if (!element) return { error: `Element ${selector} not found` };
            if (element.tagName !== "SELECT") return { error: `Element ${selector} is not a <select>` };
            selectEl = element as HTMLSelectElement;
          } else {
            selectEl = document.querySelector(selector) as HTMLSelectElement;
            if (!selectEl) return { error: `No element found matching "${selector}"` };
            if (selectEl.tagName !== "SELECT") return { error: `Element "${selector}" is not a <select>` };
          }

          if (selectEl.multiple) {
            for (const opt of selectEl.options) opt.selected = false;
          }

          const selected: string[] = [];
          const notFound: string[] = [];
          const valuesToSelect = selectEl.multiple ? values : [values[0]];

          for (const val of valuesToSelect) {
            let found = false;
            for (const opt of selectEl.options) {
              let matches = false;
              if (by === "index") matches = opt.index === parseInt(val, 10);
              else if (by === "label") matches = opt.text.toLowerCase().includes(val.toLowerCase());
              else matches = opt.value === val;
              if (matches) {
                opt.selected = true;
                selected.push(opt.value);
                found = true;
                break;
              }
            }
            if (!found) notFound.push(val);
          }

          selectEl.dispatchEvent(new Event("change", { bubbles: true }));

          if (notFound.length > 0) {
            return { selected, warning: `Values not found: ${notFound.join(", ")}` };
          }
          return { selected };
        },
        args: [message.selector as string, message.values as string[], (message.by || "value") as string],
      });
      const result = results?.[0]?.result;
      return result || { error: "Select option execution failed" };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Select option failed" };
    }
  },

  "lens.form.formInput": async (message) => {
    const tabId = requireTabId(message);
    try {
      return await chrome.tabs.sendMessage(tabId, {
        type: "lens.form.formInput",
        ref: message.ref,
        value: message.value,
      }, { frameId: getFrameIdForTab(tabId) });
    } catch {
      return { error: "Content script not loaded. Try refreshing the page." };
    }
  },

  "lens.form.setInputValue": async (message) => {
    const tabId = requireTabId(message);
    if (message.value === undefined) throw new Error("No value provided");
    const selector = message.selector;
    const ref = message.ref;
    if (!selector && !ref) throw new Error("selector or ref required");

    const lookup = ref
      ? `document.querySelector('[data-lens-ref="${ref}"]') || [...document.querySelectorAll('*')].find(e => e.getAttribute?.('data-ref') === '${ref}')`
      : `document.querySelector(${JSON.stringify(selector)})`;
    const missing = ref
      ? "'Element not found'"
      : `'Element not found: ' + ${JSON.stringify(selector)}`;
    const script = `(() => {
      const el = ${lookup};
      if (!el) return { error: ${missing} };
      el.focus();
      const isContentEditable = el.isContentEditable || el.getAttribute('contenteditable') === 'true';
      const valueTarget = isContentEditable ? el.querySelector('p') || el : el;
      valueTarget[isContentEditable ? 'textContent' : 'value'] = ${JSON.stringify(message.value)};
      for (const eventType of ['input', 'change']) {
        el.dispatchEvent(new Event(eventType, { bubbles: true }));
      }
      return { success: true, contentEditable: isContentEditable };
    })()`;
    const result = await cdp.evaluateScript(tabId, script);
    return result.result?.value || { error: "Script failed" };
  },

  "form.smart": async (message) => {
    const tabId = requireTabId(message);
    const { selector, text, clear = true, submit = false } = message;
    if (!selector) throw new Error("selector required");
    if (text === undefined) throw new Error("text required");
    const coordScript = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: 'Element not found: ' + ${JSON.stringify(selector)} };
      const target = el.querySelector('[contenteditable="true"]') || el;
      const r = target.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return { error: 'Element has zero size' };
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    })()`;
    const coordResult = await cdp.evaluateScript(tabId, coordScript);
    const coords = coordResult.result?.value;
    if (!coords || coords.error) return { error: coords?.error || "Failed to get element coordinates" };
    await cdp.click(tabId, coords.x, coords.y, "left", 1, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (clear) {
      await cdp.pressKey(tabId, "a", 4);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await cdp.pressKey(tabId, "Backspace");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await cdp.type(tabId, text);
    if (submit) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await cdp.pressKey(tabId, "Enter");
    }
    return { success: true };
  },

  "lens.find.findAndType": async (message) => {
    const tabId = requireTabId(message);
    if (!message.text) throw new Error("No text provided");
    const result = await cdp.evaluateScript(tabId, `(() => {
      const selectors = [
        'textarea:not([readonly]):not([disabled])',
        'input[type="text"]:not([readonly]):not([disabled])',
        'input[type="search"]:not([readonly]):not([disabled])',
        'input[type="email"]:not([readonly]):not([disabled])',
        'input[type="url"]:not([readonly]):not([disabled])',
        'input[type="tel"]:not([readonly]):not([disabled])',
        'input[type="password"]:not([readonly]):not([disabled])',
        'input:not([type]):not([readonly]):not([disabled])',
        '[contenteditable="true"]', '[role="textbox"]'
      ];
      const target = selectors
        .map((selector) => document.querySelector(selector))
        .find((element) => {
          if (!element) return false;
          const { width, height } = element.getBoundingClientRect();
          return width > 0 && height > 0;
        });
      if (!target) return { found: false };
      target.focus();
      const { x, y, width, height } = target.getBoundingClientRect();
      return { x: x + width / 2, y: y + height / 2, found: true };
    })()`);
    const coords = result.result?.value;
    if (!coords?.found) return { error: "No input field found on page" };
    await cdp.click(tabId, coords.x, coords.y, "left", 1, 0);
    await cdp.type(tabId, message.text);
    if (message.submit) await cdp.pressKey(tabId, message.submitKey || "Enter");
    return { success: true, coordinates: { x: coords.x, y: coords.y } };
  },

  "lens.page.clickType": async (message) => {
    const tabId = requireTabId(message);
    if (!message.text) throw new Error("No text provided");
    const clicked = await clickAndType(tabId, message, Boolean(message.doubleClick), false);
    if (!clicked) return { error: "Could not find input element" };
    await cdp.type(tabId, message.text);
    return { success: true };
  },

  "lens.page.clickTypeSubmit": async (message) => {
    const tabId = requireTabId(message);
    if (!message.text) throw new Error("No text provided");
    const clicked = await clickAndType(tabId, message, Boolean(message.doubleClick), true);
    if (!clicked) return { error: "Could not find input element" };
    await cdp.type(tabId, message.text);
    await cdp.pressKey(tabId, message.submitKey || "Enter");
    return { success: true };
  },

  "lens.form.autocompleteSelect": async (message) => {
    const tabId = requireTabId(message);
    if (!message.text) throw new Error("No text provided");
    const frameId = getFrameIdForTab(tabId);
    let clicked = false;
    if (message.ref) {
      try {
        const result = await chrome.tabs.sendMessage(tabId, {
          type: "lens.element.click", ref: message.ref, button: "left",
        }, { frameId });
        clicked = !result.error;
      } catch {}
    }
    if (!clicked && message.coordinate) {
      await cdp.click(tabId, message.coordinate[0], message.coordinate[1], "left", 1, 0);
      clicked = true;
    }
    if (!clicked) return { error: "ref or coordinate required" };
    await new Promise((resolve) => setTimeout(resolve, 100));
    await cdp.type(tabId, message.text);
    await new Promise((resolve) => setTimeout(resolve, message.waitMs || 500));
    if (message.index && message.index > 0) {
      for (let i = 0; i < message.index; i++) {
        await cdp.pressKey(tabId, "ArrowDown");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await cdp.pressKey(tabId, "Enter");
    return { success: true };
  },

  "dropdown.choose": async (message) => {
    const tabId = requireTabId(message);
    const { target, value, by = "text", useLabel = false } = message;
    if (!target) throw new Error("target (label or selector) required");
    if (!value) throw new Error("value required");

    const waitReady = Boolean(message.waitReady);
    const timeout = parsePositiveInt(message.timeout, 5000);
    const frameId = getFrameIdForTab(tabId);

    if (waitReady) {
      await ensureReadyForAction(tabId, { timeout, stable: 100, dismiss: false }, frameId);
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (tgt: string, val: string, matchBy: string, byLabel: boolean) => {
          let selectEl: HTMLSelectElement | null = null;

          if (byLabel) {
            const labels = Array.from(document.querySelectorAll("label"));
            const matchingLabel = labels.find(l => l.textContent?.toLowerCase().includes(tgt.toLowerCase()));
            if (!matchingLabel) return { error: `Label not found: "${tgt}"` };

            const forAttr = matchingLabel.getAttribute("for");
            if (forAttr) {
              const targetEl = document.getElementById(forAttr);
              if (targetEl && targetEl.tagName === "SELECT") selectEl = targetEl as HTMLSelectElement;
              if (!selectEl) {
                const byName = document.querySelector(`select[name="${forAttr}"]`);
                if (byName) selectEl = byName as HTMLSelectElement;
              }
            }
            if (!selectEl) selectEl = matchingLabel.querySelector("select");
            if (!selectEl) {
              const sibling = matchingLabel.nextElementSibling;
              if (sibling && sibling.tagName === "SELECT") selectEl = sibling as HTMLSelectElement;
            }
            if (!selectEl) return { error: `No select found for label: "${tgt}"` };
          } else {
            const selector = tgt.startsWith("#") || tgt.startsWith(".") || tgt.startsWith("[")
              ? tgt
              : `select[aria-label="${tgt}"], select[name="${tgt}"]`;
            selectEl = document.querySelector(selector) as HTMLSelectElement;
            if (!selectEl) return { error: `Select element not found: ${tgt}` };
            if (selectEl.tagName !== "SELECT") return { error: `Element is not a select: ${tgt}` };
          }

          let option: HTMLOptionElement | null = null;
          const options = Array.from(selectEl.options);

          if (matchBy === "value") {
            option = options.find(opt => opt.value === val) || null;
          } else {
            const valueLower = val.toLowerCase().trim();
            option = options.find(opt => opt.textContent?.trim().toLowerCase() === valueLower) || null;
            if (!option) {
              option = options.find(opt => opt.textContent?.toLowerCase().includes(valueLower)) || null;
            }
          }

          if (!option) {
            return { error: `Option not found: "${val}"`, available: options.map(opt => opt.textContent?.trim() || "") };
          }

          const previousValue = selectEl.value;
          selectEl.value = option.value;
          selectEl.dispatchEvent(new Event("input", { bubbles: true }));
          selectEl.dispatchEvent(new Event("change", { bubbles: true }));

          return {
            success: true,
            selected: option.textContent?.trim(),
            value: option.value,
            changed: previousValue !== option.value,
          };
        },
        args: [target as string, value as string, by as string, useLabel as boolean],
      });
      const result = results?.[0]?.result as { success?: boolean; error?: string; selected?: string; value?: string; changed?: boolean; available?: string[] } | undefined;
      if (!result || result.error) {
        return { error: result?.error || "Dropdown choose failed", availableOptions: result?.available };
      }
      return { success: true, selected: result.selected, value: result.value, changed: result.changed };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Failed to select dropdown option" };
    }
  },

  "lens.indicator.showAgentIndicators": async (message) => {
    const tabId = requireTabId(message);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content/visual-indicator.js"],
      });
      await chrome.tabs.sendMessage(tabId, { type: "lens.indicator.showAgentIndicators" });
      return { success: true };
    } catch {
      return { success: true };
    }
  },

  "lens.indicator.hideAgentIndicators": async (message) => {
    const tabId = requireTabId(message);
    try {
      await chrome.tabs.sendMessage(tabId, { type: "lens.indicator.hideAgentIndicators" });
      return { success: true };
    } catch {
      return { success: true };
    }
  },

  "lens.indicator.showStaticIndicator": async (message) => {
    const tabId = requireTabId(message);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content/visual-indicator.js"],
      });
      await chrome.tabs.sendMessage(tabId, { type: "lens.indicator.showStaticIndicator" });
      return { success: true };
    } catch {
      return { success: true };
    }
  },

  "lens.indicator.hideStaticIndicator": async (message) => {
    const tabId = requireTabId(message);
    try {
      await chrome.tabs.sendMessage(tabId, { type: "lens.indicator.hideStaticIndicator" });
      return { success: true };
    } catch {
      return { success: true };
    }
  },

  "lens.agent.stop": async (message, sender) => {
    const fromTabId = message.fromTabId;
    let targetTabId: number | undefined;

    if (fromTabId === "CURRENT_TAB" && sender.tab?.id) {
      targetTabId = sender.tab.id;
    } else if (typeof fromTabId === "number") {
      targetTabId = fromTabId;
    }

    if (targetTabId) {
      chrome.runtime.sendMessage({ type: "lens.agent.stop", targetTabId });
    }
    return { success: true };
  },

  "lens.indicator.dismissStaticIndicator": async () => ({ success: true }),

  "lens.indicator.heartbeat": async () => ({ success: true }),

  "upload.file": async (message) => {
    const tabId = requireTabId(message);
    if (!message.files || !message.files.length) throw new Error("No files provided");
    const waitReady = Boolean(message.waitReady);
    const timeout = parsePositiveInt(message.timeout, 10000);
    const frameId = getFrameIdForTab(tabId);

    if (waitReady) {
      await ensureReadyForAction(tabId, { timeout, stable: 100, dismiss: false }, frameId);
    }

    if (message.ref) {
      const selectorResults = await chrome.scripting.executeScript({
        target: { tabId },
        func: (ref: string) => {
          const refs = (window as unknown as { __lensRefs?: Record<string, Element> }).__lensRefs;
          const el = refs?.[ref];
          if (!el) return { error: `Element ${ref} not found (run page.inspect first)` };
          if (!(el instanceof HTMLInputElement) || el.type !== "file") {
            return { error: "Element is not a file input" };
          }
          const uniqueId = `__lens_file_${Date.now()}`;
          el.setAttribute("data-lens-file-id", uniqueId);
          return { selector: `[data-lens-file-id="${uniqueId}"]` };
        },
        args: [message.ref as string],
      });
      const selectorResult = selectorResults?.[0]?.result as { selector?: string; error?: string } | undefined;
      if (!selectorResult || selectorResult.error) {
        throw new Error(selectorResult?.error || "Failed to resolve file input");
      }
      const setResult = await cdp.setFileInputBySelector(tabId, selectorResult.selector!, message.files as string[]);
      if (!setResult.success) throw new Error(setResult.error);
    } else if (message.triggerRef || message.triggerSelector) {
      const interceptPromise = cdp.interceptFileChooser(tabId, message.files as string[], timeout);
      await new Promise((resolve) => setTimeout(resolve, 50));

      if (message.triggerRef) {
        const clickResults = await chrome.scripting.executeScript({
          target: { tabId },
          func: (ref: string) => {
            const refs = (window as unknown as { __lensRefs?: Record<string, Element> }).__lensRefs;
            const el = refs?.[ref] as HTMLElement | undefined;
            if (!el) return { error: `Element ${ref} not found` };
            el.click();
            return { success: true };
          },
          args: [message.triggerRef as string],
        });
        const clickResult = clickResults?.[0]?.result as { success?: boolean; error?: string } | undefined;
        if (!clickResult || clickResult.error) {
          throw new Error(clickResult?.error || "Failed to click upload trigger");
        }
      } else {
        const clickResults = await chrome.scripting.executeScript({
          target: { tabId },
          func: (sel: string) => {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (!el) return { error: `No element matches selector: ${sel}` };
            el.click();
            return { success: true };
          },
          args: [String(message.triggerSelector)],
        });
        const clickResult = clickResults?.[0]?.result as { success?: boolean; error?: string } | undefined;
        if (!clickResult || clickResult.error) {
          throw new Error(clickResult?.error || "Failed to click upload trigger selector");
        }
      }

      const result = await interceptPromise;
      if (!result.success) throw new Error(result.error || "File upload interception failed");
    } else {
      throw new Error("Either --ref (file input), --trigger (ref), or --trigger-selector (CSS selector) is required");
    }
    return { success: true, filesSet: message.files.length };
  },

  "upload.image": async (message) => {
    const tabId = requireTabId(message);
    if (!message.screenshotId) throw new Error("screenshotId required");
    if (!message.ref && !message.coordinate) throw new Error("ref or coordinate required");

    const screenshot = getScreenshot(message.screenshotId);
    if (!screenshot) throw new Error(`Screenshot not found: ${message.screenshotId}`);

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (base64: string, ref: string | undefined, coordinate: { x: number; y: number } | undefined, filename: string) => {
          let fileInput: HTMLInputElement | null = null;

          if (ref) {
            const refs = (window as unknown as { __lensRefs?: Record<string, Element> }).__lensRefs;
            const el = refs?.[ref];
            if (!el) return { error: `Element ${ref} not found` };
            if (el instanceof HTMLInputElement && el.type === "file") {
              fileInput = el;
            } else {
              const input = el.querySelector('input[type="file"]');
              if (input) fileInput = input as HTMLInputElement;
            }
          } else if (coordinate) {
            const el = document.elementFromPoint(coordinate.x, coordinate.y);
            if (el instanceof HTMLInputElement && el.type === "file") {
              fileInput = el;
            } else if (el) {
              const input = el.querySelector('input[type="file"]');
              if (input) fileInput = input as HTMLInputElement;
            }
          }

          if (!fileInput) return { error: "No file input found at target" };

          try {
            const byteChars = atob(base64);
            const byteArray = new Uint8Array(byteChars.length);
            for (let i = 0; i < byteChars.length; i++) {
              byteArray[i] = byteChars.charCodeAt(i);
            }
            const file = new File([byteArray], filename, { type: "image/png" });
            const dt = new DataTransfer();
            dt.items.add(file);
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event("change", { bubbles: true }));
            return { success: true };
          } catch (e) {
            return { error: e instanceof Error ? e.message : "Failed to set file" };
          }
        },
        args: [screenshot.base64, message.ref as string | undefined, message.coordinate as { x: number; y: number } | undefined, (message.filename || "screenshot.png") as string],
      });
      const result = results?.[0]?.result as { success?: boolean; error?: string } | undefined;
      if (!result || result.error) {
        return { error: result?.error || "Upload image failed" };
      }
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Upload image failed" };
    }
  },

  "lens.element.clickSelector": async (message) => {
    const tabId = requireTabId(message);
    const selector = message.selector as string;
    const index = Number(message.index || 0);
    const scroll = message.scroll !== "off";

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel: string, idx: number, shouldScroll: boolean) => {
          const elements = document.querySelectorAll(sel);
          if (elements.length === 0) {
            return { error: `No elements match selector: ${sel}` };
          }
          const el = elements[idx];
          if (!el) {
            return { error: `No element at index ${idx} for selector: ${sel} (found ${elements.length})` };
          }
          if (shouldScroll) {
            el.scrollIntoView({ block: "center", behavior: "instant" });
          }
          const htmlEl = el as HTMLElement;
          if (typeof htmlEl.click === "function") {
            htmlEl.click();
          } else {
            htmlEl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          }
          return { success: true, count: elements.length };
        },
        args: [selector, index, scroll],
      });
      const result = results?.[0]?.result as { success?: boolean; error?: string; count?: number } | undefined;
      if (!result || result.error) {
        return { error: result?.error || "Failed to click selector" };
      }
      await waitForNetworkSettle(tabId);
      return { success: true, selector, index, matchCount: result.count || 0 };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Click selector failed" };
    }
  },
};
