import { debugLog } from "../../utils/log";
import { receiveMessage, setMessageHandler, setNativePort } from "./protocol";

let retryTimer: ReturnType<typeof setTimeout> | null = null;
const scheduleReconnect = (delay: number): void => {
  retryTimer = setTimeout(openPort, delay);
};
const handleDisconnect = (): void => {
  const reason = chrome.runtime.lastError?.message || "unknown reason";
  debugLog("Native host disconnected:", reason);
  setNativePort(null);
  if (!reason.includes("not found")) scheduleReconnect(5000);
};
const openPort = (): void => {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  try {
    const connected = chrome.runtime.connectNative("lens.browser.host");
    setNativePort(connected);
    debugLog("Connecting to native host...",);
    connected.onMessage.addListener(receiveMessage);
    connected.onDisconnect.addListener(handleDisconnect);
  } catch (error) { debugLog("Failed to connect to native host:", error); scheduleReconnect(10000); }
};
export const initNativeMessaging = (handler: (msg: any) => Promise<any>): void => {
  setMessageHandler(handler);
  openPort();
};
