import { initNativeMessaging } from "../native/port";
import { debugLog, previewDebugValue } from "../utils/log";
import {
  agentWorkspace,
  COMMANDS_WITHOUT_TAB,
  DEFAULT_WORKSPACE,
  normalizeWorkspace,
} from "./shared";
import type { ServiceWorkerMessage } from "./types";
import { handlerRegistry } from "./registry";

debugLog("Service worker loaded");

// Message types whose handlers require a tab. Everything else - window management,
// tab listing, bookmarks for a given id - must not be blocked by the tab guard.
const NEEDS_TAB_MESSAGE_TYPES = new Set([
  "lens.form.autocompleteSelect",
  "bookmark.add",
  "bookmark.remove",
  "lens.console.clear",
  "network.clear",
  "page.click",
  "lens.element.clickSelector",
  "lens.page.clickType",
  "lens.page.clickTypeSubmit",
  "dialog.closeAll",
  "cookie.clear",
  "cookie.clearAll",
  "cookie.get",
  "cookie.list",
  "cookie.set",
  "dialog.accept",
  "dialog.dismiss",
  "dialog.info",
  "dropdown.choose",
  "emulate.cpu",
  "emulate.device",
  "emulate.geo",
  "emulate.network",
  "emulate.touch",
  "emulate.viewport",
  "frame.js",
  "run",
  "lens.page.executeClick",
  "lens.page.executeDoubleClick",
  "lens.page.executeDrag",
  "lens.page.executeHover",
  "lens.page.execute",
  "lens.input.key",
  "open",
  "lens.page.executeRightClick",
  "screenshot",
  "lens.page.scroll",
  "lens.page.executeTripleClick",
  "lens.page.executeType",
  "lens.find.findAndType",
  "form.fill",
  "lens.form.formInput",
  "frame.main",
  "frame.switch",
  "lens.element.getCoordinates",
  "element.styles",
  "frame.list",
  "lens.network.getEntries",
  "lens.network.entry",
  "network.origins",
  "network.stats",
  "network.export",
  "page.text",
  "network.body",
  "scroll.info",
  "lens.page.getViewportSize",
  "lens.indicator.hideAgentIndicators",
  "lens.indicator.hideStaticIndicator",
  "lens.page.hoverRef",
  "page.layout",
  "locate.label",
  "locate.role",
  "locate.text",
  "page.state",
  "lens.input.paste",
  "perf.metrics",
  "perf.start",
  "perf.stop",
  "console",
  "network",
  "page.inspect",
  "lens.window.resize",
  "scroll.to",
  "lens.scroll.position",
  "search",
  "select",
  "lens.form.setInputValue",
  "lens.indicator.showAgentIndicators",
  "lens.indicator.showStaticIndicator",
  "form.smart",
  "lens.stream.console",
  "lens.stream.network",
  "tab.reload",
  "lens.input.typeSubmit",
  "workspace.use",
  "upload.file",
  "upload.image",
  "wait.dom",
  "lens.wait.element",
  "wait.load",
  "wait.network",
  "wait.text",
  "wait.url",
  "wait.ready",
  "zoom.get",
  "zoom.reset",
  "zoom.set",
]);

const NO_TAB_MESSAGE_TYPES = ["lens.tabs.getCurrentId", "lens.page.getScreenshot", "lens.ping", "TAB_LIST", "TAB_NEW", "network.path", "extension.reload"];
const NON_STICKY_RUNTIME_MESSAGE_TYPES = new Set([
  "lens.agent.stop",
  "lens.indicator.dismissStaticIndicator",
  "lens.indicator.heartbeat",
  "lens.open.openSidepanel",
]);
const NATIVE_API_RESPONSE_MESSAGE_TYPES = new Set([
  "lens.nativeApi.responseStart",
  "lens.nativeApi.responseChunk",
  "lens.nativeApi.responseEnd",
  "lens.nativeApi.responseError",
]);
const isUsableCommandTabUrl = (url?: string) =>
  !!url &&
  !url.startsWith("chrome://") &&
  !url.startsWith("chrome-extension://") &&
  url !== "about:blank";

function isNonStickyRuntimeMessage(messageType?: string): boolean {
  return (
    !!messageType &&
    (NON_STICKY_RUNTIME_MESSAGE_TYPES.has(messageType) ||
      NATIVE_API_RESPONSE_MESSAGE_TYPES.has(messageType))
  );
}

async function getTabById(
  tabId: number | null | undefined,
  windowId?: number,
): Promise<chrome.tabs.Tab | undefined> {
  if (!tabId) {
    return undefined;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    if (windowId !== undefined && tab.windowId !== windowId) {
      return undefined;
    }
    return isUsableCommandTabUrl(tab.url) ? tab : undefined;
  } catch {
    agentWorkspace.forgetTarget(tabId);
    return undefined;
  }
}

async function getRememberedTab(
  windowId?: number,
  workspace?: string,
): Promise<chrome.tabs.Tab | undefined> {
  const rememberedTabId = agentWorkspace.getRememberedTab(windowId, workspace);
  return await getTabById(rememberedTabId, windowId);
}

async function getActiveWorkspaceTab(
  windowId?: number,
  workspace?: string,
): Promise<chrome.tabs.Tab | undefined> {
  return await getTabById(agentWorkspace.getActiveTab(workspace), windowId);
}

async function resolveImplicitTab(
  windowId?: number,
  allowActiveTab = false,
  workspace?: string,
): Promise<chrome.tabs.Tab | undefined> {
  const rememberedTab = await getRememberedTab(windowId, workspace);
  if (rememberedTab) {
    return rememberedTab;
  }

  const workspaceTab = await getActiveWorkspaceTab(windowId, workspace);
  if (workspaceTab) {
    return workspaceTab;
  }

  // Everything below reaches for a tab the agent does not own - the user's active
  // tab, or whatever happens to be in the focused window. Only take those when the
  // caller asked for them explicitly with --use-active-tab.
  if (!allowActiveTab) {
    return undefined;
  }

  if (windowId !== undefined) {
    const [activeWindowTab] = await chrome.tabs.query({ active: true, windowId });
    if (activeWindowTab?.id && isUsableCommandTabUrl(activeWindowTab.url)) {
      return activeWindowTab;
    }

    const tabs = await chrome.tabs.query({ windowId });
    return tabs.find((candidate) => isUsableCommandTabUrl(candidate.url));
  }

  let [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!activeTab?.id || !isUsableCommandTabUrl(activeTab.url)) {
    [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (activeTab?.id && isUsableCommandTabUrl(activeTab.url)) {
    return activeTab;
  }

  const tabs = await chrome.tabs.query({ active: true });
  return tabs.find((candidate) => isUsableCommandTabUrl(candidate.url));
}

async function rememberResolvedTab(tabId: number | undefined, workspace?: string): Promise<void> {
  if (!tabId) {
    return;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    agentWorkspace.rememberTarget(tabId, tab.windowId, workspace);
  } catch {
    agentWorkspace.forgetTarget(tabId);
  }
}

type TabResolutionSource = "explicit" | "sender" | "implicit";

function shouldRememberResolvedTab(
  messageType: string | undefined,
  tabSource: TabResolutionSource | undefined,
): boolean {
  if (!tabSource || tabSource === "sender") {
    return false;
  }

  if (
    !messageType ||
    NO_TAB_MESSAGE_TYPES.includes(messageType) ||
    isNonStickyRuntimeMessage(messageType)
  ) {
    return false;
  }

  return true;
}

chrome.runtime.onInstalled.addListener((details) => {
  debugLog("Extension installed/updated:", details.reason);
});

// Warn only when it can matter: a command that fell back to "default" while other
// work streams are bound is the collision case, and it is invisible otherwise.
function withWorkspaceWarning<T>(result: T, workspace: string, messageType?: string): T {
  if (workspace !== DEFAULT_WORKSPACE || messageType?.startsWith("WORKSPACE_")) {
    return result;
  }
  const others = agentWorkspace.workspaces?.size ?? 0;
  if (others < 2) {
    return result;
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  return {
    ...(result as Record<string, unknown>),
    workspaceWarning:
      `Using the "default" workspace while ${others - 1} other work stream(s) exist. ` +
      "Pass --workspace <name> or set LENS_WORKSPACE so concurrent work cannot collide.",
  } as T;
}

export async function handleMessage(
  message: ServiceWorkerMessage,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  let tabId = message.tabId;
  const messageType = message.type;
  // Resolution and guarding are separate questions: most message types resolve a tab
  // when one is available, but only the types that genuinely cannot run without one
  // get blocked when nothing is bound.
  const resolvesImplicitly = !messageType || !NO_TAB_MESSAGE_TYPES.includes(messageType);
  const requiresTab = !!messageType && NEEDS_TAB_MESSAGE_TYPES.has(messageType);
  const allowActiveTab = message.useActiveTab === true;
  const workspace = normalizeWorkspace(message.workspace);
  let tabSource: TabResolutionSource | undefined = tabId ? "explicit" : undefined;

  if (!tabId) {
    if (sender.tab?.id && resolvesImplicitly) {
      tabId = sender.tab.id;
      tabSource = "sender";
    } else if (resolvesImplicitly) {
      const resolvedTab = await resolveImplicitTab(message.windowId, allowActiveTab, workspace);
      if (resolvedTab?.id) {
        tabId = resolvedTab.id;
        tabSource = "implicit";
      }
    }
  }

  if (!tabId && requiresTab) {
    if (
      messageType === "open" &&
      typeof message.url === "string" &&
      message.newTab !== true
    ) {
      // Opening a page has an obvious safe answer: use a fresh tab rather than
      // replacing whatever the user is looking at.
      const created = await chrome.tabs.create({
        url: message.url,
        active: message.focus === true,
      });
      if (created.id) {
        tabId = created.id;
        tabSource = "implicit";
      }
    }
    if (!tabId) {
      throw new Error(
        workspace === DEFAULT_WORKSPACE
          ? "No agent tab is bound. Run `lens window.new` to create one, or pass --use-active-tab to drive your active tab."
          : `Workspace "${workspace}" has no tab. Run \`lens workspace.use ${workspace}\` to bind one.`,
      );
    }
  }

  if (shouldRememberResolvedTab(messageType, tabSource)) {
    await rememberResolvedTab(tabId, workspace);
  }

  const resolvedMessage: ServiceWorkerMessage = { ...message, tabId };
  const handler = messageType ? handlerRegistry[messageType] : undefined;

  debugLog("DEBUG: handleMessage type:", messageType, "handler found:", !!handler);

  if (handler) {
    const result = await handler(resolvedMessage, sender);
    debugLog("DEBUG: handler result:", previewDebugValue(result, 100));
    return withWorkspaceWarning(result, workspace, messageType);
  }

  throw new Error(`Unknown message type: ${messageType}`);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message }));
  return true;
});

// Proactive content script injection on tab activation to ensure availability
const RESTRICTED_URL_PATTERNS = [
  /^chrome:\/\//,
  /^chrome-extension:\/\//,
  /^about:/,
  /^edge:\/\//,
  /^file:\/\//,
  /^https:\/\/chrome\.google\.com\/webstore/,
];

const isRestrictedUrl = (url?: string): boolean => {
  if (!url) return true;
  return RESTRICTED_URL_PATTERNS.some((pattern) => pattern.test(url));
};

const injectContentScript = async (tabId: number) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isRestrictedUrl(tab.url)) return;

    // Check if content script is already loaded
    try {
      await chrome.tabs.sendMessage(tabId, { type: "lens.ping" }, { frameId: 0 });
      return; // Already loaded
    } catch {
      // Not loaded, proceed with injection
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/tree/index.js"],
    });
    debugLog(`Proactively injected content script into tab ${tabId}`);
  } catch (err) {
    debugLog(`Failed to proactively inject into tab ${tabId}:`, err);
  }
};

// Inject when tab is activated
chrome.tabs.onActivated.addListener(({ tabId }) => {
  injectContentScript(tabId);
});

// Inject when tab is updated (navigation)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url && !isRestrictedUrl(tab.url)) {
    injectContentScript(tabId);
  }
});

initNativeMessaging(async (message) => {
  let tabId = message.tabId;
  const windowId = message.windowId;
  const isDialogCommand = message.type?.startsWith("DIALOG_");
  const workspace = normalizeWorkspace(message.workspace);
  const allowActiveTab = message.useActiveTab === true;
  const needsTab = !COMMANDS_WITHOUT_TAB.has(message.type);
  let autoCreatedTab = false;

  if (tabId && !isDialogCommand) {
    try {
      await chrome.tabs.get(tabId);
    } catch {
      throw new Error(`Invalid tab ID: ${tabId}. Use 'lens tab.list' to see available tabs.`);
    }
  } else if (!tabId && needsTab) {
    let tab = await resolveImplicitTab(windowId, allowActiveTab, workspace);

    // Planting a tab in the caller's window is only acceptable when the caller
    // explicitly opted into driving that window.
    if (!tab?.id && windowId && allowActiveTab) {
      const newTab = await chrome.tabs.create({
        windowId,
        url: "data:text/html,<html><head><title>Lens</title></head><body></body></html>",
        active: false, // Don't steal focus from user's current tab
      });
      if (!newTab.id) {
        throw new Error(`Failed to create tab in window ${windowId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      tab = newTab;
      autoCreatedTab = true;
      agentWorkspace.registerTab(newTab.id, workspace);
    }

    if (
      !tab?.id &&
      message.type === "open" &&
      typeof message.url === "string" &&
      message.newTab !== true
    ) {
      // Safe default: a fresh tab, never the page the user is reading. When the
      // command already asks for a new tab the handler makes it - creating one
      // here too would open two.
      const created = await chrome.tabs.create({
        url: message.url,
        active: message.focus === true,
      });
      if (!created.id) {
        throw new Error("Failed to create tab");
      }
      tab = created;
      autoCreatedTab = true;
    }

    if (!tab?.id) {
      throw new Error(
        workspace === DEFAULT_WORKSPACE
          ? "No agent tab is bound. Run `lens window.new` to create one, or pass --use-active-tab to drive your active tab."
          : `Workspace "${workspace}" has no tab. Run \`lens workspace.create ${workspace}\` to create one.`,
      );
    }

    tabId = tab.id;
  }

  await rememberResolvedTab(tabId, workspace);

  const rawResult = await handleMessage({ ...message, tabId }, {} as chrome.runtime.MessageSender);
  const result =
    rawResult && typeof rawResult === "object"
      ? (rawResult as Record<string, unknown>)
      : { result: rawResult };

  const hints: string[] = [];
  if (autoCreatedTab) {
    hints.push(
      `Auto-created tab in window ${windowId} (no usable tabs existed). Navigate to your target URL.`,
    );
  }

  return {
    ...result,
    _resolvedTabId: tabId,
    _hint: hints.length > 0 ? hints.join(" ") : undefined,
  };
});
