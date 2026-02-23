import {
  hideForToolUse,
  hideIndicators,
  dismissStaticIndicator,
  showAfterToolUse,
  showIndicators,
  showStaticIndicator,
} from "./overlay";
export type VisualIndicatorMessageType = "lens.indicator.showAgentIndicators" | "lens.indicator.hideAgentIndicators" | "lens.indicator.hideForToolUse" | "lens.indicator.showAfterToolUse" | "lens.indicator.showStaticIndicator" | "lens.indicator.hideStaticIndicator";
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type as VisualIndicatorMessageType) {
    case "lens.indicator.showAgentIndicators":
      showIndicators();
      sendResponse({ success: true },);
      return false;
    case "lens.indicator.hideAgentIndicators":
      hideIndicators();
      sendResponse({ success: true },);
      return false;
    case "lens.indicator.hideForToolUse":
      hideForToolUse();
      sendResponse({ success: true },);
      return false;
    case "lens.indicator.showAfterToolUse":
      showAfterToolUse();
      sendResponse({ success: true },);
      return false;
    case "lens.indicator.showStaticIndicator":
      showStaticIndicator();
      sendResponse({ success: true },);
      return false;
    case "lens.indicator.hideStaticIndicator":
      dismissStaticIndicator();
      sendResponse({ success: true },);
      return false;
    default:
      return false;
  }
},);
window.addEventListener("beforeunload", () => {
  hideIndicators();
  dismissStaticIndicator();
},);
