#!/usr/bin/env node
/**
 * cdp-daemon.cjs — CDP transport daemon for Lens CLI
 *
 * Connects to an existing Chrome instance via CDP WebSocket
 * (launched with --remote-debugging-port=9222) and exposes
 * the same socket protocol as host/index.cjs/headless-daemon.cjs.
 *
 * Usage:
 *   node cdp-daemon.cjs --cdp-url ws://localhost:9222/devtools/page/ABC123
 *   node cdp-daemon.cjs --cdp-url http://localhost:9222  (auto-detects page)
 *
 * The daemon speaks the same socket protocol so the CLI
 * can talk to it with identical tool_request messages.
 */

const net = require("net");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { HeadlessCDP } = require("./headless-cdp.cjs");
const { HeadlessAccessibility } = require("./headless-accessibility.cjs");
const { handleHeadlessCommand } = require("./headless-commands.cjs");
const { mapToolToMessage, formatToolContent } = require("./routing/index.cjs");
const {
  cleanupEndpoint,
  ensureRuntimeDir,
  getCdpEndpoint,
  getCdpLogPath,
  getCdpPidPath,
  isWindows,
} = require("./runtime-paths.cjs");

// ── Constants ────────────────────────────────────────────────────────

const SOCKET_PATH = getCdpEndpoint();
const PID_FILE = getCdpPidPath();
const LOG_FILE = getCdpLogPath();

ensureRuntimeDir();

// ── Logging ──────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

// ── CDP Discovery ───────────────────────────────────────────────────

async function discoverWebSocketUrl(cdpUrl) {
  // If already a ws:// or wss:// URL, use it directly
  if (cdpUrl.startsWith("ws://") || cdpUrl.startsWith("wss://")) {
    return cdpUrl;
  }

  // If http:// or https://, fetch the JSON list and pick first page
  const baseUrl = cdpUrl.replace(/\/$/, "");
  const jsonUrl = `${baseUrl}/json/list`;

  return new Promise((resolve, reject) => {
    const url = new URL(jsonUrl);
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "GET",
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const targets = JSON.parse(data);
          // Find first page target (not service worker, extension, etc)
          const page = targets.find(t =>
            t.type === "page" &&
            !t.url?.startsWith("chrome-extension://") &&
            !t.url?.startsWith("chrome://")
          );
          if (page?.webSocketDebuggerUrl) {
            resolve(page.webSocketDebuggerUrl);
          } else if (targets[0]?.webSocketDebuggerUrl) {
            resolve(targets[0].webSocketDebuggerUrl);
          } else {
            reject(new Error("No valid page target found in CDP response"));
          }
        } catch (e) {
          reject(new Error(`Failed to parse CDP response: ${e.message}`));
        }
      });
    });

    req.on("error", (err) => {
      reject(new Error(`Failed to connect to CDP: ${err.message}`));
    });

    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error("CDP discovery timeout (5s)"));
    });

    req.end();
  });
}

// ── Tool Request Handler ─────────────────────────────────────────────

async function handleToolRequest(msg, socket, cdp, accessibility) {
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

  // Commands not supported via CDP transport (extension-only features)
  const unsupported = [
    "lens.tabs.getAll", "upload.image",
    "page.layout", "lens.window.resize", "tab.switch", "tab.close",
    "tab.new", "tab.group", "tab.groups",
  ];
  if (unsupported.includes(extensionMsg.type)) {
    sendResponse(socket, originalId, null,
      `"${tool}" is not supported via CDP transport. Use extension mode for this feature.`);
    return;
  }

  // Check auto-inspect flag
  const autoInspect = args?.autoInspect === true;

  try {
    const result = await handleHeadlessCommand(extensionMsg, cdp, accessibility, null);

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
  const cdpUrlIdx = args.indexOf("--cdp-url");

  if (cdpUrlIdx === -1 || !args[cdpUrlIdx + 1]) {
    console.error("Usage: node cdp-daemon.cjs --cdp-url <ws://host:port/path|http://host:port>");
    console.error("");
    console.error("Examples:");
    console.error("  --cdp-url ws://localhost:9222/devtools/page/ABC123");
    console.error("  --cdp-url http://localhost:9222  (auto-detects page)");
    process.exit(1);
  }

  const cdpUrl = args[cdpUrlIdx + 1];

  log("=== Lens CDP Daemon Starting ===");
  log(`CDP URL: ${cdpUrl}`);

  // Discover WebSocket URL
  let wsUrl;
  try {
    wsUrl = await discoverWebSocketUrl(cdpUrl);
    log(`WebSocket URL: ${wsUrl}`);
  } catch (e) {
    console.error(`Failed to connect to CDP: ${e.message}`);
    log(`Discovery failed: ${e.message}`);
    process.exit(1);
  }

  // Connect to Chrome via CDP
  const cdp = new HeadlessCDP();
  try {
    await cdp.connect(wsUrl);
    log("CDP connected");
    await cdp.attachToPage();
    log("Attached to page");
  } catch (e) {
    console.error(`Failed to connect to CDP WebSocket: ${e.message}`);
    log(`Connection failed: ${e.message}`);
    process.exit(1);
  }

  // Inject accessibility tree
  const accessibility = new HeadlessAccessibility(cdp);
  await accessibility.inject();
  log("Accessibility tree injected");

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
            handleToolRequest(msg, socket, cdp, accessibility).catch((e) => {
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
              mode: "cdp",
              url,
              cdpUrl: wsUrl,
            }) + "\n");
            continue;
          }

          // Direct message passthrough (for raw commands)
          handleHeadlessCommand(msg, cdp, accessibility, null)
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
      mode: "cdp",
      cdpUrl: wsUrl,
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
