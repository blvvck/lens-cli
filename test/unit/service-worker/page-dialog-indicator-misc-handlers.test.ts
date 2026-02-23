import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createChromeMock, resetChromeMock } from "../../mocks/chrome";

vi.mock("../../../src/native/port", () => ({
  initNativeMessaging: vi.fn(),
  postToNativeHost: vi.fn(),
}));

let handleMessage: (message: any, sender: any) => Promise<any>;

beforeAll(async () => {
  (globalThis as any).chrome = createChromeMock();
  handleMessage = (await import("../../../src/service-worker/main")).handleMessage;
});

describe("page, dialog, indicator, and misc command dispatch", () => {
  beforeEach(() => {
    (globalThis as any).chrome = createChromeMock();
  });

  afterEach(() => {
    resetChromeMock();
  });

  it("dispatches page commands and rejects a tab-required page action without a bound tab", async () => {
    await expect(handleMessage({ type: "lens.ping" }, {})).resolves.toEqual({
      success: true,
      status: "connected",
    });
    await expect(handleMessage({ type: "page.inspect" }, {})).rejects.toThrow(
      "No agent tab is bound",
    );
  });

  it("acknowledges extension reload over native messaging without resolving a page tab", async () => {
    const chrome = (globalThis as any).chrome;
    chrome.runtime.reload = vi.fn();
    const { initNativeMessaging } = await import("../../../src/native/port");
    const receiveNativeMessage = vi.mocked(initNativeMessaging).mock.calls.at(-1)?.[0];
    expect(receiveNativeMessage).toBeTypeOf("function");
    if (!receiveNativeMessage) {
      throw new Error("Native message handler was not initialized");
    }
    vi.useFakeTimers();
    try {
      const result = await receiveNativeMessage({ type: "extension.reload" });
      expect(result).toMatchObject({ reloading: true });
      expect(chrome.tabs.get).not.toHaveBeenCalled();
      expect(chrome.tabs.query).not.toHaveBeenCalled();
      expect(chrome.runtime.reload).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);

      expect(chrome.runtime.reload).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatches dialog commands and preserves the missing-tab error", async () => {
    await expect(handleMessage({ type: "dialog.info", tabId: 12 }, {})).resolves.toEqual({
      hasDialog: false,
    });
    await expect(handleMessage({ type: "dialog.accept" }, {})).rejects.toThrow(
      "No agent tab is bound",
    );
  });

  it("dispatches indicator commands and rejects tab-required indicators without a bound tab", async () => {
    await expect(handleMessage({ type: "lens.indicator.heartbeat" }, {})).resolves.toEqual({
      success: true,
    });
    await expect(handleMessage({ type: "lens.indicator.showStaticIndicator" }, {})).rejects.toThrow(
      "No agent tab is bound",
    );
  });

  it("dispatches misc commands and rejects zoom updates without a bound tab", async () => {
    await expect(handleMessage({ type: "test.smoke" }, {})).resolves.toEqual({
      error: "No URLs provided for smoke test",
    });
    await expect(handleMessage({ type: "zoom.set", level: 1.25 }, {})).rejects.toThrow(
      "No agent tab is bound",
    );
  });
});
