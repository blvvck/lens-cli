module.exports = {
  capture: function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "screenshot",
      savePath: a.savePath || a.output,
      annotate: a.annotate || false,
      fullpage: a.fullpage || false,
      maxHeight: a["max-height"] || 4000,
      fullRes: a.full || false,
      maxSize: a["max-size"] || 1200,
      ref: a.ref,
      selector: a.selector,
      ...baseMsg,
    };
  },
  screenshot: function (args, context) {
    const a = args || {};
    const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
    const baseMsg = { tabId };
    return {
      type: "screenshot",
      savePath: a.savePath || a.output,
      annotate: a.annotate || false,
      fullpage: a.fullpage || false,
      maxHeight: a["max-height"] || 4000,
      fullRes: a.full || false,
      maxSize: a["max-size"] || 1200,
      ref: a.ref,
      selector: a.selector,
      ...baseMsg,
    };
  },
  "upload.image": function (args, context) {
    const a = args || {};
    const { tabId } = context;
    const baseMsg = { tabId };
    return {
      type: "upload.image",
      screenshotId: a["screenshot-id"] || a.screenshotId,
      ref: a.ref,
      coordinate: a.coordinate || (a.x !== undefined && a.y !== undefined ? { x: Number(a.x), y: Number(a.y) } : undefined),
      filename: a.filename,
      ...baseMsg,
    };
  },
};
