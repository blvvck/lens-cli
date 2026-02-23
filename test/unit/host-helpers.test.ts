// @ts-expect-error - CommonJS module without type definitions
import * as helpers from "../../native/routing/index.cjs";

describe("mapToolToMessage", () => {
  describe("browser action policy options", () => {
    it("maps click --scroll off onto CLICK_REF messages", () => {
      const msg = helpers.mapToolToMessage("click", { ref: "e5", scroll: "off" });
      expect(msg.type).toBe("page.click");
      expect(msg.scroll).toBe("off");
    });

    it("maps type --ref --scroll off through FORM_FILL", () => {
      const msg = helpers.mapToolToMessage("type", { text: "hello", ref: "e5", scroll: "off" });
      expect(msg.type).toBe("form.fill");
      expect(msg.scroll).toBe("off");
    });

    it("maps hover --ref through the ref-aware handler and keeps scroll mode", () => {
      const msg = helpers.mapToolToMessage("hover", { ref: "e5", scroll: "off" });
      expect(msg.type).toBe("lens.page.hoverRef");
      expect(msg.scroll).toBe("off");
    });
  });

  describe("window commands", () => {
    it("maps window.new to WINDOW_NEW with url", () => {
      const msg = helpers.mapToolToMessage("window.new", { url: "https://example.com" });
      expect(msg.type).toBe("window.new");
      expect(msg.url).toBe("https://example.com");
    });

    it("parses window dimensions as integers", () => {
      const msg = helpers.mapToolToMessage("window.new", { width: "1280", height: "720" });
      expect(msg.width).toBe(1280);
      expect(msg.height).toBe(720);
    });

    it("maps window.new --incognito", () => {
      const msg = helpers.mapToolToMessage("window.new", { incognito: true });
      expect(msg.incognito).toBe(true);
    });

    it("maps window.new --unfocused to focused: false", () => {
      const msg = helpers.mapToolToMessage("window.new", { unfocused: true });
      expect(msg.focused).toBe(false);
    });

    it("maps window.list with --tabs", () => {
      const msg = helpers.mapToolToMessage("window.list", { tabs: true });
      expect(msg.type).toBe("window.list");
      expect(msg.includeTabs).toBe(true);
    });

    it("throws on window.focus without id", () => {
      expect(() => helpers.mapToolToMessage("window.focus", {})).toThrow("window id required");
    });

    it("throws on window.close without id", () => {
      expect(() => helpers.mapToolToMessage("window.close", {})).toThrow("window id required");
    });

    it("throws on window.resize without --id", () => {
      expect(() => helpers.mapToolToMessage("window.resize", { width: 800 })).toThrow(
        "--id required",
      );
    });

    it("parses window.focus id as integer", () => {
      const msg = helpers.mapToolToMessage("window.focus", { id: "123456" });
      expect(msg.windowId).toBe(123456);
    });
  });

  describe("extension commands", () => {
    it("maps extension.reload without a tab id", () => {
      expect(helpers.mapToolToMessage("extension.reload", {})).toEqual({
        type: "extension.reload",
      });
    });
  });

  describe("tab commands with windowId", () => {
    it("maps tab.list to LIST_TABS", () => {
      const msg = helpers.mapToolToMessage("tab.list", {});
      expect(msg.type).toBe("tab.list");
    });

    it("maps tab.new with url", () => {
      const msg = helpers.mapToolToMessage("tab.new", { url: "https://example.com" });
      expect(msg.type).toBe("tab.new");
      expect(msg.url).toBe("https://example.com");
    });
  });

  describe("error cases", () => {
    it("returns null for unknown tool", () => {
      expect(helpers.mapToolToMessage("unknown.command", {})).toBeNull();
    });

    it("returns null for removed browser ai wrappers", () => {
      expect(helpers.mapToolToMessage("chatgpt", { query: "hi" })).toBeNull();
      expect(helpers.mapToolToMessage("gemini", { query: "hi" })).toBeNull();
      expect(helpers.mapToolToMessage("perplexity", { query: "hi" })).toBeNull();
      expect(helpers.mapToolToMessage("grok", { query: "hi" })).toBeNull();
      expect(helpers.mapToolToMessage("ai", { query: "hi" })).toBeNull();
    });
  });
});

describe("formatToolContent", () => {
  describe("window responses", () => {
    it("formats window.new success", () => {
      const result = helpers.formatToolContent({
        success: true,
        windowId: 123,
        tabId: 456,
        hint: "Use --window-id 123",
      });
      expect(result[0].text).toContain("Window 123");
      expect(result[0].text).toContain("tab 456");
      expect(result[0].text).toContain("--window-id 123");
    });

    it("formats window.list as JSON", () => {
      const result = helpers.formatToolContent({
        windows: [{ id: 1, tabCount: 2 }],
      });
      const parsed = JSON.parse(result[0].text);
      expect(parsed.windows).toHaveLength(1);
      expect(parsed.windows[0].id).toBe(1);
    });
  });

  describe("hint handling", () => {
    it("appends _hint to output", () => {
      const result = helpers.formatToolContent({
        success: true,
        _hint: "Try this next",
      });
      expect(result[0].text).toContain("[hint] Try this next");
    });

    it("strips _resolvedTabId from JSON output", () => {
      const result = helpers.formatToolContent({
        someData: "value",
        _resolvedTabId: 123,
        _hint: "hint",
      });
      expect(result[0].text).not.toContain("_resolvedTabId");
    });
  });

  describe("basic responses", () => {
    it("returns OK for simple success", () => {
      const result = helpers.formatToolContent({ success: true });
      expect(result[0].text).toBe("OK");
    });

    it("returns OK for null/undefined", () => {
      expect(helpers.formatToolContent(null)[0].text).toBe("OK");
      expect(helpers.formatToolContent(undefined)[0].text).toBe("OK");
    });
  });

  describe("tab isolation flags", () => {
    it("marks open --new-tab so the extension creates a tab", () => {
      const msg = helpers.mapToolToMessage("open", { url: "https://example.com", "new-tab": true });
      expect(msg.type).toBe("open");
      expect(msg.newTab).toBe(true);
    });

    it("leaves open without the flag reusing its resolved tab", () => {
      const msg = helpers.mapToolToMessage("open", { url: "https://example.com" });
      expect(msg.newTab).toBeUndefined();
    });

    it("carries --use-active-tab through every mapped message", () => {
      const read = helpers.mapToolToMessage("page.inspect", { "use-active-tab": true });
      const click = helpers.mapToolToMessage("click", { ref: "e1", "use-active-tab": true });
      expect(read.useActiveTab).toBe(true);
      expect(click.useActiveTab).toBe(true);
    });

    it("does not set the opt-in when the flag is absent", () => {
      const msg = helpers.mapToolToMessage("page.inspect", {});
      expect(msg.useActiveTab).toBeUndefined();
    });
  });

  describe("workspace selection", () => {
    it("maps the workspace commands", () => {
      expect(helpers.mapToolToMessage("workspace.use", { name: "nova" }).type).toBe(
        "workspace.use",
      );
      expect(helpers.mapToolToMessage("workspace.list", {}).type).toBe("workspace.list");
      expect(helpers.mapToolToMessage("workspace.close", { name: "nova" }).name).toBe("nova");
    });

    it("attaches --workspace to any mapped message", () => {
      const msg = helpers.mapToolToMessage("page.inspect", { workspace: "nova" });
      expect(msg.workspace).toBe("nova");
    });

    it("falls back to LENS_WORKSPACE", () => {
      const previous = process.env.LENS_WORKSPACE;
      process.env.LENS_WORKSPACE = "luna";
      try {
        expect(helpers.mapToolToMessage("click", { ref: "e1" }).workspace).toBe("luna");
      } finally {
        // Empty is falsy, so it selects nothing - no need to delete the variable.
        process.env.LENS_WORKSPACE = previous ?? "";
      }
    });

    it("leaves workspace unset when nothing selects one", () => {
      expect(helpers.mapToolToMessage("click", { ref: "e1" }).workspace).toBeUndefined();
    });
  });

  describe("click.type options", () => {
    it("forwards --double, and defaults it off", () => {
      expect(helpers.mapToolToMessage("click.type", { ref: "e1", double: true }).doubleClick).toBe(
        true,
      );
      expect(helpers.mapToolToMessage("click.type", { ref: "e1" }).doubleClick).toBe(false);
    });

    it("accepts coordinates as a comma-separated string", () => {
      const msg = helpers.mapToolToMessage("click.type", { coordinate: "459,277", text: "x" });
      expect(msg.coordinate).toEqual([459, 277]);
    });
  });
});
