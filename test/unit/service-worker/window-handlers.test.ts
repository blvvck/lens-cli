import { vi } from "vitest";
import { createChromeMock, resetChromeMock } from "../../mocks/chrome";

// Mock the native port module to prevent initNativeMessaging side effects
vi.mock("../../../src/native/port", () => ({
  initNativeMessaging: vi.fn(),
  postToNativeHost: vi.fn(),
}));

// Use dynamic import to ensure chrome mock is set up BEFORE module loads
let handleMessage: (message: any, sender: any) => Promise<any>;

beforeAll(async () => {
  // Set up chrome mock BEFORE importing the module
  (globalThis as any).chrome = createChromeMock();

  // Dynamic import after mock is ready
  const mod = await import("../../../src/service-worker/main");
  handleMessage = mod.handleMessage;
});

describe("window command handlers", () => {
  beforeEach(() => {
    // Fresh mock for each test
    (globalThis as any).chrome = createChromeMock();
  });

  afterEach(() => {
    resetChromeMock();
  });

  describe("window.new", () => {
    it("creates window with URL", async () => {
      const chrome = (globalThis as any).chrome;
      chrome.windows.create.mockResolvedValue({ id: 123 });
      chrome.tabs.query.mockResolvedValue([{ id: 456 }]);

      const result = await handleMessage({ type: "window.new", url: "https://example.com" }, {});

      expect(chrome.windows.create).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://example.com",
          focused: true,
          type: "normal",
        }),
      );
      expect(result.windowId).toBe(123);
      expect(result.tabId).toBe(456);
    });

    it("creates window with dimensions", async () => {
      const chrome = (globalThis as any).chrome;
      chrome.windows.create.mockResolvedValue({ id: 1 });
      chrome.tabs.query.mockResolvedValue([{ id: 1 }]);

      await handleMessage({ type: "window.new", width: 1280, height: 720 }, {});

      expect(chrome.windows.create).toHaveBeenCalledWith(
        expect.objectContaining({
          width: 1280,
          height: 720,
        }),
      );
    });

    it("creates incognito window", async () => {
      const chrome = (globalThis as any).chrome;
      chrome.windows.create.mockResolvedValue({ id: 1 });
      chrome.tabs.query.mockResolvedValue([{ id: 1 }]);

      await handleMessage({ type: "window.new", incognito: true }, {});

      expect(chrome.windows.create).toHaveBeenCalledWith(
        expect.objectContaining({
          incognito: true,
        }),
      );
    });

    it("includes hint in response", async () => {
      const chrome = (globalThis as any).chrome;
      chrome.windows.create.mockResolvedValue({ id: 999 });
      chrome.tabs.query.mockResolvedValue([{ id: 1 }]);

      const result = await handleMessage({ type: "window.new" }, {});

      // A new window adopts its first tab, so later commands need no window flag.
      expect(result.bound).toBe(true);
      expect(result.windowId).toBe(999);
      expect(result.hint).toContain("Subsequent commands target window 999");
    });
  });

  describe("window.list", () => {
    it("returns all windows", async () => {
      const chrome = (globalThis as any).chrome;
      chrome.windows.getAll.mockResolvedValue([
        { id: 1, focused: true, width: 800, height: 600, tabs: [] },
        { id: 2, focused: false, width: 1024, height: 768, tabs: [] },
      ]);

      const result = await handleMessage({ type: "window.list" }, {});

      expect(result.windows).toHaveLength(2);
      expect(result.windows[0].id).toBe(1);
      expect(result.windows[0].focused).toBe(true);
    });

    it("includes tabs when requested", async () => {
      const chrome = (globalThis as any).chrome;
      chrome.windows.getAll.mockResolvedValue([
        { id: 1, tabs: [{ id: 10, title: "Tab 1", url: "https://a.com" }] },
      ]);

      const result = await handleMessage({ type: "window.list", includeTabs: true }, {});

      expect(result.windows[0].tabs).toHaveLength(1);
      expect(result.windows[0].tabs[0].title).toBe("Tab 1");
    });
  });

  describe("window.focus", () => {
    it("focuses window by ID", async () => {
      const chrome = (globalThis as any).chrome;
      chrome.windows.update.mockResolvedValue({});

      const result = await handleMessage({ type: "window.focus", windowId: 123 }, {});

      expect(chrome.windows.update).toHaveBeenCalledWith(123, { focused: true });
      expect(result.success).toBe(true);
    });

    it("throws without windowId", async () => {
      await expect(handleMessage({ type: "window.focus" }, {})).rejects.toThrow(
        "No windowId provided",
      );
    });
  });

  describe("window.close", () => {
    it("closes window by ID", async () => {
      const chrome = (globalThis as any).chrome;
      chrome.windows.remove.mockResolvedValue(undefined);

      const result = await handleMessage({ type: "window.close", windowId: 123 }, {});

      expect(chrome.windows.remove).toHaveBeenCalledWith(123);
      expect(result.success).toBe(true);
    });
  });

  describe("window.resize", () => {
    it("resizes window", async () => {
      const chrome = (globalThis as any).chrome;
      chrome.windows.update.mockResolvedValue({ width: 1920, height: 1080 });

      const result = await handleMessage(
        {
          type: "window.resize",
          windowId: 123,
          width: 1920,
          height: 1080,
        },
        {},
      );

      expect(chrome.windows.update).toHaveBeenCalledWith(
        123,
        expect.objectContaining({
          width: 1920,
          height: 1080,
        }),
      );
      expect(result.width).toBe(1920);
    });
  });

  describe("tab commands with windowId", () => {
    describe("tab.list", () => {
      it("filters by windowId when provided", async () => {
        const chrome = (globalThis as any).chrome;
        chrome.tabs.query.mockResolvedValue([{ id: 1, title: "Tab 1" }]);

        await handleMessage({ type: "tab.list", windowId: 123 }, {});

        expect(chrome.tabs.query).toHaveBeenCalledWith({ windowId: 123 });
      });

      it("queries all windows when no windowId", async () => {
        const chrome = (globalThis as any).chrome;
        chrome.tabs.query.mockResolvedValue([]);

        await handleMessage({ type: "tab.list" }, {});

        expect(chrome.tabs.query).toHaveBeenCalledWith({});
      });
    });

    describe("tab.new", () => {
      it("creates tab in specified window", async () => {
        const chrome = (globalThis as any).chrome;
        chrome.tabs.create.mockResolvedValue({ id: 1 });

        await handleMessage({ type: "tab.new", url: "https://example.com", windowId: 123 }, {});

        expect(chrome.tabs.create).toHaveBeenCalledWith(
          expect.objectContaining({
            url: "https://example.com",
            windowId: 123,
          }),
        );
      });
    });
  });

  describe("workspace.create", () => {
    it("uses a background tab by default, which cannot raise Chrome", async () => {
      const chrome = (globalThis as any).chrome;
      chrome.tabs.create.mockResolvedValue({ id: 501, windowId: 99 });
      chrome.tabs.get.mockRejectedValue(new Error("no such tab"));

      const result = await handleMessage({ type: "workspace.create", name: "checkout-flow" }, {});

      expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
      expect(chrome.windows.create).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: true,
        workspace: "checkout-flow",
        tabId: 501,
        reused: false,
        raised: false,
      });
    });

    it("reuses a live target instead of creating a second one", async () => {
      const chrome = (globalThis as any).chrome;
      chrome.tabs.get.mockResolvedValue({ id: 502, windowId: 90 });

      const result = await handleMessage({ type: "workspace.create", name: "checkout-flow" }, {});

      expect(chrome.tabs.create).not.toHaveBeenCalled();
      expect(chrome.windows.create).not.toHaveBeenCalled();
      expect(result).toMatchObject({ success: true, windowId: 90, tabId: 502, reused: true });
    });

    it("only opens a window when --new-window asks for one", async () => {
      const chrome = (globalThis as any).chrome;
      chrome.windows.create.mockResolvedValue({ id: 89 });
      chrome.tabs.query.mockResolvedValue([{ id: 503 }]);
      chrome.tabs.get.mockRejectedValue(new Error("no such tab"));

      const result = await handleMessage(
        { type: "workspace.create", name: "docs-sweep", newWindow: true },
        {},
      );

      expect(chrome.windows.create).toHaveBeenCalledWith(
        expect.objectContaining({ focused: false }),
      );
      expect(result).toMatchObject({ success: true, tabId: 503, raised: true });
    });
  });

  describe("workspace.info", () => {
    it("reports a live target without a recovery hint", async () => {
      await handleMessage({ type: "workspace.use", name: "info-live", tabId: 601 }, {});
      const chrome = (globalThis as any).chrome;
      chrome.tabs.get.mockResolvedValue({ id: 601, windowId: 5 });

      const info = await handleMessage({ type: "workspace.info", name: "info-live" }, {});

      expect(info).toMatchObject({
        workspace: "info-live",
        targetTabId: 601,
        live: true,
        recovery: null,
      });
      expect(info.ownedTabs).toContain(601);
    });

    it("marks a missing target stale and names the command that recovers it", async () => {
      await handleMessage({ type: "workspace.use", name: "info-stale", tabId: 602 }, {});
      const chrome = (globalThis as any).chrome;
      chrome.tabs.get.mockRejectedValue(new Error("No tab with id: 602"));

      const info = await handleMessage({ type: "workspace.info", name: "info-stale" }, {});

      expect(info).toMatchObject({ workspace: "info-stale", live: false });
      expect(info.recovery).toBe("lens workspace.create info-stale");
    });
  });
});
