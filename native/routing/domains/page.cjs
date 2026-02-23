module.exports = {
  "canvas.detect": function (args, context) {
    const { tabId } = context;
    return { type: "canvas.detect", tabId };
  },
  "canvas.text": function (args, context) {
    const { tabId } = context;
    return { type: "canvas.text", tabId };
  },
  "page.state": function (args, context) {
    const { tabId } = context;
    return { type: "page.state", tabId };
  },
  "page.layout": function (args, context) {
    const a = args || {};
    const { tabId } = context;
    return {
      type: "page.layout",
      options: { filter: a.filter || "visual", selector: a.selector },
      tabId,
    };
  },
  run: function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "lens.page.execute", code: a.code, ...baseMsg };
  },
  js: function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "lens.page.execute", code: a.code, ...baseMsg };
  },
  scroll: function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return mapComputerAction({ ...a, action: tool }, tabId);
  },
  search: function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    if (!a.term) throw new Error("search term required");
    return {
      type: "search",
      term: a.term,
      caseSensitive: a["case-sensitive"] || false,
      limit: a.limit || 10,
      ...baseMsg,
    };
  },
};
