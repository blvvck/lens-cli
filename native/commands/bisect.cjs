"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const BISECT_OPTIONS = [
  { name: "good", default: undefined, description: "Known-good commit" },
  { name: "bad", default: undefined, description: "Known-bad commit" },
  { name: "threshold", default: "1", description: "Allowed visual mismatch percentage" },
  { name: "setup", default: undefined, description: "Command to prepare each revision" },
  { name: "selector", default: undefined, description: "Element selector to capture" },
  { name: "wait", default: "2000", description: "Delay between browser operations" },
  { name: "profile", default: undefined, description: "Lens profile" },
];

class BisectExit extends Error {
  constructor(code) {
    super(`bisect exited with code ${code}`);
    this.name = "BisectExit";
    this.code = code;
  }
}

function isBisectCommand(command) {
  return command === "bisect";
}

function dependencies(overrides = {}) {
  return {
    exec: overrides.execSyncRef || execSync,
    fs: overrides.fsRef || fs,
    os: overrides.osRef || os,
    path: overrides.pathRef || path,
    console: overrides.consoleRef || console,
    process: overrides.processRef || process,
    argv: overrides.processArgv || process.argv,
  };
}

function parseBisectArgs(args) {
  const options = {};
  let url = null;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token.startsWith("--")) {
      const name = token.slice(2);
      options[name] = args[index + 1];
      index += 1;
    } else if (!url) {
      url = token;
    }
  }

  return { bisectUrl: url, bisectOpts: options };
}

function createRunner(execSyncRef) {
  return (command, opts = {}) => {
    try {
      return execSyncRef(command, {
        encoding: "utf8",
        stdio: opts.stdio || "pipe",
        ...opts,
      }).trim();
    } catch (error) {
      if (opts.allowFail) return error.stdout?.trim() || "";
      throw error;
    }
  };
}

function pause(exec, milliseconds) {
  exec(`sleep ${milliseconds / 1000}`);
}

function capturePage(run, url, profileFlag, imagePath, selectorFlag) {
  run(`${run.lens}${profileFlag} open "${url}"`);
  pause(run.exec, run.wait);
  run(`${run.lens}${profileFlag} screenshot --output "${imagePath}" --full${selectorFlag}`);
}

function compareRevisions({ run, url, profileFlag, selectorFlag, wait, setup, baselinePath, tmpDir, threshold, consoleRef }) {
  let step = 0;
  while (true) {
    step += 1;
    const commit = run("git rev-parse --short HEAD");
    const message = run("git log -1 --pretty=%s");
    consoleRef.log(`\nStep ${step}: ${commit} — ${message}`);
    if (setup) {
      consoleRef.log("  Running setup...");
      run(setup, { allowFail: true, timeout: 120000 });
    }
    pause(run.exec, wait);

    const currentPath = run.path.join(tmpDir, `step-${step}.png`);
    capturePage(run, url, profileFlag, currentPath, selectorFlag);

    const diffPath = run.path.join(tmpDir, `diff-${step}.png`);
    let diff;
    try {
      diff = run(`${run.lens} diff "${baselinePath}" "${currentPath}" --output "${diffPath}" --threshold ${threshold / 100}`);
    } catch (error) {
      diff = error.stdout?.trim() || "";
    }
    const match = diff.match(/([\d.]+)% mismatch/);
    const mismatch = match ? parseFloat(match[1]) : 0;
    const isBad = mismatch > threshold;
    consoleRef.log(`  Mismatch: ${mismatch}% ${isBad ? "\x1b[31m(bad)\x1b[0m" : "\x1b[32m(good)\x1b[0m"}`);

    const progress = run(`git bisect ${isBad ? "bad" : "good"}`, { allowFail: true });
    if (progress.includes("is the first bad commit")) {
      return {
        result: {
          commit: progress.match(/([a-f0-9]{40})/)?.[1]?.substring(0, 8) || commit,
          message,
          steps: step,
        },
        steps: step,
      };
    }
    if (!progress.includes("Bisecting:") && !progress.includes("revisions left")) {
      return { result: null, steps: step };
    }
  }
}

function executeBisectCommand({ args, ...overrides }) {
  const deps = dependencies(overrides);
  const { bisectUrl, bisectOpts } = parseBisectArgs(args);
  if (!bisectUrl || !bisectOpts.good || !bisectOpts.bad) {
    deps.console.error("Usage: lens bisect <url> --good <commit> --bad <commit> [--threshold 5] [--setup 'cmd'] [--selector '.css'] [--wait 2000]");
    throw new BisectExit(1);
  }

  const thresholdDefault = BISECT_OPTIONS.find(({ name }) => name === "threshold").default;
  const waitDefault = BISECT_OPTIONS.find(({ name }) => name === "wait").default;
  const threshold = parseFloat(bisectOpts.threshold || thresholdDefault);
  const wait = parseInt(bisectOpts.wait || waitDefault, 10);
  const tmpDir = deps.path.join(deps.os.tmpdir(), `lens-bisect-${Date.now()}`);
  deps.fs.mkdirSync(tmpDir, { recursive: true });
  const lens = `${deps.argv[0]} ${deps.argv[1]}`;
  const profileFlag = bisectOpts.profile ? ` --profile ${bisectOpts.profile}` : "";
  const selectorFlag = bisectOpts.selector ? ` --selector "${bisectOpts.selector}"` : "";
  const run = createRunner(deps.exec);
  Object.assign(run, { exec: deps.exec, lens, path: deps.path, wait });

  deps.console.log("\x1b[36mLens Bisect\x1b[0m");
  deps.console.log(`URL: ${bisectUrl}`);
  deps.console.log(`Range: ${bisectOpts.good}..${bisectOpts.bad}`);
  deps.console.log(`Threshold: ${threshold}%`);
  if (bisectOpts.setup) deps.console.log(`Setup: ${bisectOpts.setup}`);
  deps.console.log("");

  const stash = run("git stash --include-untracked", { allowFail: true });
  const restoreStash = !stash.includes("No local changes");
  try {
    deps.console.log(`Capturing baseline at ${bisectOpts.good}...`);
    run(`git checkout ${bisectOpts.good} --quiet`);
    if (bisectOpts.setup) {
      deps.console.log(`  Running setup: ${bisectOpts.setup}`);
      run(bisectOpts.setup, { allowFail: true, timeout: 120000 });
    }
    pause(deps.exec, wait);

    const baselinePath = deps.path.join(tmpDir, "baseline.png");
    capturePage(run, bisectUrl, profileFlag, baselinePath, selectorFlag);
    deps.console.log(`  Baseline saved: ${baselinePath}`);
    run(`git bisect start ${bisectOpts.bad} ${bisectOpts.good} --quiet`, { allowFail: true });

    const { result, steps } = compareRevisions({
      run,
      url: bisectUrl,
      profileFlag,
      selectorFlag,
      wait,
      setup: bisectOpts.setup,
      baselinePath,
      tmpDir,
      threshold,
      consoleRef: deps.console,
    });
    run("git bisect reset", { allowFail: true });
    if (restoreStash) run("git stash pop", { allowFail: true });

    if (result) {
      deps.console.log(`\n\x1b[31mFirst bad commit: ${result.commit}\x1b[0m — ${result.message}`);
      deps.console.log(`Found in ${result.steps} steps`);
      deps.console.log(`Screenshots: ${tmpDir}`);
    } else {
      deps.console.log("\nBisect completed — no regression found within threshold.");
    }
    return true;
  } catch (error) {
    try {
      run("git bisect reset", { allowFail: true });
    } catch {}
    deps.console.error(`Bisect error: ${error.message}`);
    throw new BisectExit(1);
  }
}

function runBisectCommand({ args, ...overrides }) {
  try {
    if (!executeBisectCommand({ args, ...overrides })) return;
    dependencies(overrides).process.exit(0);
  } catch (error) {
    const deps = dependencies(overrides);
    if (error instanceof BisectExit) {
      deps.process.exit(error.code);
      return;
    }
    deps.console.error(`Error: ${error.message}`);
    deps.process.exit(1);
  }
}

module.exports = {
  BisectExit,
  createRunner,
  executeBisectCommand,
  isBisectCommand,
  parseBisectArgs,
  runBisectCommand,
};
