import {
  agentWorkspace,
  normalizeWorkspace,
  type ServiceWorkerHandlerMap,
  type ServiceWorkerMessage,
} from "../shared";

const AGENT_BLANK_PAGE =
  'data:text/html,<html><head><title>Lens Agent</title></head><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:%23666"><div style="text-align:center"><h2>Agent Window</h2><p>Ready for automation</p></div></body></html>';

type BrowserWindow = Awaited<ReturnType<typeof chrome.windows.getAll>>[number];

type WindowListResult = {
  windows: Array<{
    id?: number;
    focused?: boolean;
    type?: chrome.windows.windowTypeEnum;
    state?: chrome.windows.windowStateEnum;
    width?: number;
    height?: number;
    tabCount: number;
    tabs?: Array<{ id?: number; title?: string; url?: string; active?: boolean }>;
  }>;
};

type WindowResizeResult = {
  success: true;
  windowId: number;
  width?: number;
  height?: number;
};

function requireWindowId(message: ServiceWorkerMessage): number {
  if (!message.windowId) {
    throw new Error("No windowId provided");
  }
  return message.windowId;
}

function summarizeWindow(window: BrowserWindow, includeTabs: boolean) {
  return {
    id: window.id,
    focused: window.focused,
    type: window.type,
    state: window.state,
    width: window.width,
    height: window.height,
    tabCount: window.tabs?.length || 0,
    tabs: includeTabs
      ? window.tabs?.map((tab) => ({
          id: tab.id,
          title: tab.title,
          url: tab.url,
          active: tab.active,
        }))
      : undefined,
  };
}

function buildWindowUpdate(message: ServiceWorkerMessage): chrome.windows.UpdateInfo {
  const update: chrome.windows.UpdateInfo = {};
  if (message.width) update.width = message.width;
  if (message.height) update.height = message.height;
  if (message.left !== undefined) update.left = message.left;
  if (message.top !== undefined) update.top = message.top;
  if (message.state) update.state = message.state as chrome.windows.windowStateEnum;
  return update;
}

export const windowHandlers: ServiceWorkerHandlerMap = {

  "workspace.create": async (message) => {
    const name = normalizeWorkspace(message.name);

    // Creating a window raises the Chrome application, which pulls the user out of
    // whatever else they were doing. A background tab does not, so that is the
    // default; a real window is opt-in with --new-window.
    const existingTabId = agentWorkspace.state(name).activeTabId;
    if (existingTabId !== null) {
      try {
        const existing = await chrome.tabs.get(existingTabId);
        if (existing?.id) {
          agentWorkspace.rememberTarget(existing.id, existing.windowId, name);
          return {
            success: true,
            workspace: name,
            windowId: existing.windowId,
            tabId: existing.id,
            reused: true,
          };
        }
      } catch {
        agentWorkspace.releaseTab(existingTabId, name);
      }
    }

    if (message.newWindow === true) {
      const created = await chrome.windows.create({
        focused: message.focused === true,
        type: "normal",
        url: message.url || AGENT_BLANK_PAGE,
      });
      if (!created.id) throw new Error("Failed to create window");

      const tabs = await chrome.tabs.query({ windowId: created.id }).catch(() => []);
      const firstTab = tabs[0];
      if (!firstTab?.id) {
        // Do not leave a window we cannot use on the user's screen.
        await chrome.windows.remove(created.id).catch(() => undefined);
        throw new Error("Agent window has no tab");
      }

      agentWorkspace.registerTab(firstTab.id, name);
      agentWorkspace.setActiveTab(firstTab.id, name);
      agentWorkspace.rememberTarget(firstTab.id, created.id, name);

      return {
        success: true,
        workspace: name,
        windowId: created.id,
        tabId: firstTab.id,
        reused: false,
        raised: true,
        hint:
          "This raised Chrome and may have interrupted the user. " +
          `Omit --new-window for a background tab. Later commands follow this stream: export LENS_WORKSPACE=${name}.`,
      };
    }

    const host = await chrome.windows.getLastFocused().catch(() => null);
    const tab = await chrome.tabs.create({
      windowId: host?.id,
      url: message.url || AGENT_BLANK_PAGE,
      active: false,
    });
    if (!tab?.id) throw new Error("Failed to create tab");

    agentWorkspace.registerTab(tab.id, name);
    agentWorkspace.setActiveTab(tab.id, name);
    agentWorkspace.rememberTarget(tab.id, tab.windowId, name);

    return {
      success: true,
      workspace: name,
      windowId: tab.windowId,
      tabId: tab.id,
      reused: false,
      raised: false,
      hint: `Later commands follow this stream: export LENS_WORKSPACE=${name} (or pass --workspace ${name}).`,
    };
  },

  "window.new": async (message) => {
    const url = message.url || AGENT_BLANK_PAGE;

    const createOptions: chrome.windows.CreateData = {
      focused: message.focused !== false,
      type: "normal",
      url,
    };

    if (message.width && message.height) {
      createOptions.width = message.width;
      createOptions.height = message.height;
    }

    if (message.incognito) {
      createOptions.incognito = true;
    }

    const window = await chrome.windows.create(createOptions);

    if (!window.id) {
      throw new Error("Failed to create window");
    }

    const tabs = await chrome.tabs.query({ windowId: window.id });
    const firstTab = tabs[0];

    if (firstTab?.id) {
      agentWorkspace.rememberTarget(firstTab.id, window.id);
      agentWorkspace.setActiveTab(firstTab.id);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    return {
      success: true,
      windowId: window.id,
      tabId: firstTab?.id,
      bound: Boolean(firstTab?.id),
      hint: `Subsequent commands target window ${window.id}`,
    };
  },

  "window.list": async (message): Promise<WindowListResult> => {
    const windows = await chrome.windows.getAll({ populate: true });

    return {
      windows: windows.map((window) => summarizeWindow(window, Boolean(message.includeTabs))),
    };
  },

  "window.focus": async (message) => {
    const windowId = requireWindowId(message);
    await chrome.windows.update(windowId, { focused: true });
    return { success: true, windowId };
  },

  "window.close": async (message) => {
    const windowId = requireWindowId(message);
    await chrome.windows.remove(windowId);
    return { success: true, windowId };
  },

  "window.resize": async (message): Promise<WindowResizeResult> => {
    const windowId = requireWindowId(message);
    const window = await chrome.windows.update(windowId, buildWindowUpdate(message));
    return {
      success: true,
      windowId,
      width: window.width,
      height: window.height,
    };
  },
};
