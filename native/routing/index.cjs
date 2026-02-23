const toolMaps = [
  require('./domains/navigation.cjs'),
  require('./domains/windows.cjs'),
  require('./domains/page.cjs'),
  require('./domains/input.cjs'),
  require('./domains/cookies.cjs'),
  require('./domains/network.cjs'),
  require('./domains/capture.cjs'),
  require('./domains/emulation.cjs'),
  require('./domains/frames.cjs'),
  require('./domains/serving.cjs'),
  require('./domains/diagnostics.cjs'),
  require('./domains/history.cjs'),
  require('./domains/dialogs.cjs'),
  require('./domains/misc.cjs'),
  require('./domains/workspace.cjs')
];
const computerActions = require('./computer-actions.cjs');
const buildActionPolicy = require('./action-policy.cjs');
const formatToolContent = require('./format-tool-content.cjs');

function mapComputerAction(args, tabId) {
  const action = args && args.action;
  if (!action) {
    return { type: "lens.unsupported.unsupportedAction", action: null, message: "No action specified for computer tool" };
  }
  const mapper = computerActions[action];
  if (!mapper) {
    return { type: "lens.unsupported.unsupportedAction", action, message: `Unknown computer action: ${action}` };
  }
  return mapper(args, { tabId, buildActionPolicy });
}

function mapToolToMessage(tool, args, tabId) {
  const context = { tool, tabId, mapComputerAction, buildActionPolicy };
  for (const toolMap of toolMaps) {
    if (Object.prototype.hasOwnProperty.call(toolMap, tool)) {
      const message = toolMap[tool](args, context);
      if (message && typeof message === "object") {
        // Opt-in to driving the user's focused tab; the extension refuses otherwise.
        if (args && args["use-active-tab"]) message.useActiveTab = true;
        // Named workspace selector: --workspace <name> or LENS_WORKSPACE
        const workspace = (args && args.workspace) || process.env.LENS_WORKSPACE;
        if (workspace) message.workspace = String(workspace);
        // open --new-tab navigates a fresh tab and binds it instead of reusing one.
        if (args && args["new-tab"] && message.type === "open") message.newTab = true;
        if (args && args.focus) message.focus = true;
      }
      return message;
    }
  }
  return null;
}

module.exports = { mapToolToMessage, mapComputerAction, formatToolContent };
