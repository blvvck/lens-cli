const AUTO_INSPECT_DELAY_MS = 300;

const AUTO_INSPECT_TOOLS = Object.freeze([
  "click",
  "type",
  "key",
  "form.smart",
  "form.fill",
  "form.input",
  "drag",
  "hover",
  "scroll",
  "scroll.top",
  "scroll.bottom",
  "scroll.to",
  "dialog.accept",
  "dialog.dismiss",
]);

const AUTO_INSPECT_TOOL_SET = new Set(AUTO_INSPECT_TOOLS);

function shouldAutoInspectTool(tool, options = {}) {
  if (options.noInspect === true) return false;
  return AUTO_INSPECT_TOOL_SET.has(tool);
}

function formatAutoInspectContent(readPageResult = {}) {
  let content = readPageResult.pageContent || readPageResult.tree || "";
  if (readPageResult.text) {
    content += `\n\n--- Page Text ---\n${readPageResult.text}`;
  }
  return content;
}

module.exports = {
  AUTO_INSPECT_DELAY_MS,
  AUTO_INSPECT_TOOLS,
  shouldAutoInspectTool,
  formatAutoInspectContent,
};
