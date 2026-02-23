import accessibilityContract from "../../native/runtime/accessibility-contract.cjs";
import fetchPolicy from "../../native/runtime/fetch-policy.cjs";
import {
  activeStreamTabs,
  agentWorkspace,
  cdp,
  DEFAULT_WORKSPACE,
  fetchEnabledTabs,
  fetchInterceptRules,
  fetchServeRoutes,
  frameContexts,
  injectedTabs,
  navigationResolvers,
  nextScreenshotSequence,
  normalizeWorkspace,
  screenshotCache,
  tabNameRegistry,
} from "./state";
import type { CDPController } from "../cdp";
import type { ServiceWorkerMessage } from "./types";

export {
  activeStreamTabs,
  agentWorkspace,
  cdp,
  DEFAULT_WORKSPACE,
  fetchInterceptRules,
  fetchServeRoutes,
  frameContexts,
  injectedTabs,
  normalizeWorkspace,
  tabNameRegistry,
};
export type { FormFillItem, MessageOptions, ServiceWorkerHandler, ServiceWorkerHandlerMap, ServiceWorkerMessage } from "./types";

export type Screenshot = { base64: string; width: number; height: number };

export function requireTabId(message: ServiceWorkerMessage): number {
  if (!message.tabId) throw new Error("No tabId provided");
  return message.tabId;
}

export function createScreenshotId(): string {
  return `screenshot_${nextScreenshotSequence()}_${Date.now()}`;
}

export function storeScreenshot(id: string, screenshot: Screenshot): void {
  screenshotCache.set(id, screenshot);
  if (screenshotCache.size > 10) {
    const oldestId = screenshotCache.keys().next().value;
    if (oldestId) screenshotCache.delete(oldestId);
  }
}

export function getScreenshot(id: string): Screenshot | null {
  return screenshotCache.get(id) ?? null;
}

export async function captureFullPage(tabId: number, maxHeight: number): Promise<Screenshot> {
  const measurement = await cdp.evaluateScript(tabId, `(() => ({
    viewportHeight: window.innerHeight,
    totalHeight: Math.min(document.documentElement.scrollHeight, ${maxHeight}),
    width: window.innerWidth,
    devicePixelRatio: window.devicePixelRatio || 1,
    originalScrollY: window.scrollY,
  }))()`);
  const page = measurement.result?.value;
  if (!page) throw new Error("Failed to get page dimensions");

  const tiles: ImageBitmap[] = [];
  let scrollY = 0;
  while (scrollY < page.totalHeight) {
    await cdp.evaluateScript(tabId, `window.scrollTo(0, ${scrollY})`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const shot = await cdp.captureScreenshot(tabId);
    tiles.push(await createImageBitmap(base64Blob(shot.base64)));
    scrollY += page.viewportHeight;
  }
  await cdp.evaluateScript(tabId, `window.scrollTo(0, ${page.originalScrollY})`);

  const pixelRatio = page.devicePixelRatio;
  const width = Math.round(page.width * pixelRatio);
  const height = Math.round(page.totalHeight * pixelRatio);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Failed to get canvas context");

  let offsetY = 0;
  const tileHeight = Math.round(page.viewportHeight * pixelRatio);
  for (const tile of tiles) {
    const drawHeight = Math.min(tileHeight, height - offsetY);
    context.drawImage(tile, 0, 0, tile.width, drawHeight, 0, offsetY, tile.width, drawHeight);
    offsetY += drawHeight;
    tile.close();
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return { base64: await blobBase64(blob), width, height };
}

export async function annotateScreenshot(
  screenshot: Screenshot,
  elements: Array<{ ref: string; tag: string; bounds: { x: number; y: number; width: number; height: number } }>,
  scale: { scaleX: number; scaleY: number },
): Promise<Screenshot> {
  const image = await createImageBitmap(base64Blob(screenshot.base64));
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Failed to get canvas context");
  context.drawImage(image, 0, 0);
  image.close();

  const colors: Record<string, string> = {
    button: "#FF6B6B",
    input: "#4ECDC4",
    select: "#45B7D1",
    a: "#96CEB4",
    textarea: "#FF8C42",
    default: "#DDA0DD",
  };
  const ratio = Math.min(scale.scaleX, scale.scaleY);
  for (const element of elements) {
    const color = colors[element.tag] || colors.default;
    const x = Math.round(element.bounds.x * ratio);
    const y = Math.round(element.bounds.y * ratio);
    const width = Math.round(element.bounds.width * ratio);
    const height = Math.round(element.bounds.height * ratio);
    if (width < 1 || height < 1) continue;

    context.strokeStyle = color;
    context.lineWidth = 2;
    context.setLineDash([4, 4]);
    context.strokeRect(x, y, width, height);
    context.setLineDash([]);

    const fontSize = Math.max(10, Math.min(16, Math.round(canvas.width * 0.01)));
    context.font = `bold ${fontSize}px sans-serif`;
    const padding = 4;
    const labelSize = {
      width: context.measureText(element.ref).width + padding * 2,
      height: fontSize + padding * 2,
    };
    const preferAbove = width < 60 || height < 30;
    const labelTop = preferAbove ? y - labelSize.height - 2 : y + 2;
    const labelX = Math.max(0, Math.min(canvas.width - labelSize.width, x + Math.floor((width - labelSize.width) / 2)));
    const labelY = Math.max(0, Math.min(canvas.height - labelSize.height, labelTop < 0 ? y + height + 2 : labelTop));
    context.fillStyle = color;
    context.fillRect(labelX, labelY, labelSize.width, labelSize.height);
    context.strokeStyle = "white";
    context.lineWidth = 1;
    context.strokeRect(labelX, labelY, labelSize.width, labelSize.height);
    context.fillStyle = "white";
    context.textBaseline = "top";
    context.fillText(element.ref, labelX + padding, labelY + padding);
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return { base64: await blobBase64(blob), width: canvas.width, height: canvas.height };
}

export async function captureVisibleFallback(tabId: number, captureError: unknown): Promise<Screenshot> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.windowId) throw captureError;
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  const bitmap = await createImageBitmap(base64Blob(base64));
  const screenshot = { base64, width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return screenshot;
}

function base64Blob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: "image/png" });
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = () => reject(new Error("Failed to convert blob to base64"));
    reader.readAsDataURL(blob);
  });
}

export const { ACCESSIBILITY_MESSAGE_TYPES, buildGenerateAccessibilityTreeMessage } = accessibilityContract;
const { matchesUrlPattern } = fetchPolicy;

type FetchRequestPausedParams = {
  requestId: string;
  request: { url: string };
};
type InterceptRule = (typeof fetchInterceptRules)[number];

export async function enableFetchInterception(tabId: number): Promise<void> {
  const patterns = [
    ...fetchServeRoutes.map(({ urlPrefix }) => ({ urlPattern: `${urlPrefix}*` })),
    ...fetchInterceptRules.map(({ pattern }) => ({ urlPattern: pattern })),
  ];
  if (patterns.length === 0) {
    await disableFetchInterception(tabId);
    return;
  }
  await cdp.sendCommand(tabId, "Fetch.enable", { patterns });
  fetchEnabledTabs.add(tabId);
}

export async function disableFetchInterception(tabId: number): Promise<void> {
  if (!fetchEnabledTabs.has(tabId)) return;
  try {
    await cdp.sendCommand(tabId, "Fetch.disable", {});
  } catch {}
  fetchEnabledTabs.delete(tabId);
}

async function handleFetchRequestPaused(tabId: number, params: FetchRequestPausedParams): Promise<void> {
  const { requestId, request: { url } } = params;
  const send = (method: string, parameters: object) => cdp.sendCommand(tabId, method, parameters);
  try {
    const route = fetchServeRoutes.find(({ urlPrefix }) => url.startsWith(urlPrefix));
    if (route) return await serveLocalFile(route, url, requestId, send);
    const rule = fetchInterceptRules.find(({ pattern }) => matchesUrlPattern(url, pattern));
    if (rule) return await applyInterceptRule(rule, requestId, send);
    await send("Fetch.continueRequest", { requestId });
  } catch {
    try {
      await send("Fetch.continueRequest", { requestId });
    } catch {}
  }
}

async function serveLocalFile(
  route: (typeof fetchServeRoutes)[number],
  url: string,
  requestId: string,
  send: (method: string, parameters: object) => Promise<unknown>,
): Promise<void> {
  try {
    const { sendToNativeHost } = await import("../native/port");
    const response = await sendToNativeHost({
      type: "lens.file.readLocal",
      dir: route.localDir,
      urlPath: decodeURIComponent(new URL(url).pathname),
    });
    await send("Fetch.fulfillRequest", {
      requestId,
      responseCode: response.responseCode || 200,
      responseHeaders: response.responseHeaders || [
        { name: "Content-Type", value: response.mimeType || "application/octet-stream" },
        { name: "Cache-Control", value: "no-cache" },
        { name: "Access-Control-Allow-Origin", value: "*" },
      ],
      body: response.base64 || "",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Server Error";
    const body = `<!DOCTYPE html><html><body><h1>500</h1><p>${reason}</p></body></html>`;
    await send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 500,
      responseHeaders: [{ name: "Content-Type", value: "text/html" }],
      body: btoa(body),
    });
  }
}

async function applyInterceptRule(
  rule: InterceptRule,
  requestId: string,
  send: (method: string, parameters: object) => Promise<unknown>,
): Promise<void> {
  if (rule.type && !["mock", "file", "block", "delay", "status"].includes(rule.type)) {
    await send("Fetch.continueRequest", { requestId });
    return;
  }
  if (rule.type === "block") {
    await send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
    return;
  }
  if (rule.type === "delay") {
    await new Promise((resolve) => setTimeout(resolve, rule.delayMs || 1000));
    await send("Fetch.continueRequest", { requestId });
    return;
  }
  if (rule.type === "status") {
    const status = rule.status || 500;
    const labels: Record<number, string> = {
      400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
      500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
    };
    await send("Fetch.fulfillRequest", {
      requestId,
      responseCode: status,
      responseHeaders: [
        { name: "Content-Type", value: "text/plain" },
        { name: "X-Lens-Intercepted", value: "true" },
      ],
      body: btoa(`${status} ${labels[status] || "Error"}`),
    });
    return;
  }

  const body = rule.fileContent || rule.response || "";
  const text = typeof body === "object" ? JSON.stringify(body) : String(body);
  const contentType = rule.contentType || (typeof body === "object"
    ? "application/json"
    : text.trimStart().startsWith("<") ? "text/html" : "text/plain");
  await send("Fetch.fulfillRequest", {
    requestId,
    responseCode: rule.status || 200,
    responseHeaders: [
      { name: "Content-Type", value: contentType },
      { name: "Access-Control-Allow-Origin", value: "*" },
      { name: "X-Lens-Intercepted", value: "true" },
    ],
    body: btoa(text),
  });
}

cdp.setFetchRequestHandler((tabId, params) => {
  handleFetchRequestPaused(tabId, params).catch((e) => {
    import("../utils/log").then(({ debugLog }) => {
      debugLog("Fetch.requestPaused handler error:", e);
    });
  });
});


export function getFrameIdForTab(tabId: number): number {
  return frameContexts.get(tabId) ?? 0;
}

export async function resolveFrameIdForTab(tabId: number, frameId = getFrameIdForTab(tabId)): Promise<number> {
  if (frameId === 0 || !chrome.webNavigation.getAllFrames) {
    return frameId;
  }

  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (frames?.some((frame) => frame.frameId === frameId)) {
      return frameId;
    }
  } catch {
    return frameId;
  }

  frameContexts.delete(tabId);
  return 0;
}


export async function waitForRuntimeReady(tabId: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
  
  while (Date.now() < deadline) {
    try {
      const result = await cdp.evaluateScript(tabId, "document.readyState");
      if (result?.result?.value === "complete") {
        await delay(1500);
        return;
      }
    } catch {
    }
    await delay(200);
  }
  
  console.warn(`waitForRuntimeReady timed out for tab ${tabId}`);
}

export async function performLocateAction(
  tabId: number, 
  ref: string, 
  action: string, 
  value: string | undefined,
  cdp: CDPController,
  frameId: number = 0
): Promise<unknown> {
  if (action === "click") {
      const result = await chrome.tabs.sendMessage(tabId, {
        type: "lens.element.click",
        ref,
        button: "left",
      }, { frameId });
      return result.error ? result : { success: true, action: "click", ref };
  }
  if (action === "fill") {
      if (!value) return { error: "fill action requires --value" };
      const result = await chrome.tabs.sendMessage(tabId, {
        type: "lens.form.formInput",
        ref,
        value,
      }, { frameId });
      return result.error ? result : { success: true, action: "fill", ref, value };
  }
  if (action === "hover") {
      const coords = await chrome.tabs.sendMessage(tabId, {
        type: ACCESSIBILITY_MESSAGE_TYPES.GET_ELEMENT_COORDINATES,
        ref,
      }, { frameId });
      if (coords.error) return coords;
      await cdp.hover(tabId, coords.x, coords.y);
      return { success: true, action: "hover", ref };
  }
  if (action === "text") {
      const textResult = await chrome.tabs.sendMessage(tabId, {
        type: "lens.element.getText",
        ref,
      }, { frameId });
      return textResult;
  }
  return { error: `Unknown action: ${action}. Use click|fill|hover|text` };
}

export async function waitForNetworkSettle(tabId: number, baseDelay = 200, maxWait = 3000): Promise<void> {
  await new Promise(r => setTimeout(r, baseDelay));
  const deadline = Date.now() + maxWait;

  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "loading") {
      await new Promise<void>((resolve) => {
        const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
          if (updatedTabId === tabId && changeInfo.status === "complete") {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(onUpdated);
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }, Math.min(maxWait, 10000));
      });
      return;
    }

    while (Date.now() < deadline) {
      const result = await cdp.evaluateScript(tabId,
        `(() => { try { return performance.getEntriesByType('resource').filter(e => e.responseEnd === 0).length; } catch { return 0; } })()`
      );
      const pending = result?.result?.value || 0;
      if (pending === 0) return;
      await new Promise(r => setTimeout(r, 200));
    }
  } catch {
  }
}

export function parsePositiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export async function dismissDialogs(tabId: number, maxAttempts = 3): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    await cdp.pressKey(tabId, "Escape");
    await new Promise(r => setTimeout(r, 100));
  }
}

function mergePageStates(
  primary: {
    hasModal: boolean;
    hasDropdown: boolean;
    hasDatePicker: boolean;
    hasOverlay: boolean;
    focusedElement: { tag: string; type?: string } | null;
    url: string;
    title: string;
  },
  secondary: {
    hasModal: boolean;
    hasDropdown: boolean;
    hasDatePicker: boolean;
    hasOverlay: boolean;
    focusedElement: { tag: string; type?: string } | null;
    url: string;
    title: string;
  },
): {
  hasModal: boolean;
  hasDropdown: boolean;
  hasDatePicker: boolean;
  hasOverlay: boolean;
  focusedElement: { tag: string; type?: string } | null;
  url: string;
  title: string;
} {
  return {
    hasModal: primary.hasModal || secondary.hasModal,
    hasDropdown: primary.hasDropdown || secondary.hasDropdown,
    hasDatePicker: primary.hasDatePicker || secondary.hasDatePicker,
    hasOverlay: primary.hasOverlay || secondary.hasOverlay,
    focusedElement: primary.focusedElement || secondary.focusedElement,
    url: primary.url || secondary.url,
    title: primary.title || secondary.title,
  };
}

export async function getPageStateSnapshot(tabId: number, frameId = getFrameIdForTab(tabId)): Promise<{
  hasModal: boolean;
  hasDropdown: boolean;
  hasDatePicker: boolean;
  hasOverlay: boolean;
  focusedElement: { tag: string; type?: string } | null;
  url: string;
  title: string;
}> {
  const resolvedFrameId = await resolveFrameIdForTab(tabId, frameId);
  const defaultState = {
    hasModal: false,
    hasDropdown: false,
    hasDatePicker: false,
    hasOverlay: false,
    focusedElement: null,
    url: "",
    title: "",
  };

  try {
    const stateResult = await chrome.tabs.sendMessage(tabId, {
      type: "lens.page.getState",
    }, { frameId: resolvedFrameId });
    if (stateResult?.error) {
      throw new Error(stateResult.error);
    }
    return stateResult || defaultState;
  } catch {
    const target =
      resolvedFrameId === 0
        ? { tabId }
        : { tabId, frameIds: [resolvedFrameId] };

    const results = await chrome.scripting.executeScript({
      target,
      func: () => {
        const isVisibleElement = (element: Element | null): element is HTMLElement => {
          if (!element) return false;
          const htmlElement = element as HTMLElement;
          const view = element.ownerDocument?.defaultView;
          const style = view?.getComputedStyle ? view.getComputedStyle(htmlElement) : null;
          if (style) {
            if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
              return false;
            }
          }
          return htmlElement.offsetWidth > 0 && htmlElement.offsetHeight > 0;
        };

        const hasVisibleMatch = (selectors: string[]) => {
          for (const selector of selectors) {
            for (const element of Array.from(document.querySelectorAll(selector))) {
              if (isVisibleElement(element)) {
                return true;
              }
            }
          }
          return false;
        };

        const hasModal = hasVisibleMatch([
          "dialog[open]",
          '[role="dialog"]',
          '[role="alertdialog"]',
          '[aria-modal="true"]',
          ".modal.show",
          ".MuiModal-root",
          ".MuiDialog-root",
        ]);

        const hasDropdown = hasVisibleMatch([
          '[role="listbox"]',
          '[role="menu"]',
          ".dropdown-menu.show",
          '[data-state="open"][role="listbox"]',
          '[data-state="open"][role="menu"]',
        ]);

        const hasDatePicker = hasVisibleMatch([
          '[role="grid"][aria-label*="calendar" i]',
          ".react-datepicker",
          ".flatpickr-calendar.open",
          '[class*="DatePicker"]',
          '[data-testid*="datepicker" i]',
        ]);

        const activeElement = document.activeElement;
        return {
          hasModal,
          hasDropdown,
          hasDatePicker,
          hasOverlay: hasModal || hasDropdown || hasDatePicker,
          focusedElement: activeElement?.tagName
            ? {
                tag: activeElement.tagName.toLowerCase(),
                type: activeElement.getAttribute?.("type") || undefined,
              }
            : null,
          url: window.location.href,
          title: document.title || "",
        };
      },
    });

    return (results[0]?.result as typeof defaultState | undefined) || defaultState;
  }
}

export async function getRelevantPageStateSnapshot(tabId: number, frameId = getFrameIdForTab(tabId)): Promise<{
  hasModal: boolean;
  hasDropdown: boolean;
  hasDatePicker: boolean;
  hasOverlay: boolean;
  focusedElement: { tag: string; type?: string } | null;
  url: string;
  title: string;
}> {
  const frameState = await getPageStateSnapshot(tabId, frameId);
  if (frameId === 0) {
    return frameState;
  }
  const mainFrameState = await getPageStateSnapshot(tabId, 0);
  return mergePageStates(frameState, mainFrameState);
}

export async function waitForDomStable(tabId: number, frameId: number, stable = 100, timeout = 5000): Promise<void> {
  const result = await chrome.tabs.sendMessage(tabId, {
    type: "wait.dom",
    stable,
    timeout,
  }, { frameId });
  if (result?.error) {
    throw new Error(result.error);
  }
}

export async function waitForSelector(tabId: number, frameId: number, selector: string, timeout = 5000): Promise<void> {
  const result = await chrome.tabs.sendMessage(tabId, {
    type: "lens.wait.element",
    selector,
    state: "visible",
    timeout,
  }, { frameId });
  if (result?.error) {
    throw new Error(result.error);
  }
}

export async function waitForText(tabId: number, frameId: number, text: string, timeout = 5000, selector?: string): Promise<void> {
  const result = await chrome.tabs.sendMessage(tabId, {
    type: "wait.text",
    text,
    selector,
    timeout,
  }, { frameId });
  if (result?.error || result?.success === false) {
    throw new Error(result?.error || "Timeout waiting for text");
  }
}

export async function ensureReadyForAction(
  tabId: number,
  opts: { timeout: number; stable: number; dismiss: boolean; selector?: string },
  frameId = getFrameIdForTab(tabId)
): Promise<{ state: unknown }> {
  if (opts.dismiss) {
    await dismissDialogs(tabId, 3).catch(() => undefined);
  }
  if (frameId !== 0) {
    await waitForDomStable(tabId, 0, opts.stable, opts.timeout);
  }
  await waitForDomStable(tabId, frameId, opts.stable, opts.timeout);
  if (opts.selector) {
    await waitForSelector(tabId, frameId, opts.selector, opts.timeout);
  }
  const state = await getRelevantPageStateSnapshot(tabId, frameId);
  if (state.hasOverlay) {
    throw new Error("Page has active overlay/modal/dropdown. Use --dismiss or wait until UI is stable.");
  }
  return { state };
}

export async function verifyActionResult(
  tabId: number,
  opts: { verifySelector?: string; verifyText?: string; verifyTimeout: number },
  frameId = getFrameIdForTab(tabId)
): Promise<void> {
  const timeout = Math.max(300, opts.verifyTimeout);
  if (opts.verifySelector) {
    await waitForSelector(tabId, frameId, opts.verifySelector, timeout);
    return;
  }
  if (opts.verifyText) {
    await waitForText(tabId, frameId, opts.verifyText, timeout);
    return;
  }
  await waitForDomStable(tabId, frameId, 100, timeout);
}

export async function withRetry<T>(fn: () => Promise<T>, retries: number, retryDelayMs: number): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
      await new Promise(r => setTimeout(r, Math.max(0, retryDelayMs)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function runActionWithPolicy(
  tabId: number,
  options: {
    retries: number;
    retryDelay: number;
    timeout: number;
    waitReady: boolean;
    verify: boolean;
    verifySelector?: string;
    verifyText?: string;
    verifyTimeout: number;
    dismiss?: boolean;
    frameId?: number;
  },
  action: () => Promise<void>
): Promise<void> {
  const frameId = options.frameId ?? getFrameIdForTab(tabId);

  await withRetry(async () => {
    if (options.waitReady) {
      await ensureReadyForAction(
        tabId,
        { timeout: options.timeout, stable: 100, dismiss: Boolean(options.dismiss) },
        frameId,
      );
    }
    await action();
  }, options.retries, options.retryDelay);

  if (options.verify) {
    await withRetry(async () => {
      await verifyActionResult(
        tabId,
        {
          verifySelector: options.verifySelector,
          verifyText: options.verifyText,
          verifyTimeout: options.verifyTimeout,
        },
        frameId,
      );
    }, options.retries, options.retryDelay);
  }
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), Math.max(250, timeoutMs))
    ),
  ]);
}

export async function clickAtWithFallback(tabId: number, x: number, y: number, timeoutMs = 3000): Promise<void> {
  try {
    await withTimeout(cdp.click(tabId, x, y, "left", 1, 0), timeoutMs, "CDP click");
    return;
  } catch {
    const clickScript = `(() => {
      const el = document.elementFromPoint(${x}, ${y});
      if (!el) return { error: "No element at click point" };
      const target = el instanceof HTMLElement ? el : el.parentElement;
      if (!target) return { error: "No clickable element resolved" };
      target.click();
      return { success: true };
    })()`;
    const evalResult = await cdp.evaluateScript(tabId, clickScript);
    const value = evalResult?.result?.value;
    if (value?.error) {
      throw new Error(value.error);
    }
  }
}


export const COMMANDS_WITHOUT_TAB = new Set([
  "tab.list", "tab.new", "TABS_NEW", "CLOSE_TABS", "tab.switch", "TABS_SWITCH",
  "tab.name", "tab.unname", "tab.named", "tab.getByName",
  "CREATE_TAB_GROUP", "UNGROUP_TABS", "LIST_TAB_GROUPS", "GET_HISTORY", "SEARCH_HISTORY",
  "GET_COOKIES", "SET_COOKIE", "DELETE_COOKIES", "GET_BOOKMARKS", "ADD_BOOKMARK",
  "DELETE_BOOKMARK", "dialog.dismiss", "dialog.accept", "dialog.info",
  "window.new", "window.list", "window.focus", "window.close", "window.resize",
  "workspace.create", "workspace.list", "workspace.info", "workspace.close", "workspace.queue",
  "emulate.deviceList",
  "network.path",
  "lens.page.diff", "lens.page.domDiff", "extension.reload"
]);
