export const ACCESSIBILITY_MESSAGE_TYPES: Readonly<{
  GENERATE_TREE: "lens.page.generateAccessibilityTree";
  GET_ELEMENT_COORDINATES: "lens.element.getCoordinates";
  GET_ELEMENT_INFO_FOR_FILL: "lens.element.getFillInfo";
  SET_SELECT_VALUE: "lens.element.setSelectValue";
  GET_PAGE_TEXT: "page.text";
}>;

export const ACCESSIBILITY_BRIDGE_GLOBALS: Readonly<{
  HANDLE_MESSAGE: "__lensHandleMessage";
  GET_TREE: "__lensGetTree";
  GET_TEXT: "__lensGetText";
  GET_COORDS: "__lensGetCoords";
  GET_FILL_INFO: "__lensGetFillInfo";
  SET_SELECT: "__lensSetSelect";
}>;

export function normalizeAccessibilityTreeOptions(options?: {
  filter?: "all" | "interactive";
  depth?: number;
  compact?: boolean;
  refId?: string;
  includeText?: boolean;
  forceFullSnapshot?: boolean;
  format?: "yaml";
}): {
  filter: "all" | "interactive";
  depth: number;
  compact: boolean;
  refId?: string;
  includeText: boolean;
  forceFullSnapshot: boolean;
  format?: "yaml";
};

export function buildGenerateAccessibilityTreeMessage(options?: {
  filter?: "all" | "interactive";
  depth?: number;
  compact?: boolean;
  refId?: string;
  includeText?: boolean;
  forceFullSnapshot?: boolean;
  format?: "yaml";
}): {
  type: typeof ACCESSIBILITY_MESSAGE_TYPES.GENERATE_TREE;
  options: ReturnType<typeof normalizeAccessibilityTreeOptions>;
};

declare const accessibilityContract: {
  ACCESSIBILITY_MESSAGE_TYPES: typeof ACCESSIBILITY_MESSAGE_TYPES;
  ACCESSIBILITY_BRIDGE_GLOBALS: typeof ACCESSIBILITY_BRIDGE_GLOBALS;
  normalizeAccessibilityTreeOptions: typeof normalizeAccessibilityTreeOptions;
  buildGenerateAccessibilityTreeMessage: typeof buildGenerateAccessibilityTreeMessage;
};

export default accessibilityContract;
