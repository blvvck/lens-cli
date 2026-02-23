import type { ServiceWorkerHandlerMap } from "../shared";

export const nativeHostHandlers: ServiceWorkerHandlerMap = {
  "lens.auth.get": async () => {
    try {
      const { sendToNativeHost } = await import("../../native/port");
      return await sendToNativeHost({ type: "lens.auth.get" });
    } catch {
      return { auth: null, hint: "Native host not connected. Make sure Lens native host is installed." };
    }
  },
  "lens.nativeApi.requestFromExtension": async (message) => {
    try {
      const { sendToNativeHost } = await import("../../native/port");
      await sendToNativeHost({
        type: "lens.nativeApi.request", streamId: message.streamId, url: message.url,
        method: message.method, headers: message.headers, body: message.body,
      });
      return { sent: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Unknown error" };
    }
  },
};
