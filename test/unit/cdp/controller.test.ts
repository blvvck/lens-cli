import { vi } from "vitest";
import { CDPController } from "../../../src/cdp";
import { createChromeMock } from "../../mocks/chrome";

const chromeApi = createChromeMock();
const send = chromeApi.debugger.sendCommand;
const target = (tabId: number) => ({ tabId });
const dispatched = (method: string) => send.mock.calls.filter(([, command]) => command === method);
const mouseEvents = () => dispatched("Input.dispatchMouseEvent").map(([, , params]) => params);
const keyEvents = () => dispatched("Input.dispatchKeyEvent").map(([, , params]) => params);

vi.stubGlobal("chrome", chromeApi);

describe("CDPController", () => {
  let cdp: CDPController;

  beforeEach(() => {
    vi.clearAllMocks();
    chromeApi.debugger.attach.mockResolvedValue(undefined);
    chromeApi.debugger.detach.mockResolvedValue(undefined);
    send.mockResolvedValue({});
    cdp = new CDPController();
  });

  describe("parseModifiers", () => {
    it("treats an omitted modifier list as no flags", () => {
      expect(cdp.parseModifiers(undefined)).toBe(0);
    });
    it("treats a blank modifier list as no flags", () => {
      expect(cdp.parseModifiers("")).toBe(0);
    });
    it("sets the Shift bit", () => {
      expect(cdp.parseModifiers("shift")).toBe(8);
    });
    it("sets the Control bit", () => {
      expect(cdp.parseModifiers("ctrl")).toBe(2);
    });
    it("sets the Alt bit", () => {
      expect(cdp.parseModifiers("alt")).toBe(1);
    });
    it("sets the Meta bit", () => {
      expect(cdp.parseModifiers("meta")).toBe(4);
    });
    it("merges Control and Shift", () => {
      expect(cdp.parseModifiers("ctrl+shift")).toBe(10);
    });
    it("merges three flags into one bit mask", () => {
      expect(cdp.parseModifiers("alt+shift+ctrl")).toBe(11);
    });
    it("matches modifier names without case sensitivity", () => {
      expect(cdp.parseModifiers("SHIFT+Ctrl+control")).toBe(10);
      expect(cdp.parseModifiers("control")).toBe(2);
    });
    it("accepts common names for the Meta key", () => {
      expect(["cmd", "command", "win", "windows"].map((key) => cdp.parseModifiers(key))).toEqual([
        4, 4, 4, 4,
      ]);
    });
    it("maps an unknown name to zero", () => {
      expect(cdp.parseModifiers("unknown")).toBe(0);
    });
    it("keeps recognized flags beside unknown names", () => {
      expect(cdp.parseModifiers("ctrl+unknown")).toBe(2);
    });
  });

  describe("getConsoleMessages", () => {
    it("starts with no collected messages", () => {
      expect(cdp.getConsoleMessages(123)).toEqual([]);
    });
    it("returns an empty collection after clearing an unknown tab", () => {
      cdp.clearConsoleMessages(123);
      expect(cdp.getConsoleMessages(123)).toEqual([]);
    });
  });

  describe("getNetworkRequests", () => {
    it("starts with no requests for the requested tab", () => {
      expect(cdp.getNetworkRequests(456)).toEqual([]);
    });
    it("remains empty when clearing a tab without requests", () => {
      cdp.clearNetworkRequests(456);
      expect(cdp.getNetworkRequests(456)).toEqual([]);
    });
  });

  describe("getDialogInfo", () => {
    it("has no pending dialog for a new tab", () => {
      expect(cdp.getDialogInfo(789)).toBeNull();
    });
  });

  describe("attach", () => {
    it("connects using the supported debugger protocol version", async () => {
      await cdp.attach(100);
      expect(chromeApi.debugger.attach).toHaveBeenCalledWith(target(100), "1.3");
    });
    it("enables Page once a debugger target is attached", async () => {
      await cdp.attach(100);
      expect(send).toHaveBeenCalledWith(target(100), "Page.enable", undefined);
    });
    it("leaves an existing target attached after a repeated request", async () => {
      await cdp.attach(100);
      await cdp.attach(100);
      expect(chromeApi.debugger.attach).toHaveBeenCalledTimes(1);
    });
    it("explains Chrome restricted-page failures", async () => {
      chromeApi.debugger.attach.mockRejectedValueOnce(new Error("Cannot access a chrome:// URL"));
      await expect(cdp.attach(100)).rejects.toThrow("Cannot control this page");
    });
    it("includes the underlying reason for other connection failures", async () => {
      chromeApi.debugger.attach.mockRejectedValueOnce(new Error("Some other error"));
      await expect(cdp.attach(100)).rejects.toThrow("Failed to attach debugger: Some other error");
    });
  });

  describe("detach", () => {
    it("disconnects a target that was attached", async () => {
      await cdp.attach(200);
      await cdp.detach(200);
      expect(chromeApi.debugger.detach).toHaveBeenCalledWith(target(200));
    });
    it("does not call Chrome for a target it does not own", async () => {
      await cdp.detach(200);
      expect(chromeApi.debugger.detach).not.toHaveBeenCalled();
    });
    it("discards tab-scoped console and request data", async () => {
      await cdp.attach(200);
      await cdp.detach(200);
      expect(cdp.getConsoleMessages(200)).toEqual([]);
      expect(cdp.getNetworkRequests(200)).toEqual([]);
    });
  });

  describe("detachAll", () => {
    it("disconnects every currently attached tab", async () => {
      for (const id of [301, 302, 303]) {
        await cdp.attach(id);
      }
      await cdp.detachAll();
      expect(chromeApi.debugger.detach).toHaveBeenCalledTimes(3);
    });
  });

  describe("emulateNetwork", () => {
    it("reports an unsupported connection profile", async () => {
      const outcome = await cdp.emulateNetwork(400, "unknown-preset");
      expect(outcome.success).toBe(false);
      expect(outcome.error).toContain("Unknown preset");
    });
    it.each([
      ["offline", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }],
      [
        "slow-3g",
        { offline: false, latency: 2000, downloadThroughput: 50000, uploadThroughput: 50000 },
      ],
      ["reset", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }],
    ])("sends the %s connection profile to CDP", async (profile, conditions) => {
      const outcome = await cdp.emulateNetwork(400, profile);
      expect(outcome.success).toBe(true);
      expect(send).toHaveBeenCalledWith(
        target(400),
        "Network.emulateNetworkConditions",
        conditions,
      );
    });
  });

  describe("emulateCPU", () => {
    it("rejects a throttling multiplier below one", async () => {
      const outcome = await cdp.emulateCPU(500, 0.5);
      expect(outcome.success).toBe(false);
      expect(outcome.error).toContain("rate must be >= 1");
    });
    it("passes a valid CPU multiplier through", async () => {
      const outcome = await cdp.emulateCPU(500, 4);
      expect(outcome.success).toBe(true);
      expect(send).toHaveBeenCalledWith(target(500), "Emulation.setCPUThrottlingRate", { rate: 4 });
    });
  });

  describe("emulateGeolocation", () => {
    it("uses the default location accuracy", async () => {
      const outcome = await cdp.emulateGeolocation(600, 37.7749, -122.4194);
      expect(outcome.success).toBe(true);
      expect(send).toHaveBeenCalledWith(target(600), "Emulation.setGeolocationOverride", {
        latitude: 37.7749,
        longitude: -122.4194,
        accuracy: 100,
      });
    });
    it("honors a caller supplied accuracy", async () => {
      const outcome = await cdp.emulateGeolocation(600, 51.5074, -0.1278, 50);
      expect(outcome.success).toBe(true);
      expect(send).toHaveBeenCalledWith(target(600), "Emulation.setGeolocationOverride", {
        latitude: 51.5074,
        longitude: -0.1278,
        accuracy: 50,
      });
    });
  });

  describe("clearGeolocation", () => {
    it("removes the geolocation override", async () => {
      const outcome = await cdp.clearGeolocation(700);
      expect(outcome.success).toBe(true);
      expect(send).toHaveBeenCalledWith(
        target(700),
        "Emulation.clearGeolocationOverride",
        undefined,
      );
    });
  });

  describe("getViewportSize", () => {
    it("prefers visual viewport dimensions", async () => {
      send.mockResolvedValue({ visualViewport: { clientWidth: 1280, clientHeight: 720 } });
      expect(await cdp.getViewportSize(800)).toEqual({ width: 1280, height: 720 });
    });
    it("uses layout viewport dimensions when visual metrics are absent", async () => {
      send.mockResolvedValue({ layoutViewport: { clientWidth: 1024, clientHeight: 768 } });
      expect(await cdp.getViewportSize(800)).toEqual({ width: 1024, height: 768 });
    });
    it("rounds fractional measurements to whole pixels", async () => {
      send.mockResolvedValue({ visualViewport: { clientWidth: 1280.5, clientHeight: 720.7 } });
      expect(await cdp.getViewportSize(800)).toEqual({ width: 1281, height: 721 });
    });
  });

  describe("captureScreenshot", () => {
    const prepareScreenshot = (image: string, width: number, height: number) => {
      send.mockResolvedValueOnce({});
      send.mockResolvedValueOnce({ data: image });
      send.mockResolvedValueOnce({ visualViewport: { clientWidth: width, clientHeight: height } });
    };
    it("returns the encoded image and measured viewport", async () => {
      prepareScreenshot("base64imagedata", 1920, 1080);
      expect(await cdp.captureScreenshot(900)).toMatchObject({
        base64: "base64imagedata",
        width: 1920,
        height: 1080,
      });
    });
    it("requests a PNG image bounded to the viewport", async () => {
      prepareScreenshot("base64", 800, 600);
      await cdp.captureScreenshot(900);
      expect(send).toHaveBeenCalledWith(target(900), "Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
    });
  });

  describe("captureRegion", () => {
    it("returns the requested clip with matching dimensions", async () => {
      send.mockResolvedValueOnce({});
      send.mockResolvedValueOnce({ data: "regiondata" });
      const result = await cdp.captureRegion(1000, 100, 200, 300, 400);
      expect(result).toMatchObject({ base64: "regiondata", width: 300, height: 400 });
      expect(send).toHaveBeenCalledWith(target(1000), "Page.captureScreenshot", {
        format: "png",
        clip: { x: 100, y: 200, width: 300, height: 400, scale: 1 },
      });
    });
  });

  describe("hover", () => {
    it("moves the pointer to the requested point without a pressed button", async () => {
      await cdp.hover(1100, 150, 250);
      expect(mouseEvents()).toContainEqual(
        expect.objectContaining({
          type: "mouseMoved",
          x: 150,
          y: 250,
          button: "none",
        }),
      );
    });
  });

  describe("scroll", () => {
    it("emits a wheel event with the requested position and deltas", async () => {
      await cdp.scroll(1200, 100, 200, 0, 300);
      expect(mouseEvents()).toContainEqual(
        expect.objectContaining({
          type: "mouseWheel",
          x: 100,
          y: 200,
          deltaX: 0,
          deltaY: 300,
        }),
      );
    });
  });

  describe("evaluateScript", () => {
    it("returns a by-value evaluation and awaits promises", async () => {
      send.mockResolvedValueOnce({});
      send.mockResolvedValueOnce({});
      send.mockResolvedValueOnce({ result: { value: 42, type: "number" } });
      const result = await cdp.evaluateScript(1300, "21 + 21");
      expect(result.result?.value).toBe(42);
      expect(send).toHaveBeenCalledWith(
        target(1300),
        "Runtime.evaluate",
        expect.objectContaining({
          expression: "21 + 21",
          returnByValue: true,
          awaitPromise: true,
        }),
      );
    });
    it("preserves exception information from the runtime", async () => {
      send.mockResolvedValueOnce({});
      send.mockResolvedValueOnce({});
      send.mockResolvedValueOnce({
        exceptionDetails: { text: "ReferenceError: x is not defined" },
      });
      expect((await cdp.evaluateScript(1300, "x")).exceptionDetails?.text).toBe(
        "ReferenceError: x is not defined",
      );
    });
  });

  describe("sendCommand", () => {
    it("forwards arbitrary method arguments and returns CDP output", async () => {
      send.mockResolvedValue({ result: "test" });
      const result = await cdp.sendCommand(1400, "DOM.getDocument", { depth: 1 });
      expect(result).toEqual({ result: "test" });
      expect(send).toHaveBeenCalledWith(target(1400), "DOM.getDocument", { depth: 1 });
    });
  });

  describe("click", () => {
    it("moves to the target, then presses and releases the primary button", async () => {
      await cdp.click(1500, 100, 200);
      const events = mouseEvents();
      const moves = events.filter((event) => event.type === "mouseMoved");
      expect(events.length).toBeGreaterThanOrEqual(3);
      expect(moves.length).toBeGreaterThan(0);
      expect(moves.at(-1)).toMatchObject({ x: 100, y: 200 });
      expect(events.find((event) => event.type === "mousePressed")).toMatchObject({
        button: "left",
      });
      expect(events.find((event) => event.type === "mouseReleased")).toBeDefined();
    });
    it("uses the selected button for the press", async () => {
      await cdp.click(1500, 50, 50, "right");
      expect(mouseEvents().find((event) => event.type === "mousePressed")?.button).toBe("right");
    });
  });

  describe("rightClick", () => {
    it("presses with the secondary mouse button", async () => {
      await cdp.rightClick(1600, 100, 200);
      expect(mouseEvents().find((event) => event.type === "mousePressed")?.button).toBe("right");
    });
  });

  describe("doubleClick", () => {
    it("sends two press events and marks the second click", async () => {
      await cdp.doubleClick(1700, 100, 200);
      const presses = mouseEvents().filter((event) => event.type === "mousePressed");
      expect(presses).toHaveLength(2);
      expect(presses[1]?.clickCount).toBe(2);
    });
  });

  describe("pressKey", () => {
    it("pairs Enter keydown and keyup with the proper key identity", async () => {
      await cdp.pressKey(1800, "Enter");
      const events = keyEvents();
      expect(events).toHaveLength(2);
      expect(events.find((event) => event.type === "keyDown")).toMatchObject({
        key: "Enter",
        code: "Enter",
      });
      expect(events.find((event) => event.type === "keyUp")?.key).toBe("Enter");
    });
    it("derives a physical code and text for a typed letter", async () => {
      await cdp.pressKey(1800, "a");
      expect(keyEvents().find((event) => event.type === "keyDown")).toMatchObject({
        key: "a",
        code: "KeyA",
        text: "a",
      });
    });
    it("rejects a key absent from the supported key map", async () => {
      await expect(cdp.pressKey(1800, "UnknownSpecialKey")).rejects.toThrow("Unknown key");
    });
  });

  describe("pressKeyChord", () => {
    it("applies the Control modifier to a single key", async () => {
      await cdp.pressKeyChord(1900, "ctrl+a");
      expect(keyEvents().find((event) => event.type === "keyDown")).toMatchObject({
        key: "a",
        modifiers: 2,
      });
    });
    it("combines the Control and Shift modifier bits", async () => {
      await cdp.pressKeyChord(1900, "ctrl+shift+a");
      expect(keyEvents().find((event) => event.type === "keyDown")?.modifiers).toBe(10);
    });
  });

  describe("drag", () => {
    it("presses at the origin and releases at the destination", async () => {
      await cdp.drag(2000, 100, 100, 200, 200);
      const events = mouseEvents();
      expect(events.length).toBeGreaterThanOrEqual(4);
      expect(events.find((event) => event.type === "mousePressed")).toMatchObject({
        x: 100,
        y: 100,
      });
      expect(events.find((event) => event.type === "mouseReleased")).toMatchObject({
        x: 200,
        y: 200,
      });
    });
  });

  describe("subscribeToConsole", () => {
    it("stores a console stream callback without invoking it", () => {
      const listener = vi.fn();
      cdp.subscribeToConsole(2100, 1, listener);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("unsubscribeFromConsole", () => {
    it("removes a previously registered callback safely", () => {
      const listener = vi.fn();
      cdp.subscribeToConsole(2200, 1, listener);
      expect(() => cdp.unsubscribeFromConsole(2200, 1)).not.toThrow();
    });
    it("accepts an unknown stream id", () => {
      expect(() => cdp.unsubscribeFromConsole(2200, 999)).not.toThrow();
    });
  });

  describe("subscribeToNetwork", () => {
    it("stores a network stream callback without invoking it", () => {
      const listener = vi.fn();
      cdp.subscribeToNetwork(2300, 1, listener);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("unsubscribeFromNetwork", () => {
    it("removes a registered network callback", () => {
      const listener = vi.fn();
      cdp.subscribeToNetwork(2400, 1, listener);
      expect(() => cdp.unsubscribeFromNetwork(2400, 1)).not.toThrow();
    });
  });

  describe("enableConsoleTracking", () => {
    it("enables Runtime event delivery for the tab", async () => {
      await cdp.enableConsoleTracking(2500);
      expect(send).toHaveBeenCalledWith(target(2500), "Runtime.enable", undefined);
    });
  });

  describe("enableNetworkTracking", () => {
    it("enables Network with enough room for posted request data", async () => {
      await cdp.enableNetworkTracking(2600);
      expect(send).toHaveBeenCalledWith(target(2600), "Network.enable", { maxPostDataSize: 65536 });
    });
  });

  describe("handleDialog", () => {
    beforeEach(async () => {
      await cdp.attach(2700);
    });
    it("accepts a JavaScript dialog", async () => {
      const outcome = await cdp.handleDialog(2700, true);
      expect(outcome.success).toBe(true);
      expect(send).toHaveBeenCalledWith(target(2700), "Page.handleJavaScriptDialog", {
        accept: true,
        promptText: undefined,
      });
    });
    it("dismisses a JavaScript dialog", async () => {
      const outcome = await cdp.handleDialog(2700, false);
      expect(outcome.success).toBe(true);
      expect(send).toHaveBeenCalledWith(target(2700), "Page.handleJavaScriptDialog", {
        accept: false,
        promptText: undefined,
      });
    });
    it("sends text when accepting a prompt", async () => {
      const outcome = await cdp.handleDialog(2700, true, "user input");
      expect(outcome.success).toBe(true);
      expect(send).toHaveBeenCalledWith(target(2700), "Page.handleJavaScriptDialog", {
        accept: true,
        promptText: "user input",
      });
    });
    it("returns a failure result when CDP cannot handle the dialog", async () => {
      send.mockRejectedValueOnce(new Error("No dialog"));
      const outcome = await cdp.handleDialog(2700, true);
      expect(outcome.success).toBe(false);
      expect(outcome.error).toContain("No dialog");
    });
  });

  describe("getNetworkEntries", () => {
    it("returns no entries for a tab without captured traffic", () => {
      expect(cdp.getNetworkEntries(2800)).toEqual([]);
    });
  });

  describe("waitForLoad", () => {
    it("reports the complete document state", async () => {
      send.mockResolvedValueOnce({});
      send.mockResolvedValueOnce({ result: { value: "complete" } });
      const outcome = await cdp.waitForLoad(2900, 1000);
      expect(outcome.success).toBe(true);
      expect(outcome.readyState).toBe("complete");
      expect(send).toHaveBeenCalledWith(target(2900), "Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });
    });
    it("returns a timeout result while the document remains loading", async () => {
      send.mockResolvedValueOnce({});
      send.mockResolvedValue({ result: { value: "loading" } });
      const outcome = await cdp.waitForLoad(2900, 200);
      expect(outcome.success).toBe(false);
      expect(outcome.error).toContain("Timeout");
    });
  });

  describe("getFrames", () => {
    it("flattens the main frame and child frame relationship", async () => {
      send.mockResolvedValueOnce({});
      send.mockResolvedValueOnce({});
      send.mockResolvedValueOnce({
        frameTree: {
          frame: { id: "main", url: "https://example.com", name: "" },
          childFrames: [
            { frame: { id: "iframe1", url: "https://example.com/iframe", name: "myframe" } },
          ],
        },
      });
      const outcome = await cdp.getFrames(3000);
      expect(outcome.success).toBe(true);
      expect(outcome.frames).toHaveLength(2);
      expect(outcome.frames?.map(({ frameId }) => frameId)).toEqual(["main", "iframe1"]);
      expect(outcome.frames?.[1].parentId).toBe("main");
    });
  });

  describe("getPerformanceMetrics", () => {
    it("maps returned metric names to their numeric values", async () => {
      send.mockResolvedValueOnce({});
      send.mockResolvedValueOnce({});
      send.mockResolvedValueOnce({
        metrics: [
          { name: "Timestamp", value: 1234.5 },
          { name: "Documents", value: 3 },
        ],
      });
      send.mockResolvedValueOnce({});
      const outcome = await cdp.getPerformanceMetrics(3100);
      expect(outcome.success).toBe(true);
      expect(outcome.metrics).toMatchObject({ Timestamp: 1234.5, Documents: 3 });
    });
  });

  describe("tripleClick", () => {
    it("marks the third press as click number three", async () => {
      await cdp.tripleClick(3200, 100, 200);
      const presses = mouseEvents().filter((event) => event.type === "mousePressed");
      expect(presses).toHaveLength(3);
      expect(presses[2]?.clickCount).toBe(3);
    });
  });

  describe("type", () => {
    it("emits one down/up pair per ordinary character", async () => {
      await cdp.type(3300, "ab");
      const events = keyEvents();
      expect(events).toHaveLength(4);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "a", type: "keyDown" }),
          expect.objectContaining({ key: "b", type: "keyDown" }),
        ]),
      );
    });
    it("converts a newline into the Enter key", async () => {
      await cdp.type(3300, "a\nb");
      expect(keyEvents()).toContainEqual(
        expect.objectContaining({ key: "Enter", type: "keyDown" }),
      );
    });
  });

  describe("getResponseBody", () => {
    it("returns the response payload and encoding flag", async () => {
      send.mockResolvedValueOnce({});
      send.mockResolvedValueOnce({ body: '{"key":"value"}', base64Encoded: false });
      const outcome = await cdp.getResponseBody(3400, "req-123");
      expect(outcome).toMatchObject({
        success: true,
        body: '{"key":"value"}',
        base64Encoded: false,
      });
    });
    it("reports when Chrome no longer has the requested body", async () => {
      send.mockResolvedValueOnce({});
      send.mockRejectedValueOnce(new Error("No resource with given identifier"));
      const outcome = await cdp.getResponseBody(3400, "req-invalid");
      expect(outcome.success).toBe(false);
      expect(outcome.error).toContain("No resource");
    });
  });

  describe("getNetworkEntry", () => {
    it("returns null for an id absent from the tab cache", () => {
      expect(cdp.getNetworkEntry(3500, "nonexistent")).toBeNull();
    });
  });

  describe("evaluateInFrame", () => {
    it("creates an isolated world and evaluates within its context", async () => {
      send.mockResolvedValueOnce({});
      send.mockResolvedValueOnce({ executionContextId: 123 });
      send.mockResolvedValueOnce({ result: { value: '"test result"' } });
      const outcome = await cdp.evaluateInFrame(3600, "frame-1", "return 'test'");
      expect(outcome.success).toBe(true);
      expect(send).toHaveBeenCalledWith(target(3600), "Page.createIsolatedWorld", {
        frameId: "frame-1",
        worldName: "lens-isolated",
      });
      expect(send).toHaveBeenCalledWith(
        target(3600),
        "Runtime.evaluate",
        expect.objectContaining({
          contextId: 123,
          returnByValue: true,
          awaitPromise: true,
        }),
      );
    });
    it("surfaces syntax failure details from the frame runtime", async () => {
      send.mockResolvedValueOnce({});
      send.mockResolvedValueOnce({ executionContextId: 123 });
      send.mockResolvedValueOnce({ exceptionDetails: { text: "SyntaxError" } });
      const outcome = await cdp.evaluateInFrame(3600, "frame-1", "invalid{{{");
      expect(outcome.success).toBe(false);
      expect(outcome.error).toContain("SyntaxError");
    });
  });

  describe("setFileInputBySelector", () => {
    it("looks up a DOM node and assigns the requested file path", async () => {
      send.mockResolvedValueOnce({});
      send.mockResolvedValueOnce({});
      send.mockResolvedValueOnce({ root: { nodeId: 1 } });
      send.mockResolvedValueOnce({ nodeId: 42 });
      send.mockResolvedValueOnce({});
      const outcome = await cdp.setFileInputBySelector(3700, "#upload", ["/path/to/file"]);
      expect(outcome.success).toBe(true);
      expect(send).toHaveBeenCalledWith(target(3700), "DOM.setFileInputFiles", {
        nodeId: 42,
        files: ["/path/to/file"],
      });
    });
    it("returns a useful failure when the selector has no matching node", async () => {
      send.mockResolvedValueOnce({});
      send.mockResolvedValueOnce({});
      send.mockResolvedValueOnce({ root: { nodeId: 1 } });
      send.mockResolvedValueOnce({ nodeId: 0 });
      const outcome = await cdp.setFileInputBySelector(3700, "#missing", ["/file"]);
      expect(outcome.success).toBe(false);
      expect(outcome.error).toContain("Could not find element");
    });
  });
});
