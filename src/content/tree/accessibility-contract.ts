export const ACCESSIBILITY_MESSAGE_TYPES = Object.freeze({
  GENERATE_TREE: "lens.page.generateAccessibilityTree",
  GET_ELEMENT_COORDINATES: "lens.element.getCoordinates",
  GET_ELEMENT_INFO_FOR_FILL: "lens.element.getFillInfo",
  SET_SELECT_VALUE: "lens.element.setSelectValue",
  GET_PAGE_TEXT: "page.text",
  GET_PAGE_STATE: "lens.page.getState",
});

type NormalizedAccessibilityTreeOptions = {
  filter: "all" | "interactive";
  depth: number;
  compact: boolean;
  refId?: string;
  includeText: boolean;
  forceFullSnapshot: boolean;
  format?: string;
};

export function normalizeAccessibilityTreeOptions(options: {
  filter?: string;
  depth?: number;
  compact?: boolean;
  refId?: string;
  includeText?: boolean;
  forceFullSnapshot?: boolean;
  format?: string;
} = {}): NormalizedAccessibilityTreeOptions {
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
