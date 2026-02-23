"use strict";

const lifecycle = require("../lifecycle.cjs");

function routeHeadlessInvocation({ args, headlessSocket }) {
  if (args[0] !== "headless" || args.length < 2 || args[1]?.startsWith("-")) {
    return { args, isHeadlessMode: false, socketPath: null };
  }
  return { args: args.slice(1), isHeadlessMode: true, socketPath: headlessSocket };
}

function isHeadlessLifecycleCommand(command) {
  return command === "headless.start" || command === "headless.stop" || command === "headless.status";
}

function recordCommand(command, args, deps) {
  if (typeof deps.recordCommand !== "function") return;
  try {
    deps.recordCommand({ command, args: args.slice(1), commandFamily: "headless", status: "started" });
  } catch {}
}

function runHeadlessCommand({ command, args, headlessSocket, headlessPidFile, headlessLogFile, daemonPath, ...overrides }) {
  const deps = lifecycle.dependencies(overrides);
  recordCommand(command, args, overrides);

  if (command === "headless.start") {
    const viewportIndex = args.indexOf("--viewport");
    const daemonArgs = viewportIndex === -1 || !args[viewportIndex + 1]
      ? []
      : ["--viewport", args[viewportIndex + 1]];
    return lifecycle.start({
      name: "Headless",
      socketPath: headlessSocket,
      pidFile: headlessPidFile,
      logFile: headlessLogFile,
      daemonPath,
      daemonArgs,
      deps,
      readyLines: (status) => [
        `Headless daemon started (PID ${status.pid}, ${status.mode})`,
        `Socket: ${status.socket}`,
        `Viewport: ${status.viewport.width}x${status.viewport.height}`,
      ],
    });
  }

  if (command === "headless.stop") {
    lifecycle.stop({ name: "Headless", displayName: "headless", pidFile: headlessPidFile, deps });
    return true;
  }

  if (command === "headless.status") {
    lifecycle.status({
      name: "Headless",
      missingName: "headless",
      socketPath: headlessSocket,
      pidFile: headlessPidFile,
      deps,
      statusLines: (status) => [
        `Headless daemon running (PID ${status.pid})`,
        `Mode: ${status.mode}`,
        `URL: ${status.url}`,
        `Viewport: ${status.viewport.width}x${status.viewport.height}`,
      ],
    });
    return true;
  }
  return false;
}

module.exports = {
  routeHeadlessInvocation,
  isHeadlessLifecycleCommand,
  runHeadlessCommand,
};
