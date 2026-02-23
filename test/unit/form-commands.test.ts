// @ts-expect-error - CommonJS module without type definitions
import * as helpers from "../../native/routing/index.cjs";

describe("form commands", () => {
  describe("dropdown.choose", () => {
    it("maps dropdown.choose with label to DROPDOWN_CHOOSE", () => {
      const msg = helpers.mapToolToMessage("dropdown.choose", { label: "Country", value: "USA" });
      expect(msg.type).toBe("dropdown.choose");
      expect(msg.target).toBe("Country");
      expect(msg.value).toBe("USA");
      expect(msg.useLabel).toBe(true);
      expect(msg.by).toBe("text");
    });

    it("maps dropdown.choose with selector to DROPDOWN_CHOOSE", () => {
      const msg = helpers.mapToolToMessage("dropdown.choose", { selector: "#country-select", value: "USA" });
      expect(msg.type).toBe("dropdown.choose");
      expect(msg.target).toBe("#country-select");
      expect(msg.value).toBe("USA");
      expect(msg.useLabel).toBe(false);
    });

    it("maps dropdown.choose with positional args", () => {
      const msg = helpers.mapToolToMessage("dropdown.choose", { _: "Country", _2: "USA" });
      expect(msg.type).toBe("dropdown.choose");
      expect(msg.target).toBe("Country");
      expect(msg.value).toBe("USA");
      expect(msg.useLabel).toBe(true);
    });

    it("supports --by value for matching option value", () => {
      const msg = helpers.mapToolToMessage("dropdown.choose", { label: "Country", value: "us", by: "value" });
      expect(msg.by).toBe("value");
    });

    it("detects CSS selector and disables useLabel", () => {
      const msg = helpers.mapToolToMessage("dropdown.choose", { _: "#country", _2: "USA" });
      expect(msg.useLabel).toBe(false);
    });

    it("detects attribute selector and disables useLabel", () => {
      const msg = helpers.mapToolToMessage("dropdown.choose", { _: "[name=country]", _2: "USA" });
      expect(msg.useLabel).toBe(false);
    });

    it("includes action policy options", () => {
      const msg = helpers.mapToolToMessage("dropdown.choose", {
        label: "Country",
        value: "USA",
        retry: 5,
        "retry-delay": 500,
        "wait-ready": true,
      });
      // Action policy options are spread via buildActionPolicy
      expect(msg.retry).toBe(5);
      expect(msg.retryDelay).toBe(500);
      expect(msg.waitReady).toBe(true);
    });

    it("throws without target", () => {
      expect(() => helpers.mapToolToMessage("dropdown.choose", { value: "USA" })).toThrow("label-or-selector argument required");
    });

    it("throws without value", () => {
      expect(() => helpers.mapToolToMessage("dropdown.choose", { label: "Country" })).toThrow("value argument required");
    });
  });

  describe("form.fill", () => {
    it("maps form.fill with JSON object data", () => {
      const data = { name: "John", email: "john@example.com" };
      const msg = helpers.mapToolToMessage("form.fill", { data: JSON.stringify(data) });
      expect(msg.type).toBe("form.fill");
      expect(msg.data).toEqual({ name: "John", email: "john@example.com" });
    });

    it("maps form.fill with JSON array data", () => {
      const data = [{ ref: "name", value: "John" }, { ref: "email", value: "john@example.com" }];
      const msg = helpers.mapToolToMessage("form.fill", { data: JSON.stringify(data) });
      expect(msg.type).toBe("form.fill");
      expect(msg.data).toEqual([
        { ref: "name", value: "John" },
        { ref: "email", value: "john@example.com" },
      ]);
    });

    it("includes action policy options", () => {
      const msg = helpers.mapToolToMessage("form.fill", {
        data: JSON.stringify({ name: "John" }),
        retry: 3,
        "retry-delay": 250,
        "wait-ready": true,
        verify: true,
      });
      expect(msg.retry).toBe(3);
      expect(msg.retryDelay).toBe(250);
      expect(msg.waitReady).toBe(true);
      expect(msg.verify).toBe(true);
    });

    it("throws when no data provided", () => {
      expect(() => helpers.mapToolToMessage("form.fill", {})).toThrow("data argument required");
    });

    it("throws on invalid JSON", () => {
      expect(() => helpers.mapToolToMessage("form.fill", { data: "not-json" })).toThrow("invalid --data JSON");
    });
  });
});

describe("form command formatters", () => {
  it("formats dropdown.choose success with single selection", () => {
    const result = helpers.formatToolContent({
      success: true,
      selected: "United States",
      value: "us",
      changed: true,
    });
    expect(result[0].text).toBe("Selected: United States");
  });

  it("formats dropdown.choose success with multiple selection", () => {
    const result = helpers.formatToolContent({
      success: true,
      selected: ["USA", "Canada"],
      changed: true,
    });
    expect(result[0].text).toBe("Selected: USA, Canada");
  });

  it("formats dropdown.choose with warning", () => {
    const result = helpers.formatToolContent({
      success: true,
      selected: "Option1",
      warning: "partial match",
    });
    expect(result[0].text).toContain("Selected: Option1");
    expect(result[0].text).toContain("[Warning: partial match]");
  });

  it("formats dropdown.choose error", () => {
    const result = helpers.formatToolContent({
      error: "Option not found",
      availableOptions: ["USA", "Canada", "Mexico"],
    });
    // Generic error formatting returns JSON
    expect(result[0].text).toContain("not found");
  });

  it("formats form.fill success as OK (simple success)", () => {
    const result = helpers.formatToolContent({
      success: true,
      filled: 3,
      failed: 0,
    });
    // Simple success returns "OK"
    expect(result[0].text).toBe("OK");
  });

  it("formats form.fill with failures as JSON", () => {
    const result = helpers.formatToolContent({
      success: false,
      filled: 1,
      failed: 2,
      results: [
        { ref: "name", success: true },
        { ref: "email", success: false, error: "Field not found" },
        { ref: "phone", success: false, error: "Invalid format" },
      ],
    });
    const parsed = JSON.parse(result[0].text);
    expect(parsed.filled).toBe(1);
    expect(parsed.failed).toBe(2);
    expect(parsed.results[1].ref).toBe("email");
  });
});
