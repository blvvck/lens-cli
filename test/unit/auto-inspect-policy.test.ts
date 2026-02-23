import { describe, expect, it } from "vitest";

// @ts-expect-error CommonJS module without type definitions
import * as autoInspectPolicy from "../../native/runtime/auto-inspect-policy.cjs";

describe("auto inspect policy", () => {
  it("enables auto-inspect for supported action tools", () => {
    expect(autoInspectPolicy.shouldAutoInspectTool("click")).toBe(true);
    expect(autoInspectPolicy.shouldAutoInspectTool("form.fill")).toBe(true);
    expect(autoInspectPolicy.shouldAutoInspectTool("scroll.bottom")).toBe(true);
  });

  it("disables auto-inspect for unsupported tools or explicit noInspect", () => {
    expect(autoInspectPolicy.shouldAutoInspectTool("page.inspect")).toBe(false);
    expect(autoInspectPolicy.shouldAutoInspectTool("click", { noInspect: true })).toBe(false);
  });

  it("formats page content and visible text consistently", () => {
    expect(
      autoInspectPolicy.formatAutoInspectContent({
        pageContent: "tree",
        text: "visible text",
      })
    ).toBe("tree\n\n--- Page Text ---\nvisible text");
  });

  it("falls back to tree content when pageContent is absent", () => {
    expect(
      autoInspectPolicy.formatAutoInspectContent({
        tree: "tree only",
      })
    ).toBe("tree only");
  });

  it("exports the shared settle delay", () => {
    expect(autoInspectPolicy.AUTO_INSPECT_DELAY_MS).toBe(300);
  });
});
