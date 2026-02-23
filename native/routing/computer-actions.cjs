module.exports = {
  "screenshot": function(args, context) {
  const a = args || {};
  const { action, text, scroll_direction, scroll_amount, start_coordinate, ref, duration, modifiers } = a;
  const { tabId } = context;
  const actionPolicy = context.buildActionPolicy(a);
  const coordinate = a.coordinate || (a.x !== undefined && a.y !== undefined ? [a.x, a.y] : undefined);
  const baseMsg = { tabId };
  return { type: "screenshot", ...baseMsg };
},
  "click": function(args, context) {
  const a = args || {};
  const { tabId } = context;
  const button = a.button || "left";
  const actionPolicy = context.buildActionPolicy(a);
  const coordinate = a.coordinate || (a.x !== undefined && a.y !== undefined ? [a.x, a.y] : undefined);
  const baseMsg = { tabId };
  if (!["left", "right", "double", "triple"].includes(button)) throw new Error("button must be left, right, double, or triple");
  if (a.ref) return { type: "page.click", ref: a.ref, button, ...actionPolicy, ...baseMsg };
  if (a.selector) return { type: "lens.element.clickSelector", selector: a.selector, index: a.index || 0, button, ...actionPolicy, ...baseMsg };
  const clickTypes = {
    left: "lens.page.executeClick",
    right: "lens.page.executeRightClick",
    double: "lens.page.executeDoubleClick",
    triple: "lens.page.executeTripleClick",
  };
  return { type: clickTypes[button], x: coordinate?.[0], y: coordinate?.[1], modifiers: a.modifiers, ...actionPolicy, ...baseMsg };
},
  "type": function(args, context) {
  const a = args || {};
  const { action, text, scroll_direction, scroll_amount, start_coordinate, ref, duration, modifiers } = a;
  const { tabId } = context;
  const actionPolicy = context.buildActionPolicy(a);
  const coordinate = a.coordinate || (a.x !== undefined && a.y !== undefined ? [a.x, a.y] : undefined);
  const baseMsg = { tabId };
  if (a.submit && ref) return { type: "lens.page.clickTypeSubmit", text, ref, submitKey: a.submitKey || "Enter", ...baseMsg };
  if (a.submit) return { type: "lens.input.typeSubmit", text, submitKey: a.submitKey || "Enter", ...baseMsg };
  if (ref) {
          return { type: "form.fill", data: [{ ref, value: text }], ...actionPolicy, ...baseMsg };
        }
  return { type: "lens.page.executeType", text, ...actionPolicy, ...baseMsg };
},
  "key": function(args, context) {
  const a = args || {};
  const { action, text, scroll_direction, scroll_amount, start_coordinate, ref, duration, modifiers } = a;
  const { tabId } = context;
  const actionPolicy = context.buildActionPolicy(a);
  const coordinate = a.coordinate || (a.x !== undefined && a.y !== undefined ? [a.x, a.y] : undefined);
  const baseMsg = { tabId };
  {
        const keyValue = a.key || text;
        
        const repeatCount = Math.min(100, Math.max(1, a.times || a.repeat || 1));
        const delayMs = Math.min(5000, Math.max(0, a["delay-ms"] || a.delayMs || 50));
        if (repeatCount > 1) {
          return { type: "lens.input.repeatKey", key: keyValue, repeat: repeatCount, delayMs, tabId };
        }
        return { type: "lens.input.key", key: keyValue, ...baseMsg };
      }
},
  "click.type": function(args, context) {
  const a = args || {};
  const { action, text, scroll_direction, scroll_amount, start_coordinate, ref, duration, modifiers } = a;
  const { tabId } = context;
  const actionPolicy = context.buildActionPolicy(a);
  const rawCoord = a.coordinate || (a.x !== undefined && a.y !== undefined ? [a.x, a.y] : undefined);
  const coordinate = typeof rawCoord === "string" ? rawCoord.split(",").map(Number) : rawCoord;
  const baseMsg = { tabId };
  return { type: "lens.page.clickType", text, ref, coordinate, doubleClick: !!a.double, ...baseMsg };
},
  "click.typeSubmit": function(args, context) {
  const a = args || {};
  const { action, text, scroll_direction, scroll_amount, start_coordinate, ref, duration, modifiers } = a;
  const { tabId } = context;
  const actionPolicy = context.buildActionPolicy(a);
  const coordinate = a.coordinate || (a.x !== undefined && a.y !== undefined ? [a.x, a.y] : undefined);
  const baseMsg = { tabId };
  return { type: "lens.page.clickTypeSubmit", text, ref, coordinate, submitKey: a.submitKey || "Enter", ...baseMsg };
},
  "form.find": function(args, context) {
  const a = args || {};
  const { action, text, scroll_direction, scroll_amount, start_coordinate, ref, duration, modifiers } = a;
  const { tabId } = context;
  const actionPolicy = context.buildActionPolicy(a);
  const coordinate = a.coordinate || (a.x !== undefined && a.y !== undefined ? [a.x, a.y] : undefined);
  const baseMsg = { tabId };
  return { type: "lens.find.findAndType", text, submit: a.submit ?? false, submitKey: a.submitKey || "Enter", ...baseMsg };
},
  "scroll": function(args, context) {
  const a = args || {};
  const { action, text, scroll_direction, scroll_amount, start_coordinate, ref, duration, modifiers } = a;
  const { tabId } = context;
  const actionPolicy = context.buildActionPolicy(a);
  const coordinate = a.coordinate || (a.x !== undefined && a.y !== undefined ? [a.x, a.y] : undefined);
  const baseMsg = { tabId };
  {
        const amount = (scroll_amount || 3) * 100;
        const deltas = {
          up: { deltaX: 0, deltaY: -amount },
          down: { deltaX: 0, deltaY: amount },
          left: { deltaX: -amount, deltaY: 0 },
          right: { deltaX: amount, deltaY: 0 },
        };
        const { deltaX, deltaY } = deltas[scroll_direction] || { deltaX: 0, deltaY: 0 };
        return { type: "lens.page.scroll", deltaX, deltaY, x: coordinate?.[0], y: coordinate?.[1], ...baseMsg };
      }
},
  "hover": function(args, context) {
  const a = args || {};
  const { action, text, scroll_direction, scroll_amount, start_coordinate, ref, duration, modifiers } = a;
  const { tabId } = context;
  const actionPolicy = context.buildActionPolicy(a);
  const coordinate = a.coordinate || (a.x !== undefined && a.y !== undefined ? [a.x, a.y] : undefined);
  const baseMsg = { tabId };
  if (ref) return { type: "lens.page.hoverRef", ref, ...actionPolicy, ...baseMsg };
  return { type: "lens.page.executeHover", x: coordinate?.[0], y: coordinate?.[1], ...actionPolicy, ...baseMsg };
},
  "drag": function(args, context) {
  const a = args || {};
  const { tabId } = context;
  const parsePoint = (value) => {
    if (Array.isArray(value)) return value.map(Number);
    if (typeof value === "string") return value.split(",").map((part) => Number(part.trim()));
    if (value && typeof value === "object") return [Number(value.x), Number(value.y)];
    return [];
  };
  const [startX, startY] = parsePoint(a.from);
  const [endX, endY] = parsePoint(a.to);
  if (![startX, startY, endX, endY].every(Number.isFinite)) throw new Error("--from and --to must be x,y coordinates");
  const baseMsg = { tabId };
  return { type: "lens.page.executeDrag", startX, startY, endX, endY, modifiers: a.modifiers, ...baseMsg };
},
  "wait": function(args, context) {
  const a = args || {};
  const { action, text, scroll_direction, scroll_amount, start_coordinate, ref, duration, modifiers } = a;
  const { tabId } = context;
  const actionPolicy = context.buildActionPolicy(a);
  const coordinate = a.coordinate || (a.x !== undefined && a.y !== undefined ? [a.x, a.y] : undefined);
  const baseMsg = { tabId };
  return { type: "wait", seconds: Math.min(30, duration || 1) };
},
  "zoom": function(args, context) {
  const a = args || {};
  const { action, text, scroll_direction, scroll_amount, start_coordinate, ref, duration, modifiers } = a;
  const { tabId } = context;
  const actionPolicy = context.buildActionPolicy(a);
  const coordinate = a.coordinate || (a.x !== undefined && a.y !== undefined ? [a.x, a.y] : undefined);
  const baseMsg = { tabId };
  if (a.reset) return { type: "zoom.reset", tabId };
  if (a.level !== undefined) return { type: "zoom.set", level: parseFloat(a.level), tabId };
  return { type: "zoom.get", tabId };
},
};
