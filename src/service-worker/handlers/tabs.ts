import { agentWorkspace, cdp, normalizeWorkspace, tabNameRegistry, waitForRuntimeReady } from "../shared";
import type { ServiceWorkerHandlerMap } from "../shared";

export const tabHandlers: ServiceWorkerHandlerMap = {
  "tab.reload": async (message) => {
    const tabId = message.tabId;
    if (!tabId) throw new Error("No tabId provided");
    await chrome.tabs.reload(tabId, { bypassCache: message.hard || false });
    return { success: true };
  },

  "workspace.info": async (message) => {
    const name = normalizeWorkspace(message.name);
    const state = agentWorkspace.state(name);
    const ownedTabs = [...state.ownedTabs];

    let live = false;
    if (state.lastTargetTabId !== null) {
      try {
        const tab = await chrome.tabs.get(state.lastTargetTabId);
        live = Boolean(tab?.id);
      } catch {
        live = false;
      }
    }

    return {
      workspace: name,
      targetTabId: state.lastTargetTabId,
      targetWindowId: state.lastTargetWindowId,
      activeTabId: state.activeTabId,
      ownedTabs,
      live,
      recovery: live || state.lastTargetTabId === null ? null : `lens workspace.create ${name}`,
    };
  },

  "workspace.use": async (message) => {
    const tabId = message.tabId;
    if (!tabId) throw new Error("No tabId provided");
    const name = normalizeWorkspace(message.name);
    agentWorkspace.setActiveTab(tabId, name);
    agentWorkspace.rememberTarget(tabId, undefined, name);
    return { success: true, workspace: name, tabId };
  },

  "workspace.list": async () => ({ workspaces: agentWorkspace.list() }),

  "workspace.close": async (message) => {
    const name = normalizeWorkspace(message.name);
    return { success: agentWorkspace.close(name), workspace: name };
  },
  "tab.create": async (message) => {
    const tabId = message.tabId;
    const activeTab = tabId ? await chrome.tabs.get(tabId) : null;

    const newTab = await chrome.tabs.create({
      url: message.url || "about:blank",
      active: false,
    });

    if (!newTab.id) {
      throw new Error("Failed to create tab");
    }

    if (activeTab?.groupId && activeTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      await chrome.tabs.group({ tabIds: newTab.id, groupId: activeTab.groupId });
    }

    return {
      success: true,
      tabId: newTab.id,
      url: newTab.url || message.url || "about:blank",
    };
  },

  "lens.tabs.getAll": async () => {
    const tabs = await chrome.tabs.query({});
    return {
      tabs: tabs.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url })),
    };
  },

  "tab.list": async (message) => {
    const queryOptions: chrome.tabs.QueryInfo = {};
    if (message.windowId) {
      queryOptions.windowId = message.windowId;
    }

    const tabs = await chrome.tabs.query(queryOptions);
    return {
      tabs: tabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        url: tab.url,
        active: tab.active,
        windowId: tab.windowId,
      })),
    };
  },

  "tab.new": async (message) => {
    const urls = message.urls || (message.url ? [message.url] : ["about:blank"]);
    const background = message.background !== false; // Default to true (background/not active)
    const createdTabs: Array<{ tabId: number; url: string }> = [];

    for (let index = 0; index < urls.length; index++) {
      const createOptions: chrome.tabs.CreateProperties = {
        url: urls[index],
        active: !background, // Only active if background is false
      };

      if (message.windowId) {
        createOptions.windowId = message.windowId;
      }

      const newTab = await chrome.tabs.create(createOptions);
      if (newTab.id) {
        createdTabs.push({ tabId: newTab.id, url: urls[index] });
        // Register as agent-owned tab (doesn't steal focus from user)
        agentWorkspace.registerTab(newTab.id, message.workspace);
      }
    }

    if (createdTabs.length === 1) {
      return { success: true, tabId: createdTabs[0].tabId, url: createdTabs[0].url };
    }

    return { success: true, tabs: createdTabs };
  },

  "tab.switch": async (message) => {
    const targetTabId = message.tabId;
    if (!targetTabId) {
      throw new Error("No tabId provided");
    }

    const tab = await chrome.tabs.update(targetTabId, { active: true });
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }

    return { success: true, tabId: targetTabId, url: tab.url, title: tab.title };
  },

  "tab.close": async (message) => {
    const tabIds = message.tabIds || (message.tabId ? [message.tabId] : []);
    if (tabIds.length === 0) {
      throw new Error("No tabId(s) provided");
    }

    await chrome.tabs.remove(tabIds);
    if (tabIds.length === 1) {
      return { success: true, tabId: tabIds[0] };
    }

    return { success: true, closed: tabIds };
  },

  "tab.name": async (message) => {
    const tabId = message.tabId;
    if (!tabId) {
      throw new Error("No tabId provided");
    }
    if (!message.name) {
      throw new Error("No name provided");
    }

    tabNameRegistry.set(message.name, tabId);
    return { success: true, name: message.name, tabId };
  },

  "tab.getByName": async (message) => {
    if (!message.name) {
      throw new Error("No name provided");
    }

    const registeredTabId = tabNameRegistry.get(message.name);
    if (!registeredTabId) {
      return { error: `No tab registered with name "${message.name}"` };
    }

    try {
      const tab = await chrome.tabs.get(registeredTabId);
      return { tabId: registeredTabId, url: tab.url, title: tab.title };
    } catch {
      tabNameRegistry.delete(message.name);
      return { error: `Tab "${message.name}" no longer exists` };
    }
  },

  "tab.named": async () => {
    const namedTabs: Array<{ name: string; tabId: number; url?: string; title?: string }> = [];
    for (const [name, id] of tabNameRegistry) {
      try {
        const tab = await chrome.tabs.get(id);
        namedTabs.push({ name, tabId: id, url: tab.url, title: tab.title });
      } catch {
        tabNameRegistry.delete(name);
      }
    }

    return { tabs: namedTabs };
  },

  "tab.unname": async (message) => {
    if (!message.name) {
      throw new Error("No name provided");
    }

    const deleted = tabNameRegistry.delete(message.name);
    if (!deleted) {
      return { success: false, error: `No tab registered with name "${message.name}"` };
    }

    return { success: true };
  },

  "tab.group": async (message) => {
    const tabIds = [...(message.tabIds || [])];
    const name = message.name || "Lens";
    const validColors = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
    const color =
      typeof message.color === "string" && validColors.includes(message.color) ? message.color : "blue";

    if (tabIds.length === 0 && message.tabId) {
      tabIds.push(message.tabId);
    }

    if (tabIds.length === 0) {
      throw new Error("No tabs specified");
    }

    const existingGroups = await chrome.tabGroups.query({ title: name });
    let groupId: number;

    if (existingGroups.length > 0) {
      groupId = existingGroups[0].id;
      await chrome.tabs.group({ tabIds, groupId });
    } else {
      groupId = await chrome.tabs.group({ tabIds });
      await chrome.tabGroups.update(groupId, {
        title: name,
        color: color as chrome.tabGroups.ColorEnum,
        collapsed: false,
      });
    }

    return { success: true, groupId, name, tabIds };
  },

  "tab.ungroup": async (message) => {
    const tabIds = [...(message.tabIds || [])];
    if (tabIds.length === 0 && message.tabId) {
      tabIds.push(message.tabId);
    }

    if (tabIds.length === 0) {
      throw new Error("No tabs specified");
    }

    await chrome.tabs.ungroup(tabIds);
    return { success: true, ungrouped: tabIds };
  },

  "tab.groups": async () => {
    const groups = await chrome.tabGroups.query({});
    const result = [];

    for (const group of groups) {
      const tabs = await chrome.tabs.query({ groupId: group.id });
      result.push({
        id: group.id,
        name: group.title || "(unnamed)",
        color: group.color,
        collapsed: group.collapsed,
        tabs: tabs.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url })),
      });
    }

    return { groups: result };
  },

  "lens.window.resize": async (message) => {
    const tabId = message.tabId;
    if (!tabId) {
      throw new Error("No tabId provided");
    }
    if (!message.width || !message.height) {
      throw new Error("width and height required");
    }

    const tab = await chrome.tabs.get(tabId);
    if (!tab.windowId) {
      throw new Error("Tab has no window");
    }

    await chrome.windows.update(tab.windowId, {
      width: Math.floor(message.width),
      height: Math.floor(message.height),
    });

    return { success: true, width: message.width, height: message.height };
  },

  "tab.agent": async () => {
    const ownedTabIds = Array.from(agentWorkspace.ownedTabs);
    const ownedTabs = [];
    for (const id of ownedTabIds) {
      try {
        const tab = await chrome.tabs.get(id);
        ownedTabs.push({
          id: tab.id,
          title: tab.title,
          url: tab.url,
          active: tab.id === agentWorkspace.activeTabId,
        });
      } catch {
        // Tab no longer exists, clean up
        agentWorkspace.releaseTab(id);
      }
    }
    return {
      activeTabId: agentWorkspace.activeTabId,
      userLastActiveTabId: agentWorkspace.userLastActiveTabId,
      ownedTabs,
    };
  },

  "tab.agent.set": async (message) => {
    const tabId = message.tabId;
    if (!tabId) {
      throw new Error("No tabId provided");
    }
    // Verify tab exists
    await chrome.tabs.get(tabId);
    agentWorkspace.setActiveTab(tabId);
    return { success: true, activeTabId: tabId };
  },

  "tab.agent.release": async (message) => {
    const tabId = message.tabId;
    if (tabId) {
      agentWorkspace.releaseTab(tabId);
      return { success: true, releasedTabId: tabId };
    } else {
      // Release all agent-owned tabs
      const released = Array.from(agentWorkspace.ownedTabs);
      for (const id of released) {
        agentWorkspace.releaseTab(id);
      }
      return { success: true, releasedTabIds: released };
    }
  },
};
