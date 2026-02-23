module.exports = {
  "form.input": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "lens.form.formInput", ref: a.ref, value: a.value, ...baseMsg };
  },
  "form.find": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "lens.find.findAndType",
      text: a.text,
      submit: a.submit ?? false,
      submitKey: a.submitKey || "Enter",
      ...baseMsg,
    };
  },
  "form.autocomplete": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "lens.form.autocompleteSelect",
      text: a.text,
      ref: a.ref,
      coordinate: a.coordinate,
      index: a.index ?? 0,
      waitMs: a.waitMs ?? 500,
      ...baseMsg,
    };
  },
  "form.value": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "lens.form.setInputValue",
      selector: a.selector,
      ref: a.ref,
      value: a.value,
      ...baseMsg,
    };
  },
  "form.smart": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "form.smart",
      selector: a.selector,
      text: a.text,
      clear: a.clear ?? true,
      submit: a.submit ?? false,
      ...baseMsg,
    };
  },
  "wait.element": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "lens.wait.element",
      selector: a.selector,
      timeout: a.timeout,
      ...baseMsg,
    };
  },
  "wait.network": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "wait.network", timeout: a.timeout, ...baseMsg };
  },
  "wait.url": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "wait.url",
      pattern: a.pattern || a.url,
      timeout: a.timeout,
      ...baseMsg,
    };
  },
  "wait.text": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    if (!a.text) throw new Error("text argument required");
    return {
      type: "wait.text",
      text: a.text,
      selector: a.selector,
      timeout: a.timeout || 20000,
      ...baseMsg,
    };
  },
  "wait.dom": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "wait.dom",
      stable: a.stable || 100,
      timeout: a.timeout || 5000,
      ...baseMsg,
    };
  },
  "wait.ready": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "wait.ready",
      timeout: a.timeout || 5000,
      stable: a.stable || 100,
      dismiss: a.dismiss || false,
      selector: a.selector,
      ...baseMsg,
    };
  },
  "wait.load": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "wait.load", timeout: a.timeout || 30000, ...baseMsg };
  },
  "dropdown.choose": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    {
      const target = a.label || a.selector || a.target || a._;
      if (!target) throw new Error("label-or-selector argument required");
      const value = a.value || a._2 || a[1];
      if (!value) throw new Error("value argument required");
      return {
        type: "dropdown.choose",
        target,
        value,
        by: a.by || "text",
        useLabel:
          !!a.label ||
          (!a.selector &&
            !target.startsWith("#") &&
            !target.startsWith(".") &&
            !target.startsWith("[")),
        ...buildActionPolicy(a),
        ...baseMsg,
      };
    }
  },
  "form.fill": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    let fillData = a.data;
    if (fillData === undefined) throw new Error("--data argument required");
    if (typeof fillData === "string") {
      try {
        fillData = JSON.parse(fillData);
      } catch (e) {
        throw new Error("invalid --data JSON");
      }
    }
    return {
      type: "form.fill",
      data: fillData,
      ...buildActionPolicy(a),
      ...baseMsg,
    };
  },
  upload: function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    {
      const files = a.files
        ? typeof a.files === "string"
          ? a.files.split(",").map((f) => f.trim())
          : a.files
        : [];
      return {
        type: "upload.file",
        ref: a.ref,
        triggerRef: a.trigger,
        triggerSelector: a["trigger-selector"] || a.triggerSelector,
        files,
        timeout: a.timeout,
        ...buildActionPolicy(a),
        ...baseMsg,
      };
    }
  },
  paste: function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return { type: "lens.input.paste", text: a.text, ...baseMsg };
  },
  "locate.role": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    if (!a.role) throw new Error("role argument required");
    return {
      type: "locate.role",
      role: a.role,
      name: a.name,
      action: a.action,
      value: a.value,
      all: a.all || false,
      ...baseMsg,
    };
  },
  "locate.text": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    if (!a.text) throw new Error("text argument required");
    return {
      type: "locate.text",
      text: a.text,
      exact: a.exact || false,
      action: a.action,
      value: a.value,
      ...baseMsg,
    };
  },
  "locate.label": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    if (!a.label) throw new Error("label argument required");
    return {
      type: "locate.label",
      label: a.label,
      action: a.action,
      value: a.value,
      ...baseMsg,
    };
  },
  "element.styles": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    if (!a.selector) throw new Error("selector argument required");
    return {
      type: "element.styles",
      selector: a.selector,
      ...baseMsg,
    };
  },
  select: function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    {
      if (!a.selector) throw new Error("selector argument required");
      const values = Array.isArray(a.values)
        ? a.values
        : a.values
          ? [a.values]
          : [];
      if (values.length === 0) throw new Error("at least one value required");
      return {
        type: "select",
        selector: a.selector,
        values,
        by: a.by || "value",
        ...baseMsg,
      };
    }
  },
  wait: function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "wait",
      seconds: Math.min(30, a.duration || a.seconds || 1),
    };
  },
  type: function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return mapComputerAction({ ...a, action: tool }, tabId);
  },
  "click.type": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return mapComputerAction({ ...a, action: tool }, tabId);
  },
  "click.typeSubmit": function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return mapComputerAction({ ...a, action: tool }, tabId);
  },
  key: function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return mapComputerAction({ ...a, action: tool }, tabId);
  },
  hover: function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return mapComputerAction({ ...a, action: tool }, tabId);
  },
  drag: function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return mapComputerAction({ ...a, action: tool }, tabId);
  },
  click: function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return mapComputerAction({ ...a, action: tool }, tabId);
  },
};
