import { describe, expect, it } from "vitest";

// @ts-expect-error CommonJS module without type definitions
import * as registry from "../../native/commands/registry.cjs";

describe("command registry", () => {
  it("resolves primary args from canonical commands", () => {
    expect(registry.getPrimaryArgKey("open")).toBe("url");
    expect(registry.getPrimaryArgKey("page.inspect")).toBeUndefined();
    expect(registry.getPrimaryArgKey("locate.role")).toBe("role");
  });

  it("captures runtime targets for help-visible commands", () => {
    expect(registry.getCommandRuntimeTarget("open")).toBe("socket");
    expect(registry.getCommandRuntimeTarget("extension.reload")).toBe("socket");
    expect(registry.getCommandRuntimeTarget("publish")).toBe("native");
  });

  it("exposes help metadata through canonical command lookup", () => {
    const open = registry.getCommandMetadata("open");
    expect(open?.canonicalName).toBe("open");
    expect(open?.helpGroup).toBe("nav");
    expect(open?.help.desc).toBe(
      "Navigate to a URL in the current tab, or open it in a new tab with --new-tab.",
    );
  });

  it("documents the extension reload command", () => {
    expect(registry.getCommandMetadata("extension.reload")?.help.desc).toBe(
      "Reload the Lens Chrome extension.",
    );
  });

  it("pins help strings for shipped command modules", () => {
    expect(registry.getCommandMetadata("headless.start")?.help.desc).toBe(
      "Start the local headless browser daemon.",
    );
    expect(registry.getCommandMetadata("bisect")?.help.desc).toBe(
      "Find the first commit that introduced a visual change using screenshot comparisons.",
    );
  });

  it("advertises the scroll policy flag on shipped ergonomics commands", () => {
    expect(registry.getCommandMetadata("click")?.help.opts?.scroll).toContain("auto|off");
    expect(registry.getCommandMetadata("type")?.help.opts?.scroll).toContain("auto|off");
    expect(registry.getCommandMetadata("hover")?.help.opts?.scroll).toContain("auto|off");
  });

  it("keeps shipped form helpers listed with their runtime metadata", () => {
    expect(registry.getCommandRuntimeTarget("dropdown.choose")).toBe("socket");
    expect(registry.getCommandMetadata("dropdown.choose")?.help.opts?.by).toContain("text|value");
    expect(registry.getCommandRuntimeTarget("form.fill")).toBe("socket");
  });

  it("does not advertise removed browser ai wrappers in help metadata", () => {
    expect(registry.getCommandMetadata("chatgpt")).toBeNull();
    expect(registry.getCommandMetadata("gemini")).toBeNull();
    expect(registry.getCommandMetadata("perplexity")).toBeNull();
    expect(registry.getCommandMetadata("grok")).toBeNull();
    expect(registry.getCommandMetadata("ai")).toBeNull();
  });
});
