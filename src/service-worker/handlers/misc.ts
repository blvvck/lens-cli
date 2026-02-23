import { cdp, type ServiceWorkerHandlerMap } from "../shared";
import { tabHandlers } from "./tabs";

export const miscHandlers: ServiceWorkerHandlerMap = {
  "zoom.get": async (message) => {
    const tabId = message.tabId;
    if (!tabId) throw new Error("No tabId provided");
    return { zoom: await chrome.tabs.getZoom(tabId) };
  },

  "zoom.set": async (message) => {
    const tabId = message.tabId;
    if (!tabId) throw new Error("No tabId provided");
    if (message.level === undefined) throw new Error("Zoom level required");
    if (message.level < 0.25 || message.level > 5) {
      throw new Error("Zoom level must be between 0.25 and 5");
    }
    await chrome.tabs.setZoom(tabId, message.level);
    return { success: true, zoom: message.level };
  },

  "zoom.reset": async (message) => {
    const tabId = message.tabId;
    if (!tabId) throw new Error("No tabId provided");
    await chrome.tabs.setZoom(tabId, 0);
    return { success: true, zoom: 1.0 };
  },

  "doctor": async (message) => {
    if (!message.url) throw new Error("No url provided");
    const timeout = message.timeout || 30000;
    const expectedStatus = message.expect || 200;
    const startedAt = Date.now();
    let lastError: string | null = null;

    while (Date.now() - startedAt < timeout) {
      try {
        const response = await fetch(message.url, { method: "GET" });
        await response.text();
        if (response.status === expectedStatus) {
          return { success: true, status: response.status, time: Date.now() - startedAt };
        }
        lastError = `Got status ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return {
      error: `Timeout waiting for ${message.url} to return ${expectedStatus}`,
      lastError,
      time: Date.now() - startedAt,
    };
  },

  "test.smoke": async (message) => {
    const urls: string[] = message.urls || [];
    if (urls.length === 0) return { error: "No URLs provided for smoke test" };

    const results: Array<{
      url: string;
      status: "pass" | "fail";
      time: number;
      errors: string[];
      screenshotBase64?: string;
      hostname?: string;
    }> = [];
    let pass = 0;
    let fail = 0;

    for (const url of urls) {
      const startedAt = Date.now();
      const errors: string[] = [];
      let screenshotBase64: string | undefined;
      let hostname: string | undefined;
      let testTabId: number | undefined;

      try {
        hostname = new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
        const tab = await chrome.tabs.create({ url, active: false });
        if (!tab.id) throw new Error("Failed to create tab");
        testTabId = tab.id;

        try {
          await cdp.enableConsoleTracking(testTabId);
        } catch {}

        await new Promise<void>((resolve) => {
          const removeListeners = () => {
            chrome.webNavigation.onCompleted.removeListener(onComplete);
            chrome.webNavigation.onErrorOccurred.removeListener(onError);
          };
          const onComplete = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
            if (details.tabId !== testTabId || details.frameId !== 0) return;
            removeListeners();
            resolve();
          };
          const onError = (details: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails) => {
            if (details.tabId !== testTabId || details.frameId !== 0) return;
            removeListeners();
            errors.push(`Navigation error: ${details.error}`);
            resolve();
          };

          chrome.webNavigation.onCompleted.addListener(onComplete);
          chrome.webNavigation.onErrorOccurred.addListener(onError);
          setTimeout(() => {
            removeListeners();
            errors.push("Navigation timeout (30s)");
            resolve();
          }, 30000);
        });

        await new Promise((resolve) => setTimeout(resolve, 2000));
        const consoleErrors = cdp.getConsoleMessages(testTabId, { onlyErrors: true, limit: 50 });
        errors.push(...consoleErrors.map((entry) => `[${entry.type}] ${entry.text}`));

        if (message.savePath !== undefined) {
          try {
            const screenshot = await cdp.captureScreenshot(testTabId);
            screenshotBase64 = screenshot.base64;
          } catch {}
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      } finally {
        if (testTabId) {
          try {
            await chrome.tabs.remove(testTabId);
          } catch {}
        }
      }

      const status = errors.length === 0 ? "pass" : "fail";
      if (status === "pass") pass += 1;
      else fail += 1;
      results.push({
        url,
        status,
        time: Date.now() - startedAt,
        errors,
        ...(screenshotBase64 && { screenshotBase64, hostname }),
      });

      if (message.failFast && status === "fail") break;
    }

    return {
      results,
      summary: { pass, fail, total: results.length },
      savePath: message.savePath,
    };
  },

  "tab.groups": tabHandlers["tab.groups"],
};
