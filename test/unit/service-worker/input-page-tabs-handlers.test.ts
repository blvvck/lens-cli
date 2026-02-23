import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createChromeMock, resetChromeMock } from "../../mocks/chrome";

vi.mock("../../../src/native/port", () => ({
  initNativeMessaging: vi.fn(),
  postToNativeHost: vi.fn(),
}));

let handleMessage: (message: any, sender: any) => Promise<any>;
let handlerRegistry: Record<string, unknown>;
let cdp: Record<string, any>;

function installCanvasMocks() {
  vi.stubGlobal("createImageBitmap", async () => ({ width: 100, height: 100, close: vi.fn() }));
  const drawing = {
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 20 })),
    setLineDash: vi.fn(),
    strokeRect: vi.fn(),
  };
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return drawing;
      }
      convertToBlob() {
        return Promise.resolve(new Blob(["image"], { type: "image/png" }));
      }
    },
  );
  vi.stubGlobal(
    "FileReader",
    class {
      result: string | null = "data:image/png;base64,aW1hZ2U=";
      onload: (() => void) | null = null;
      readAsDataURL() {
        this.onload?.();
      }
    },
  );
  return drawing;
}

beforeAll(async () => {
  (globalThis as any).chrome = createChromeMock();
  ({ handleMessage } = await import("../../../src/service-worker/main"));
  ({ handlerRegistry } = await import("../../../src/service-worker/registry"));
  ({ cdp } = await import("../../../src/service-worker/state"));
});

describe("input, page search, and tab reload command dispatch", () => {
  beforeEach(() => {
    const chrome = createChromeMock() as any;
    chrome.tabs.reload = vi.fn().mockResolvedValue(undefined);
    (globalThis as any).chrome = chrome;
  });

  afterEach(() => {
    resetChromeMock();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("registers and dispatches input commands with legacy validation errors", async () => {
    for (const type of [
      "lens.page.executeClick",
      "lens.page.executeRightClick",
      "lens.page.executeDoubleClick",
      "lens.page.executeTripleClick",
      "lens.page.executeHover",
      "lens.page.executeDrag",
      "lens.page.executeType",
      "open",
      "lens.page.scroll",
      "screenshot",
      "lens.tabs.getCurrentId",
      "lens.input.paste",
      "lens.input.typeSubmit",
    ]) {
      expect(handlerRegistry[type]).toBeTypeOf("function");
    }

    const chrome = (globalThis as any).chrome;
    chrome.tabs.query.mockResolvedValue([{ id: 9 }]);
    await expect(handleMessage({ type: "lens.tabs.getCurrentId" }, {})).resolves.toEqual({ tabId: 9 });
    await expect(handleMessage({ type: "lens.page.executeType", tabId: 9 }, {})).rejects.toThrow(
      "No text provided",
    );
  });

  it("falls back when a CDP click does not complete within three seconds", async () => {
    vi.useFakeTimers();
    vi.spyOn(cdp, "click").mockReturnValue(new Promise((resolve) => setTimeout(resolve, 60000)));
    vi.spyOn(cdp, "evaluateScript").mockResolvedValue({ result: { value: { success: true } } });

    const pending = handleMessage({ type: "lens.page.executeClick", tabId: 9, x: 10, y: 20 }, {});
    await vi.advanceTimersByTimeAsync(3200);
    await expect(pending).resolves.toEqual({ success: true });
    expect(cdp.evaluateScript).toHaveBeenCalledWith(
      9,
      expect.stringContaining("elementFromPoint(10, 20)"),
    );
    vi.useRealTimers();
  });

  it("finishes navigation after a main-frame event and removes its listeners", async () => {
    vi.useFakeTimers();
    const chrome = (globalThis as any).chrome;
    chrome.tabs.get.mockResolvedValue({ id: 9, status: "loading" });
    let evaluations = 0;
    vi.spyOn(cdp, "evaluateScript").mockImplementation(async () => {
      evaluations += 1;
      return { result: { value: evaluations === 1 ? "loading" : "complete" } };
    });

    const pending = handleMessage(
      { type: "open", tabId: 9, url: "https://example.com/next" },
      {},
    );
    await Promise.resolve();
    await Promise.resolve();
    const completedListener = chrome.webNavigation.onCompleted.addListener.mock.calls[0]?.[0];
    expect(completedListener).toBeTypeOf("function");
    completedListener({ tabId: 9, frameId: 0 });
    await vi.advanceTimersByTimeAsync(1600);

    await expect(pending).resolves.toEqual({ success: true });
    expect(chrome.webNavigation.onCompleted.removeListener).toHaveBeenCalledWith(completedListener);
    vi.useRealTimers();
  });

  it("dispatches SEARCH_PAGE and preserves its missing-term error", async () => {
    expect(handlerRegistry["search"]).toBeTypeOf("function");
    const chrome = (globalThis as any).chrome;
    chrome.tabs.sendMessage.mockResolvedValue({ matches: [{ text: "needle" }] });
    await expect(
      handleMessage({ type: "search", tabId: 9, term: "needle" }, {}),
    ).resolves.toEqual({
      matches: [{ text: "needle" }],
    });
    await expect(handleMessage({ type: "search", tabId: 9 }, {})).rejects.toThrow(
      "Search term required",
    );
  });

  it("dispatches TAB_RELOAD with hard reload options and propagates browser failures", async () => {
    expect(handlerRegistry["tab.reload"]).toBeTypeOf("function");
    const reload = (globalThis as any).chrome.tabs.reload;
    await expect(handleMessage({ type: "tab.reload", tabId: 9, hard: true }, {})).resolves.toEqual({
      success: true,
    });
    expect(reload).toHaveBeenCalledWith(9, { bypassCache: true });
    reload.mockRejectedValueOnce(new Error("reload failed"));
    await expect(handleMessage({ type: "tab.reload", tabId: 9 }, {})).rejects.toThrow(
      "reload failed",
    );
  });

  it("captures full pages by scrolling and stitching viewport screenshots", async () => {
    const drawing = await installCanvasMocks();
    vi.spyOn(cdp, "evaluateScript").mockResolvedValue({
      result: {
        value: {
          viewportHeight: 100,
          totalHeight: 250,
          width: 100,
          devicePixelRatio: 1,
          originalScrollY: 20,
        },
      },
    });
    vi.spyOn(cdp, "captureScreenshot").mockResolvedValue({
      base64: "aW1hZ2U=",
      width: 100,
      height: 100,
    });

    const result = await handleMessage(
      { type: "screenshot", tabId: 9, fullpage: true, maxHeight: 250 },
      {},
    );

    expect(cdp.evaluateScript).toHaveBeenCalledWith(9, expect.stringContaining("totalHeight"));
    expect(cdp.evaluateScript).toHaveBeenCalledWith(9, "window.scrollTo(0, 200)");
    expect(cdp.evaluateScript).toHaveBeenLastCalledWith(9, "window.scrollTo(0, 20)");
    expect(drawing.drawImage).toHaveBeenCalledTimes(3);
    expect(result.height).toBe(250);
  });

  it("requests element bounds and annotates screenshots when requested", async () => {
    const drawing = await installCanvasMocks();
    const chrome = (globalThis as any).chrome;
    chrome.tabs.sendMessage.mockImplementation(async (_tabId: number, message: { type: string }) =>
      message.type === "lens.element.getBoundsForAnnotation"
        ? {
            elements: [
              { ref: "button1", tag: "button", bounds: { x: 1, y: 2, width: 30, height: 20 } },
            ],
          }
        : undefined,
    );
    vi.spyOn(cdp, "captureScreenshot").mockResolvedValue({
      base64: "aW1hZ2U=",
      width: 100,
      height: 100,
    });

    await handleMessage({ type: "screenshot", tabId: 9, annotate: true }, {});

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      9,
      { type: "lens.element.getBoundsForAnnotation" },
      { frameId: 0 },
    );
    expect(drawing.strokeRect).toHaveBeenCalled();
  });

  it("stores captured screenshots for later screenshot ID lookup", async () => {
    vi.spyOn(cdp, "captureScreenshot").mockResolvedValue({
      base64: "aW1hZ2U=",
      width: 100,
      height: 100,
    });

    const result = await handleMessage({ type: "screenshot", tabId: 9 }, {});

    expect(result.screenshotId).toEqual(expect.any(String));
    expect(
      (await import("../../../src/service-worker/shared")).getScreenshot(result.screenshotId),
    ).toEqual({
      base64: "aW1hZ2U=",
      width: 100,
      height: 100,
    });
    await expect(
      handleMessage({ type: "lens.page.getScreenshot", screenshotId: result.screenshotId }, {}),
    ).resolves.toEqual({ base64: "aW1hZ2U=", width: 100, height: 100 });
  });
});
