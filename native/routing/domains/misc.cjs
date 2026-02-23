module.exports = {
  "tab.list": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "tab.list" };
  },
  "tab.new": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "tab.new",
      url: a.url,
      urls: a.urls,
      background: a.background,
    };
  },
  "tab.switch": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    {
      const id = a.id || a.tab_id || a.tabId;
      if (typeof id === "string" && !/^\d+$/.test(id)) {
        return { type: "tab.switchByName", name: id };
      }
      return { type: "tab.switch", tabId: id };
    }
  },
  "tab.close": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    {
      const id = a.id || a.tab_id || a.tabId;
      const ids = a.ids || a.tab_ids || a.tabIds;
      if (typeof id === "string" && !/^\d+$/.test(id)) {
        return { type: "tab.closeByName", name: id };
      }
      return { type: "tab.close", tabId: id, tabIds: ids };
    }
  },
  "tab.name": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "tab.name", name: a.name, ...baseMsg };
  },
  "tab.unname": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "tab.unname", name: a.name };
  },
  "tab.named": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "tab.named" };
  },
  "tab.agent": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "tab.agent" };
  },
  "tab.agent.set": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    {
      const id = a.id || a.tabId || a.tab_id;
      return { type: "tab.agent.set", tabId: parseInt(id, 10) };
    }
  },
  "tab.agent.release": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    {
      const id = a.id || a.tabId || a.tab_id;
      return {
        type: "tab.agent.release",
        tabId: id ? parseInt(id, 10) : undefined,
      };
    }
  },
  "scroll.top": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "lens.scroll.position",
      position: "top",
      selector: a.selector,
      ...baseMsg,
    };
  },
  "scroll.bottom": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "lens.scroll.position",
      position: "bottom",
      selector: a.selector,
      ...baseMsg,
    };
  },
  "scroll.info": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "scroll.info", selector: a.selector, ...baseMsg };
  },
  "scroll.position": function (args, context) {
    const a = args || {};
    const { tabId } = context;
    return { type: "lens.scroll.position", position: a.position, selector: a.selector, tabId };
  },
  "scroll.to": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "scroll.to", ref: a.ref, ...baseMsg };
  },
  "page.inspect": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "page.inspect",
      options: {
        filter: a.filter || "interactive",
        refId: a.ref,
        includeText: a["no-text"] !== true,
        depth: a.depth !== undefined ? parseInt(a.depth, 10) : undefined,
        compact: a.compact || false,
      },
      wait: a.wait !== undefined ? parseInt(a.wait, 10) : undefined,
      ...baseMsg,
    };
  },
  "page.text": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "page.text", ...baseMsg };
  },
  "tab.group": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    {
      const tabIds = a.tabs
        ? String(a.tabs)
            .split(",")
            .map((id) => parseInt(id.trim(), 10))
            .filter((id) => !isNaN(id))
        : [];
      return {
        type: "tab.group",
        name: a.name,
        tabIds,
        color: a.color || "blue",
        ...baseMsg,
      };
    }
  },
  "tab.ungroup": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    {
      const tabIds = a.tabs
        ? String(a.tabs)
            .split(",")
            .map((id) => parseInt(id.trim(), 10))
            .filter((id) => !isNaN(id))
        : [];
      return { type: "tab.ungroup", tabIds, ...baseMsg };
    }
  },
  "tab.groups": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "tab.groups" };
  },
  "tab.reload": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "tab.reload", hard: a.hard || false, ...baseMsg };
  },
  "extension.reload": function () {
    return { type: "extension.reload" };
  },
};
