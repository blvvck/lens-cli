module.exports = {
  "bookmark.add": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "bookmark.add", folder: a.folder, ...baseMsg };
  },
  "bookmark.remove": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "bookmark.remove", ...baseMsg };
  },
  "bookmark.list": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "bookmark.list",
      folder: a.folder,
      limit: a.limit !== undefined ? parseInt(a.limit, 10) : 50,
    };
  },
  "history.list": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "history.list",
      limit: a.limit !== undefined ? parseInt(a.limit, 10) : 20,
    };
  },
  "history.search": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    if (!a.query) throw new Error("query required");
    return {
      type: "history.search",
      query: a.query,
      limit: a.limit !== undefined ? parseInt(a.limit, 10) : 20,
    };
  },
};
