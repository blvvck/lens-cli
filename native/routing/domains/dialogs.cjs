module.exports = {
  "dialog.dismissAll": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "dialog.closeAll",
      maxAttempts: a.maxAttempts ?? 3,
      ...baseMsg,
    };
  },
  "dialog.accept": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "dialog.accept", text: a.text, ...baseMsg };
  },
  "dialog.dismiss": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    if (a.all)
      return {
        type: "dialog.closeAll",
        maxAttempts: a.maxAttempts || 3,
        ...baseMsg,
      };
    return { type: "dialog.dismiss", ...baseMsg };
  },
  "dialog.info": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "dialog.info", ...baseMsg };
  },
};
