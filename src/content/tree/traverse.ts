import { getElementMap, registerElement, resetReadRefs } from "./refs";
import { isVisible } from "./dom";

export type TreeFilter = "all" | "interactive";

export interface TreeNode {
  role: string;
  name: string;
  ref: string;
  depth: number;
  properties: string[];
  href?: string;
  type?: string;
  placeholder?: string;
  children: TreeNode[];
}

export type ElementDescriptor = { tag: string; role: string; name: string };

const roles = new Set(
  `alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main mark marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem`.split(
    " ",
  ),
);
const excluded = new Set(["script", "style", "meta", "link", "title", "noscript"]);
const actionTags = new Set(["a", "button", "input", "select", "textarea", "details", "summary"]);
const landmarks = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "nav",
  "main",
  "header",
  "footer",
  "section",
  "article",
  "aside",
]);

function focusable(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (["button", "input", "select", "textarea"].includes(tag)) return !(el as HTMLButtonElement).disabled;
  if (tag === "a" && el.hasAttribute("href")) return true;
  if (el.hasAttribute("tabindex")) return Number.parseInt(el.getAttribute("tabindex") || "", 10) >= 0;
  return el.getAttribute("contenteditable") === "true";
}

function explicitRole(el: Element): string | null {
  return (
    el
      .getAttribute("role")
      ?.split(/\s+/)
      .find((role) => roles.has(role)) ?? null
  );
}

export function getResolvedRole(el: Element): string {
  const explicit = explicitRole(el);
  if (explicit && !(["none", "presentation"].includes(explicit) && focusable(el))) return explicit;
  const tag = el.tagName.toLowerCase();
  const type = el.getAttribute("type") || "";
  if (tag === "input") return inputRoles.get(type) || "textbox";
  const standard = elementRoles.get(tag);
  if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
  if (tag === "footer") return el.closest("article, aside, main, nav, section") ? "generic" : "contentinfo";
  if (tag === "header") return el.closest("article, aside, main, nav, section") ? "generic" : "banner";
  if (tag === "form")
    return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "form" : "generic";
  if (tag === "img") return el.getAttribute("alt") === "" ? "presentation" : "img";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "section")
    return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : "generic";
  if (tag === "select") {
    const select = el as HTMLSelectElement;
    return select.multiple || select.size > 1 ? "listbox" : "combobox";
  }
  return standard || "generic";
}

const inputRoles = new Map(Object.entries({
  button: "button", checkbox: "checkbox", email: "textbox", file: "button", image: "button", number: "spinbutton",
  radio: "radio", range: "slider", reset: "button", search: "searchbox", submit: "button", tel: "textbox", text: "textbox", url: "textbox",
}));
const elementRoles = new Map<string, string>([
  ["article", "article"], ["aside", "complementary"], ["button", "button"], ["datalist", "listbox"], ["dd", "definition"],
  ["details", "group"], ["dialog", "dialog"], ["dt", "term"], ["fieldset", "group"], ["figure", "figure"], ["hr", "separator"],
  ["li", "listitem"], ["main", "main"], ["math", "math"], ["menu", "list"], ["meter", "meter"], ["nav", "navigation"],
  ["ol", "list"], ["optgroup", "group"], ["option", "option"], ["output", "status"], ["p", "paragraph"], ["progress", "progressbar"],
  ["search", "search"], ["table", "table"], ["tbody", "rowgroup"], ["td", "cell"], ["textarea", "textbox"], ["tfoot", "rowgroup"],
  ["th", "columnheader"], ["thead", "rowgroup"], ["time", "time"], ["tr", "row"], ["ul", "list"],
]);

export function getAccessibleName(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const byId = el
    .getAttribute("aria-labelledby")
    ?.split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent?.trim() || "")
    .filter(Boolean)
    .join(" ");
  if (byId) return byId.slice(0, 100) + (byId.length > 100 ? "..." : "");
  if (tag === "select") {
    const select = el as HTMLSelectElement;
    const option =
      select.querySelector("option[selected]") ||
      (select.selectedIndex >= 0 ? select.options[select.selectedIndex] : null);
    if (option?.textContent?.trim()) return option.textContent.trim();
  }
  for (const attr of ["aria-label", "placeholder", "title", "alt"]) {
    const value = el.getAttribute(attr);
    if (value?.trim()) return value.trim();
  }
  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label?.textContent?.trim()) return label.textContent.trim();
  }
  if (tag === "input") {
    const input = el as HTMLInputElement;
    const value = el.getAttribute("value");
    if (input.type === "submit" && value?.trim()) return value.trim();
    if (input.value && input.value.length < 50 && input.value.trim()) return input.value.trim();
  }
  if (["button", "a", "summary"].includes(tag)) {
    const direct = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent || "")
      .join("")
      .trim();
    if (direct) return direct;
  }
  if (/^h[1-6]$/.test(tag) && el.textContent?.trim())
    return el.textContent.trim().slice(0, 100) + (el.textContent.trim().length > 100 ? "..." : "");
  if (tag === "img") return "";
  const text = Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent || "")
    .join("")
    .trim();
  return text.length >= 3 ? text.slice(0, 100) + (text.length > 100 ? "..." : "") : "";
}

export function describeElement(el: Element): ElementDescriptor {
  return { tag: el.tagName.toLowerCase(), role: getResolvedRole(el), name: getAccessibleName(el) };
}

function interactive(el: Element): boolean {
  return (
    actionTags.has(el.tagName.toLowerCase()) ||
    el.hasAttribute("onclick") ||
    el.hasAttribute("tabindex") ||
    ["button", "link"].includes(el.getAttribute("role") || "") ||
    el.getAttribute("contenteditable") === "true"
  );
}

function visible(el: Element): boolean {
  return isVisible(el);
}

function inViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0;
}

function ariaState(el: Element): string[] {
  const props: string[] = [];
  const checked = el.getAttribute("aria-checked");
  const input = el instanceof HTMLInputElement && ["checkbox", "radio"].includes(el.type) ? el : null;
  const value =
    checked === "mixed" || (input?.type === "checkbox" && input.indeterminate)
      ? "mixed"
      : checked === "true"
        ? "true"
        : checked === "false"
          ? "false"
          : input
            ? String(input.checked)
            : undefined;
  if (value !== undefined)
    props.push(value === "mixed" ? "[checked=mixed]" : value === "true" ? "[checked]" : "[unchecked]");
  const disableable =
    el instanceof HTMLButtonElement ||
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement;
  if (
    el.getAttribute("aria-disabled") === "true" ||
    (disableable && (el as HTMLButtonElement).disabled) ||
    el.closest("fieldset:disabled")
  )
    props.push("[disabled]");
  const expanded = el.getAttribute("aria-expanded");
  if (expanded === "true" || expanded === "false")
    props.push(expanded === "true" ? "[expanded]" : "[collapsed]");
  const pressed = el.getAttribute("aria-pressed");
  if (pressed === "mixed" || pressed === "true" || pressed === "false")
    props.push(pressed === "mixed" ? "[pressed=mixed]" : pressed === "true" ? "[pressed]" : "[not-pressed]");
  const selected = el.getAttribute("aria-selected");
  if (selected === "true" || selected === "false")
    props.push(selected === "true" ? "[selected]" : "[not-selected]");
  const current = el.getAttribute("aria-current");
  if (current && current !== "false") props.push("[active]");
  const tag = el.tagName.toLowerCase();
  const level = /^h[1-6]$/.test(tag) ? Number(tag[1]) : Number(el.getAttribute("aria-level"));
  if (level) props.push(`[level=${level}]`);
  return props;
}

export function walkAccessibilityTree(options: {
  filter: TreeFilter;
  depth: number;
  refId?: string;
  compact?: boolean;
  yaml?: boolean;
  root?: Element;
}): TreeNode[] {
  resetReadRefs();
  const root = options.root || document.body;
  const descendants = (el: Element): Element[] => {
    const shadow = el.shadowRoot;
    const children = Array.from(shadow?.children || el.children);
    if (el instanceof HTMLIFrameElement) {
      try {
        if (el.contentDocument?.body) children.push(el.contentDocument.body);
      } catch {}
    }
    return children;
  };
  const walk = (el: Element, depth: number): TreeNode[] => {
    if (depth > options.depth || excluded.has(el.tagName.toLowerCase())) return [];
    if (options.filter !== "all" && (el.getAttribute("aria-hidden") === "true" || !visible(el))) return [];
    if ((options.yaml || (options.filter !== "all" && !options.refId)) && !inViewport(el)) return [];
    const role = getResolvedRole(el),
      name = getAccessibleName(el),
      isAction = interactive(el);
    const semantic = landmarks.has(el.tagName.toLowerCase()) || el.hasAttribute("role");
    const structural =
      options.compact &&
      ["generic", "group", "region", "article", "section", "complementary"].includes(role) &&
      !name;
    const include =
      options.yaml && options.filter === "all"
        ? true
        : options.filter === "interactive"
          ? isAction
          : semantic || !!name || (role !== "generic" && role !== "img");
    const emitted = (include && !structural) || (options.refId !== undefined && depth === 0);
    const ref = emitted ? registerElement(el, role, name) : "";
    const style = getComputedStyle(el);
    const node: TreeNode = { role, name, ref, depth, properties: ariaState(el), children: [] };
    if (style.cursor === "pointer") node.properties.push("[cursor=pointer]");
    node.href = el.getAttribute("href") || undefined;
    node.type = el.getAttribute("type") || undefined;
    node.placeholder = el.getAttribute("placeholder") || undefined;
    const nextDepth = emitted ? depth + 1 : depth;
    for (const child of descendants(el))
      node.children.push(...walk(child, options.yaml ? depth + (emitted ? 1 : 0) : nextDepth));
    return emitted ? [node] : node.children;
  };
  return walk(root, 0);
}
