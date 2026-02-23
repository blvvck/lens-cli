import { cdp, type ServiceWorkerHandlerMap } from "../shared";

export const dialogHandlers: ServiceWorkerHandlerMap = {
  "dialog.accept": async (message) => {
    if (!message.tabId) throw new Error("No tabId provided");
    return cdp.handleDialog(message.tabId, true, message.text);
  },

  "dialog.dismiss": async (message) => {
    if (!message.tabId) throw new Error("No tabId provided");
    return cdp.handleDialog(message.tabId, false);
  },

  "dialog.info": async (message) => {
    if (!message.tabId) throw new Error("No tabId provided");
    return cdp.getDialogInfo(message.tabId) || { hasDialog: false };
  },

  "dialog.closeAll": async (message) => {
    const tabId = message.tabId;
    if (!tabId) throw new Error("No tabId provided");

    const attempts = message.maxAttempts || 3;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await cdp.pressKey(tabId, "Escape");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return { success: true };
  },
};
