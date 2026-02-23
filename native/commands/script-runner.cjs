"use strict";

const fs = require("fs");
const net = require("net");

const REQUEST_TIMEOUT_MS = 30000;

function dependencies(overrides = {}) {
  return {
    fs: overrides.fsRef || fs,
    net: overrides.netRef || net,
    console: overrides.consoleRef || console,
    process: overrides.processRef || process,
    setTimeout: overrides.setTimeoutRef || setTimeout,
    clearTimeout: overrides.clearTimeoutRef || clearTimeout,
    now: overrides.dateNow || Date.now,
    random: overrides.randomRef || Math.random,
  };
}

function isScriptRunnerInvocation(args) {
  return args.includes("--script");
}

function loadScriptDefinition(args, deps) {
  const optionIndex = args.indexOf("--script");
  const scriptPath = args[optionIndex + 1];

  if (!scriptPath || scriptPath.startsWith("--")) {
    deps.consoleRef.error("Error: --script requires a file path");
    deps.processRef.exit(1);
    return null;
  }
  if (!deps.fsRef.existsSync(scriptPath)) {
    deps.consoleRef.error(`Error: Script file not found: ${scriptPath}`);
    deps.processRef.exit(1);
    return null;
  }

  let script;
  try {
    script = JSON.parse(deps.fsRef.readFileSync(scriptPath, "utf8"));
  } catch (error) {
    deps.consoleRef.error(`Error: Failed to parse script: ${error.message}`);
    deps.processRef.exit(1);
    return null;
  }
  if (!script.steps || !Array.isArray(script.steps)) {
    deps.consoleRef.error("Error: Script must have a 'steps' array");
    deps.processRef.exit(1);
    return null;
  }
  return { scriptPath, script };
}

function createScriptRequestSender({ socketPath, scriptTabId, deps }) {
  const io = dependencies(deps);

  return (toolName, toolArgs = {}) => new Promise((resolve, reject) => {
    let socket;
    let buffer = "";
    let settled = false;
    let timeoutId;

    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      io.clearTimeout(timeoutId);
      socket?.end();
      if (error) reject(error);
      else resolve(response);
    };

    timeoutId = io.setTimeout(() => {
      socket?.destroy();
      finish(new Error("Timeout"));
    }, REQUEST_TIMEOUT_MS);

    socket = io.net.createConnection(socketPath, () => {
      const request = {
        type: "lens.socket.toolRequest",
        method: "execute_tool",
        params: { tool: toolName, args: toolArgs },
        id: `cli-${io.now()}-${io.random()}`,
      };
      if (scriptTabId) request.tabId = parseInt(scriptTabId, 10);
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline).trim();
      if (!line) return;
      try {
        const response = JSON.parse(line);
        if (response === null || typeof response !== "object" || Array.isArray(response)) {
          finish(new Error("Invalid response"));
          return;
        }
        finish(null, response);
      } catch {
        finish(new Error("Invalid JSON"));
      }
    });

    socket.on("error", (error) => finish(error));
  });
}

function summarizeArguments(args) {
  return Object.entries(args).map(([key, value]) => {
    if (typeof value === "string" && value.length > 40) {
      return `${key}="${value.slice(0, 37)}..."`;
    }
    return `${key}=${JSON.stringify(value)}`;
  }).join(" ");
}

async function executeScriptRunner({ args, socketPath, ...overrides }) {
  const deps = dependencies(overrides);
  const loaded = loadScriptDefinition(args, {
    ...overrides,
    fsRef: deps.fs,
    consoleRef: deps.console,
    processRef: deps.process,
  });
  if (!loaded) return true;

  const { scriptPath, script } = loaded;
  const dryRun = args.includes("--dry-run");
  const stopOnError = args.includes("--stop-on-error");
  const tabOption = args.indexOf("--tab-id");
  const scriptTabId = tabOption === -1 ? undefined : args[tabOption + 1];
  const sendRequest = createScriptRequestSender({ socketPath, scriptTabId, deps: overrides });
  const total = script.steps.length;
  const results = [];
  let failed = 0;

  deps.console.log(`Running: ${script.name || scriptPath} (${total} steps)`);
  deps.console.log(dryRun ? "(dry-run mode)\n" : "");

  for (let index = 0; index < total; index += 1) {
    const step = script.steps[index];
    const number = `[${index + 1}/${total}]`;
    const tool = step.tool;
    const toolArgs = step.args || {};
    const summary = summarizeArguments(toolArgs);
    const description = summary ? `${tool} ${summary}` : tool;

    if (dryRun) {
      deps.console.log(`${number} ${description}`);
      results.push({ step: index + 1, tool, status: "skipped" });
      continue;
    }

    deps.process.stdout.write(`${number} ${description} ... `);
    try {
      const response = await sendRequest(tool, toolArgs);
      if (response.error) {
        const message = response.error.content?.[0]?.text || JSON.stringify(response.error);
        deps.console.log("FAIL");
        deps.console.log(`     Error: ${message}`);
        results.push({ step: index + 1, tool, status: "fail", error: message });
        failed += 1;
        if (stopOnError) break;
      } else {
        deps.console.log("OK");
        results.push({ step: index + 1, tool, status: "ok" });
      }
    } catch (error) {
      deps.console.log("FAIL");
      deps.console.log(`     Error: ${error.message}`);
      results.push({ step: index + 1, tool, status: "fail", error: error.message });
      failed += 1;
      if (stopOnError) break;
    }
  }

  const passed = results.filter((result) => result.status === "ok").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  deps.console.log("");
  deps.console.log(dryRun
    ? `Summary: ${skipped} steps would run`
    : `Summary: ${passed} passed, ${failed} failed, ${total} total`);
  deps.process.exit(failed > 0 ? 1 : 0);
  return true;
}

function runScriptRunner(options) {
  executeScriptRunner(options);
}

module.exports = {
  createScriptRequestSender,
  executeScriptRunner,
  isScriptRunnerInvocation,
  loadScriptDefinition,
  runScriptRunner,
};
