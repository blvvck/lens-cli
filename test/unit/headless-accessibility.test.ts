import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildInjectableAccessibilityScript,
  HeadlessAccessibility,
} from "../../native/headless-accessibility.cjs";

describe("headless accessibility", () => {
  beforeEach(() => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("window.__lensInjected = true;" as never);
  });

  afterEach(() => vi.restoreAllMocks());

  it("rewrites the built ESM content script into an injectable runtime bundle", () => {
    const script =
      'import{a as nt}from"../chunks/accessibility-contract-test.js";const value=nt.ACCESSIBILITY_MESSAGE_TYPES;';
    const fsRef = {
      readFileSync: vi
        .fn()
        .mockReturnValue(
          'function l(E){}var t,r;function a(){return t={ACCESSIBILITY_MESSAGE_TYPES:{"page.text":"page.text"}}}var s=a();const i=s;export{i as a,l as g};',
        ),
    };
    const pathRef = {
      dirname: vi.fn().mockReturnValue("/tmp/dist/content"),
      resolve: vi.fn().mockReturnValue("/tmp/dist/chunks/accessibility-contract-test.js"),
    };

    const result = buildInjectableAccessibilityScript(
      script,
      "/tmp/dist/content/tree/index.js",
      fsRef,
      pathRef,
    );

    expect(result).not.toContain("import{a as nt}");
    expect(result).toContain("const nt = (() => {");
    expect(result).toContain("page.text");
  });

  it("rewrites the built chunk using the actual exported alias instead of a hardcoded symbol", () => {
    const script =
      'import{a as nt}from"../chunks/accessibility-contract-test.js";const value=nt.ACCESSIBILITY_MESSAGE_TYPES;';
    const fsRef = {
      readFileSync: vi
        .fn()
        .mockReturnValue(
          'function l(E){return E}var t,T;function a(){if(T)return t;T=1;const E=Object.freeze({"page.text":"page.text"}),r=Object.freeze({GET_TREE:"__lensGetTree"});return t={ACCESSIBILITY_MESSAGE_TYPES:E,ACCESSIBILITY_BRIDGE_GLOBALS:r},t}var s=a();const n=l(s);export{n as a,l as g};',
        ),
    };
    const pathRef = {
      dirname: vi.fn().mockReturnValue("/tmp/dist/content"),
      resolve: vi.fn().mockReturnValue("/tmp/dist/chunks/accessibility-contract-test.js"),
    };

    const result = buildInjectableAccessibilityScript(
      script,
      "/tmp/dist/content/tree/index.js",
      fsRef,
      pathRef,
    );

    expect(result).toContain("return n;");
    expect(result).not.toContain("return i;");
  });

  it("reinjects the bridge after navigation when the helper globals disappear", async () => {
    const cdp = {
      addScriptOnNewDocument: vi.fn().mockResolvedValue(undefined),
      evaluateScript: vi
        .fn()
        .mockResolvedValueOnce({
          result: { value: { getTreeType: "undefined", hasHandlers: false } },
        })
        .mockResolvedValueOnce({ result: { value: true } })
        .mockResolvedValueOnce({
          result: { value: { pageContent: "tree", viewport: { width: 1, height: 1 } } },
        })
        .mockResolvedValueOnce({ result: { value: { text: "hello" } } }),
    };

    const accessibility = new HeadlessAccessibility(cdp);
    accessibility._injected = true;

    const result = await accessibility.getTree({ includeText: true });

    expect(cdp.addScriptOnNewDocument).toHaveBeenCalledTimes(1);
    expect(result.pageContent).toBe("tree");
    expect(result.text).toBe("hello");
  });

  it("reads page state through the injected bridge", async () => {
    const cdp = {
      addScriptOnNewDocument: vi.fn().mockResolvedValue(undefined),
      evaluateScript: vi
        .fn()
        .mockResolvedValueOnce({
          result: { value: { getTreeType: "function", hasHandlers: true } },
        })
        .mockResolvedValueOnce({
          result: {
            value: {
              hasModal: true,
              hasDropdown: false,
              hasDatePicker: false,
              hasOverlay: true,
              focusedElement: { tag: "input", type: "text" },
              url: "https://example.com",
              title: "Example",
            },
          },
        }),
    };

    const accessibility = new HeadlessAccessibility(cdp);
    accessibility._injected = true;

    const result = await accessibility.getPageState();

    expect(result).toEqual({
      hasModal: true,
      hasDropdown: false,
      hasDatePicker: false,
      hasOverlay: true,
      focusedElement: { tag: "input", type: "text" },
      url: "https://example.com",
      title: "Example",
    });
  });

  it("reinjects when bridge globals exist but no message handlers are registered", async () => {
    const cdp = {
      addScriptOnNewDocument: vi.fn().mockResolvedValue(undefined),
      evaluateScript: vi
        .fn()
        .mockResolvedValueOnce({
          result: { value: { getTreeType: "function", hasHandlers: false } },
        })
        .mockResolvedValueOnce({ result: { value: true } })
        .mockResolvedValueOnce({
          result: {
            value: {
              hasModal: false,
              hasDropdown: false,
              hasDatePicker: false,
              hasOverlay: false,
              focusedElement: null,
              url: "https://example.com",
              title: "Example",
            },
          },
        }),
    };

    const accessibility = new HeadlessAccessibility(cdp);
    accessibility._injected = true;

    const result = await accessibility.getPageState();

    expect(cdp.addScriptOnNewDocument).toHaveBeenCalledTimes(1);
    expect(result.title).toBe("Example");
    expect(result.url).toBe("https://example.com");
  });
});
