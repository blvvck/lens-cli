import { activeStreamTabs, cdp } from "../shared";
import type { ServiceWorkerHandlerMap, ServiceWorkerMessage } from "../shared";
import { postToNativeHost, sendToNativeHost } from "../../native/port";

const requireTab = (message: ServiceWorkerMessage): number => {
  if (!message.tabId) throw new Error("No tabId provided");
  return message.tabId;
};

export const consoleNetworkHandlers: ServiceWorkerHandlerMap = {
  "console": async (message) => {
    const tabId = requireTab(message);
    try { await cdp.enableConsoleTracking(tabId); } catch {}
    const messages = cdp.getConsoleMessages(tabId, {
      onlyErrors: message.onlyErrors,
      pattern: message.pattern,
      limit: message.limit || 100,
    });
    if (message.clear) cdp.clearConsoleMessages(tabId);
    return { messages };
  },
  "lens.console.clear": async (message) => {
    cdp.clearConsoleMessages(requireTab(message));
    return { success: true };
  },
  "network": async (message) => {
    const tabId = requireTab(message);
    try { await cdp.enableNetworkTracking(tabId); } catch {}
    if (message.full) {
      let entries = cdp.getNetworkEntries(tabId, { urlPattern: message.urlPattern });
      if (message.method) entries = entries.filter((entry) => entry.method === message.method);
      if (message.status) entries = entries.filter((entry) => entry.status === message.status);
      if (message.contentType) entries = entries.filter((entry) => entry.type === message.contentType);
      if (message.clear) cdp.clearNetworkRequests(tabId);
      return { entries: entries.slice(0, message.limit || 100), format: message.format, verbose: message.verbose };
    }
    let requests = cdp.getNetworkRequests(tabId, { urlPattern: message.urlPattern, limit: message.limit || 100 });
    if (message.method) requests = requests.filter((request) => request.method === message.method);
    if (message.status) requests = requests.filter((request) => request.status === message.status);
    if (message.contentType) requests = requests.filter((request) => request.type === message.contentType);
    if (message.clear) cdp.clearNetworkRequests(tabId);
    return { requests, format: message.format, verbose: message.verbose };
  },
  "network.export": async (message) => {
    const tabId = requireTab(message);
    try { await cdp.enableNetworkTracking(tabId); } catch {}
    const entries = cdp.getNetworkEntries(tabId, {});
    const content = message.jsonl
      ? entries.map((entry) => JSON.stringify(entry)).join("\n")
      : JSON.stringify(entries, null, 2);
    const result = await sendToNativeHost({
      type: "lens.network.export.write",
      output: message.output,
      jsonl: message.jsonl,
      content,
    });
    if (!result.path) throw new Error(result.error || "Failed to export network entries");
    return { path: result.path };
  },
  "network.path": async (message) => {
    if (!message.requestId) throw new Error("No requestId provided");
    const result = await sendToNativeHost({
      type: "lens.network.paths",
      requestId: message.requestId,
    });
    if (!result.paths) throw new Error(result.error || `Entry not found: ${message.requestId}`);
    return { paths: result.paths };
  },
  "network.clear": async (message) => {
    cdp.clearNetworkRequests(requireTab(message));
    return { success: true };
  },
  "lens.network.getEntries": async (message) => {
    const tabId = requireTab(message);
    try { await cdp.enableNetworkTracking(tabId); } catch {}
    let entries = cdp.getNetworkEntries(tabId, {
      urlPattern: message.urlPattern,
      includeStatic: !message.excludeStatic,
    });
    if (message.origin) entries = entries.filter((entry) => entry.origin === message.origin);
    if (message.method) entries = entries.filter((entry) => entry.method === message.method);
    if (message.status) entries = entries.filter((entry) => entry.status === message.status);
    if (message.type) entries = entries.filter((entry) => entry.type === message.type);
    if (typeof message.since === "number") entries = entries.filter((entry) => entry.ts >= message.since!);
    if (message.hasBody !== undefined) {
      entries = entries.filter((entry) => message.hasBody ? entry.responseBodySize && entry.responseBodySize > 0 : !entry.responseBodySize);
    }
    if (message.last) entries = entries.slice(-message.last);
    if (message.clear) cdp.clearNetworkRequests(tabId);
    return { entries };
  },
  "lens.network.entry": async (message) => {
    const tabId = requireTab(message);
    if (!message.requestId) throw new Error("No requestId provided");
    const entry = cdp.findNetworkEntry(message.requestId, tabId);
    return entry ? { entry } : { error: `Entry not found: ${message.requestId}` };
  },
  "network.body": async (message) => {
    let tabId = requireTab(message);
    if (!message.requestId) throw new Error("No requestId provided");
    let requestId = message.requestId;
    const entry = cdp.findNetworkEntry(requestId, tabId);
    if (entry) {
      requestId = entry._requestId || requestId;
      tabId = entry.tabId;
    }
    return cdp.getResponseBody(tabId, requestId);
  },
  "network.origins": async (message) => {
    const entries = cdp.getNetworkEntries(requireTab(message), {});
    const origins: Record<string, { count: number; lastSeen: number; size: number }> = {};
    for (const entry of entries) {
      const origin = origins[entry.origin] ??= { count: 0, lastSeen: 0, size: 0 };
      origin.count++;
      origin.lastSeen = Math.max(origin.lastSeen, entry.ts);
      origin.size += entry.responseBodySize || 0;
    }
    return { origins };
  },
  "network.stats": async (message) => {
    const entries = cdp.getNetworkEntries(requireTab(message), {});
    const origins: Record<string, number> = {};
    const byMethod: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let totalSize = 0;
    let oldest = Infinity;
    let newest = 0;
    for (const entry of entries) {
      origins[entry.origin] = (origins[entry.origin] || 0) + 1;
      const method = entry.method || "GET";
      byMethod[method] = (byMethod[method] || 0) + 1;
      if (entry.status) {
        const group = `${Math.floor(entry.status / 100)}xx`;
        byStatus[group] = (byStatus[group] || 0) + 1;
      }
      totalSize += entry.responseBodySize || 0;
      oldest = Math.min(oldest, entry.ts);
      newest = Math.max(newest, entry.ts);
    }
    return { stats: {
      totalRequests: entries.length, totalSize, uniqueOrigins: Object.keys(origins).length,
      startTime: oldest === Infinity ? null : oldest,
      duration: newest && oldest !== Infinity ? newest - oldest : 0,
      byMethod, byStatus,
    } };
  },
  "lens.stream.console": async (message) => startStream(message, "console"),
  "lens.stream.network": async (message) => startStream(message, "network"),
  "lens.stream.stop": async (message) => {
    const streamId = message.streamId;
    if (streamId === undefined) throw new Error("No streamId provided");
    const tabId = activeStreamTabs.get(streamId);
    if (tabId !== undefined) {
      cdp.unsubscribeFromConsole(tabId, streamId);
      cdp.unsubscribeFromNetwork(tabId, streamId);
      activeStreamTabs.delete(streamId);
    }
    return { success: true };
  },
};

async function startStream(message: ServiceWorkerMessage, kind: "console" | "network") {
  const tabId = requireTab(message);
  const streamId = message.streamId;
  if (streamId === undefined) throw new Error("No streamId provided");
  try {
    if (kind === "console") {
      await cdp.enableConsoleTracking(tabId);
      activeStreamTabs.set(streamId, tabId);
      cdp.subscribeToConsole(tabId, streamId, (event) => postToNativeHost({
        type: "lens.event.stream", streamId,
        event: { type: "console_event", level: event.type === "exception" ? "error" : event.type,
          text: event.text, timestamp: event.timestamp, url: event.url, line: event.line },
      }));
    } else {
      await cdp.enableNetworkTracking(tabId);
      activeStreamTabs.set(streamId, tabId);
      cdp.subscribeToNetwork(tabId, streamId, (event) => postToNativeHost({
        type: "lens.event.stream", streamId,
        event: { type: "network_event", method: event.method, url: event.url,
          status: event.status, duration: event.duration, timestamp: event.timestamp },
      }));
    }
    return { success: true, streaming: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : `Failed to start ${kind} stream`;
    postToNativeHost({ type: "lens.event.streamError", streamId, error });
    return { error };
  }
}
