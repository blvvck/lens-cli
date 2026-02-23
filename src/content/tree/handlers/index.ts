import { treeHandlers } from "./tree";
import { elementsHandlers } from "./elements";
import { waitsHandlers } from "./waits";
import { framesHandlers } from "./frames";
import { layoutHandlers } from "./layout";
import type { IncomingMessage, MessageHandler } from "./shared";

const handlers: Record<string, MessageHandler> = {
  ...treeHandlers,
  ...elementsHandlers,
  ...waitsHandlers,
  ...framesHandlers,
  ...layoutHandlers,
};

export function registerAccessibilityHandlers(): void {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!message || typeof message !== "object" || !("type" in message)) return false;
    const incoming = message as IncomingMessage;
    if (typeof incoming.type !== "string") return false;
    return handlers[incoming.type]?.(incoming, sendResponse) ?? false;
  });
}
