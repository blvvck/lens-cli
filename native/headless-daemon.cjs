#!/usr/bin/env node
/**
 * headless-daemon.cjs — Headless browser daemon for Lens CLI
 *
 * Launches headless Chromium,
 * listens on the Lens headless IPC endpoint, and routes commands through
 * headless-commands.cjs instead of the Chrome extension.
 *
 * Usage:
 *   node headless-daemon.cjs [--port PORT] [--viewport WIDTHxHEIGHT]
 *
 * The daemon speaks the same socket protocol as host/index.cjs so the CLI
 * can talk to it with identical tool_request messages.
 */

const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { HeadlessCDP } = require("./headless-cdp.cjs");
const { HeadlessAccessibility } = require("./headless-accessibility.cjs");
const { handleHeadlessCommand } = require("./headless-commands.cjs");
const { mapToolToMessage, formatToolContent } = require("./routing/index.cjs");
const { loadConfig } = require("./config/index.cjs");
const { FetchInterceptor } = require("./fetch-interceptor.cjs");
const {
  AUTO_INSPECT_DELAY_MS,
  formatAutoInspectContent,
} = require("./runtime/auto-inspect-policy.cjs");
const {
  cleanupEndpoint,
  ensureRuntimeDir,
  findChromiumBinary,
  getHeadlessEndpoint,
  getHeadlessLogPath,
  getHeadlessPidPath,
  isWindows,
} = require("./runtime-paths.cjs");

// ── Constants ────────────────────────────────────────────────────────

const SOCKET_PATH = getHeadlessEndpoint();
const PID_FILE = getHeadlessPidPath();
const LOG_FILE = getHeadlessLogPath();
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

ensureRuntimeDir();

// ── Logging ──────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

// ── Chromium Discovery ───────────────────────────────────────────────

function findChromium() {
  const config = loadConfig();
  return findChromiumBinary({
    configPath: config.headless?.chromiumPath || null,
  });
}

// ── Stealth ─────────────────────────────────────────────────────────

// Rotate through real browser UAs (updated 2025-2026 versions)
const REAL_USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
];

function getRandomUA() {
  return REAL_USER_AGENTS[Math.floor(Math.random() * REAL_USER_AGENTS.length)];
}

// ── Launch Headless Chromium ─────────────────────────────────────────

function launchChromium(chromiumPath, viewport) {
  return new Promise((resolve, reject) => {
    const userDataDir = path.join(os.tmpdir(), `lens-headless-profile-${process.pid}`);
    const userAgent = getRandomUA();

    const args = [
      "--headless=new",
      "--remote-debugging-port=0",  // OS picks a free port
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-translate",
      "--metrics-recording-only",
      "--mute-audio",
      // Stealth: hide automation signals
      "--disable-blink-features=AutomationControlled",
      `--user-agent=${userAgent}`,
      `--lang=en-US`,
      `--window-size=${viewport.width},${viewport.height}`,
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ];

    log(`Launching: ${chromiumPath} ${args.join(" ")}`);
    const child = spawn(chromiumPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    let wsUrl = null;
    let stderrBuf = "";
    const timeout = setTimeout(() => {
      if (!wsUrl) {
        child.kill("SIGTERM");
        reject(new Error("Chromium launch timed out (10s). stderr:\n" + stderrBuf));
      }
    }, 10000);

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      // Parse: DevTools listening on ws://127.0.0.1:PORT/devtools/browser/UUID
      const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match && !wsUrl) {
        wsUrl = match[1];
        clearTimeout(timeout);
        log(`Chromium ready: ${wsUrl}`);
        resolve({ child, wsUrl, userDataDir });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to launch Chromium: ${err.message}`));
    });

    child.on("exit", (code) => {
      if (!wsUrl) {
        clearTimeout(timeout);
        reject(new Error(`Chromium exited early (code ${code}). stderr:\n${stderrBuf}`));
      }
    });
  });
}

// ── Stealth Patches ─────────────────────────────────────────────────

async function injectStealth(cdp) {
  // Inject before every new document loads
  await cdp.sendToPage("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      // 1. Remove navigator.webdriver flag (delete from prototype so 'webdriver' in navigator is false)
      delete Object.getPrototypeOf(navigator).webdriver;

      // 2. Fix navigator.languages (headless Chrome returns empty)
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

      // 3. Fix navigator.plugins (headless has 0, real Chrome has 3+)
      // Keep original PluginArray type so instanceof checks pass
      if (navigator.plugins.length === 0) {
        Object.defineProperty(navigator, 'plugins', {
          get: () => {
            const arr = [
              { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
              { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
              { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 1 },
            ];
            arr.item = (i) => arr[i];
            arr.namedItem = (name) => arr.find(p => p.name === name);
            arr.refresh = () => {};
            Object.setPrototypeOf(arr, PluginArray.prototype);
            return arr;
          }
        });
      }

      // 4. Fix navigator.permissions.query for notifications
      const origQuery = window.Permissions?.prototype?.query;
      if (origQuery) {
        window.Permissions.prototype.query = function(params) {
          if (params.name === 'notifications') {
            return Promise.resolve({ state: Notification.permission });
          }
          return origQuery.call(this, params);
        };
      }

      // 5. Fix chrome.runtime to look like a real browser (not headless)
      if (!window.chrome) window.chrome = {};
      if (!window.chrome.runtime) window.chrome.runtime = { connect: () => {}, sendMessage: () => {} };

      // 6. Prevent iframe contentWindow detection
      const origGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
      Object.getOwnPropertyDescriptor = function(obj, prop) {
        if (prop === 'contentWindow' && obj?.tagName === 'IFRAME') return undefined;
        return origGetOwnPropertyDescriptor.call(this, obj, prop);
      };

      // 7. Fix WebGL vendor/renderer (headless returns generic values)
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(param) {
        if (param === 37445) return 'Google Inc. (Intel)';       // UNMASKED_VENDOR_WEBGL
        if (param === 37446) return 'ANGLE (Intel, Mesa Intel(R) UHD Graphics, OpenGL 4.6)'; // UNMASKED_RENDERER_WEBGL
        return getParameter.call(this, param);
      };
    `,
  });

  // Set timezone and locale via CDP
  await cdp.sendToPage("Emulation.setTimezoneOverride", { timezoneId: "America/New_York" });
  await cdp.sendToPage("Emulation.setLocaleOverride", { locale: "en-US" });

  // Set extra HTTP headers that real browsers send
  await cdp.sendToPage("Network.enable");
  await cdp.sendToPage("Network.setExtraHTTPHeaders", {
    headers: {
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
      "DNT": "1",
    },
  });
}

async function runAutoInspect(cdp, accessibility) {
  try {
    await new Promise(r => setTimeout(r, AUTO_INSPECT_DELAY_MS)); // Post-action settle
    const tree = await accessibility.getTree({
      filter: "interactive",
      includeText: true,
    });
    return formatAutoInspectContent(tree);
  } catch (e) {
    log(`Auto-inspect error: ${e.message}`);
    return null;
  }
}

// ── Tool Request Handler ─────────────────────────────────────────────

async function handleToolRequest(msg, socket, cdp, accessibility, fetchInterceptor) {
  const { method, params } = msg;
  const originalId = msg.id || null;

  if (method !== "execute_tool") {
    sendResponse(socket, originalId, null, `Unknown method: ${method}`);
    return;
  }

  const { tool, args } = params || {};
  if (!tool) {
    sendResponse(socket, originalId, null, "No tool specified");
    return;
  }

  // Map tool name to extension message format
  const extensionMsg = mapToolToMessage(tool, args, 1); // Virtual tabId = 1
  if (!extensionMsg) {
    sendResponse(socket, originalId, null, `Unknown tool: ${tool}`);
    return;
  }

  if (extensionMsg.type === "lens.unsupported.unsupportedAction") {
    sendResponse(socket, originalId, null, extensionMsg.message);
    return;
  }

  if (extensionMsg.type === "wait") {
    setTimeout(() => {
      sendResponse(socket, originalId, { success: true }, null);
    }, extensionMsg.seconds * 1000);
    return;
  }

  // Commands not supported in headless (extension-only features)
  const unsupported = [
    "lens.tabs.getAll", "upload.image", "extension.reload",
    "page.layout", "lens.window.resize",
  ];
  if (unsupported.includes(extensionMsg.type)) {
    sendResponse(socket, originalId, null,
      `"${tool}" is not supported in headless mode. Use the real browser for this.`);
    return;
  }

  // Check auto-inspect flag
  const autoInspect = args?.autoInspect === true;

  try {
    const result = await handleHeadlessCommand(extensionMsg, cdp, accessibility, fetchInterceptor);

    // Screenshot save-to-file handling
    if (result.base64 && (args?.savePath || args?.output)) {
      const savePath = args.savePath || args.output;
      const dir = path.dirname(savePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(savePath, Buffer.from(result.base64, "base64"));
      sendResponse(socket, originalId, {
        message: `Saved to ${savePath}`,
        path: savePath,
      }, null);
      return;
    }

    // Auto-inspect after action
    if (autoInspect && !result.error && !result.base64) {
      const tree = await runAutoInspect(cdp, accessibility);
      if (tree) {
        sendResponse(socket, originalId, { ...result, autoInspect: tree }, null);
        return;
      }
    }

    // Normal response
    if (result.error && !result.success && !result.pageContent && !result.text) {
      sendResponse(socket, originalId, null, result.error);
    } else {
      sendResponse(socket, originalId, result, null);
    }
  } catch (e) {
    log(`Command error (${extensionMsg.type}): ${e.message}`);
    sendResponse(socket, originalId, null, e.message);
  }
}

// ── Socket Protocol ──────────────────────────────────────────────────

function sendResponse(socket, id, result, error) {
  const response = { type: "lens.socket.toolResponse", id };
  if (error) {
    response.error = { content: [{ type: "text", text: error }] };
  } else {
    response.result = { content: formatToolContent(result, log) };
  }
  try {
    socket.write(JSON.stringify(response) + "\n");
  } catch (e) {
    log(`Error sending response: ${e.message}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const portIdx = args.indexOf("--port");
  const viewportIdx = args.indexOf("--viewport");

  // Parse viewport
  let viewport = { ...DEFAULT_VIEWPORT };
  if (viewportIdx !== -1 && args[viewportIdx + 1]) {
    const [w, h] = args[viewportIdx + 1].split("x").map(Number);
    if (w && h) viewport = { width: w, height: h };
  }

  // Check config for viewport override
  const config = loadConfig();
  if (!viewportIdx && config.headless?.viewport) {
    const cv = config.headless.viewport;
    if (cv.width && cv.height) viewport = { width: cv.width, height: cv.height };
  }

  log("=== Lens Headless Daemon Starting ===");
  log(`Viewport: ${viewport.width}x${viewport.height}`);

  let cdp;
  let chromiumChild = null;
  let userDataDir = null;

  const chromiumPath = findChromium();
  if (!chromiumPath) {
    console.error(
      "No Chromium/Chrome found. Set CHROMIUM_PATH or CHROME_PATH, " +
      "or install Chrome/Chromium."
    );
    process.exit(1);
  }

  log(`Using: ${chromiumPath}`);
  const launch = await launchChromium(chromiumPath, viewport);
  chromiumChild = launch.child;
  userDataDir = launch.userDataDir;

  cdp = new HeadlessCDP();
  await cdp.connect(launch.wsUrl);
  log("CDP connected");

  // Attach to page target
  await cdp.attachToPage();
  log("Attached to page target");

  // Set viewport
  await cdp.setViewport(viewport.width, viewport.height);

  // Inject accessibility tree
  const accessibility = new HeadlessAccessibility(cdp);
  await accessibility.inject();
  log("Accessibility tree injected");

  // Inject stealth patches (before any navigation)
  await injectStealth(cdp);
  log("Stealth patches injected");

  // ── Fetch Interceptor (serve + intercept) ──────────────────────────

  const fetchInterceptor = new FetchInterceptor();
  cdp.on("cdp-event", (method, params) => {
    if (method === "Fetch.requestPaused") {
      const sendFn = (m, p) => cdp.sendToPage(m, p);
      fetchInterceptor.handleRequestPaused(params, sendFn).catch(e => {
        log(`Fetch.requestPaused error: ${e.message}`);
      });
    }
  });
  log("Fetch interceptor ready");

  // ── Socket Server ────────────────────────────────────────────────

  // Clean up stale socket
  cleanupEndpoint(SOCKET_PATH);

  const server = net.createServer((socket) => {
    log("CLI client connected");

    let dataBuffer = "";

    socket.on("data", (data) => {
      dataBuffer += data.toString();
      const lines = dataBuffer.split("\n");
      dataBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);

          if (msg.type === "lens.socket.toolRequest") {
            log(`Tool request: ${msg.method} ${msg.params?.tool || ""}`);
            handleToolRequest(msg, socket, cdp, accessibility, fetchInterceptor).catch((e) => {
              log(`Unhandled error: ${e.message}`);
              sendResponse(socket, msg.id, null, e.message);
            });
            continue;
          }

          if (msg.type === "ping") {
            socket.write(JSON.stringify({ type: "pong", pid: process.pid }) + "\n");
            continue;
          }

          if (msg.type === "status") {
            const url = cdp._currentUrl || "about:blank";
            socket.write(JSON.stringify({
              type: "status",
              pid: process.pid,
              mode: "local",
              url,
              viewport,
            }) + "\n");
            continue;
          }

          // Direct message passthrough (for raw commands)
          handleHeadlessCommand(msg, cdp, accessibility, fetchInterceptor)
            .then((result) => {
              socket.write(JSON.stringify({ id: msg.id, ...result }) + "\n");
            })
            .catch((e) => {
              socket.write(JSON.stringify({ id: msg.id, error: e.message }) + "\n");
            });

        } catch (e) {
          log(`Parse error: ${e.message}`);
          socket.write(JSON.stringify({ error: "Invalid JSON" }) + "\n");
        }
      }
    });

    socket.on("error", (err) => log(`Socket error: ${err.message}`));
    socket.on("close", () => log("CLI client disconnected"));
  });

  server.listen(SOCKET_PATH, () => {
    if (!isWindows()) {
      fs.chmodSync(SOCKET_PATH, 0o600);
    }
    log(`Listening on ${SOCKET_PATH}`);

    // Write PID file
    fs.writeFileSync(PID_FILE, String(process.pid));

    // Print status to stdout for the CLI to read
    console.log(JSON.stringify({
      status: "ready",
      pid: process.pid,
      socket: SOCKET_PATH,
      mode: "local",
      viewport,
    }));
  });

  server.on("error", (err) => {
    log(`Server error: ${err.message}`);
    console.error(`Server error: ${err.message}`);
    process.exit(1);
  });

  // ── Cleanup ──────────────────────────────────────────────────────

  function cleanup() {
    log("Cleaning up...");
    server.close();
    cleanupEndpoint(SOCKET_PATH);
    try { fs.unlinkSync(PID_FILE); } catch {}

    if (cdp) {
      try { cdp.close(); } catch {}
    }

    if (chromiumChild) {
      try { chromiumChild.kill("SIGTERM"); } catch {}
    }

    if (userDataDir) {
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    }


    log("Shutdown complete");
  }

  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("uncaughtException", (err) => {
    log(`Uncaught exception: ${err.message}\n${err.stack}`);
    cleanup();
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  log(`Fatal: ${err.message}\n${err.stack}`);
  process.exit(1);
});
