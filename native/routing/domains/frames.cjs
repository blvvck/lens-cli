module.exports = {
  "frame.list": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "frame.list", ...baseMsg };
  },
  "frame.switch": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "frame.switch",
      selector: a.selector,
      name: a.name,
      index: a.index !== undefined ? parseInt(a.index, 10) : undefined,
      ...baseMsg,
    };
  },
  "frame.main": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "frame.main", ...baseMsg };
  },
  "frame.js": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "frame.js",
      frameId: a.id,
      code: a.code,
      ...baseMsg,
    };
  },
};
