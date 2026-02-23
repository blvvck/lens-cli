module.exports = {
  "cookie.list": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "cookie.list", ...baseMsg };
  },
  "cookie.get": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    if (!a.name) throw new Error("--name required");
    return { type: "cookie.get", name: a.name, ...baseMsg };
  },
  "cookie.set": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    if (!a.name) throw new Error("--name required");
    if (a.value === undefined) throw new Error("--value required");
    return {
      type: "cookie.set",
      name: a.name,
      value: a.value,
      expires: a.expires,
      ...baseMsg,
    };
  },
  "cookie.clear": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    if (a.all) return { type: "cookie.clearAll", ...baseMsg };
    if (!a.name) throw new Error("--name or --all required");
    return { type: "cookie.clear", name: a.name, ...baseMsg };
  },
};
