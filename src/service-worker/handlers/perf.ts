import { cdp } from "../shared";
import type { ServiceWorkerHandlerMap } from "../shared";

type TraceReply<T> = { success: boolean; error?: string } & T;

function acceptTrace<T>(reply: TraceReply<T>): T {
  const { success, error, ...value } = reply;
  if (!success) throw new Error(error);
  return value as T;
}

async function traceRequest<T>(tabId: number | undefined, request: (id: number) => Promise<TraceReply<T>>) {
  if (!tabId) throw new Error("No tabId provided");
  return acceptTrace(await request(tabId));
}

export const perfHandlers: ServiceWorkerHandlerMap = {
  "perf.start": async (message) => {
    await traceRequest(message.tabId, (tabId) => cdp.startPerformanceTrace(tabId, message.categories));
    return { success: true, message: "Performance tracing started" };
  },

  "perf.stop": async (message) => {
    const result = await traceRequest(message.tabId, (tabId) => cdp.stopPerformanceTrace(tabId));
    return { success: true, metrics: result.metrics };
  },

  "perf.metrics": async (message) => {
    const result = await traceRequest(message.tabId, (tabId) => cdp.getPerformanceMetrics(tabId));
    return { success: true, metrics: result.metrics };
  },
};
