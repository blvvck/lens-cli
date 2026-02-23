module.exports = {
  console: function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "console",
      onlyErrors: a.only_errors,
      pattern: a.pattern,
      limit: a.limit,
      clear: a.clear,
      ...baseMsg,
    };
  },
  "perf.start": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "perf.start",
      categories: a.categories ? a.categories.split(",") : undefined,
      ...baseMsg,
    };
  },
  "perf.stop": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "perf.stop", ...baseMsg };
  },
  "perf.metrics": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "perf.metrics", ...baseMsg };
  },
  "test.health": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    if (a.url) {
      return {
        type: "doctor",
        url: a.url,
        expect: a.expect || 200,
        timeout: a.timeout || 30000,
      };
    } else if (a.selector) {
      return {
        type: "lens.wait.element",
        selector: a.selector,
        timeout: a.timeout || 30000,
        ...baseMsg,
      };
    }
    return { type: "lens.command.error", error: "--url or --selector required" };
  },
  doctor: function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    if (a.url) {
      return {
        type: "doctor",
        url: a.url,
        expect: a.expect || 200,
        timeout: a.timeout || 30000,
      };
    } else if (a.selector) {
      return {
        type: "lens.wait.element",
        selector: a.selector,
        timeout: a.timeout || 30000,
        ...baseMsg,
      };
    }
    return { type: "lens.command.error", error: "--url or --selector required" };
  },
  "test.smoke": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "test.smoke",
      urls: a.urls || [],
      routes: a.routes,
      savePath: a.screenshot,
      failFast: a["fail-fast"] || false,
      ...baseMsg,
    };
  },
};
