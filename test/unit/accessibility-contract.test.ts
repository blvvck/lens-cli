import { describe, expect, it } from "vitest";

import * as accessibilityContract from "../../native/runtime/accessibility-contract.cjs";

describe("accessibility contract", () => {
  it("normalizes tree options with shared defaults", () => {
    expect(accessibilityContract.normalizeAccessibilityTreeOptions({})).toEqual({
      filter: "interactive",
      depth: 15,
      compact: false,
      refId: undefined,
      includeText: true,
      forceFullSnapshot: false,
    });
  });

  it("preserves explicit tree option overrides", () => {
    expect(
      accessibilityContract.normalizeAccessibilityTreeOptions({
        filter: "all",
        depth: 5,
        compact: true,
        refId: "e7",
        includeText: false,
        forceFullSnapshot: true,
      })
    ).toEqual({
      filter: "all",
      depth: 5,
      compact: true,
      refId: "e7",
      includeText: false,
      forceFullSnapshot: true,
    });
  });

  it("builds the shared tree-generation message shape", () => {
    expect(accessibilityContract.buildGenerateAccessibilityTreeMessage({ refId: "e2" })).toEqual({
      type: accessibilityContract.ACCESSIBILITY_MESSAGE_TYPES.GENERATE_TREE,
      options: {
        filter: "interactive",
        depth: 15,
        compact: false,
        refId: "e2",
        includeText: true,
        forceFullSnapshot: false,
      },
    });
  });
});
