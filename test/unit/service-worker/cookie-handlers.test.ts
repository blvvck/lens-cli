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

describe("cookie command dispatch", () => {
  beforeEach(() => {
    const chrome = createChromeMock() as any;
    chrome.cookies = {
      getAll: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue({ name: "session", value: "abc" }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    chrome.tabs.get.mockResolvedValue({ id: 12, url: "https://example.com/path" });
    (globalThis as any).chrome = chrome;
  });

  afterEach(() => {
    resetChromeMock();
  });

  it("sets a cookie for the resolved tab URL and returns the browser result", async () => {
    const chrome = (globalThis as any).chrome;

    await expect(
      handleMessage({ type: "cookie.set", tabId: 12, name: "session", value: "abc" }, {}),
    ).resolves.toEqual({
      success: true,
      cookie: { name: "session", value: "abc" },
    });

    expect(chrome.cookies.set).toHaveBeenCalledWith({
      url: "https://example.com/path",
      name: "session",
      value: "abc",
    });
  });
});
