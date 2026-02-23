import { CDPController } from "../cdp";

export const cdp = new CDPController();
export const DEFAULT_WORKSPACE = "default";
export const activeStreamTabs = new Map<number, number>();
export const injectedTabs = new Set<number>();
export const frameContexts = new Map<number, number>();
export const tabNameRegistry = new Map<string, number>();
export const fetchServeRoutes: Array<{ urlPrefix: string; localDir: string }> = [];
export const fetchInterceptRules: Array<{
  pattern: string;
  type: string;
  response?: string;
  status?: number;
  delayMs?: number;
  fileContent?: string;
  contentType?: string;
}> = [];
export const fetchEnabledTabs = new Set<number>();
export const screenshotCache = new Map<string, { base64: string; width: number; height: number }>();
export const navigationResolvers = new Map<number, () => void>();
let screenshotSequence = 0;

export function nextScreenshotSequence(): number {
  screenshotSequence += 1;
  return screenshotSequence;
}

const WORKSPACE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export function normalizeWorkspace(name?: string | null): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) {
    return DEFAULT_WORKSPACE;
  }
  if (!WORKSPACE_NAME.test(trimmed)) {
    throw new Error(`Invalid workspace name "${trimmed}": use letters, digits, dot, dash or underscore`);
  }
  return trimmed;
}

interface WorkspaceState {
  activeTabId: number | null;
  ownedTabs: Set<number>;
  lastTargetTabId: number | null;
  lastTargetWindowId: number | null;
}

function emptyWorkspace(): WorkspaceState {
  return { activeTabId: null, ownedTabs: new Set(), lastTargetTabId: null, lastTargetWindowId: null };
}

export const agentWorkspace = {
  // Track user's last active tab so we don't steal focus
  userLastActiveTabId: null as number | null,
  workspaces: new Map<string, WorkspaceState>(),

  state(name?: string | null): WorkspaceState {
    const key = normalizeWorkspace(name);
    let state = this.workspaces.get(key);
    if (!state) {
      state = emptyWorkspace();
      this.workspaces.set(key, state);
    }
    return state;
  },

  get ownedTabs(): Set<number> {
    return this.state(DEFAULT_WORKSPACE).ownedTabs;
  },

  get activeTabId(): number | null {
    return this.state(DEFAULT_WORKSPACE).activeTabId;
  },

  rememberTarget(tabId: number, windowId?: number | null, name?: string | null) {
    const state = this.state(name);
    state.lastTargetTabId = tabId;
    state.lastTargetWindowId = windowId ?? null;
  },

  forgetTarget(tabId: number, name?: string | null) {
    const state = this.state(name);
    if (state.lastTargetTabId === tabId) {
      state.lastTargetTabId = null;
      state.lastTargetWindowId = null;
    }
  },

  getRememberedTab(windowId?: number, name?: string | null): number | null {
    const state = this.state(name);
    if (state.lastTargetTabId === null) {
      return null;
    }
    if (windowId !== undefined && state.lastTargetWindowId !== windowId) {
      return null;
    }
    return state.lastTargetTabId;
  },

  // A tab belongs to one stream at a time. Binding it elsewhere moves it, so two
  // streams cannot end up driving the same tab.
  setActiveTab(tabId: number, name?: string | null) {
    const key = normalizeWorkspace(name);
    for (const [other, state] of this.workspaces.entries()) {
      if (other !== key) {
        state.ownedTabs.delete(tabId);
        if (state.activeTabId === tabId) {
          state.activeTabId = null;
        }
        if (state.lastTargetTabId === tabId) {
          state.lastTargetTabId = null;
          state.lastTargetWindowId = null;
        }
      }
    }
    const state = this.state(key);
    state.activeTabId = tabId;
    state.ownedTabs.add(tabId);
  },

  isOwned(tabId: number): boolean {
    for (const state of this.workspaces.values()) {
      if (state.ownedTabs.has(tabId)) {
        return true;
      }
    }
    return false;
  },

  registerTab(tabId: number, name?: string | null) {
    const state = this.state(name);
    state.ownedTabs.add(tabId);
    if (state.activeTabId === null) {
      state.activeTabId = tabId;
    }
  },

  releaseEverywhere(tabId: number) {
    for (const [name, state] of this.workspaces.entries()) {
      state.ownedTabs.delete(tabId);
      if (state.activeTabId === tabId) {
        state.activeTabId = state.ownedTabs.size > 0 ? (state.ownedTabs.values().next().value ?? null) : null;
      }
      if (state.lastTargetTabId === tabId) {
        state.lastTargetTabId = null;
        state.lastTargetWindowId = null;
      }
      if (
        state.activeTabId === null &&
        state.ownedTabs.size === 0 &&
        state.lastTargetTabId === null &&
        name !== DEFAULT_WORKSPACE
      ) {
        this.workspaces.delete(name);
      }
    }
  },

  releaseTab(tabId: number, name?: string | null) {
    const state = this.state(name);
    state.ownedTabs.delete(tabId);
    this.forgetTarget(tabId, name);
    if (state.activeTabId === tabId) {
      state.activeTabId = state.ownedTabs.size > 0
        ? (state.ownedTabs.values().next().value ?? null)
        : null;
    }
  },

  getActiveTab(name?: string | null): number | null {
    const state = this.state(name);
    if (state.activeTabId !== null) {
      chrome.tabs.get(state.activeTabId).catch(() => {
        this.releaseTab(state.activeTabId!, name);
      });
    }
    return state.activeTabId;
  },

  list() {
    return [...this.workspaces.entries()].map(([name, state]) => ({
      workspace: name,
      activeTabId: state.activeTabId,
      targetTabId: state.lastTargetTabId,
      targetWindowId: state.lastTargetWindowId,
      ownedTabCount: state.ownedTabs.size,
    }));
  },

  close(name?: string | null) {
    const key = normalizeWorkspace(name);
    if (key === DEFAULT_WORKSPACE) {
      return false;
    }
    return this.workspaces.delete(key);
  },

  clear() {
    this.workspaces.clear();
    this.userLastActiveTabId = null;
  },
};

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!agentWorkspace.isOwned(tabId)) agentWorkspace.userLastActiveTabId = tabId;
});

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  frameContexts.delete(details.tabId);
  const resolveNavigation = navigationResolvers.get(details.tabId);
  if (resolveNavigation) {
    resolveNavigation();
    navigationResolvers.delete(details.tabId);
  }
});

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0) return;
  const resolveNavigation = navigationResolvers.get(details.tabId);
  if (resolveNavigation) {
    resolveNavigation();
    navigationResolvers.delete(details.tabId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || typeof changeInfo.url === "string") {
    injectedTabs.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cdp.detach(tabId);
  injectedTabs.delete(tabId);
  frameContexts.delete(tabId);
  agentWorkspace.releaseEverywhere(tabId);
  for (const [name, registeredTabId] of tabNameRegistry) {
    if (registeredTabId === tabId) tabNameRegistry.delete(name);
  }
  for (const [streamId, streamTabId] of activeStreamTabs) {
    if (streamTabId === tabId) activeStreamTabs.delete(streamId);
  }
});

