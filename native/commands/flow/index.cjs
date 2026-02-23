"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const { parseFlowCommands } = require("../../flow-parser.cjs");
const { executeFlowSteps } = require("../../flow-executor.cjs");

const FLOW_COMMANDS = new Set([
  "flow",
  "flow.list",
  "flow.info",
]);

class FlowExit extends Error {
  constructor(code) {
    super(`Workflow command exited with code ${code}`);
    this.name = "FlowExit";
    this.code = code;
  }
}

function isFlowCommand(command) {
  return FLOW_COMMANDS.has(command);
}

const FLOW_OPTIONS = [
  { name: "file", flag: "--file", key: "fileInput", type: "string", default: null, description: "Load a flow definition from a file" },
  { name: "actions", flag: "--actions", key: "actionsInput", type: "string", default: null, description: "Run a JSON action list" },
  { name: "dry-run", flag: "--dry-run", key: "dryRun", type: "boolean", default: false, description: "Print the steps without running them" },
  { name: "on-error", flag: "--on-error", key: "onError", type: "string", default: "stop", description: "Choose what to do after a failed step" },
  { name: "no-auto-wait", flag: "--no-auto-wait", key: "noAutoWait", type: "boolean", default: false, description: "Disable automatic waits" },
  { name: "step-delay", flag: "--step-delay", key: "stepDelay", type: "integer", default: 100, description: "Delay between steps in milliseconds" },
  { name: "json", flag: "--json", key: "wantJson", type: "boolean", default: false, description: "Print the execution result as JSON" },
  { name: "tab-id", flag: "--tab-id", key: "tabId", type: "integer", default: undefined, description: "Target a browser tab" },
  { name: "window-id", flag: "--window-id", key: "windowId", type: "integer", default: undefined, description: "Target a browser window" },
  { name: "profile", flag: "--profile", key: null, type: "reserved", default: undefined, description: "Consumed by the top-level CLI" },
];

function coerceFlowValue(value, type = "auto", fallback) {
  if (type === "string") return fallback === "stop" ? value || fallback : value;
  if (type === "boolean") return true;
  if (type === "integer") {
    const number = parseInt(value, 10);
    return Number.isNaN(number) && fallback !== undefined ? fallback : number;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  return value;
}

function parseFlowFlags(rawArgs) {
  const options = Object.fromEntries(FLOW_OPTIONS
    .filter(({ key }) => key)
    .map(({ key, default: value }) => [key, value]));
  const workflowArgs = {};

  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    const option = FLOW_OPTIONS.find(({ flag }) => flag === token);
    if (option) {
      if (option.type === "reserved") continue;
      if (option.type === "boolean") {
        options[option.key] = true;
        continue;
      }
      options[option.key] = coerceFlowValue(rawArgs[index + 1], option.type, option.default);
      index += 1;
      continue;
    }

    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = rawArgs[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        workflowArgs[key] = coerceFlowValue(next);
        index += 1;
      } else {
        workflowArgs[key] = true;
      }
    } else if (!token.startsWith("-") && !options.commandsInput) {
      options.commandsInput = token;
    }
  }

  return { commandsInput: null, ...options, workflowArgs };
}

function buildDependencies(overrides = {}) {
  return {
    fs: overrides.fs || fs,
    path: overrides.path || path,
    os: overrides.os || os,
    cwd: overrides.cwd || (() => process.cwd()),
    parseFlowCommands: overrides.parseFlowCommands || parseFlowCommands,
    executeFlowSteps: overrides.executeFlowSteps || executeFlowSteps,
    consoleRef: overrides.consoleRef || console,
    processRef: overrides.processRef || process,
  };
}

function getFlowDirs(overrides = {}) {
  const deps = buildDependencies(overrides);
  return [
    { path: deps.path.join(deps.cwd(), ".lens", "flows"), scope: "project" },
    { path: deps.path.join(deps.os.homedir(), ".lens", "flows"), scope: "user" },
  ];
}

function resolveFlow(nameOrPath, overrides = {}) {
  const deps = buildDependencies(overrides);

  if (nameOrPath.includes("|")) {
    return { type: "inline", content: nameOrPath };
  }

  if (nameOrPath.includes("/") || nameOrPath.includes("\\") || nameOrPath.endsWith(".json")) {
    if (deps.fs.existsSync(nameOrPath)) {
      return { type: "file", path: nameOrPath };
    }
    return { type: "not_found", name: nameOrPath };
  }

  for (const { path: dir } of getFlowDirs(deps)) {
    const filePath = deps.path.join(dir, `${nameOrPath}.json`);
    if (deps.fs.existsSync(filePath)) {
      return { type: "file", path: filePath };
    }
  }

  return { type: "not_found", name: nameOrPath };
}

function listFlows(overrides = {}) {
  const deps = buildDependencies(overrides);
  const workflows = [];

  for (const { path: dir, scope } of getFlowDirs(deps)) {
    if (!deps.fs.existsSync(dir)) continue;
    try {
      const files = deps.fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
      for (const file of files) {
        const filePath = deps.path.join(dir, file);
        try {
          const content = JSON.parse(deps.fs.readFileSync(filePath, "utf8"));
          workflows.push({
            name: content.name || file.replace(/\.json$/, ""),
            description: content.description || "",
            scope,
            path: filePath,
            args: content.args,
            stepCount: content.steps?.length || 0,
          });
        } catch {
          // Skip invalid JSON files.
        }
      }
    } catch {
      // Skip inaccessible directories.
    }
  }

  return workflows;
}

function getFlowInfo(name, overrides = {}) {
  const deps = buildDependencies(overrides);
  const resolved = resolveFlow(name, deps);

  if (resolved.type === "not_found") {
    return { error: `Workflow not found: ${name}` };
  }

  if (resolved.type === "inline") {
    return { error: "Cannot get info for inline workflows" };
  }

  try {
    const content = JSON.parse(deps.fs.readFileSync(resolved.path, "utf8"));
    return {
      name: content.name || name,
      description: content.description || "",
      args: content.args || {},
      steps: content.steps || [],
      path: resolved.path,
    };
  } catch (error) {
    return { error: `Failed to parse workflow: ${error.message}` };
  }
}

function validateFlowArgs(workflow, providedArgs) {
  const errors = [];
  if (workflow.args) {
    for (const [name, spec] of Object.entries(workflow.args)) {
      if (spec.required && providedArgs[name] === undefined) {
        errors.push(`Missing required argument: --${name}`);
      }
    }
  }
  return errors;
}

function applyArgDefaults(workflow, providedArgs) {
  const vars = { ...providedArgs };
  if (workflow.args) {
    for (const [name, spec] of Object.entries(workflow.args)) {
      if (vars[name] === undefined && spec.default !== undefined) {
        vars[name] = spec.default;
      }
    }
  }
  return vars;
}

function validateFlowFile(filePath, overrides = {}) {
  const deps = buildDependencies(overrides);
  if (!deps.fs.existsSync(filePath)) {
    return { valid: false, error: `File not found: ${filePath}` };
  }

  try {
    const workflow = JSON.parse(deps.fs.readFileSync(filePath, "utf8"));
    if (!workflow.steps || !Array.isArray(workflow.steps)) {
      return { valid: false, error: "Workflow must have a 'steps' array" };
    }
    if (workflow.steps.length === 0) {
      return { valid: false, error: "Workflow has no steps" };
    }

    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      if (step.repeat !== undefined || step.each !== undefined) {
        if (!step.steps || !Array.isArray(step.steps)) {
          return { valid: false, error: `Step ${i + 1}: loop must have a 'steps' array` };
        }
        continue;
      }
      if (!step.tool && !step.cmd) {
        return { valid: false, error: `Step ${i + 1}: must have 'tool' field` };
      }
    }

    if (workflow.args && typeof workflow.args !== "object") {
      return { valid: false, error: "'args' must be an object" };
    }

    return { valid: true, workflow };
  } catch (error) {
    return { valid: false, error: `Invalid JSON: ${error.message}` };
  }
}

function formatStep(step, indent = 0) {
  const prefix = "  ".repeat(indent);
  const nested = (heading, children, until) => {
    const lines = [`${prefix}${heading}`];
    for (const child of children || []) lines.push(formatStep(child, indent + 1));
    if (until) lines.push(`${prefix}  until: ${until.tool || until.cmd}`);
    return lines.join("\n");
  };

  if (step.repeat !== undefined) return nested(`repeat ${step.repeat} times:`, step.steps, step.until);
  if (step.each !== undefined) return nested(`each ${step.each} as ${step.as || "item"}:`, step.steps);

  const args = Object.entries(step.args || {})
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  return `${prefix}${step.tool || step.cmd}${args ? ` ${args}` : ""}${step.as ? ` → ${step.as}` : ""}`;
}

function convertWorkflowSteps(workflow) {
  return workflow.steps.map((step) => {
    if (step.repeat !== undefined || step.each !== undefined) {
      const convertSteps = (steps) => steps.map((nestedStep) => {
        if (nestedStep.repeat !== undefined || nestedStep.each !== undefined) {
          return {
            ...nestedStep,
            steps: convertSteps(nestedStep.steps || []),
            until: nestedStep.until
              ? { cmd: nestedStep.until.tool || nestedStep.until.cmd, args: nestedStep.until.args || {} }
              : undefined,
          };
        }
        return { cmd: nestedStep.tool || nestedStep.cmd, args: nestedStep.args || {}, as: nestedStep.as };
      });

      return {
        ...step,
        steps: convertSteps(step.steps || []),
        until: step.until ? { cmd: step.until.tool || step.until.cmd, args: step.until.args || {} } : undefined,
      };
    }

    return { cmd: step.tool || step.cmd, args: step.args || {}, as: step.as };
  });
}

function printWorkflowArgs(workflow, consoleRef) {
  if (!workflow.args) return;
  consoleRef.error(`\nWorkflow arguments:`);
  for (const [name, spec] of Object.entries(workflow.args)) {
    const required = spec.required ? " (required)" : "";
    const defaultValue = spec.default !== undefined ? ` [default: ${spec.default}]` : "";
    const description = spec.desc || spec.description || "";
    consoleRef.error(`  --${name}${required}${defaultValue}${description ? ` - ${description}` : ""}`);
  }
}

function printDryRun(steps, workflow, workflowName, vars, consoleRef) {
  if (workflowName) {
    consoleRef.log(`Workflow: ${workflowName}`);
    if (workflow?.description) consoleRef.log(`Description: ${workflow.description}`);
  }
  consoleRef.log(`\nWould execute ${steps.length} steps:`);
  steps.forEach((step, index) => {
    consoleRef.log(`  ${index + 1}. ${formatStep(step)}`);
  });
  if (Object.keys(vars).length > 0) {
    consoleRef.log(`\nVariables:`);
    for (const [key, value] of Object.entries(vars)) {
      consoleRef.log(`  ${key} = ${JSON.stringify(value)}`);
    }
  }
}

async function runFlow(args, deps) {
  const {
    commandsInput,
    fileInput,
    actionsInput,
    dryRun,
    onError,
    noAutoWait,
    stepDelay,
    wantJson,
    tabId,
    windowId,
    workflowArgs,
  } = parseFlowFlags(args);

  if (!commandsInput && !fileInput && !actionsInput) {
    deps.consoleRef.error("Error: a commands string, a flow name, --file or --actions is required");
    deps.consoleRef.error("Usage: lens flow 'open \"url\" | click e5'");
    deps.consoleRef.error("       lens flow --file flow.json");
    deps.consoleRef.error("       lens flow checkout --url value");
    deps.consoleRef.error('       lens flow --actions \'[{"type":"click","ref":"e1"}]\'');
    throw new FlowExit(1);
  }

  let steps;
  let workflow = null;
  let workflowName = null;

  try {
    if (actionsInput) {
      const actions = JSON.parse(actionsInput);
      if (!Array.isArray(actions)) {
        deps.consoleRef.error("Error: --actions must be a JSON array");
        throw new FlowExit(1);
      }
      steps = actions.map((action) => {
        const { type, ...rest } = action;
        return { tool: type, args: rest };
      });
    } else if (fileInput) {
      if (!deps.fs.existsSync(fileInput)) {
        deps.consoleRef.error(`Error: File not found: ${fileInput}`);
        throw new FlowExit(1);
      }
      workflow = JSON.parse(deps.fs.readFileSync(fileInput, "utf8"));
      workflowName = workflow.name || fileInput;
    } else {
      const resolved = resolveFlow(commandsInput, deps);
      if (resolved.type === "inline") {
        steps = deps.parseFlowCommands(resolved.content);
      } else if (resolved.type === "file") {
        workflow = JSON.parse(deps.fs.readFileSync(resolved.path, "utf8"));
        workflowName = workflow.name || commandsInput;
      } else {
        steps = deps.parseFlowCommands(commandsInput);
        if (steps.length === 0) {
          deps.consoleRef.error(`Error: Workflow not found: ${commandsInput}`);
          deps.consoleRef.error("Searched in:");
          for (const { path: dir } of getFlowDirs(deps)) {
            deps.consoleRef.error(`  ${dir}`);
          }
          deps.consoleRef.error("\nRun 'lens flow.list' to see available workflows.");
          throw new FlowExit(1);
        }
      }
    }

    if (workflow) {
      if (!workflow.steps || !Array.isArray(workflow.steps)) {
        throw new Error("Workflow must have a 'steps' array");
      }

      const argErrors = validateFlowArgs(workflow, workflowArgs);
      if (argErrors.length > 0) {
        deps.consoleRef.error("Error: Missing required arguments:");
        argErrors.forEach((error) => deps.consoleRef.error(`  ${error}`));
        printWorkflowArgs(workflow, deps.consoleRef);
        deps.consoleRef.error(`\nRun 'lens flow.info ${workflowName}' for details.`);
        throw new FlowExit(1);
      }

      steps = convertWorkflowSteps(workflow);
    }
  } catch (error) {
    if (error instanceof FlowExit) throw error;
    deps.consoleRef.error(`Error: Failed to parse workflow: ${error.message}`);
    throw new FlowExit(1);
  }

  if (!steps || steps.length === 0) {
    deps.consoleRef.error("Error: No commands found in workflow");
    throw new FlowExit(1);
  }

  const vars = workflow ? applyArgDefaults(workflow, workflowArgs) : workflowArgs;

  if (dryRun) {
    printDryRun(steps, workflow, workflowName, vars, deps.consoleRef);
    return;
  }

  if (!wantJson) {
    if (workflowName) deps.consoleRef.log(`Running workflow: ${workflowName} (${steps.length} steps)...\n`);
    else deps.consoleRef.log(`Running workflow (${steps.length} steps)...\n`);
  }

  const result = await deps.executeFlowSteps(steps, {
    onError,
    autoWait: !noAutoWait,
    stepDelay,
    quiet: wantJson,
    vars,
    context: { tabId, windowId },
  });

  if (wantJson) {
    deps.consoleRef.log(JSON.stringify(result, null, 2));
    if (result.status !== "completed") {
      throw new FlowExit(1);
    }
    return;
  }

  deps.consoleRef.log("");
  if (result.status === "completed") {
    deps.consoleRef.log(`Completed: ${result.completedSteps}/${result.totalSteps} steps (${result.totalMs}ms)`);
    return;
  }
  if (result.status === "partial") {
    deps.consoleRef.log(`Partial: ${result.completedSteps}/${result.totalSteps} steps completed, ${result.failed} failed`);
    throw new FlowExit(1);
  }
  deps.consoleRef.error(`Failed: ${result.completedSteps}/${result.totalSteps} steps completed`);
  if (result.error) deps.consoleRef.error(`Error: ${result.error}`);
  throw new FlowExit(1);
}

async function runFlowList(_args, deps) {
  const workflows = listFlows(deps);
  if (workflows.length === 0) {
    deps.consoleRef.log("No workflows found.");
    deps.consoleRef.log("\nFlow directories:");
    for (const { path: dir, scope } of getFlowDirs(deps)) {
      deps.consoleRef.log(`  ${scope}: ${dir}`);
    }
    deps.consoleRef.log("\nCreate a workflow JSON file in one of these directories.");
    return;
  }

  const byScope = { project: [], user: [] };
  for (const workflow of workflows) {
    byScope[workflow.scope].push(workflow);
  }

  if (byScope.user.length > 0) {
    deps.consoleRef.log("User Workflows (~/.lens/workflows/):");
    for (const workflow of byScope.user) {
      const description = workflow.description ? ` - ${workflow.description}` : "";
      deps.consoleRef.log(`  ${workflow.name.padEnd(20)} ${description}`);
    }
    deps.consoleRef.log("");
  }

  if (byScope.project.length > 0) {
    deps.consoleRef.log("Project Workflows (./.lens/workflows/):");
    for (const workflow of byScope.project) {
      const description = workflow.description ? ` - ${workflow.description}` : "";
      deps.consoleRef.log(`  ${workflow.name.padEnd(20)} ${description}`);
    }
    deps.consoleRef.log("");
  }

  deps.consoleRef.log("Run 'lens flow.info <name>' for details.");
}

async function runFlowInfo(args, deps) {
  const name = args[0];
  if (!name) {
    deps.consoleRef.error("Error: workflow name required");
    deps.consoleRef.error("Usage: lens flow.info <name>");
    throw new FlowExit(1);
  }

  const info = getFlowInfo(name, deps);
  if (info.error) {
    deps.consoleRef.error(`Error: ${info.error}`);
    throw new FlowExit(1);
  }

  deps.consoleRef.log(`${info.name}${info.description ? ` - ${info.description}` : ""}`);
  deps.consoleRef.log("");

  if (info.args && Object.keys(info.args).length > 0) {
    deps.consoleRef.log("Arguments:");
    for (const [argName, spec] of Object.entries(info.args)) {
      const required = spec.required ? " (required)" : "";
      const defaultValue = spec.default !== undefined ? ` [default: ${spec.default}]` : "";
      const description = spec.desc || spec.description || "";
      deps.consoleRef.log(`  --${argName}${required}${defaultValue}`);
      if (description) deps.consoleRef.log(`      ${description}`);
    }
    deps.consoleRef.log("");
  }

  deps.consoleRef.log(`Steps (${info.steps.length}):`);
  info.steps.forEach((step, index) => {
    deps.consoleRef.log(`  ${index + 1}. ${formatStep(step)}`);
  });
  deps.consoleRef.log("");
  deps.consoleRef.log(`Location: ${info.path}`);
  deps.consoleRef.log("");

  const argExample = Object.entries(info.args || {})
    .filter(([, spec]) => spec.required)
    .map(([name]) => `--${name} "..."`)
    .join(" ");
  deps.consoleRef.log("Run:");
  deps.consoleRef.log(`  lens flow ${name}${argExample ? ` ${argExample}` : ""}`);
}

async function executeFlowCommand({ command, args, ...overrides }) {
  const deps = buildDependencies(overrides);
  const runner =
    command === "flow" ? runFlow :
    command === "flow.list" ? runFlowList :
    command === "flow.info" ? runFlowInfo :
    null;

  if (!runner) return false;
  await runner(args, deps);
  return true;
}

function runFlowCommand({ command, args, ...overrides }) {
  executeFlowCommand({ command, args, ...overrides }).then((handled) => {
    if (!handled) return;
    const deps = buildDependencies(overrides);
    deps.processRef.exit(0);
  }).catch((error) => {
    const deps = buildDependencies(overrides);
    if (error instanceof FlowExit) {
      deps.processRef.exit(error.code);
      return;
    }
    deps.consoleRef.error(`Error: ${error.message}`);
    deps.processRef.exit(1);
  });
}

module.exports = {
  FLOW_COMMANDS,
  FlowExit,
  applyArgDefaults,
  executeFlowCommand,
  formatStep,
  getFlowDirs,
  getFlowInfo,
  isFlowCommand,
  listFlows,
  parseFlowFlags,
  resolveFlow,
  runFlowCommand,
  validateFlowArgs,
  validateFlowFile,
};
