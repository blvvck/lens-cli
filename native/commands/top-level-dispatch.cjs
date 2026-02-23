"use strict";

const { isFlowCommand, runFlowCommand } = require("./flow/index.cjs");

function buildDependencies(overrides = {}) {
  return {
    isFlowCommand: overrides.isFlowCommand || isFlowCommand,
    runFlowCommand: overrides.runFlowCommand || runFlowCommand,
    recordCommand: overrides.recordCommand,
    loadConfig: overrides.loadConfig,
    processRef: overrides.processRef || process,
    consoleRef: overrides.consoleRef || console,
  };
}

function maybeRecordCommand(deps, { command, args, commandFamily }) {
  if (typeof deps.recordCommand !== "function") return;
  try {
    deps.recordCommand({
      command,
      args,
      commandFamily,
      status: "started",
    });
  } catch {}
}

function runTopLevelDispatch({ args, socketPath, ...overrides }) {
  const deps = buildDependencies(overrides);
  const command = args[0];

  if (deps.isFlowCommand(command)) {
    maybeRecordCommand(deps, {
      command,
      args: args.slice(1),
      commandFamily: "workflow",
    });
    deps.runFlowCommand({
      command,
      args: args.slice(1),
      consoleRef: deps.consoleRef,
      processRef: deps.processRef,
    });
    return { handled: true, socketPath };
  }

  return { handled: false, socketPath };
}

module.exports = {
  runTopLevelDispatch,
};
