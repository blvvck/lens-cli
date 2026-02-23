import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChromeMock, resetChromeMock } from "../../mocks/chrome";

const { mockHandler } = vi.hoisted(() => ({
  mockHandler: vi.fn(),
}));

const { mockGetActiveTab, mockGetRememberedTab, mockRememberTarget, mockForgetTarget } = vi.hoisted(
  () => ({
    mockGetActiveTab: vi.fn(() => null),
    mockGetRememberedTab: vi.fn<() => number | null>(() => null),
    mockRememberTarget: vi.fn(),
    mockForgetTarget: vi.fn(),
  }),
);

vi.mock("../../../src/native/port", () => ({
  initNativeMessaging: vi.fn(),
  postToNativeHost: vi.fn(),
  sendToNativeHost: vi.fn(),
}));

vi.mock("../../../src/service-worker/registry", () => ({
  handlerRegistry: {
    TEST_UNDEFINED: mockHandler,
    "page.inspect": mockHandler,
    "lens.indicator.heartbeat": mockHandler,
    "open": mockHandler,
  },
}));

vi.mock("../../../src/service-worker/shared", () => ({
  agentWorkspace: {
    getActiveTab: mockGetActiveTab,
    getRememberedTab: mockGetRememberedTab,
    rememberTarget: mockRememberTarget,
    forgetTarget: mockForgetTarget,
    workspaces: new Map<string, unknown>(),
  },
  COMMANDS_WITHOUT_TAB: new Set<string>(),
  DEFAULT_WORKSPACE: "default",
  normalizeWorkspace: (name?: string | null) => {
    const trimmed = typeof name === "string" ? name.trim() : "";
    return trimmed || "default";
  },
}));

async function loadHandleMessage() {
  vi.resetModules();
  const chrome = createChromeMock() as any;
  chrome.tabs.query.mockResolvedValue([{ id: 123 }]);
  chrome.tabs.get.mockImplementation(async (tabId: number) => ({
    id: tabId,
    windowId: tabId === 456 ? 7 : 1,
    url: `https://example.com/${tabId}`,
  }));
  (globalThis as any).chrome = chrome;
  const mod = await import("../../../src/service-worker/main");
  return mod.handleMessage;
}

describe("service worker result logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveTab.mockReturnValue(null);
    mockGetRememberedTab.mockReturnValue(null);
  });

  afterEach(() => {
    resetChromeMock();
  });

  it("does not throw when a registered handler resolves to undefined", async () => {
    mockHandler.mockResolvedValueOnce(undefined);
    const handleMessage = await loadHandleMessage();

    await expect(
      handleMessage({ type: "TEST_UNDEFINED", tabId: 123 }, {} as chrome.runtime.MessageSender),
    ).resolves.toBeUndefined();
    expect(mockHandler).toHaveBeenCalledWith(
      expect.objectContaining({ type: "TEST_UNDEFINED", tabId: 123 }),
      expect.any(Object),
    );
  });

  it("rejects unknown messages without a fallback", async () => {
    const handleMessage = await loadHandleMessage();

    await expect(
      handleMessage({ type: "UNKNOWN_TOOL", tabId: 123 }, {} as chrome.runtime.MessageSender),
    ).rejects.toThrow("Unknown message type: UNKNOWN_TOOL");
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it("prefers the remembered tab over the browser active tab when no tabId is provided", async () => {
    mockHandler.mockResolvedValueOnce({ success: true });
    mockGetRememberedTab.mockReturnValueOnce(456);
    const handleMessage = await loadHandleMessage();

    await expect(
      handleMessage({ type: "TEST_UNDEFINED" }, {} as chrome.runtime.MessageSender),
    ).resolves.toEqual({ success: true });
    expect(mockHandler).toHaveBeenCalledWith(
      expect.objectContaining({ type: "TEST_UNDEFINED", tabId: 456 }),
      expect.any(Object),
    );
    expect(mockRememberTarget).toHaveBeenCalledWith(456, 7, "default");
  });

  it("does not let tab-originated runtime messages overwrite the remembered target", async () => {
    mockHandler.mockResolvedValueOnce({ success: true });
    const handleMessage = await loadHandleMessage();

    await expect(
      handleMessage({ type: "lens.indicator.heartbeat" }, {
        tab: { id: 456, windowId: 7, url: "https://example.com/456" },
      } as chrome.runtime.MessageSender),
    ).resolves.toEqual({ success: true });

    expect(mockHandler).toHaveBeenCalledWith(
      expect.objectContaining({ type: "lens.indicator.heartbeat", tabId: 456 }),
      expect.any(Object),
    );
    expect(mockRememberTarget).not.toHaveBeenCalled();
  });

  it("refuses to drive the user's active tab when nothing is bound", async () => {
    mockHandler.mockResolvedValueOnce({ success: true });
    const handleMessage = await loadHandleMessage();
    const chrome = (globalThis as any).chrome;
    chrome.tabs.query.mockResolvedValue([{ id: 123, url: "https://example.com/mine" }]);

    await expect(
      handleMessage({ type: "page.inspect" }, {} as chrome.runtime.MessageSender),
    ).rejects.toThrow("No agent tab is bound");
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it("drives the user's active tab when --use-active-tab is passed", async () => {
    mockHandler.mockResolvedValueOnce({ success: true });
    const handleMessage = await loadHandleMessage();
    const chrome = (globalThis as any).chrome;
    chrome.tabs.query.mockResolvedValue([{ id: 123, url: "https://example.com/mine" }]);

    await handleMessage(
      { type: "page.inspect", useActiveTab: true },
      {} as chrome.runtime.MessageSender,
    );

    expect(mockHandler).toHaveBeenCalledWith(
      expect.objectContaining({ type: "page.inspect", tabId: 123 }),
      expect.any(Object),
    );
  });

  it("opens a fresh tab instead of replacing the user's page", async () => {
    mockHandler.mockResolvedValueOnce({ success: true });
    const handleMessage = await loadHandleMessage();
    const chrome = (globalThis as any).chrome;
    chrome.tabs.query.mockResolvedValue([{ id: 123, url: "https://example.com/mine" }]);
    chrome.tabs.create.mockResolvedValue({ id: 999, windowId: 2 });

    await handleMessage(
      { type: "open", url: "https://example.com/agent" },
      {} as chrome.runtime.MessageSender,
    );

    expect(chrome.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/agent" }),
    );
    expect(mockHandler).toHaveBeenCalledWith(
      expect.objectContaining({ type: "open", tabId: 999 }),
      expect.any(Object),
    );
  });

  it("resolves each workspace's own remembered tab", async () => {
    mockHandler.mockResolvedValue({ success: true });
    mockGetRememberedTab.mockImplementation((_windowId?: number, workspace?: string) => {
      if (workspace === "nova") {
        return 456;
      }
      if (workspace === "luna") {
        return 457;
      }
      return null;
    });
    const handleMessage = await loadHandleMessage();
    const chrome = (globalThis as any).chrome;
    chrome.tabs.get.mockImplementation(async (tabId: number) => ({
      id: tabId,
      windowId: 7,
      url: "https://example.com/ws",
    }));

    await handleMessage(
      { type: "page.inspect", workspace: "nova" },
      {} as chrome.runtime.MessageSender,
    );
    await handleMessage(
      { type: "page.inspect", workspace: "luna" },
      {} as chrome.runtime.MessageSender,
    );

    expect(mockGetRememberedTab).toHaveBeenCalledWith(undefined, "nova");
    expect(mockGetRememberedTab).toHaveBeenCalledWith(undefined, "luna");
    const resolved = mockHandler.mock.calls.map((call: unknown[]) => {
      const msg = call[0] as { tabId: number; workspace?: string };
      return [msg.workspace, msg.tabId];
    });
    expect(resolved).toEqual([
      ["nova", 456],
      ["luna", 457],
    ]);
  });

  it("warns when a command falls back to default while other work streams exist", async () => {
    mockHandler.mockResolvedValueOnce({ success: true });
    const handleMessage = await loadHandleMessage();
    const sharedModule = await import("../../../src/service-worker/shared");
    const map = (sharedModule.agentWorkspace as unknown as { workspaces: Map<string, unknown> })
      .workspaces;
    map.set("default", {});
    map.set("checkout-flow", {});

    const result = await handleMessage(
      { type: "page.inspect", tabId: 123 },
      {} as chrome.runtime.MessageSender,
    );

    expect(result).toMatchObject({ success: true });
    expect((result as { workspaceWarning?: string }).workspaceWarning).toContain("--workspace");
  });

  it("stays quiet when only the default stream exists", async () => {
    mockHandler.mockResolvedValueOnce({ success: true });
    const handleMessage = await loadHandleMessage();
    const sharedModule = await import("../../../src/service-worker/shared");
    const map = (sharedModule.agentWorkspace as unknown as { workspaces: Map<string, unknown> })
      .workspaces;
    map.clear();
    map.set("default", {});

    const result = await handleMessage(
      { type: "page.inspect", tabId: 123 },
      {} as chrome.runtime.MessageSender,
    );

    expect((result as { workspaceWarning?: string }).workspaceWarning).toBeUndefined();
  });

  it("stays quiet when the caller named its own workspace", async () => {
    mockHandler.mockResolvedValueOnce({ success: true });
    mockGetRememberedTab.mockReturnValue(456);
    const handleMessage = await loadHandleMessage();
    const sharedModule = await import("../../../src/service-worker/shared");
    const map = (sharedModule.agentWorkspace as unknown as { workspaces: Map<string, unknown> })
      .workspaces;
    map.set("default", {});
    map.set("checkout-flow", {});

    const result = await handleMessage(
      { type: "page.inspect", workspace: "checkout-flow" },
      {} as chrome.runtime.MessageSender,
    );

    expect((result as { workspaceWarning?: string }).workspaceWarning).toBeUndefined();
  });
});
