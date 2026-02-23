module.exports = {
  "window.new": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "window.new",
      url: a.url,
      width: a.width ? parseInt(a.width, 10) : undefined,
      height: a.height ? parseInt(a.height, 10) : undefined,
      incognito: a.incognito || false,
      focused: a.unfocused ? false : true,
    };
  },
  "window.list": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "window.list", includeTabs: a.tabs || false };
  },
  "window.focus": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    if (!a.id) throw new Error("window id required");
    return { type: "window.focus", windowId: parseInt(a.id, 10) };
  },
  "window.close": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    if (!a.id) throw new Error("window id required");
    return { type: "window.close", windowId: parseInt(a.id, 10) };
  },
  "window.resize": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    if (!a.id) throw new Error("--id required");
    return {
      type: "window.resize",
      windowId: parseInt(a.id, 10),
      width: a.width ? parseInt(a.width, 10) : undefined,
      height: a.height ? parseInt(a.height, 10) : undefined,
      left: a.left !== undefined ? parseInt(a.left, 10) : undefined,
      top: a.top !== undefined ? parseInt(a.top, 10) : undefined,
      state: a.state,
    };
  },
};
