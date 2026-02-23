import {
  disableFetchInterception,
  enableFetchInterception,
  fetchInterceptRules,
  fetchServeRoutes,
} from "../shared";
import type { ServiceWorkerHandlerMap } from "../shared";

export const fetchInterceptHandlers: ServiceWorkerHandlerMap = {
  "lens.serve.start": async (message) => {
    if (!message.dir) {
      throw new Error("No directory provided");
    }

    const port = message.port || 8100;
    const urlPrefix = `http://lens.local:${port}/`;
    const existingIndex = fetchServeRoutes.findIndex((route) => route.urlPrefix === urlPrefix);
    if (existingIndex >= 0) {
      fetchServeRoutes.splice(existingIndex, 1);
    }
    fetchServeRoutes.push({ urlPrefix, localDir: message.dir });

    if (message.tabId) {
      await enableFetchInterception(message.tabId);
    }

    return { success: true, url: urlPrefix, dir: message.dir };
  },

  "lens.serve.stop": async (message) => {
    const port = message.port || 8100;
    const urlPrefix = `http://lens.local:${port}/`;
    const before = fetchServeRoutes.length;
    const index = fetchServeRoutes.findIndex((route) => route.urlPrefix === urlPrefix);
    if (index >= 0) {
      fetchServeRoutes.splice(index, 1);
    }

    const removed = fetchServeRoutes.length < before;
    if (fetchServeRoutes.length === 0 && fetchInterceptRules.length === 0) {
      if (message.tabId) {
        await disableFetchInterception(message.tabId);
      }
    } else if (message.tabId) {
      await enableFetchInterception(message.tabId);
    }

    return { success: true, removed };
  },

  "lens.serve.status": async () => ({
    success: true,
    serveRoutes: fetchServeRoutes.map((route) => ({
      urlPrefix: route.urlPrefix,
      localDir: route.localDir,
    })),
    interceptRules: fetchInterceptRules.map((rule) => ({ pattern: rule.pattern, type: rule.type })),
  }),

  "lens.intercept.add": async (message) => {
    if (!message.pattern) {
      throw new Error("No pattern provided");
    }

    const existingIndex = fetchInterceptRules.findIndex((rule) => rule.pattern === message.pattern);
    if (existingIndex >= 0) {
      fetchInterceptRules.splice(existingIndex, 1);
    }

    fetchInterceptRules.push({
      pattern: message.pattern,
      type: message.ruleType || "mock",
      response: message.response,
      status: message.status,
      delayMs: message.delayMs,
      fileContent: message.fileContent,
      contentType: message.contentType,
    });

    if (message.tabId) {
      await enableFetchInterception(message.tabId);
    }

    return { success: true, pattern: message.pattern, type: message.ruleType || "mock" };
  },

  "lens.intercept.remove": async (message) => {
    if (!message.pattern) {
      throw new Error("No pattern provided");
    }

    const before = fetchInterceptRules.length;
    const index = fetchInterceptRules.findIndex((rule) => rule.pattern === message.pattern);
    if (index >= 0) {
      fetchInterceptRules.splice(index, 1);
    }

    const removed = fetchInterceptRules.length < before;
    if (fetchServeRoutes.length === 0 && fetchInterceptRules.length === 0) {
      if (message.tabId) {
        await disableFetchInterception(message.tabId);
      }
    } else if (message.tabId) {
      await enableFetchInterception(message.tabId);
    }

    return { success: true, removed };
  },

  "lens.intercept.list": async () => ({
    success: true,
    serveRoutes: fetchServeRoutes.map((route) => ({
      urlPrefix: route.urlPrefix,
      localDir: route.localDir,
    })),
    interceptRules: fetchInterceptRules.map((rule) => ({ pattern: rule.pattern, type: rule.type })),
  }),

  "lens.intercept.clear": async (message) => {
    fetchInterceptRules.length = 0;
    if (fetchServeRoutes.length === 0) {
      if (message.tabId) {
        await disableFetchInterception(message.tabId);
      }
    } else if (message.tabId) {
      await enableFetchInterception(message.tabId);
    }

    return { success: true };
  },
};
