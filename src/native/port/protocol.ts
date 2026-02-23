import { debugLog, previewDebugValue } from "../../utils/log";
import { handleNativeApiResponse as forwardApiResponse } from "../native-api-transport";
type PendingCall = {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
};
let port: chrome.runtime.Port | null = null;
let dispatch: ((message: any) => Promise<any>) | null = null;
let requestSequence = 0;
const waiting = new Map<number, PendingCall>();
const NATIVE_API_RESPONSE_MESSAGE_TYPES = new Set([
  "lens.nativeApi.responseStart",
  "lens.nativeApi.responseChunk",
  "lens.nativeApi.responseEnd",
  "lens.nativeApi.responseError",
]);
export const setNativePort = (nextPort: chrome.runtime.Port | null): void => {
  port = nextPort;
};
export const setMessageHandler = (handler: (message: any) => Promise<any>): void => {
  dispatch = handler;
};
const sendProfileInfo = async (): Promise<void> => {
  debugLog("Native host ready, sending profile info...");
  const profile = await chrome.identity.getProfileUserInfo({ accountStatus: chrome.identity.AccountStatus.ANY },).catch((error) => {
    debugLog("Failed to get profile info:", error);
    return { email: "" };
  });
  const email = profile.email || "";
  debugLog("Sending PROFILE_INFO, email:", email || "(none)");
  port?.postMessage({ type: "lens.profile.info", email },);
};
const answerMessage = async (message: any): Promise<void> => {
  try {
    const result = await dispatch!(message);
    debugLog("DEBUG: messageHandler result:", previewDebugValue(result, 200));
    if (!port) debugLog("Cannot send response - native host disconnected:", message.id);
    else port.postMessage({ id: message.id, ...result },);
  } catch (error) {
    if (!port) debugLog("Cannot send error - native host disconnected:", message.id);
    else port.postMessage({ id: message.id, error: error instanceof Error ? error.message : "Unknown error" },);
  }
};
export const receiveMessage = async (message: any): Promise<void> => {
  debugLog("Received from native host:", message.type || message.id);
  if (message.type === "lens.host.ready") return sendProfileInfo();
  if (NATIVE_API_RESPONSE_MESSAGE_TYPES.has(message.type)) {
    forwardApiResponse(message);
    chrome.runtime.sendMessage(message).catch(() => {},);
    return;
  }
  const call = message.id ? waiting.get(message.id) : undefined;
  if (call) { waiting.delete(message.id); call.resolve(message); return; }
  if (dispatch) await answerMessage(message);
};
export const sendToNativeHost = async (message: any): Promise<any> => {
  const activePort = port;
  if (!activePort) throw new Error("Native host not connected");
  if (message.type === "lens.nativeApi.request") {
    activePort.postMessage(message);
    return { sent: true };
  }
  const id = ++requestSequence;
  return new Promise<any>((resolve, reject) => {
    waiting.set(id, { resolve, reject },);
    activePort.postMessage({ ...message, id },);
    setTimeout(function expirePendingRequest() { const call = waiting.get(id); if (call) { waiting.delete(id); call.reject(new Error("Native host request timeout")); } }, 10000);
  },);
};
export const postToNativeHost = (message: any): void => {
  port?.postMessage(message);
};
