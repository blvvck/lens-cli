"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

function dependencies(overrides = {}) {
  return {
    fs: overrides.fsRef || fs,
    net: overrides.netRef || net,
    path: overrides.pathRef || path,
    spawn: overrides.spawnProc || spawn,
    process: overrides.processRef || process,
    console: overrides.consoleRef || console,
    setTimeout: overrides.setTimeoutRef || setTimeout,
  };
}

function start({ name, socketPath, pidFile, logFile, daemonPath, daemonArgs, readyLines, deps }) {
  try {
    const pid = parseInt(deps.fs.readFileSync(pidFile, "utf8").trim(), 10);
    if (pid && !Number.isNaN(pid)) {
      try {
        deps.process.kill(pid, 0);
        deps.console.log(`${name} daemon already running (PID ${pid})`);
        if (name === "CDP") deps.console.log(`Socket: ${socketPath}`);
        deps.process.exit(0);
        return true;
      } catch {
        try {
          deps.fs.unlinkSync(pidFile);
        } catch {}
      }
    }
  } catch {}

  const logFd = deps.fs.openSync(logFile, "a");
  const child = deps.spawn(deps.process.execPath, [daemonPath, ...daemonArgs], {
    stdio: ["ignore", "pipe", logFd],
    detached: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
    if (!output.includes("\n")) return;
    try {
      const status = JSON.parse(output.trim());
      if (status.status !== "ready") return;
      for (const line of readyLines(status)) deps.console.log(line);
      if (typeof child.unref === "function") child.unref();
      deps.process.exit(0);
    } catch {}
  });
  child.on("error", (error) => {
    deps.console.error(`Failed to start daemon: ${error.message}`);
    deps.process.exit(1);
  });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      deps.console.error(`Daemon exited with code ${code}. Check ${logFile}`);
      deps.process.exit(1);
    }
  });

  const timeoutMs = 15000;
  deps.setTimeout(() => {
    deps.console.error(`Daemon start timed out (${timeoutMs / 1000}s). Check ${logFile}`);
    try {
      child.kill();
    } catch {}
    deps.process.exit(1);
  }, timeoutMs);
  return true;
}

function stop({ name, displayName = name, pidFile, deps }) {
  try {
    const pid = parseInt(deps.fs.readFileSync(pidFile, "utf8").trim(), 10);
    deps.process.kill(pid, "SIGTERM");
    deps.console.log(`Stopped ${displayName} daemon (PID ${pid})`);
  } catch (error) {
    if (error.code === "ENOENT") {
      deps.console.log(`No ${displayName} daemon running`);
    } else if (error.code === "ESRCH") {
      deps.console.log("Daemon already stopped (stale PID file)");
      try {
        deps.fs.unlinkSync(pidFile);
      } catch {}
    } else {
      deps.console.error(`Error: ${error.message}`);
    }
  }
  deps.process.exit(0);
}

function status({ name, missingName = name, socketPath, pidFile, timeoutMs = 2000, statusLines, deps }) {
  try {
    const pid = parseInt(deps.fs.readFileSync(pidFile, "utf8").trim(), 10);
    try {
      deps.process.kill(pid, 0);
      const socket = deps.net.createConnection(socketPath, () => {
        socket.write(`${JSON.stringify({ type: "status" })}\n`);
      });
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            for (const detail of statusLines(JSON.parse(line))) deps.console.log(detail);
          } catch {}
          socket.end();
          deps.process.exit(0);
        }
      });
      socket.on("error", () => {
        deps.console.log(`${name} daemon running (PID ${pid}) but socket not responding`);
        deps.process.exit(1);
      });
      deps.setTimeout(() => {
        deps.console.log(`${name} daemon running (PID ${pid})`);
        socket.end();
        deps.process.exit(0);
      }, timeoutMs);
    } catch {
      deps.console.log("Daemon not running (stale PID file)");
      try {
        deps.fs.unlinkSync(pidFile);
      } catch {}
      deps.process.exit(1);
    }
  } catch {
    deps.console.log(`No ${missingName} daemon running`);
    deps.process.exit(1);
  }
}

module.exports = { dependencies, start, status, stop };
