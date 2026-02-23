"use strict";

const lifecycle = require("../lifecycle.cjs");

function isCdpLifecycleCommand(command) {
  return command === "cdp.start" || command === "cdp.stop" || command === "cdp.status";
}

function recordCommand(command, args, deps) {
  if (typeof deps.recordCommand !== "function") return;
  try {
    deps.recordCommand({ command, args: args.slice(1), commandFamily: "headless", status: "started" });
  } catch {}
}

function showStartUsage(deps) {
  deps.console.error("Usage: lens cdp.start --cdp-url <ws://host:port/path|http://host:port>");
  deps.console.error("");
  deps.console.error("Examples:");
  deps.console.error("  lens cdp.start --cdp-url ws://localhost:9222/devtools/page/ABC123");
  deps.console.error("  lens cdp.start --cdp-url http://localhost:9222  (auto-detects page)");
  deps.console.error("  lens cdp.start --cdp-url http://192.168.1.100:9222  (remote Chrome)");
}

function runCdpCommand({ command, args, cdpSocket, cdpPidFile, cdpLogFile, daemonPath, ...overrides }) {
  const deps = lifecycle.dependencies(overrides);
  recordCommand(command, args, overrides);

  if (command === "cdp.start") {
    const urlIndex = args.indexOf("--cdp-url");
    const cdpUrl = args[urlIndex + 1];
    if (urlIndex === -1 || !cdpUrl) {
      showStartUsage(deps);
      deps.process.exit(1);
      return true;
    }
    return lifecycle.start({
      name: "CDP",
      socketPath: cdpSocket,
      pidFile: cdpPidFile,
      logFile: cdpLogFile,
      daemonPath,
      daemonArgs: ["--cdp-url", cdpUrl],
      deps,
      readyLines: (status) => [
        `CDP daemon started (PID ${status.pid})`,
        `Socket: ${status.socket}`,
        `CDP URL: ${status.cdpUrl}`,
      ],
    });
  }

  if (command === "cdp.stop") {
    lifecycle.stop({ name: "CDP", displayName: "CDP", pidFile: cdpPidFile, deps });
    return true;
  }

  if (command === "cdp.status") {
    lifecycle.status({
      name: "CDP",
      missingName: "CDP",
      socketPath: cdpSocket,
      pidFile: cdpPidFile,
      deps,
      statusLines: (status) => [
        `CDP daemon running (PID ${status.pid})`,
        `Mode: ${status.mode}`,
        `URL: ${status.url}`,
        `CDP: ${status.cdpUrl}`,
      ],
    });
    return true;
  }
  return false;
}

module.exports = {
  isCdpLifecycleCommand,
  runCdpCommand,
};
