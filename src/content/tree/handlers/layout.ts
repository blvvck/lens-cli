import { getElementMap, registerElement } from "../refs";
import { formatLayoutLine, formatLayoutTree } from "../format";
import { describeElement, type ElementDescriptor } from "../traverse";
import { isVisible } from "../dom";
import { validatePayload, requestHandler, guarded, type MessageHandler } from "./shared";

type TextMatch = {
  ref: string;
  text: string;
  context: string;
  bounds: { x: number; y: number; width: number; height: number };
  elementRef: string | null;
};

function elementRef(parent: Element, entries: ReturnType<typeof getElementMap>): string | null {
  for (const [ref, item] of Object.entries(entries)) {
    const element = item.element.deref();
    if (element && (element === parent || element.contains(parent))) return ref;
  }
  return null;
}

function searchPageText(term: string, caseSensitive: boolean, limit: number): TextMatch[] {
  const query = caseSensitive ? term : term.toLowerCase();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const refs = getElementMap(), matches: TextMatch[] = [];
  while (walker.nextNode() && matches.length < limit) {
    const node = walker.currentNode, content = node.textContent || "";
    const searchable = caseSensitive ? content : content.toLowerCase();
    let offset = 0;
    while ((offset = searchable.indexOf(query, offset)) !== -1 && matches.length < limit) {
      const parent = node.parentElement;
      if (!parent) { offset++; continue; }
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, Math.min(offset + term.length, content.length));
      const rect = range.getBoundingClientRect();
      if (rect.width !== 0 && rect.height !== 0) {
        const start = Math.max(0, offset - 30), end = Math.min(content.length, offset + term.length + 30);
        matches.push({
          ref: `m${matches.length + 1}`, text: content.slice(offset, offset + term.length),
          context: content.slice(start, end).trim(),
          bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          elementRef: elementRef(parent, refs),
        });
      }
      offset++;
    }
  }
  return matches;
}

type LayoutOptions = { depth: number; selector?: string; filter: "all" | "interactive" | "visual" };

function resolveOptions(options: any = {}): LayoutOptions {
  return {
    depth: options.depth ?? 10,
    selector: options.selector,
    filter: options.filter === "all" || options.filter === "interactive" ? options.filter : "visual",
  };
}

function layoutName(element: Element, tag: string): string {
  for (const attribute of ["aria-label", "placeholder", "title", "alt"]) {
    const value = element.getAttribute(attribute)?.trim();
    if (value) return value;
  }
  if (/^h[1-6]$/.test(tag) || ["button", "a", "summary"].includes(tag)) {
    const value = element.textContent?.trim();
    if (value) return value.length > 100 ? `${value.substring(0, 100)}...` : value;
  }
  const value = Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).reduce((text, node) => text + node.textContent, "").trim();
  return value.length >= 3 ? `${value.substring(0, 100)}${value.length > 100 ? "..." : ""}` : "";
}

function layoutVisible(element: Element): boolean {
  return isVisible(element);
}

function layoutInteractive(element: Element, tag: string): boolean {
  return ["a", "button", "input", "select", "textarea", "details", "summary"].includes(tag) ||
    element.hasAttribute("onclick") || element.hasAttribute("tabindex") ||
    ["button", "link"].includes(element.getAttribute("role") || "") || element.getAttribute("contenteditable") === "true";
}

function layoutLandmark(element: Element, tag: string): boolean {
  return ["h1", "h2", "h3", "h4", "h5", "h6", "nav", "main", "header", "footer", "section", "article", "aside"].includes(tag) || element.hasAttribute("role");
}

function includeLayout(element: Element, filter: string, descriptor: ElementDescriptor): boolean {
  const { tag, role } = descriptor;
  if (["script", "style", "meta", "link", "title", "noscript", "svg", "path"].includes(tag) || element.getAttribute("aria-hidden") === "true" || !layoutVisible(element)) return false;
  const rect = element.getBoundingClientRect();
  if (!(rect.top < innerHeight && rect.bottom > 0 && rect.left < innerWidth && rect.right > 0) || rect.width < 4 || rect.height < 4) return false;
  if (filter === "all") return true;
  if (filter === "interactive") return layoutInteractive(element, tag) || layoutLandmark(element, tag);
  const style = getComputedStyle(element);
  const background = style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent";
  const border = style.borderWidth !== "0px" && style.borderStyle !== "none";
  const container = ["flex", "grid", "inline-flex", "inline-grid"].includes(style.display);
  const text = Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
  return layoutInteractive(element, tag) || layoutLandmark(element, tag) || background || border || container || (element.childNodes.length > 0 && text) || role !== "generic";
}

function layoutColor(value: string): string {
  if (!value || value === "transparent" || value === "rgba(0, 0, 0, 0)") return "";
  const rgb = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return rgb ? `#${rgb.slice(1).map((part) => parseInt(part).toString(16).padStart(2, "0")).join("")}` : value;
}

function layoutDetails(element: Element): string {
  const style = getComputedStyle(element), rect = element.getBoundingClientRect(), parts = [`${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`];
  const gap = style.gap !== "normal" && style.gap !== "0px" ? ` gap:${style.gap}` : "";
  if (["flex", "inline-flex"].includes(style.display)) parts.push(`flex:${style.flexDirection === "row" ? "row" : "col"}${gap}`);
  else if (["grid", "inline-grid"].includes(style.display)) parts.push(`grid:${style.gridTemplateColumns.split(" ").filter((column) => column && column !== "none").length}col${gap}`);
  const directText = Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
  if (directText) {
    parts.push(`font:${style.fontSize}${parseInt(style.fontWeight) >= 600 ? " bold" : ""}`);
    const color = layoutColor(style.color);
    if (color) parts.push(color);
  }
  const background = layoutColor(style.backgroundColor);
  if (background) parts.push(`bg:${background}`);
  if (style.padding && style.padding !== "0px") parts.push(`pad:${style.padding}`);
  if (style.borderRadius && style.borderRadius !== "0px") parts.push(`r:${style.borderRadius}`);
  return parts.join(" ");
}

function buildLayout(element: Element, depth: number, options: LayoutOptions, lines: string[]): void {
  if (depth > options.depth) return;
  const descriptor = describeElement(element);
  const include = includeLayout(element, options.filter, descriptor);
  if (include) {
    const { role } = descriptor, name = layoutName(element, descriptor.tag), ref = registerElement(element, role, name);
    getElementMap()[ref] = { element: new WeakRef(element), role, name };
    lines.push(formatLayoutLine(depth, role, name, ref, layoutDetails(element)));
  }
  for (const child of element.children) buildLayout(child, depth + Number(include), options, lines);
}

export const layoutHandlers: Record<string, MessageHandler> = {
  ["search"]: requestHandler((message, sendResponse) => {
    message = validatePayload(message, ['term', 'caseSensitive', 'limit']);
    const { term, caseSensitive, limit } = message;
    const matches = searchPageText(term, caseSensitive || false, limit || 10);
    sendResponse({ query: term, count: matches.length, matches });
    return false;
  }),
  ["lens.page.generateLayoutTree"]: guarded(requestHandler((message, sendResponse) => {
    message = validatePayload(message, ['options']);
    const options = resolveOptions(message.options);
    window.__lensRefs = {};
    const root = options.selector ? document.querySelector(options.selector) || document.body : document.body;
    const lines: string[] = [];
    buildLayout(root, 0, options, lines);
    const body = lines.join("\n");
    const content = formatLayoutTree(lines, { width: innerWidth, height: innerHeight });
    if (body.length > 80000) {
      sendResponse({ error: `Output exceeds 80000 chars (${body.length}). Try a selector to scope, or filter="interactive".`, layoutContent: "", viewport: { width: innerWidth, height: innerHeight } });
    } else sendResponse({ layoutContent: content, viewport: { width: innerWidth, height: innerHeight } });
    return true;
  }), (error) => ({ error: `Error generating layout tree: ${error instanceof Error ? error.message : "Unknown error"}`, layoutContent: "", viewport: { width: innerWidth, height: innerHeight } })),
};
