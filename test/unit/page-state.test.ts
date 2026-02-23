import { describe, expect, it } from "vitest";
import {
  findVisibleTextMatch,
  getInteractivePageState,
  getVisibleTextObserverOptions,
} from "../../src/content/page-state";

type FakeElement = {
  _style: { display: string; visibility: string; opacity: string };
  children: FakeElement[];
  innerText?: string;
  querySelectorAll: (selector: string) => FakeElement[];
  tagName: string;
  offsetWidth: number;
  offsetHeight: number;
  ownerDocument: FakeDocument;
  textContent?: string | null;
  getAttribute: (name: string) => string | null;
};

type FakeDocument = {
  activeElement: FakeElement | null;
  defaultView: {
    getComputedStyle: (element: FakeElement) => { display: string; visibility: string; opacity: string };
  };
  location: { href: string };
  querySelectorAll: (selector: string) => FakeElement[];
  title: string;
};

function createElement(
  doc: FakeDocument,
  {
    tag = "DIV",
    attrs = {},
    width = 100,
    height = 40,
    innerText,
    style = {},
    textContent,
  }: {
    tag?: string;
    attrs?: Record<string, string>;
    width?: number;
    height?: number;
    innerText?: string;
    style?: Partial<{ display: string; visibility: string; opacity: string }>;
    textContent?: string;
  } = {},
): FakeElement {
  const computed = {
    display: style.display || "block",
    visibility: style.visibility || "visible",
    opacity: style.opacity || "1",
  };
  const element: FakeElement = {
    _style: computed,
    children: [],
    innerText,
    querySelectorAll(selector: string) {
      if (selector === "*") {
        return element.children;
      }
      return [];
    },
    tagName: tag,
    offsetWidth: width,
    offsetHeight: height,
    ownerDocument: doc,
    textContent: textContent ?? innerText ?? null,
    getAttribute(name: string) {
      return attrs[name] ?? null;
    },
  };
  return element;
}

function createDocument(selectors: Record<string, FakeElement[]> = {}): FakeDocument {
  return {
    activeElement: null,
    defaultView: {
      getComputedStyle: (element: FakeElement) => element._style,
    },
    location: { href: "https://example.com/page" },
    querySelectorAll(selector: string) {
      return selectors[selector] || [];
    },
    title: "Example Page",
  };
}

describe("getInteractivePageState", () => {
  it("does not treat a plain expanded disclosure as an overlay", () => {
    const doc = createDocument();
    const expandedTrigger = createElement(doc, {
      tag: "BUTTON",
      attrs: { "aria-expanded": "true", type: "button" },
    });
    doc.activeElement = expandedTrigger;

    const state = getInteractivePageState(doc as unknown as Document);

    expect(state.hasDropdown).toBe(false);
    expect(state.hasOverlay).toBe(false);
    expect(state.focusedElement).toEqual({ tag: "button", type: "button" });
  });

  it("detects a visible menu as a blocking dropdown", () => {
    const doc = createDocument();
    const menu = createElement(doc, { attrs: { role: "menu" } });
    const state = getInteractivePageState(
      createDocument({ '[role="menu"]': [menu] }) as unknown as Document,
    );

    expect(state.hasDropdown).toBe(true);
    expect(state.hasOverlay).toBe(true);
  });

  it("wait-for-text only matches visible text", () => {
    const doc = createDocument();
    const hiddenTemplate = createElement(doc, {
      innerText: "Saved",
      textContent: "Saved",
      style: { display: "none" },
    });
    const visibleContainer = createElement(doc, {
      innerText: "Compose",
      textContent: "Compose",
    });
    visibleContainer.children = [hiddenTemplate];

    expect(findVisibleTextMatch(visibleContainer as unknown as Element, "Saved")).toBeNull();
    expect(findVisibleTextMatch(visibleContainer as unknown as Element, "Compose")).toBe(visibleContainer);
  });

  it("wait-for-text observes visibility-related attribute changes", () => {
    const options = getVisibleTextObserverOptions();

    expect(options.attributes).toBe(true);
    expect(options.characterData).toBe(true);
    expect(options.attributeFilter).toEqual(["style", "class", "hidden", "aria-hidden"]);
  });
});
