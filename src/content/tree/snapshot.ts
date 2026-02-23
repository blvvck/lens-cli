import { generateTextTree } from "./format";

export function generateAccessibilityTree(
  filter: "all" | "interactive" = "interactive",
  depth = 15,
  refId?: string,
  force = false,
  compact = false,
) {
  return generateTextTree(filter, depth, refId, force, compact);
}
