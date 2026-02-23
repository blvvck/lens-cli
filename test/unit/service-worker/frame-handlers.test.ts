import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChromeMock, resetChromeMock } from "../../mocks/chrome";

const { mockCdp } = vi.hoisted(() => ({
  mockCdp: {
    getFrames: vi.fn(),
    evaluateInFrame: vi.fn(),
    setFetchRequestHandler: vi.fn(),
  },
}));

vi.mock("../../../src/cdp", () => ({
  CDPController: class MockCDPController {
    constructor() {
      return mockCdp;
    }
  },
}));

vi.mock("../../../src/native/port", () => ({
  initNativeMessaging: vi.fn(),
  postToNativeHost: vi.fn(),
}));

async function loadHandleMessage() {
  vi.resetModules();
  const chrome = createChromeMock() as any;
  chrome.tabs.get.mockResolvedValue({ id: 123, status: "complete", url: "https://example.com" });
  chrome.webNavigation.getAllFrames = vi.fn().mockResolvedValue([
    { frameId: 0, url: "https://example.com" },
    { frameId: 7, url: "https://example.com/frame" },
  ]);
  (globalThis as any).chrome = chrome;
  const mod = await import("../../../src/service-worker/main");
  return { handleMessage: mod.handleMessage, chrome };
}

describe("service worker frame handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCdp.getFrames.mockResolvedValue({
      success: true,
      frames: [
        { frameId: "main", url: "https://example.com" },
        { frameId: "frame-7", url: "https://example.com/frame" },
      ],
    });
    mockCdp.evaluateInFrame.mockResolvedValue({
      success: true,
      result: { value: 2 },
    });
  });

  afterEach(() => {
    resetChromeMock();
  });

  it("uses the active frame context for frame.js when --id is omitted", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();

    await expect(
      handleMessage({ type: "frame.switch", tabId: 123, index: 0 }, {}),
    ).resolves.toEqual({
      success: true,
      frameId: 7,
      cdpFrameId: "frame-7",
      url: "https://example.com/frame",
    });

    await expect(
      handleMessage(
        {
          type: "frame.js",
          tabId: 123,
          code: "1 + 1",
        },
        {},
      ),
    ).resolves.toEqual({
      value: { value: 2 },
    });

    expect(mockCdp.evaluateInFrame).toHaveBeenCalledWith(123, "frame-7", "1 + 1");
    expect(chrome.webNavigation.getAllFrames).toHaveBeenCalledWith({ tabId: 123 });
  });

  it("fails clearly when duplicate frame URLs cannot be disambiguated", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();
    chrome.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 0, url: "https://example.com" },
      { frameId: 7, url: "https://example.com/frame" },
      { frameId: 8, url: "https://example.com/frame" },
    ]);
    mockCdp.getFrames.mockResolvedValue({
      success: true,
      frames: [
        { frameId: "main", url: "https://example.com" },
        { frameId: "frame-a", url: "https://example.com/frame", parentId: "main" },
        { frameId: "frame-b", url: "https://example.com/frame", parentId: "main" },
      ],
    });

    await expect(handleMessage({ type: "frame.switch", tabId: 123, index: 1 }, {})).rejects.toThrow(
      "Could not uniquely map frame 8 to CDP (2 matching URLs)",
    );
  });

  it("fails clearly when the selected frame cannot be mapped to CDP", async () => {
    const { handleMessage } = await loadHandleMessage();
    mockCdp.getFrames.mockResolvedValue({ success: false, error: "CDP unavailable" });

    await expect(handleMessage({ type: "frame.switch", tabId: 123, index: 0 }, {})).rejects.toThrow(
      "Could not map the selected frame to a CDP frame",
    );
  });

  it("does not reuse a prior CDP frame after a later switch fails", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();
    mockCdp.getFrames.mockResolvedValueOnce({
      success: true,
      frames: [
        { frameId: "main", url: "https://example.com" },
        { frameId: "frame-7", url: "https://example.com/frame" },
      ],
    });
    await handleMessage({ type: "frame.switch", tabId: 123, index: 0 }, {});

    chrome.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 0, url: "https://example.com" },
      { frameId: 8, url: "https://example.com/frame" },
      { frameId: 9, url: "https://example.com/frame" },
    ]);
    mockCdp.getFrames.mockResolvedValueOnce({
      success: true,
      frames: [
        { frameId: "main", url: "https://example.com" },
        { frameId: "frame-a", url: "https://example.com/frame" },
        { frameId: "frame-b", url: "https://example.com/frame" },
      ],
    });
    await expect(handleMessage({ type: "frame.switch", tabId: 123, index: 0 }, {})).rejects.toThrow(
      "Could not uniquely map frame 8 to CDP (2 matching URLs)",
    );
    await expect(
      handleMessage({ type: "frame.js", tabId: 123, code: "document.title" }, {}),
    ).rejects.toThrow("No frameId provided");
  });

  it("clears both frame contexts before an early switch failure", async () => {
    const { handleMessage } = await loadHandleMessage();
    await handleMessage({ type: "frame.switch", tabId: 123, index: 0 }, {});

    await expect(
      handleMessage({ type: "frame.switch", tabId: 123, index: 99 }, {}),
    ).rejects.toThrow("Frame index 99 out of range");
    await expect(
      handleMessage({ type: "frame.js", tabId: 123, code: "document.title" }, {}),
    ).rejects.toThrow("No frameId provided");
  });
});
