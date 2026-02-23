module.exports = {
  network: function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "network",
      full:
        a.v ||
        a.vv ||
        a.format === "curl" ||
        a.format === "verbose" ||
        a.format === "raw",
      urlPattern: a.filter || a.url_pattern || a.origin,
      method: a.method,
      status: a.status,
      contentType: a.type,
      limit: a.limit || a.last,
      format: a.format,
      verbose: a.v ? 1 : a.vv ? 2 : 0,
      ...baseMsg,
    };
  },
  "network.get": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "lens.network.entry",
      requestId: a.id || args[0],
      ...baseMsg,
    };
  },
  "network.body": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "network.body",
      requestId: a.id || args[0],
      isRequest: a.request,
      ...baseMsg,
    };
  },
  "network.curl": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "lens.network.entry",
      requestId: a.id || args[0],
      formatAsCurl: true,
      ...baseMsg,
    };
  },
  "network.origins": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "network.origins",
      byTab: a["by-tab"] || a.byTab,
      ...baseMsg,
    };
  },
  "network.clear": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "network.clear",
      before: a.before,
      origin: a.origin,
      ...baseMsg,
    };
  },
  "network.stats": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "network.stats",
      ...baseMsg,
    };
  },
  "network.export": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "network.export",
      har: a.har,
      jsonl: a.jsonl,
      output: a.output,
      ...baseMsg,
    };
  },
  "network.path": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "network.path",
      requestId: a.id || args[0],
      ...baseMsg,
    };
  },
};
