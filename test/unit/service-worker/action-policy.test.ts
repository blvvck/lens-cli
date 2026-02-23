import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChromeMock, resetChromeMock } from "../../mocks/chrome";

const { mockCdp } = vi.hoisted(() => ({
  mockCdp: {
    click: vi.fn(),
    doubleClick: vi.fn(),
    rightClick: vi.fn(),
    tripleClick: vi.fn(),
    hover: vi.fn(),
    type: vi.fn(),
    parseModifiers: vi.fn(() => 0),
    pressKey: vi.fn(),
    evaluateScript: vi.fn(),
    getFrames: vi.fn(),
    findNetworkEntry: vi.fn(),
    getResponseBody: vi.fn(),
    setFetchRequestHandler: vi.fn(),
    setFileInputBySelector: vi.fn(),
    interceptFileChooser: vi.fn(),
  },
}));

vi.mock("../../../src/cdp", () => ({
  CDPController: vi.fn(function MockCDPController() {
    return mockCdp;
  }),
}));

vi.mock("../../../src/native/port", () => ({
  initNativeMessaging: vi.fn(),
  postToNativeHost: vi.fn(),
  sendToNativeHost: vi.fn(),
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

describe("service worker action policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockCdp.click.mockResolvedValue(undefined);
    mockCdp.doubleClick.mockResolvedValue(undefined);
    mockCdp.rightClick.mockResolvedValue(undefined);
    mockCdp.tripleClick.mockResolvedValue(undefined);
    mockCdp.hover.mockResolvedValue(undefined);
    mockCdp.type.mockResolvedValue(undefined);
    mockCdp.pressKey.mockResolvedValue(undefined);
    mockCdp.evaluateScript.mockResolvedValue({ result: { value: 0 } });
    mockCdp.getFrames.mockResolvedValue({
      success: true,
      frames: [
        { frameId: "main", url: "https://example.com" },
        { frameId: "frame-7", url: "https://example.com/frame" },
      ],
    });
    mockCdp.findNetworkEntry.mockReturnValue(null);
    mockCdp.getResponseBody.mockResolvedValue({ success: true });
    mockCdp.setFileInputBySelector.mockResolvedValue({ success: true });
    mockCdp.interceptFileChooser.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetChromeMock();
  });

  it("retries verification without replaying the click action", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();
    let verifyAttempts = 0;

    chrome.tabs.sendMessage.mockImplementation((_tabId: number, message: { type: string }) => {
      if (message.type === "lens.wait.element") {
        verifyAttempts += 1;
        if (verifyAttempts === 1) {
          return Promise.resolve({ error: "Timeout waiting for selector" });
        }
        return Promise.resolve({ success: true, waited: 25 });
      }
      return Promise.resolve({ success: true });
    });

    const resultPromise = handleMessage(
      {
        type: "lens.page.executeClick",
        tabId: 123,
        x: 40,
        y: 50,
        verify: true,
        verifySelector: ".saved",
        retry: 1,
        retryDelay: 10,
      },
      {},
    );

    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual({ success: true });
    expect(mockCdp.click).toHaveBeenCalledTimes(1);
    expect(verifyAttempts).toBe(2);
  });

  it("uses the active frame for wait.ready checks after frame.switch", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();

    chrome.tabs.sendMessage.mockImplementation(
      (_tabId: number, message: { type: string }, options?: { frameId?: number }) => {
        if (
          message.type === "wait.dom" ||
          message.type === "lens.wait.element" ||
          message.type === "lens.page.getState"
        ) {
          return Promise.resolve({
            success: true,
            waited: 10,
            hasModal: false,
            hasDropdown: false,
            hasDatePicker: false,
            hasOverlay: false,
            focusedElement: null,
            url: "https://example.com/frame",
            title: "Frame",
            frameId: options?.frameId,
          });
        }
        return Promise.resolve({ success: true });
      },
    );

    await expect(
      handleMessage({ type: "frame.switch", tabId: 123, index: 0 }, {}),
    ).resolves.toEqual({
      success: true,
      frameId: 7,
      cdpFrameId: "frame-7",
      url: "https://example.com/frame",
    });

    chrome.tabs.sendMessage.mockClear();

    const readyPromise = handleMessage(
      {
        type: "wait.ready",
        tabId: 123,
        selector: "#composer",
      },
      {},
    );

    await vi.runAllTimersAsync();
    await expect(readyPromise).resolves.toMatchObject({ success: true });

    const frameCalls = chrome.tabs.sendMessage.mock.calls
      .filter(([, message]: [number, { type: string }]) =>
        ["wait.dom", "lens.wait.element", "lens.page.getState"].includes(message.type),
      )
      .map(([, message, options]: [number, { type: string }, { frameId?: number }]) => ({
        type: message.type,
        frameId: options?.frameId,
      }));

    expect(frameCalls).toEqual([
      { type: "wait.dom", frameId: 0 },
      { type: "wait.dom", frameId: 7 },
      { type: "lens.wait.element", frameId: 7 },
      { type: "lens.page.getState", frameId: 7 },
      { type: "lens.page.getState", frameId: 0 },
    ]);
  });

  it("wait.ready still rejects when the top document has an overlay after frame.switch", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();

    chrome.tabs.sendMessage.mockImplementation(
      (_tabId: number, message: { type: string }, options?: { frameId?: number }) => {
        if (message.type === "wait.dom" || message.type === "lens.wait.element") {
          return Promise.resolve({ success: true });
        }
        if (message.type === "lens.page.getState") {
          if (options?.frameId === 0) {
            return Promise.resolve({
              hasModal: true,
              hasDropdown: false,
              hasDatePicker: false,
              hasOverlay: true,
              focusedElement: null,
              url: "https://example.com",
              title: "Main",
            });
          }
          return Promise.resolve({
            hasModal: false,
            hasDropdown: false,
            hasDatePicker: false,
            hasOverlay: false,
            focusedElement: null,
            url: "https://example.com/frame",
            title: "Frame",
          });
        }
        return Promise.resolve({ success: true });
      },
    );

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
          type: "wait.ready",
          tabId: 123,
          selector: "#composer",
        },
        {},
      ),
    ).rejects.toThrow("Page has active overlay/modal/dropdown");
  });

  it("click.ref clicks through the frame-local ref map instead of main-document coordinates", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();

    chrome.tabs.sendMessage.mockImplementation((_tabId: number, message: { type: string }) => {
      if (message.type === "wait.dom" || message.type === "lens.page.getState") {
        return Promise.resolve({
          success: true,
          hasModal: false,
          hasDropdown: false,
          hasDatePicker: false,
          hasOverlay: false,
          focusedElement: null,
          url: "https://example.com/frame",
          title: "Frame",
        });
      }
      return Promise.resolve({ success: true });
    });
    chrome.scripting.executeScript.mockResolvedValue([{ result: { success: true } }]);

    await expect(
      handleMessage({ type: "frame.switch", tabId: 123, index: 0 }, {}),
    ).resolves.toEqual({
      success: true,
      frameId: 7,
      cdpFrameId: "frame-7",
      url: "https://example.com/frame",
    });

    chrome.scripting.executeScript.mockClear();

    const clickPromise = handleMessage(
      {
        type: "page.click",
        tabId: 123,
        ref: "r1",
        waitReady: true,
      },
      {},
    );

    await vi.runAllTimersAsync();
    await expect(clickPromise).resolves.toEqual({ success: true });

    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 123, frameIds: [7] },
        args: ["r1", "left", true, 5000],
      }),
    );
    expect(mockCdp.click).not.toHaveBeenCalled();
  });

  it("click.ref forwards scroll mode to the in-page click", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();

    chrome.tabs.sendMessage.mockResolvedValue({ success: true });
    chrome.scripting.executeScript.mockResolvedValue([{ result: { success: true } }]);

    const clickPromise = handleMessage(
      {
        type: "page.click",
        tabId: 123,
        ref: "r1",
        scroll: "off",
      },
      {},
    );

    await vi.runAllTimersAsync();
    await expect(clickPromise).resolves.toEqual({ success: true });

    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 123 },
        args: ["r1", "left", false, 5000],
      }),
    );
  });

  it("hover.ref forwards scroll mode through coordinate lookup", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();

    chrome.tabs.sendMessage.mockResolvedValue({ success: true });
    chrome.scripting.executeScript.mockResolvedValue([{ result: { x: 10, y: 20 } }]);

    const hoverPromise = handleMessage(
      {
        type: "lens.page.hoverRef",
        tabId: 123,
        ref: "r1",
        scroll: "off",
      },
      {},
    );

    await vi.runAllTimersAsync();
    await expect(hoverPromise).resolves.toEqual({ success: true });

    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 123 },
        args: ["r1", false],
      }),
    );
    expect(mockCdp.hover).toHaveBeenCalledWith(123, 10, 20);
  });

  it("form.fill retries only the failing field instead of replaying earlier checkboxes", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();
    let nameAttempts = 0;

    chrome.tabs.sendMessage.mockResolvedValue({ success: true });
    chrome.scripting.executeScript.mockImplementation(async (injection: { args?: unknown[] }) => {
      const ref = injection.args?.[0];
      if (ref === "name") {
        nameAttempts += 1;
        if (nameAttempts === 1) {
          return [{ result: { success: false, error: "Element not focused" } }];
        }
      }
      return [{ result: { success: true } }];
    });

    const formPromise = handleMessage(
      {
        type: "form.fill",
        tabId: 123,
        retry: 1,
        retryDelay: 10,
        data: [
          { ref: "accept", value: true },
          { ref: "name", value: "Isaac" },
        ],
      },
      {},
    );

    await vi.runAllTimersAsync();
    await expect(formPromise).resolves.toMatchObject({
      success: true,
      filled: 2,
      failed: 0,
    });

    const callsFor = (ref: string) =>
      chrome.scripting.executeScript.mock.calls.filter(
        ([injection]: [{ args?: unknown[] }]) => injection.args?.[0] === ref,
      );
    expect(callsFor("accept")).toHaveLength(1);
    expect(callsFor("name")).toHaveLength(2);
  });

  it("form.fill forwards scroll mode to the in-page fill", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();

    chrome.tabs.sendMessage.mockResolvedValue({ success: true });
    chrome.scripting.executeScript.mockResolvedValue([{ result: { success: true } }]);

    const formPromise = handleMessage(
      {
        type: "form.fill",
        tabId: 123,
        scroll: "off",
        data: [{ ref: "name", value: "Isaac" }],
      },
      {},
    );

    await vi.runAllTimersAsync();
    await expect(formPromise).resolves.toMatchObject({
      success: true,
      filled: 1,
      failed: 0,
    });

    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 123 },
        args: ["name", "Isaac", false, 5000],
      }),
    );
  });

  it("form.fill keeps scroll mode unset so ref typing uses the default auto-scroll behavior", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();

    chrome.tabs.sendMessage.mockResolvedValue({ success: true });
    chrome.scripting.executeScript.mockResolvedValue([{ result: { success: true } }]);

    const formPromise = handleMessage(
      {
        type: "form.fill",
        tabId: 123,
        data: [{ ref: "name", value: "Isaac" }],
      },
      {},
    );

    await vi.runAllTimersAsync();
    await expect(formPromise).resolves.toMatchObject({
      success: true,
      filled: 1,
      failed: 0,
    });

    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 123 },
        args: ["name", "Isaac", true, 5000],
      }),
    );
  });

  it("page.inspect includes visible text by default when options are omitted", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();

    chrome.tabs.sendMessage.mockImplementation((_tabId: number, message: { type: string }) => {
      if (message.type === "lens.page.generateAccessibilityTree") {
        return Promise.resolve({ pageContent: "tree", viewport: { width: 100, height: 50 } });
      }
      if (message.type === "page.text") {
        return Promise.resolve({ text: "visible text" });
      }
      return Promise.resolve({ success: true });
    });

    const resultPromise = handleMessage({ type: "page.inspect", tabId: 123 }, {});

    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual({
      pageContent: "tree",
      viewport: { width: 100, height: 50 },
      text: "visible text",
    });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      123,
      { type: "page.text" },
      { frameId: 0 },
    );
  });

  it("page.state falls back to a direct snapshot when the content-script receiver is missing", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();

    chrome.tabs.sendMessage.mockImplementation((_tabId: number, message: { type: string }) => {
      if (message.type === "lens.page.getState") {
        return Promise.reject(
          new Error("Could not establish connection. Receiving end does not exist."),
        );
      }
      return Promise.resolve({ success: true });
    });
    chrome.scripting.executeScript.mockResolvedValue([
      {
        result: {
          hasModal: false,
          hasDropdown: false,
          hasDatePicker: false,
          hasOverlay: false,
          focusedElement: { tag: "input", type: "text" },
          url: "https://example.com",
          title: "Example",
        },
      },
    ]);

    await expect(handleMessage({ type: "page.state", tabId: 123 }, {})).resolves.toEqual({
      hasModal: false,
      hasDropdown: false,
      hasDatePicker: false,
      hasOverlay: false,
      focusedElement: { tag: "input", type: "text" },
      url: "https://example.com",
      title: "Example",
    });
  });

  it("page.layout falls back to a direct DOM snapshot when retries still cannot reach the content script", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();

    chrome.tabs.sendMessage.mockImplementation((_tabId: number, message: { type: string }) => {
      if (message.type === "lens.page.generateLayoutTree" || message.type === "lens.ping") {
        return Promise.reject(
          new Error("Could not establish connection. Receiving end does not exist."),
        );
      }
      return Promise.resolve({ success: true });
    });
    chrome.scripting.executeScript.mockResolvedValue([
      {
        result: {
          layoutContent:
            "body {x:0 y:0 w:100 h:80 display:block position:static}\n\n[Viewport: 100x80]",
          viewport: { width: 100, height: 80 },
          fallback: "Direct DOM layout snapshot",
        },
      },
    ]);

    const layoutPromise = handleMessage({ type: "page.layout", tabId: 123 }, {});
    await vi.runAllTimersAsync();

    await expect(layoutPromise).resolves.toEqual({
      layoutContent:
        "body {x:0 y:0 w:100 h:80 display:block position:static}\n\n[Viewport: 100x80]",
      viewport: { width: 100, height: 80 },
      fallback: "Direct DOM layout snapshot",
    });
  });

  it("navigate returns once the destination tab is already usable even without a webNavigation completion event", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();

    chrome.tabs.update.mockResolvedValue({ id: 123, url: "https://jitter.video/templates/" });
    chrome.tabs.get.mockResolvedValue({
      id: 123,
      status: "complete",
      url: "https://jitter.video/templates/",
    });
    mockCdp.evaluateScript.mockImplementation(async (_tabId: number, expression: string) => {
      if (expression === "document.readyState") {
        return { result: { value: "complete" } };
      }
      return { result: { value: 0 } };
    });

    const navigatePromise = handleMessage(
      {
        type: "open",
        tabId: 123,
        url: "https://jitter.video/templates/",
      },
      {},
    );

    await vi.runAllTimersAsync();
    await expect(navigatePromise).resolves.toEqual({ success: true });
  });

  it("network.body retargets to the owning tab even when given a raw CDP request id", async () => {
    const { handleMessage } = await loadHandleMessage();

    mockCdp.findNetworkEntry.mockReturnValue({
      id: "r_1712000_1",
      _requestId: "req-123",
      tabId: 777,
    });
    mockCdp.getResponseBody.mockResolvedValue({
      success: true,
      body: '{"ok":true}',
      base64Encoded: false,
    });

    await expect(
      handleMessage(
        {
          type: "network.body",
          tabId: 123,
          requestId: "req-123",
        },
        {},
      ),
    ).resolves.toEqual({
      success: true,
      body: '{"ok":true}',
      base64Encoded: false,
    });

    expect(mockCdp.findNetworkEntry).toHaveBeenCalledWith("req-123", 123);
    expect(mockCdp.getResponseBody).toHaveBeenCalledWith(777, "req-123");
  });

  it("click.ref bounds the in-page actionability wait with the caller timeout", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();
    chrome.tabs.sendMessage.mockResolvedValue({ success: true });
    chrome.scripting.executeScript.mockResolvedValue([{ result: { success: true } }]);

    const clickPromise = handleMessage(
      { type: "page.click", tabId: 123, ref: "r1", timeout: 1234 },
      {},
    );
    await vi.runAllTimersAsync();
    await expect(clickPromise).resolves.toEqual({ success: true });

    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["r1", "left", true, 1234] }),
    );
  });

  it("form.fill bounds the in-page actionability wait with the caller timeout", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();
    chrome.tabs.sendMessage.mockResolvedValue({ success: true });
    chrome.scripting.executeScript.mockResolvedValue([{ result: { success: true } }]);

    const fillPromise = handleMessage(
      { type: "form.fill", tabId: 123, timeout: 2500, data: [{ ref: "name", value: "Isaac" }] },
      {},
    );
    await vi.runAllTimersAsync();
    await expect(fillPromise).resolves.toMatchObject({ success: true, filled: 1 });

    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["name", "Isaac", true, 2500] }),
    );
  });

  it("wait.element targets the frame selected by frame.switch", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();
    chrome.tabs.sendMessage.mockImplementation((_tabId: number, message: { type: string }) => {
      if (message.type === "wait.dom" || message.type === "lens.page.getState") {
        return Promise.resolve({
          success: true,
          hasModal: false,
          hasDropdown: false,
          hasDatePicker: false,
          hasOverlay: false,
          focusedElement: null,
          url: "https://example.com/frame",
          title: "Frame",
        });
      }
      return Promise.resolve({ success: true });
    });
    chrome.scripting.executeScript.mockResolvedValue([{ result: { success: true, waited: 0 } }]);

    await handleMessage({ type: "frame.switch", tabId: 123, index: 0 }, {});
    chrome.scripting.executeScript.mockClear();

    await handleMessage(
      { type: "lens.wait.element", tabId: 123, selector: "#target", state: "visible" },
      {},
    );

    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 123, frameIds: [7] } }),
    );
  });

  it("click.type forwards --double to the content script", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();
    chrome.tabs.sendMessage.mockResolvedValue({ success: true });

    await handleMessage(
      { type: "lens.page.clickType", tabId: 123, ref: "e1", text: "x", doubleClick: true },
      {},
    );
    await vi.runAllTimersAsync();

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      123,
      expect.objectContaining({ type: "lens.element.click", button: "double" }),
      expect.anything(),
    );
  });

  it("form.input forwards the ref and value to the active frame", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();
    chrome.tabs.sendMessage.mockResolvedValue({ success: true });
    await expect(
      handleMessage({ type: "lens.form.formInput", tabId: 123, ref: "e1", value: "Ada" }, {}),
    ).resolves.toEqual({ success: true });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      123,
      { type: "lens.form.formInput", ref: "e1", value: "Ada" },
      { frameId: 0 },
    );
  });

  it("set.input.value evaluates the supplied selector and value", async () => {
    const { handleMessage } = await loadHandleMessage();
    mockCdp.evaluateScript.mockResolvedValue({
      result: { value: { success: true, contentEditable: false } },
    });
    await expect(
      handleMessage(
        { type: "lens.form.setInputValue", tabId: 123, selector: "#name", value: "Ada" },
        {},
      ),
    ).resolves.toEqual({ success: true, contentEditable: false });
    expect(mockCdp.evaluateScript).toHaveBeenCalledWith(
      123,
      expect.stringContaining('document.querySelector("#name")'),
    );
  });

  it("smart.type focuses, clears, types, and submits through CDP", async () => {
    const { handleMessage } = await loadHandleMessage();
    mockCdp.evaluateScript.mockResolvedValue({ result: { value: { x: 20, y: 30 } } });
    const result = handleMessage(
      { type: "form.smart", tabId: 123, selector: "#search", text: "query", submit: true },
      {},
    );
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ success: true });
    expect(mockCdp.click).toHaveBeenCalledWith(123, 20, 30, "left", 1, 0);
    expect(mockCdp.type).toHaveBeenCalledWith(123, "query");
    expect(mockCdp.pressKey).toHaveBeenCalledWith(123, "Enter");
  });

  it("find.and.type returns the selected input coordinates", async () => {
    const { handleMessage } = await loadHandleMessage();
    mockCdp.evaluateScript.mockResolvedValue({ result: { value: { x: 15, y: 25, found: true } } });
    await expect(
      handleMessage({ type: "lens.find.findAndType", tabId: 123, text: "query", submit: true }, {}),
    ).resolves.toEqual({ success: true, coordinates: { x: 15, y: 25 } });
    expect(mockCdp.click).toHaveBeenCalledWith(123, 15, 25, "left", 1, 0);
    expect(mockCdp.type).toHaveBeenCalledWith(123, "query");
    expect(mockCdp.pressKey).toHaveBeenCalledWith(123, "Enter");
  });

  it("find.and.type types into an editable email input and skips date/color controls", async () => {
    const { handleMessage } = await loadHandleMessage();
    mockCdp.evaluateScript.mockImplementationOnce(async (_tabId: number, script: string) => {
      expect(script).toContain('input[type="email"]');
      expect(script.indexOf('input[type="email"]')).toBeLessThan(
        script.indexOf('[contenteditable="true"]'),
      );
      expect(script).not.toContain('input[type="date"]');
      expect(script).not.toContain('input[type="color"]');
      return { result: { value: { found: true, x: 41, y: 23 } } };
    });

    await expect(
      handleMessage({ type: "lens.find.findAndType", tabId: 123, text: "isaac@example.com" }, {}),
    ).resolves.toEqual({ success: true, coordinates: { x: 41, y: 23 } });
    expect(mockCdp.click).toHaveBeenCalledWith(123, 41, 23, "left", 1, 0);
    expect(mockCdp.type).toHaveBeenCalledWith(123, "isaac@example.com");
  });

  it("click.type.submit uses the provided submit key after typing", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();
    chrome.tabs.sendMessage.mockResolvedValue({ success: true });
    await expect(
      handleMessage(
        {
          type: "lens.page.clickTypeSubmit",
          tabId: 123,
          ref: "e1",
          text: "query",
          submitKey: "Tab",
        },
        {},
      ),
    ).resolves.toEqual({ success: true });
    expect(mockCdp.type).toHaveBeenCalledWith(123, "query");
    expect(mockCdp.pressKey).toHaveBeenCalledWith(123, "Tab");
  });

  it("autocomplete.select types, waits, selects an index, and confirms", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();
    chrome.tabs.sendMessage.mockResolvedValue({ success: true });
    const result = handleMessage(
      {
        type: "lens.form.autocompleteSelect",
        tabId: 123,
        ref: "e1",
        text: "query",
        waitMs: 250,
        index: 1,
      },
      {},
    );
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ success: true });
    expect(mockCdp.type).toHaveBeenCalledWith(123, "query");
    expect(mockCdp.pressKey).toHaveBeenNthCalledWith(1, 123, "ArrowDown");
    expect(mockCdp.pressKey).toHaveBeenNthCalledWith(2, 123, "Enter");
  });

  it("locate commands forward their criteria through dispatch", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();
    chrome.tabs.sendMessage.mockResolvedValue({ ref: "e1", text: "Submit" });
    const cases = [
      [
        { type: "locate.role", role: "button", name: "Submit", all: true },
        { type: "locate.role", role: "button", name: "Submit", all: true },
      ],
      [
        { type: "locate.text", text: "Submit", exact: true },
        { type: "locate.text", text: "Submit", exact: true },
      ],
      [
        { type: "locate.label", label: "Email" },
        { type: "locate.label", label: "Email" },
      ],
    ];
    for (const [request, forwarded] of cases) {
      await expect(handleMessage({ ...request, tabId: 123 }, {})).resolves.toMatchObject({
        ref: "e1",
      });
      expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(123, forwarded, { frameId: 0 });
    }
  });

  it("element coordinate and style commands return content-script results", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();
    chrome.tabs.sendMessage.mockResolvedValue({ x: 15, y: 25, color: "red" });
    await expect(
      handleMessage({ type: "lens.element.getCoordinates", tabId: 123, ref: "e1" }, {}),
    ).resolves.toEqual({ x: 15, y: 25, color: "red" });
    expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(
      123,
      { type: "lens.element.getCoordinates", ref: "e1" },
      { frameId: 0 },
    );
    await expect(
      handleMessage({ type: "element.styles", tabId: 123, selector: "button" }, {}),
    ).resolves.toEqual({ x: 15, y: 25, color: "red" });
    expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(
      123,
      { type: "element.styles", selector: "button" },
      { frameId: 0 },
    );
  });

  it("scroll commands dispatch to the page handlers", async () => {
    const { handleMessage, chrome } = await loadHandleMessage();
    chrome.tabs.sendMessage.mockResolvedValue({ success: true, ref: "e1" });
    await expect(handleMessage({ type: "scroll.to", tabId: 123, ref: "e1" }, {})).resolves.toEqual({
      success: true,
      ref: "e1",
    });
    expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(
      123,
      { type: "scroll.to", ref: "e1" },
      { frameId: 0 },
    );
    mockCdp.evaluateScript.mockResolvedValue({ result: { value: { scrollTop: 0, atTop: true } } });
    await expect(
      handleMessage({ type: "lens.scroll.position", tabId: 123, position: "top" }, {}),
    ).resolves.toEqual({ scrollTop: 0, atTop: true });
    expect(mockCdp.evaluateScript).toHaveBeenCalledWith(123, expect.stringContaining('"top"'));
  });
});
