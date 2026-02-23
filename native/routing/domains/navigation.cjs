module.exports = {
  open: function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "open", url: a.url, ...baseMsg };
  },
  back: function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "lens.page.execute", code: "history.back()", ...baseMsg };
  },
  forward: function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "lens.page.execute",
      code: "history.forward()",
      ...baseMsg,
    };
  },
};
