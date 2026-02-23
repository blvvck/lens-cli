import { ACCESSIBILITY_MESSAGE_TYPES } from "../accessibility-contract";
import { validatePayload, requestHandler, guarded, type MessageHandler } from "./shared";

function getPageText() {
  try {
    const content = document.querySelector("article") || document.querySelector("main") || document.body;
    return { text: content.textContent?.replace(/\s+/g, " ").trim().slice(0, 50000) || "", title: document.title, url: location.href };
  } catch (error) {
    return { text: "", title: "", url: "", error: `Failed to extract text: ${error instanceof Error ? error.message : "Unknown error"}` };
  }
}

export const framesHandlers: Record<string, MessageHandler> = {
  ["run"]: requestHandler((message, sendResponse) => {
    message = validatePayload(message, ['code']);
    try {
      const hasStmts =
        /\b(return|var|let|const|if|for|while|do|switch|try|class|function|throw|import|export)\b/.test(
          message.code,
        );
      const wrappedCode = hasStmts ? message.code : `return (${message.code})`;
      const fn = new Function(wrappedCode);
      const result = fn();
      sendResponse({ success: true, value: result });
    } catch (err) {
      sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
    return false;
  }),
  [ACCESSIBILITY_MESSAGE_TYPES.GET_PAGE_TEXT]: requestHandler((message, sendResponse) => {
    message = validatePayload(message, []);
    const result = getPageText();
    sendResponse(result);
    return true;
  }),
  ["lens.frame.getBySelector"]: guarded(requestHandler((message, sendResponse) => {
    message = validatePayload(message, ['selector']);
    const iframe = document.querySelector(message.selector) as HTMLIFrameElement;
    if (!iframe || iframe.tagName.toLowerCase() !== "iframe") {
      sendResponse({ error: `No iframe found with selector "${message.selector}"` });
      return false;
    }
    sendResponse({
      url: iframe.src,
      name: iframe.name || undefined,
    });
    return false;
  })),
  ["lens.frame.getName"]: requestHandler((message, sendResponse) => {
    message = validatePayload(message, []);
    try {
      sendResponse({ name: window.name || null });
    } catch (err) {
      sendResponse({ name: null });
    }
    return false;
  }),
};
