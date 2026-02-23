module.exports = {
  serve: function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    {
      if (!a.dir)
        throw new Error(
          "directory argument required (e.g. lens serve ./my-project)",
        );
      const resolvedDir = require("path").resolve(a.dir);
      return {
        type: "lens.serve.start",
        dir: resolvedDir,
        port: a.port ? parseInt(a.port, 10) : 8100,
        ...baseMsg,
      };
    }
  },
  "serve.stop": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "lens.serve.stop",
      port: a.port ? parseInt(a.port, 10) : 8100,
      ...baseMsg,
    };
  },
  "serve.status": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "lens.serve.status", ...baseMsg };
  },
  intercept: function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    {
      if (!a.pattern)
        throw new Error(
          "URL pattern required (e.g. lens intercept \"https://api.example.com/*\" --response '{}')",
        );
      const msg = { type: "lens.intercept.add", pattern: a.pattern, ...baseMsg };
      if (a.block) msg.block = true;
      if (a.response) {
        try {
          msg.response = JSON.parse(a.response);
        } catch {
          msg.response = a.response;
        }
      }
      if (a.file) {
        msg.filePath = require("path").resolve(a.file);
        try {
          msg.fileContent = require("fs").readFileSync(msg.filePath, "utf8");
        } catch (e) {
          throw new Error(`Cannot read file: ${msg.filePath} (${e.message})`);
        }
      }
      if (a.status) msg.statusCode = parseInt(a.status, 10);
      if (a.delay) msg.delayMs = parseInt(a.delay, 10);
      if (a["content-type"]) msg.contentType = a["content-type"];
      return msg;
    }
  },
  "intercept.list": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "lens.intercept.list", ...baseMsg };
  },
  "intercept.remove": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    if (!a.pattern) throw new Error("URL pattern required");
    return { type: "lens.intercept.remove", pattern: a.pattern, ...baseMsg };
  },
  "intercept.clear": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "lens.intercept.clear", ...baseMsg };
  },
};
