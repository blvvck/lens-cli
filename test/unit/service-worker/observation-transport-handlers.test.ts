import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChromeMock, resetChromeMock } from "../../mocks/chrome";

const { mockCdp, mockNative } = vi.hoisted(() => {
  const functions = [
    "startPerformanceTrace",
    "stopPerformanceTrace",
    "getPerformanceMetrics",
    "getFrames",
    "evaluateInFrame",
    "evaluateScript",
    "waitForLoad",
    "emulateNetwork",
    "emulateCPU",
    "emulateGeolocation",
    "clearGeolocation",
    "emulateDevice",
    "clearDeviceEmulation",
    "emulateViewport",
    "emulateTouch",
    "enableConsoleTracking",
    "getConsoleMessages",
    "clearConsoleMessages",
    "enableNetworkTracking",
    "getNetworkRequests",
    "getNetworkEntries",
    "clearNetworkRequests",
    "findNetworkEntry",
    "getResponseBody",
    "subscribeToConsole",
    "subscribeToNetwork",
    "unsubscribeFromConsole",
    "unsubscribeFromNetwork",
    "setFetchRequestHandler",
  ];
  return {
    mockCdp: Object.fromEntries(functions.map((name) => [name, vi.fn()])),
    mockNative: { sendToNativeHost: vi.fn(), postToNativeHost: vi.fn() },
  };
});

vi.mock("../../../src/cdp", () => ({
  CDPController: class {
    constructor() {
      Object.assign(this, mockCdp);
    }
  },
}));
vi.mock("../../../src/native/port", () => ({
  initNativeMessaging: vi.fn(),
  postToNativeHost: mockNative.postToNativeHost,
  sendToNativeHost: mockNative.sendToNativeHost,
}));

async function dispatch(type: string, fields: Record<string, unknown> = {}) {
  vi.resetModules();
  const chrome = createChromeMock() as any;
  chrome.tabs.get.mockResolvedValue({ id: 123, status: "complete", url: "https://example.com" });
  chrome.webNavigation.getAllFrames = vi.fn().mockResolvedValue([
    { frameId: 0, url: "https://example.com" },
    { frameId: 7, url: "https://example.com/frame" },
  ]);
  (globalThis as any).chrome = chrome;
  const { handleMessage } = await import("../../../src/service-worker/main");
  return handleMessage({ type, tabId: 123, ...fields } as any, {} as any);
}

describe("observation and transport handler dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCdp.startPerformanceTrace.mockResolvedValue({ success: true });
    mockCdp.stopPerformanceTrace.mockResolvedValue({
      success: true,
      metrics: { duration: 10 },
    });
    mockCdp.getPerformanceMetrics.mockResolvedValue({ success: true, metrics: [] });
    mockCdp.getFrames.mockResolvedValue({ success: true, frames: [{ frameId: "main" }] });
    mockCdp.evaluateInFrame.mockResolvedValue({ success: true, result: 4 });
    mockCdp.waitForLoad.mockResolvedValue({ success: true, readyState: "complete" });
    mockCdp.emulateNetwork.mockResolvedValue({ success: true });
    mockCdp.getConsoleMessages.mockReturnValue([{ text: "ready" }]);
    mockCdp.getNetworkEntries.mockReturnValue([]);
    mockNative.sendToNativeHost.mockResolvedValue({ auth: { user: "test" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetChromeMock();
  });

  it("registers every message type owned by these handler families", async () => {
    await dispatch("lens.auth.get");
    const { handlerRegistry } = await import("../../../src/service-worker/registry");
    const expectedTypes = [
      "console",
      "lens.console.clear",
      "network",
      "network.clear",
      "lens.network.getEntries",
      "lens.network.entry",
      "network.origins",
      "network.stats",
      "network.body",
      "network.export",
      "network.path",
      "lens.stream.console",
      "lens.stream.network",
      "lens.stream.stop",
      "frame.list",
      "frame.switch",
      "frame.main",
      "frame.js",
      "lens.page.execute",
      "perf.start",
      "perf.stop",
      "perf.metrics",
      "wait.load",
      "lens.wait.element",
      "wait.text",
      "wait.url",
      "wait.network",
      "wait.dom",
      "emulate.network",
      "emulate.cpu",
      "emulate.geo",
      "emulate.deviceList",
      "emulate.device",
      "emulate.viewport",
      "emulate.touch",
      "lens.page.diff",
      "lens.page.domDiff",
      "extension.reload",
      "lens.auth.get",
      "lens.nativeApi.requestFromExtension",
    ];
    expect(Object.keys(handlerRegistry)).toEqual(expect.arrayContaining(expectedTypes));
  });

  it("dispatches console/network reads and validation errors", async () => {
    await expect(dispatch("console")).resolves.toEqual({
      messages: [{ text: "ready" }],
    });
    await expect(dispatch("lens.network.entry")).rejects.toThrow("No requestId provided");
  });

  it("exports captured network entries and resolves stored body paths", async () => {
    const entries = [
      {
        id: "r_001",
        ts: 10,
        method: "GET",
        url: "https://example.com/data",
        origin: "https://example.com",
        requestHeaders: {},
        responseHeaders: { "content-type": "application/json" },
        responseBody: '{"ok":true}',
        tabId: 123,
        flags: [],
        _requestId: "cdp-1",
        _responseReceived: true,
        _loadingFinished: true,
      },
    ];
    mockCdp.getNetworkEntries.mockReturnValue(entries);
    mockNative.sendToNativeHost.mockImplementation(async (message: any) => {
      if (message.type === "lens.network.export.write") {
        return { path: message.output || "/tmp/lens-network.jsonl" };
      }
      if (message.type === "lens.network.paths") {
        return { paths: { response: "/tmp/lens-network/bodies/hash.res" } };
      }
      return {};
    });

    await expect(
      dispatch("network.export", { jsonl: true, output: "/tmp/export.jsonl" }),
    ).resolves.toEqual({ path: "/tmp/export.jsonl" });
    await expect(dispatch("network.path", { requestId: "r_001" })).resolves.toEqual({
      paths: { response: "/tmp/lens-network/bodies/hash.res" },
    });
    expect(mockNative.sendToNativeHost).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "lens.network.export.write",
        output: "/tmp/export.jsonl",
        content: expect.any(String),
      }),
    );
    expect(mockNative.sendToNativeHost).toHaveBeenCalledWith({
      type: "lens.network.paths",
      requestId: "r_001",
    });
  });

  it("dispatches frame operations and rejects missing code", async () => {
    await expect(dispatch("frame.list")).resolves.toEqual({
      success: true,
      frames: [{ frameId: "main" }],
    });
    await expect(dispatch("frame.js", { frameId: 7 })).rejects.toThrow("No code provided");
  });

  it("dispatches performance operations and propagates CDP errors", async () => {
    await expect(dispatch("perf.start")).resolves.toEqual({
      success: true,
      message: "Performance tracing started",
    });
    mockCdp.stopPerformanceTrace.mockResolvedValueOnce({
      success: false,
      error: "trace failed",
    });
    await expect(dispatch("perf.stop")).rejects.toThrow("trace failed");
  });

  it("dispatches load waits and propagates load failures", async () => {
    await expect(dispatch("wait.load")).resolves.toEqual({
      success: true,
      readyState: "complete",
    });
    mockCdp.waitForLoad.mockResolvedValueOnce({
      success: false,
      error: "navigation timeout",
    });
    await expect(dispatch("wait.load")).rejects.toThrow("navigation timeout");
  });

  it("dispatches emulation and propagates CDP errors", async () => {
    await expect(dispatch("emulate.network", { preset: "fast3g" })).resolves.toEqual({
      success: true,
      preset: "fast3g",
    });
    mockCdp.emulateNetwork.mockResolvedValueOnce({
      success: false,
      error: "emulation unavailable",
    });
    await expect(dispatch("emulate.network", { preset: "offline" })).rejects.toThrow(
      "emulation unavailable",
    );
  });

  it("dispatches snapshot comparison and rejects incomplete snapshots", async () => {
    const node = { tag: "main", bounds: { x: 0, y: 0, w: 10, h: 10 }, styles: {}, children: [] };
    await expect(
      dispatch("lens.page.domDiff", {
        snapshotA: { tree: node },
        snapshotB: { tree: node },
      }),
    ).resolves.toMatchObject({ changes: [], summary: { total: 0 } });
    await expect(dispatch("lens.page.domDiff")).rejects.toThrow("Two snapshots required");
  });

  it("returns the raw-image pixel diff reply through dispatch", async () => {
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return {
            createImageData: (width: number, height: number) => ({
              data: new Uint8ClampedArray(width * height * 4),
            }),
            putImageData: vi.fn(),
          };
        }
        convertToBlob() {
          return Promise.resolve(new Blob());
        }
      },
    );
    vi.stubGlobal(
      "FileReader",
      class {
        result: string | null = null;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsDataURL() {
          this.result = "data:image/png;base64,WA==";
          this.onload?.();
        }
      },
    );
    await expect(
      dispatch("lens.page.diff", {
        rawA: "AAAAAA==",
        rawB: "AAAAAA==",
        width: 1,
        height: 1,
      }),
    ).resolves.toMatchObject({
      base64: "WA==",
      width: 1,
      height: 1,
      mismatch: 0,
      mismatchPixels: 0,
      totalPixels: 1,
      aaPixels: 0,
      passed: true,
    });
    await expect(
      dispatch("lens.page.diff", {
        rawA: "AAAAAA==",
        rawB: "AAAAAA==",
        width: 1,
        height: 1,
        mode: "ssim",
      }),
    ).resolves.toMatchObject({
      base64: "WA==",
      width: 1,
      height: 1,
      mode: "ssim",
      ssim: 1,
      mssim: 1,
      totalPixels: 1,
      passed: true,
    });
  });

  it("dispatches native host calls and returns native failures", async () => {
    await expect(dispatch("lens.auth.get")).resolves.toEqual({ auth: { user: "test" } });
    mockNative.sendToNativeHost.mockRejectedValueOnce(new Error("host unavailable"));
    await expect(
      dispatch("lens.nativeApi.requestFromExtension", { url: "https://api.example.test" }),
    ).resolves.toEqual({ error: "host unavailable" });
  });
});
