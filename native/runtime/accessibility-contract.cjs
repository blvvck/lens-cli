const ACCESSIBILITY_MESSAGE_TYPES = Object.freeze({
  GENERATE_TREE: "lens.page.generateAccessibilityTree",
  GET_ELEMENT_COORDINATES: "lens.element.getCoordinates",
  GET_ELEMENT_INFO_FOR_FILL: "lens.element.getFillInfo",
  SET_SELECT_VALUE: "lens.element.setSelectValue",
  GET_PAGE_TEXT: "page.text",
  GET_PAGE_STATE: "lens.page.getState",
});

const ACCESSIBILITY_BRIDGE_GLOBALS = Object.freeze({
  HANDLE_MESSAGE: "__lensHandleMessage",
  GET_TREE: "__lensGetTree",
  GET_TEXT: "__lensGetText",
  GET_STATE: "__lensGetPageState",
  HAS_HANDLERS: "__lensHasAccessibilityHandlers",
  GET_COORDS: "__lensGetCoords",
  GET_FILL_INFO: "__lensGetFillInfo",
  SET_SELECT: "__lensSetSelect",
});

function normalizeAccessibilityTreeOptions(options = {}) {
  return {
    filter: options.filter === "all" ? "all" : "interactive",
    depth: options.depth ?? 15,
    compact: options.compact ?? false,
    refId: options.refId,
    includeText: options.includeText ?? true,
    forceFullSnapshot: options.forceFullSnapshot ?? false,
    ...(options.format ? { format: options.format } : {}),
  };
}

function buildGenerateAccessibilityTreeMessage(options = {}) {
  return {
    type: ACCESSIBILITY_MESSAGE_TYPES.GENERATE_TREE,
    options: normalizeAccessibilityTreeOptions(options),
  };
}

module.exports = {
  ACCESSIBILITY_MESSAGE_TYPES,
  ACCESSIBILITY_BRIDGE_GLOBALS,
  normalizeAccessibilityTreeOptions,
  buildGenerateAccessibilityTreeMessage,
};
