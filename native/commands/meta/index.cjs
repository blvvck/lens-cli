"use strict";

const path = require("path");
const { spawnSync } = require("child_process");
const { getConfigPath, createStarterConfig, loadConfig } = require("../../config/index.cjs");
const { getCurrentProfile, listRegisteredProfiles } = require("../../runtime-paths.cjs");

const META_COMMANDS = new Set([
  "--version", "-v", "--list", "--find", "--about", "profile.list", "profiles",
  "extension-path", "path", "install", "uninstall", "config",
]);

class MetaExit extends Error {
  constructor(code) {
    super(`Meta command exited with code ${code}`);
    this.name = "MetaExit";
    this.code = code;
  }
}

function isMetaCommand(command) {
  return META_COMMANDS.has(command);
}

function dependencies(overrides = {}) {
  return {
    path: overrides.path || path,
    spawn: overrides.spawnSync || spawnSync,
    getConfigPath: overrides.getConfigPath || getConfigPath,
    createStarterConfig: overrides.createStarterConfig || createStarterConfig,
    loadConfig: overrides.loadConfig || loadConfig,
    getCurrentProfile: overrides.getCurrentProfile || getCurrentProfile,
    listRegisteredProfiles: overrides.listRegisteredProfiles || listRegisteredProfiles,
    showAllTools: overrides.showAllTools,
    showFindResults: overrides.showFindResults,
    showAbout: overrides.showAbout,
    recordCommand: overrides.recordCommand,
    version: overrides.version,
    process: overrides.processRef || process,
    console: overrides.consoleRef || console,
  };
}

function recordInvocation(command, args, deps) {
  if (typeof deps.recordCommand !== "function") return;
  try {
    deps.recordCommand({ command, args: args.slice(1), commandFamily: "meta", status: "started" });
  } catch {}
}

function failSpawn(result, deps) {
  if (result.error) {
    deps.console.error(`Error: ${result.error.message}`);
  } else if (typeof result.status === "number") {
    throw new MetaExit(result.status);
  } else if (result.signal) {
    deps.console.error(`Error: process terminated by signal ${result.signal}`);
  }
  throw new MetaExit(1);
}

function runProfileList(deps) {
  try {
    const profiles = deps.listRegisteredProfiles();
    if (profiles.length === 0) {
      deps.console.log("No active profiles. Is Chrome running with the Lens extension?");
      return;
    }

    const defaultSlug = deps.loadConfig().defaultProfile;
    const currentSlug = deps.getCurrentProfile()?.slug;
    deps.console.log("Active Lens profiles:\n");
    for (const { slug } of profiles) {
      const labels = [];
      if (defaultSlug === slug) labels.push("default");
      if (currentSlug === slug) labels.push("current");
      deps.console.log(`  ${slug}${labels.length ? `  (${labels.join(", ")})` : ""}`);
    }
    deps.console.log("\nUsage: lens --profile <slug> <command>");
  } catch (error) {
    deps.console.error(`Error: ${error.message}`);
    throw new MetaExit(1);
  }
}

function runConfig(args, deps) {
  const options = args.slice(1);
  if (options.includes("--init")) {
    const result = deps.createStarterConfig();
    if (!result.success) {
      deps.console.error(`Error: ${result.error}`);
      deps.console.error(`Path: ${result.path}`);
      throw new MetaExit(1);
    }
    deps.console.log(`Created: ${result.path}`);
    return;
  }

  const config = deps.loadConfig();
  const configPath = deps.getConfigPath();
  if (options.includes("--path")) {
    deps.console.log(configPath || "No config found");
  } else if (configPath) {
    deps.console.log(JSON.stringify(config, null, 2));
  } else {
    deps.console.log("No config found");
    deps.console.log("Create one with: lens config --init");
  }
}

function spawnHostAction(action, args, deps) {
  const script = deps.path.resolve(__dirname, `../../../scripts/${action}-host.cjs`);
  const result = deps.spawn(deps.process.execPath, [script, ...args.slice(1)], { stdio: "inherit" });
  failSpawn(result, deps);
}

async function executeMetaCommand({ command, args, ...overrides }) {
  const deps = dependencies(overrides);
  switch (command) {
    case "--version":
    case "-v":
      deps.console.log(`lens v${deps.version}`);
      return { exit: true };
    case "--list":
      deps.showAllTools();
      return { exit: true };
    case "--find":
      if (!args[1]) return false;
      deps.showFindResults(args.slice(1).join(" "));
      return { exit: true };
    case "--about":
      if (!args[1]) return false;
      deps.showAbout(args[1]);
      return { exit: true };
    case "profile.list":
    case "profiles":
      runProfileList(deps);
      return { exit: true };
    case "extension-path":
    case "path":
      deps.console.log(deps.path.resolve(__dirname, "../../../dist"));
      return { exit: true };
    case "install":
    case "uninstall": {
      const options = args.slice(1);
      const help = command === "install"
        ? options.length === 0 || options[0] === "--help" || options[0] === "-h"
        : options.includes("--help") || options.includes("-h");
      if (help || (command === "install" && options.length === 0)) {
        const usage = command === "install"
          ? `
Usage: lens install <extension-id> [options]

Install native messaging host for browser communication.

Arguments:
  extension-id    Chrome extension ID (32 lowercase letters a-p)
                  Find at chrome://extensions with Developer Mode enabled

Options:
  -b, --browser   Browser(s) to install for (default: chrome)
                  Values: chrome, chromium, brave, edge, arc, all
                  Multiple: --browser chrome,brave

Examples:
  lens install hnfbepgmaoklhekckbpjnleifhahkcpl
  lens install hnfbepgmaoklhekckbpjnleifhahkcpl --browser brave
  lens install hnfbepgmaoklhekckbpjnleifhahkcpl --browser all
`
          : `
Usage: lens uninstall [options]

Remove native messaging host configuration.

Options:
  -b, --browser   Browser(s) to uninstall from (default: chrome)
                  Values: chrome, chromium, brave, edge, arc, all
  -a, --all       Uninstall from all browsers and remove wrapper

Examples:
  lens uninstall
  lens uninstall --browser brave
  lens uninstall --all
`;
        deps.console.log(usage);
        return { exit: true };
      }
      spawnHostAction(command, args, deps);
      return { exit: true };
    }
    case "config":
      runConfig(args, deps);
      return { exit: true };
    default:
      return false;
  }
}

function runMetaCommand({ command, args, ...overrides }) {
  const deps = dependencies(overrides);
  recordInvocation(command, args, deps);
  executeMetaCommand({ command, args, ...overrides }).then((result) => {
    if (result && result.exit !== false) deps.process.exit(0);
  }).catch((error) => {
    if (error instanceof MetaExit) {
      deps.process.exit(error.code);
      return;
    }
    deps.console.error(`Error: ${error.message}`);
    deps.process.exit(1);
  });
}

module.exports = {
  META_COMMANDS,
  MetaExit,
  executeMetaCommand,
  isMetaCommand,
  runMetaCommand,
};
