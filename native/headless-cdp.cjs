/**
 * headless-cdp.cjs — WebSocket-based CDP client for headless mode
 *
 * Mirrors the public interface of src/cdp/controller.ts but uses
 * direct WebSocket connection instead of chrome.debugger API.
 * Works with any Chrome/Chromium exposed via --remote-debugging-port.
 */

const { EventEmitter } = require("events");

const MODIFIERS = Object.fromEntries(
  "alt:1 ctrl:2 control:2 meta:4 cmd:4 command:4 win:4 windows:4 shift:8"
    .split(" ").map(pair => {
      const [name, value] = pair.split(":");
      return [name, Number(value)];
    })
);

const KEY_DEFINITIONS = Object.fromEntries(
  `enter|Enter|Enter|13|\r
tab|Tab|Tab|9|
escape|Escape|Escape|27|
backspace|Backspace|Backspace|8|
delete|Delete|Delete|46|
arrowup|ArrowUp|ArrowUp|38|
arrowdown|ArrowDown|ArrowDown|40|
arrowleft|ArrowLeft|ArrowLeft|37|
arrowright|ArrowRight|ArrowRight|39|
home|Home|Home|36|
end|End|End|35|
pageup|PageUp|PageUp|33|
pagedown|PageDown|PageDown|34|
space|SPACE|Space|32|SPACE
${Array.from({ length: 12 }, (_, i) => `f${i + 1}|F${i + 1}|F${i + 1}|${112 + i}|`).join("\n")}`
    .split("\n")
    .map(row => {
      const [name, key, code, keyCode, text] = row.split("|");
      return [name, {
        key: key === "SPACE" ? " " : key,
        code,
        keyCode: Number(keyCode),
        ...(text ? { text: text === "SPACE" ? " " : text } : {}),
      }];
    })
);

// ── Human-Like Input Helpers ──────────────────────────────────────────

/**
 * Cubic bezier curve from (x0,y0) to (x1,y1) with random control point offset.
 * Produces natural-looking mouse movement paths.
 */
function _bezierPoints(x0, y0, x1, y1, steps = 12) {
  const cx = (x0 + x1) / 2 + (Math.random() - 0.5) * 60;
  const cy = (y0 + y1) / 2 + (Math.random() - 0.5) * 60;
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t ** 2 * x1;
    const y = (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t ** 2 * y1;
    points.push({ x: Math.round(x), y: Math.round(y) });
  }
  return points;
}

/** Random delay between min and max ms */
function _humanDelay(min, max) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

/** Click position offset within element bounds (not dead center) */
function _jitterOffset(width, height) {
  return {
    dx: (Math.random() - 0.5) * Math.min(width * 0.3, 10),
    dy: (Math.random() - 0.5) * Math.min(height * 0.3, 6),
  };
}

// ── HeadlessCDP ────────────────────────────────────────────────────────

class HeadlessCDP extends EventEmitter {
  constructor() {
    super();
    this._ws = null;           // WebSocket connection
    this._requestId = 0;       // CDP message counter
    this._pending = new Map(); // id → { resolve, reject }
    this._sessionId = null;    // CDP session ID for page target
    this._connected = false;
    this._consoleMessages = [];
    this._pendingDialog = null;
    this._lastMouseX = 640;    // Track mouse position for bezier paths
    this._lastMouseY = 400;
  }

  // ── Connection ───────────────────────────────────────────────────

  /**
   * Connect to a Chrome DevTools Protocol WebSocket endpoint.
   * @param {string} wsUrl - e.g. "ws://127.0.0.1:9222/devtools/browser/abc123"
   */
  async connect(wsUrl) {
    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(wsUrl);
      this._ws.onopen = () => {
        this._connected = true;
        resolve();
      };
      this._ws.onerror = (err) => {
        reject(new Error(`CDP WebSocket error: ${err.message || "connection failed"}`));
      };
      this._ws.onclose = () => {
        this._connected = false;
        // Reject any pending requests
        for (const [id, { reject: rej }] of this._pending) {
          rej(new Error("CDP connection closed"));
        }
        this._pending.clear();
        this.emit("disconnected");
      };
      this._ws.onmessage = (event) => {
        this._handleMessage(JSON.parse(event.data));
      };
    });
  }

  /**
   * Connect to a specific page target from the browser endpoint.
   * Discovers the first page target and attaches to it.
   */
  async attachToPage() {
    // Get existing targets
    const { targetInfos } = await this.send("Target.getTargets");
    let pageTarget = targetInfos.find(t => t.type === "page" && !t.url.startsWith("chrome://"));

    if (!pageTarget) {
      // Create a new blank page
      const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
      pageTarget = { targetId };
    }

    // Attach to the page target to get a session
    const { sessionId } = await this.send("Target.attachToTarget", {
      targetId: pageTarget.targetId,
      flatten: true,
    });
    this._sessionId = sessionId;

    // Enable core domains
    await this.sendToPage("Page.enable");
    await this.sendToPage("Runtime.enable");

    return pageTarget.targetId;
  }

  /**
   * Create a new page target (tab equivalent).
   * @returns {{ targetId: string, sessionId: string }}
   */
  async createPage(url = "about:blank") {
    const { targetId } = await this.send("Target.createTarget", { url });
    const { sessionId } = await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    return { targetId, sessionId };
  }

  /**
   * Close a page target.
   */
  async closePage(targetId) {
    await this.send("Target.closeTarget", { targetId });
  }

  async disconnect() {
    if (this._ws) {
      this._ws.close();
      this._ws = null;
      this._connected = false;
    }
  }

  // ── Raw CDP messaging ────────────────────────────────────────────

  /**
   * Send a CDP command to the browser target (no session).
   */
  send(method, params = {}) {
    return this._request({ method, params });
  }

  /**
   * Send a CDP command to the attached page session.
   */
  sendToPage(method, params = {}) {
    if (!this._sessionId) return Promise.reject(new Error("No page session attached. Call attachToPage() first."));
    return this._request({ method, params, sessionId: this._sessionId });
  }

  _request(command) {
    if (!this._connected) return Promise.reject(new Error("Not connected to CDP"));
    const id = ++this._requestId;
    const request = { id, ...command };
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      try {
        this._ws.send(JSON.stringify(request));
      } catch (error) {
        this._pending.delete(id);
        reject(error);
      }
    });
  }

  _handleMessage(msg) {
    // Response to a command
    if (msg.id !== undefined) {
      const pending = this._pending.get(msg.id);
      if (pending) {
        this._pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`CDP error: ${msg.error.message} (${msg.error.code})`));
        } else {
          pending.resolve(msg.result ?? {});
        }
      }
      return;
    }

    // CDP event
    if (msg.method) {
      this._handleCDPEvent(msg.method, msg.params || {});
    }
  }

  _handleCDPEvent(method, params) {
    const eventActions = new Map([
      ["Runtime.consoleAPICalled", () => {
        const args = params.args || [];
        const text = args.map(a => a.value !== undefined ? String(a.value) : (a.description || "")).join(" ");
        const frame = params.stackTrace?.callFrames?.[0];
        this._consoleMessages.push({
          type: params.type || "log",
          text,
          timestamp: params.timestamp || Date.now(),
          url: frame?.url,
          line: frame?.lineNumber,
        });
        if (this._consoleMessages.length > 1000) this._consoleMessages.shift();
      }],
      ["Page.javascriptDialogOpening", () => {
        this._pendingDialog = {
          type: params.type,
          message: params.message,
          defaultPrompt: params.defaultPrompt,
          timestamp: Date.now(),
        };
      }],
      ["Page.javascriptDialogClosed", () => { this._pendingDialog = null; }],
      ["Page.frameNavigated", () => this.emit("navigated", params.frame)],
      ["Page.loadEventFired", () => this.emit("load")],
    ]).get(method);
    eventActions?.();

    // Emit all events for external listeners
    this.emit("cdp-event", method, params);
  }

  // ── Navigation ───────────────────────────────────────────────────

  async navigate(url) {
    const result = await this.sendToPage("Page.navigate", { url });
    if (result.errorText) {
      throw new Error(`Navigation failed: ${result.errorText}`);
    }
    // Wait for load
    await this.waitForLoad(10000);
    return result;
  }

  async waitForLoad(timeout = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = await this.evaluateScript("document.readyState");
      if (result.result?.value === "complete" || result.result?.value === "interactive") {
        return;
      }
      await new Promise(r => setTimeout(r, 100));
    }
  }

  async getUrl() {
    const result = await this.evaluateScript("window.location.href");
    return result.result?.value || "";
  }

  async getTitle() {
    const result = await this.evaluateScript("document.title");
    return result.result?.value || "";
  }

  // ── JavaScript Evaluation ────────────────────────────────────────

  async evaluateScript(expression) {
    const options = Object.fromEntries([
      ["expression", expression], ["returnByValue", true], ["awaitPromise", true], ["timeout", 10000],
    ]);
    return this.sendToPage("Runtime.evaluate", options);
  }

  // ── Input: Mouse ─────────────────────────────────────────────────

  async _dispatchMouseEvent(type, x, y, options = {}) {
    const params = Object.fromEntries([
      ["type", type], ["x", Math.round(x)], ["y", Math.round(y)], ["modifiers", options.modifiers || 0],
    ]);

    if (type === "mousePressed" || type === "mouseReleased" || type === "mouseMoved") {
      // Only include button if explicitly provided or for pressed/released events
      if (options.button) {
        params.button = options.button;
      } else if (type !== "mouseMoved") {
        params.button = "left"; // default for pressed/released
      }
      if (type === "mousePressed" || type === "mouseReleased") {
        params.clickCount = options.clickCount || 1;
      }
    }

    if (type !== "mouseWheel") {
      // Only include buttons if explicitly provided (omit for hover/move)
      if (options.buttons !== undefined) {
        params.buttons = options.buttons;
      }
    }

    if (type === "mouseWheel") {
      Object.assign(params, { deltaX: options.deltaX || 0, deltaY: options.deltaY || 0 });
    }

    await this.sendToPage("Input.dispatchMouseEvent", params);
  }

  async click(x, y, button = "left", clickCount = 1, modifiers = 0) {
    const buttonValue = button === "left" ? 1 : button === "right" ? 2 : button === "middle" ? 4 : 0;

    // Bezier curve mouse movement from last position to target
    const path = _bezierPoints(this._lastMouseX, this._lastMouseY, x, y);
    for (const pt of path) {
      await this._dispatchMouseEvent("mouseMoved", pt.x, pt.y, { button: "none", buttons: 0, modifiers });
      await _humanDelay(8, 25);
    }
    this._lastMouseX = x;
    this._lastMouseY = y;

    // Pre-click hover pause
    await _humanDelay(60, 180);

    for (let i = 1; i <= clickCount; i++) {
      await this._dispatchMouseEvent("mousePressed", x, y, {
        button, buttons: buttonValue, clickCount: i, modifiers,
      });
      await _humanDelay(40, 120); // Variable hold duration
      await this._dispatchMouseEvent("mouseReleased", x, y, {
        button, buttons: 0, clickCount: i, modifiers,
      });
      if (i < clickCount) await _humanDelay(80, 150);
    }
  }

  async rightClick(x, y, modifiers = 0) {
    await this.click(x, y, "right", 1, modifiers);
  }

  async doubleClick(x, y, modifiers = 0) {
    await this.click(x, y, "left", 2, modifiers);
  }

  async tripleClick(x, y, modifiers = 0) {
    await this.click(x, y, "left", 3, modifiers);
  }

  async hover(x, y) {
    await this._dispatchMouseEvent("mouseMoved", x, y, {});
  }

  async drag(startX, startY, endX, endY, modifiers = 0) {
    await this._dispatchMouseEvent("mouseMoved", startX, startY, { button: "none", buttons: 0 });
    await new Promise(r => setTimeout(r, 50));
    await this._dispatchMouseEvent("mousePressed", startX, startY, {
      button: "left", buttons: 1, clickCount: 1, modifiers,
    });
    await new Promise(r => setTimeout(r, 50));
    await this._dispatchMouseEvent("mouseMoved", endX, endY, { button: "left", buttons: 1, modifiers });
    await new Promise(r => setTimeout(r, 50));
    await this._dispatchMouseEvent("mouseReleased", endX, endY, {
      button: "left", buttons: 0, clickCount: 1, modifiers,
    });
  }

  async scroll(x, y, deltaX, deltaY) {
    await this._dispatchMouseEvent("mouseWheel", x, y, { deltaX, deltaY });
  }

  // ── Input: Keyboard ──────────────────────────────────────────────

  async type(text) {
    for (const char of text) {
      if (char === "\n" || char === "\r") {
        await this.pressKey("Enter");
      } else if (char === "\t") {
        await this.pressKey("Tab");
      } else if (/^[a-zA-Z0-9]$/.test(char)) {
        const needsShift = /[A-Z]/.test(char);
        await this.pressKey(char, needsShift ? MODIFIERS.shift : 0);
      } else if (KEY_DEFINITIONS[char] || KEY_DEFINITIONS[char.toLowerCase()]) {
        await this.pressKey(char);
      } else {
        // Special characters — insertText is reliable
        await this.sendToPage("Input.insertText", { text: char });
      }
      // Variable inter-key delay: ~60-100 WPM with occasional hesitation
      const pause = Math.random() < 0.08
        ? 300 + Math.random() * 400   // hesitation ~8% of keystrokes
        : 60 + Math.random() * 40;    // normal typing speed
      await _humanDelay(pause * 0.8, pause * 1.2);
    }
  }

  async pressKey(key, modifiers = 0) {
    const keyDef = this._getKeyDefinition(key);
    if (!keyDef) throw new Error(`Unknown key: ${key}`);
    await this._dispatchKeyEvent("keyDown", keyDef, modifiers);
    await this._dispatchKeyEvent("keyUp", keyDef, modifiers);
  }

  async pressKeyChord(chord) {
    const parts = chord.toLowerCase().split("+");
    const modifierKeys = [];
    let mainKey = "";
    for (const part of parts) {
      if (part in MODIFIERS) modifierKeys.push(part);
      else mainKey = part;
    }
    let mods = 0;
    for (const mod of modifierKeys) mods |= MODIFIERS[mod] || 0;
    if (mainKey) await this.pressKey(mainKey, mods);
  }

  async _dispatchKeyEvent(type, keyDef, modifiers = 0) {
    const event = Object.fromEntries([
      ["type", keyDef.text ? type : (type === "keyDown" ? "rawKeyDown" : type)],
      ["key", keyDef.key], ["code", keyDef.code], ["windowsVirtualKeyCode", keyDef.keyCode],
      ["modifiers", modifiers], ["text", keyDef.text ?? ""],
      ["unmodifiedText", keyDef.text ?? ""], ["location", keyDef.location ?? 0],
    ]);
    await this.sendToPage("Input.dispatchKeyEvent", event);
  }

  _getKeyDefinition(key) {
    const lowerKey = key.toLowerCase();
    if (KEY_DEFINITIONS[lowerKey]) return KEY_DEFINITIONS[lowerKey];
    if (key.length === 1) {
      const code = key.toUpperCase().charCodeAt(0);
      return { key, code: `Key${key.toUpperCase()}`, keyCode: code, text: key };
    }
    return null;
  }

  parseModifiers(modifierString) {
    if (!modifierString) return 0;
    let result = 0;
    for (const part of modifierString.toLowerCase().split("+")) {
      const trimmed = part.trim();
      if (trimmed in MODIFIERS) result |= MODIFIERS[trimmed];
    }
    return result;
  }

  // ── Screenshots ──────────────────────────────────────────────────

  async captureScreenshot(options = {}) {
    const params = { format: options.format || "png" };
    if (options.clip) params.clip = { ...options.clip, scale: 1 };
    if (options.fullPage) {
      // Get full page dimensions
      const metrics = await this.sendToPage("Page.getLayoutMetrics");
      params.clip = {
        x: 0, y: 0,
        width: metrics.contentSize.width,
        height: metrics.contentSize.height,
        scale: 1,
      };
    }
    const result = await this.sendToPage("Page.captureScreenshot", params);
    return { base64: result.data };
  }

  // ── Viewport ─────────────────────────────────────────────────────

  async setViewport(width, height, deviceScaleFactor = 1) {
    await this.sendToPage("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor, mobile: false,
    });
  }

  async getViewportSize() {
    const result = await this.evaluateScript(
      "JSON.stringify({ width: window.innerWidth, height: window.innerHeight })"
    );
    return JSON.parse(result.result?.value || '{"width":0,"height":0}');
  }

  // ── Dialogs ──────────────────────────────────────────────────────

  getPendingDialog() {
    return this._pendingDialog;
  }

  async handleDialog(accept, promptText) {
    await this.sendToPage("Page.handleJavaScriptDialog", {
      accept,
      promptText: promptText || undefined,
    });
    this._pendingDialog = null;
  }

  // ── Console ──────────────────────────────────────────────────────

  getConsoleMessages() {
    return [...this._consoleMessages];
  }

  clearConsoleMessages() {
    this._consoleMessages = [];
  }

  // ── File Upload ──────────────────────────────────────────────────

  async setFileInputFiles(selector, files) {
    // Find the node by selector
    const { root } = await this.sendToPage("DOM.getDocument");
    const { nodeId } = await this.sendToPage("DOM.querySelector", {
      nodeId: root.nodeId,
      selector,
    });
    if (!nodeId) throw new Error(`Element not found: ${selector}`);
    await this.sendToPage("DOM.setFileInputFiles", { nodeId, files });
  }

  // ── Script Injection ─────────────────────────────────────────────

  /**
   * Add a script that runs on every new document (survives navigation).
   */
  async addScriptOnNewDocument(source) {
    return this.sendToPage("Page.addScriptToEvaluateOnNewDocument", { source });
  }
}

module.exports = { HeadlessCDP, MODIFIERS, KEY_DEFINITIONS, _bezierPoints, _humanDelay, _jitterOffset };
