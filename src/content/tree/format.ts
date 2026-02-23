import { walkAccessibilityTree, type TreeFilter, type TreeNode } from "./traverse";
import { getElementMap } from "./refs";

type Viewport = { width: number; height: number };
type TreeResult = {
  pageContent: string;
  diff?: string;
  viewport: Viewport;
  error?: string;
  modalStates?: Array<{ type: "dialog" | "alertdialog"; description: string; clearedBy: string }>;
  modalLimitations?: string;
  isIncremental?: boolean;
};

function viewport(): Viewport {
  return { width: innerWidth, height: innerHeight };
}
function message(error: unknown, kind: "tree" | "YAML"): string {
  return `Error generating ${kind} tree: ${error instanceof Error ? error.message : "Unknown error"}`;
}
function cap(text: string, kind: string): string | undefined {
  return text.length > 50000
    ? `Output exceeds 50000 character limit (${text.length} characters). Try using filter="interactive"${kind === "text" ? " or specify a ref_id" : ""}.`
    : undefined;
}
function escapeName(name: string): string {
  return name.replace(/\s+/g, " ").replace(/"/g, '\\"');
}

export function formatLayoutLine(depth: number, role: string, name: string, ref: string, details: string): string {
  const escaped = escapeName(name), label = name ? ` "${escaped.slice(0, 60)}${escaped.length > 60 ? "..." : ""}"` : "";
  return `${"  ".repeat(depth)}${role}${label} [${ref}] {${details}}`;
}

export function formatLayoutTree(lines: string[], size: Viewport): string {
  return `${lines.join("\n")}\n\n[Viewport: ${size.width}x${size.height}]`;
}

function textNode(node: TreeNode): string[] {
  const pad = "  ".repeat(node.depth);
  let row = `${pad}${node.role}`;
  if (node.name) row += ` "${escapeName(node.name)}"`;
  row += ` [${node.ref}]`;
  if (node.properties.length) row += ` ${node.properties.join(" ")}`;
  if (node.href) row += ` href="${node.href}"`;
  if (node.type) row += ` type="${node.type}"`;
  if (node.placeholder) row += ` placeholder="${node.placeholder}"`;
  return [row, ...node.children.flatMap(textNode)];
}

function yamlValue(value: string): string {
  if (
    !value ||
    /[\n\r]/.test(value) ||
    /^[\s]/.test(value) ||
    /[\s]$/.test(value) ||
    /[:"{}[\]]/.test(value)
  ) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
  }
  return value;
}

function yamlNode(node: TreeNode): string[] {
  const pad = "  ".repeat(node.depth);
  let key = node.role;
  if (node.name) key += ` ${yamlValue(node.name)}`;
  key += ` [ref=${node.ref}]`;
  if (node.properties.length) key += ` ${node.properties.join(" ")}`;
  const props: string[] = [];
  if (node.href) props.push(`/url: ${yamlValue(node.href)}`);
  if (node.placeholder) props.push(`/placeholder: ${yamlValue(node.placeholder)}`);
  const children = node.children.flatMap(yamlNode);
  if (!children.length && !props.length) return [`${pad}- ${key}`];
  return [`${pad}- ${key}:`, ...props.map((prop) => `${pad}  - ${prop}`), ...children];
}

function normalized(line: string): string {
  return line.replace(/\[e\d+\]/g, "[REF]");
}
function difference(previous: string, current: string): string {
  const old = new Map<string, number>(),
    fresh = new Map<string, number>();
  for (const line of previous.split("\n"))
    if (line.trim()) old.set(normalized(line), (old.get(normalized(line)) || 0) + 1);
  for (const line of current.split("\n"))
    if (line.trim()) fresh.set(normalized(line), (fresh.get(normalized(line)) || 0) + 1);
  const removed: string[] = [],
    added: string[] = [];
  for (const line of previous.split("\n")) {
    if (!line.trim()) continue;
    const key = normalized(line),
      count = old.get(key) || 0;
    if (count > (fresh.get(key) || 0)) {
      removed.push(`- ${line}`);
      old.set(key, count - 1);
    }
  }
  const seen = new Map<string, number>();
  for (const line of current.split("\n")) {
    if (!line.trim()) continue;
    const key = normalized(line),
      count = seen.get(key) || 0;
    if (count >= (old.get(key) || 0)) added.push(`+ ${line}`);
    seen.set(key, count + 1);
  }
  return [...removed, ...added].join("\n") || "[NO CHANGES]";
}

export function generateTextTree(
  filter: TreeFilter = "interactive",
  depth = 15,
  refId?: string,
  forceFull = false,
  compact = false,
): TreeResult {
  try {
    let root: Element | undefined;
    if (refId) {
      const record = getElementMap()[refId];
      root = record?.element.deref();
      if (!record)
        return {
          error: `Element with ref_id '${refId}' not found. Use page.inspect without a ref to get current elements.`,
          pageContent: "",
          viewport: viewport(),
        };
      if (!root) {
        delete getElementMap()[refId];
        return {
          error: `Element with ref_id '${refId}' no longer exists. Use page.inspect without a ref to get current elements.`,
          pageContent: "",
          viewport: viewport(),
        };
      }
    }
    const rows = walkAccessibilityTree({ filter, depth, refId, compact, root }).flatMap(textNode);
    const content = rows.join("\n");
    const tooLarge = cap(content, "text");
    if (tooLarge) return { error: tooLarge, pageContent: "", viewport: viewport() };
    const now = Date.now(),
      last = window.__lensLastSnapshot;
    const incremental = !forceFull && !refId && !!last && now - last.timestamp < 5000;
    const diff = incremental ? difference(last!.content, content) : undefined;
    window.__lensLastSnapshot = { content, timestamp: now };
    const modals = detectModalStates() || [];
    return {
      pageContent: `${content}\n\n[Viewport: ${innerWidth}x${innerHeight}]`,
      diff,
      viewport: viewport(),
      modalStates: modals.length ? modals : undefined,
      modalLimitations:
        "Only custom modals ([role=dialog]) detected. Native alert/confirm/prompt dialogs and system file choosers cannot be detected from content scripts.",
      isIncremental: incremental,
    };
  } catch (error) {
    return { error: message(error, "tree"), pageContent: "", viewport: viewport() };
  }
}

export function generateYamlTree(
  filter: TreeFilter = "interactive",
  depth = 15,
): { yaml: string; viewport: Viewport; error?: string } {
  try {
    const source = walkAccessibilityTree({ filter, depth, yaml: true });
    const rows = source.flatMap(yamlNode),
      yaml = rows.join("\n");
    const error = cap(yaml, "YAML");
    return error
      ? { error, yaml: "", viewport: viewport() }
      : { yaml: `${yaml}\n\n[Viewport: ${innerWidth}x${innerHeight}]`, viewport: viewport() };
  } catch (error) {
    return { error: message(error, "YAML"), yaml: "", viewport: viewport() };
  }
}

export function detectModalStates(): TreeResult["modalStates"] {
  const result: NonNullable<TreeResult["modalStates"]> = [];
  for (const dialog of document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]')) {
    const css = getComputedStyle(dialog);
    if (
      css.display === "none" ||
      css.visibility === "hidden" ||
      css.opacity === "0" ||
      !(dialog as HTMLElement).offsetWidth ||
      !(dialog as HTMLElement).offsetHeight
    )
      continue;
    const role = dialog.getAttribute("role") || "dialog";
    const label =
      dialog.getAttribute("aria-label") ||
      dialog.querySelector('[role="heading"], h1, h2, h3')?.textContent?.trim() ||
      "Dialog";
    result.push({
      type: role as "dialog" | "alertdialog",
      description: `${role}: ${label.slice(0, 100)}${label.length > 100 ? "..." : ""}`,
      clearedBy: "computer(action=key, text=Escape)",
    });
  }
  return result;
}
