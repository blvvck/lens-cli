module.exports = {
  "emulate.network": function(args, context) {
  const a = args || {};
  const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
  const baseMsg = { tabId };
  return { type: "emulate.network", preset: a.preset, ...baseMsg };
},
  "emulate.cpu": function(args, context) {
  const a = args || {};
  const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
  const baseMsg = { tabId };
  const cpuRate = parseFloat(a.rate);
  return { type: "emulate.cpu", rate: isNaN(cpuRate) ? 1 : cpuRate, ...baseMsg };
},
  "emulate.geo": function(args, context) {
  const a = args || {};
  const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
  const baseMsg = { tabId };
  if (a.clear) {
          return { type: "emulate.geo", clear: true, ...baseMsg };
        }
  if (a.lat === undefined || a.lon === undefined) {
          throw new Error("--lat and --lon required");
        }
  return { type: "emulate.geo", latitude: parseFloat(a.lat), longitude: parseFloat(a.lon), accuracy: parseFloat(a.accuracy) || 100, ...baseMsg };
},
  "emulate.device": function(args, context) {
  const a = args || {};
  const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
  const baseMsg = { tabId };
  if (a.list) {
          return { type: "emulate.deviceList" };
        }
  const device = a.device || (a.width && a.height ? "custom" : undefined);
  if (!device) throw new Error("device name required, or provide --width and --height for a custom device");
  return {
    type: "emulate.device",
    device,
    width: a.width ? parseInt(a.width, 10) : undefined,
    height: a.height ? parseInt(a.height, 10) : undefined,
    deviceScaleFactor: a.scale ? parseFloat(a.scale) : undefined,
    mobile: a.mobile === true || a.mobile === "true",
    touch: a.touch === true || a.touch === "true",
    userAgent: a["user-agent"],
    ...baseMsg,
  };
},
  "emulate.viewport": function(args, context) {
  const a = args || {};
  const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
  const baseMsg = { tabId };
  return { 
          type: "emulate.viewport",
          width: a.width ? parseInt(a.width, 10) : undefined,
          height: a.height ? parseInt(a.height, 10) : undefined,
          deviceScaleFactor: a.scale ? parseFloat(a.scale) : undefined,
          mobile: a.mobile,
          ...baseMsg 
        };
},
  "emulate.touch": function(args, context) {
  const a = args || {};
  const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
  const baseMsg = { tabId };
  return { type: "emulate.touch", enabled: a.enabled !== false, ...baseMsg };
},
  "zoom": function(args, context) {
  const a = args || {};
  const { tabId, tool, mapComputerAction, buildActionPolicy } = context;
  const baseMsg = { tabId };
  if (a.reset) return { type: "zoom.reset", ...baseMsg };
  if (a.level !== undefined) return { type: "zoom.set", level: parseFloat(a.level), ...baseMsg };
  return { type: "zoom.get", ...baseMsg };
},
};
