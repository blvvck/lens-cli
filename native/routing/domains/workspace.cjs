module.exports = {
  "workspace.create": function (args) {
    const a = args || {};
    if (!a.name) throw new Error("workspace name required");
    return {
      type: "workspace.create",
      name: a.name,
      url: a.url,
      focused: a.focused === true,
      newWindow: a["new-window"] === true,
    };
  },
  "workspace.use": function (args) {
    const a = args || {};
    if (!a.name) throw new Error("workspace name required");
    return { type: "workspace.use", name: a.name };
  },
  "workspace.list": function () {
    return { type: "workspace.list" };
  },
  "workspace.info": function (args) {
    const a = args || {};
    return { type: "workspace.info", name: a.name };
  },
  "workspace.queue": function () {
    return { type: "workspace.queue" };
  },
  "workspace.close": function (args) {
    const a = args || {};
    if (!a.name) throw new Error("workspace name required");
    return { type: "workspace.close", name: a.name };
  },
};
