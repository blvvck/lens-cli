import { ACCESSIBILITY_MESSAGE_TYPES } from "../accessibility-contract";
import { getElementMap, resolveRef, registerElement } from "../refs";
import { describeElement, type ElementDescriptor } from "../traverse";
import { dispatchEvents, errorMessage, isVisible } from "../dom";
import { validatePayload, requestHandler, guarded, type MessageHandler } from "./shared";

async function ensureActionable(
  element: Element,
  timeout = 5000,
  options: { scroll?: boolean } = {},
): Promise<{ error?: string }> {
  if (options.scroll !== false) element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  const deadline = Date.now() + timeout;
  let previous = element.getBoundingClientRect(), stable = 0;
  while (Date.now() < deadline) {
    const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
    const visible = style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    const unchanged = ["x", "y", "width", "height"].every((key) => Math.abs(bounds[key as "x"] - previous[key as "x"]) < 1);
    if (!visible || !(bounds.width > 0 || bounds.height > 0) || !unchanged) {
      stable = 0;
    } else if (++stable >= 2) {
      const top = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      if (top && (top === element || element.contains(top) || top.contains(element))) return {};
      stable = 0;
    }
    previous = bounds;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { error: "Element not actionable within timeout (not visible, animating, or obscured by another element)" };
}

function getElementBounds(ref: string) {
  const { bounds } = resolveTarget({ ref });
  if (!bounds) return { x: 0, y: 0, width: 0, height: 0, error: `Element ${ref} not found. Use page.inspect to get current elements.` };
  const rect = bounds;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function setFormValue(ref: string, value: string | boolean | number) {
  const { element, descriptor } = resolveTarget({ ref });
  if (!element) return { success: false, error: `Element ${ref} not found. Use page.inspect to get current elements.` };
  const tag = descriptor!.tag;
  try {
    if (tag === "input") {
      const input = element as HTMLInputElement;
      if (["checkbox", "radio"].includes(input.type.toLowerCase())) {
        input.checked = Boolean(value);
        dispatchEvents(input, "change");
      } else {
        input.value = String(value);
        dispatchEvents(input, "input", "change");
      }
    } else if (tag === "textarea") {
      const field = element as HTMLTextAreaElement;
      field.value = String(value);
      dispatchEvents(field, "input", "change");
    } else if (tag === "select") {
      const field = element as HTMLSelectElement;
      const match = Array.from(field.options).find((option) => option.value === String(value) || option.textContent?.trim() === String(value));
      if (!match) return { success: false, error: `Option "${value}" not found in select element ${ref}` };
      field.value = match.value;
      dispatchEvents(field, "change");
    } else if (element.getAttribute("contenteditable") === "true") {
      element.textContent = String(value);
      dispatchEvents(element, "input");
    } else return { success: false, error: `Element ${ref} (${tag}) is not a form field` };
    return { success: true };
  } catch (error) {
    return { success: false, error: `Failed to set value: ${errorMessage(error)}` };
  }
}

function scrollToElement(ref: string) {
  const { element } = resolveTarget({ ref });
  if (!element) return { success: false, error: `Element ${ref} not found. Run page.inspect to get current element refs.` };
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  return { success: true };
}

function uploadImage(base64: string, ref?: string, coordinate?: [number, number], filename = "screenshot.png") {
  try {
    const binary = atob(base64), bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const file = new File([new Blob([bytes], { type: "image/png" })], filename, { type: "image/png" });
    const target = (ref ? resolveTarget({ ref }).element : coordinate ? document.elementFromPoint(...coordinate) : null) as HTMLElement | null;
    if (!target) return { success: false, error: ref ? `Element ${ref} not found. Run page.inspect first.` : coordinate ? `No element at (${coordinate[0]}, ${coordinate[1]})` : "No target element" };
    const transfer = new DataTransfer();
    transfer.items.add(file);
    if (target instanceof HTMLInputElement && target.type === "file") {
      target.files = transfer.files;
      target.dispatchEvent(new Event("change", { bubbles: true }));
    } else target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Upload failed" };
  }
}

type Target = { ref?: string; selector?: string; index?: number; visible?: boolean; text?: string; exact?: boolean; role?: string; name?: string; label?: string };
type Resolution = { element: Element | null; bounds: DOMRect | null; descriptor?: ElementDescriptor; matches?: Element[]; reason?: string };
type Actuation<T> = Resolution & { value?: T; performed?: boolean; attempts: number };

function resolved(element: Element, extra: Pick<Resolution, "matches"> = {}): Resolution {
  return { element, bounds: element.getBoundingClientRect(), descriptor: describeElement(element), ...extra };
}

const roleSelectors = new Map<string, string[]>([
  ["button", ["button", 'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]', '[role="button"]']],
  ["link", ["a[href]", '[role="link"]']],
  ["textbox", ["input:not([type])", 'input[type="text"]', 'input[type="email"]', 'input[type="password"]', 'input[type="search"]', 'input[type="tel"]', 'input[type="url"]', "textarea", '[role="textbox"]']],
  ["checkbox", ['input[type="checkbox"]', '[role="checkbox"]']], ["radio", ['input[type="radio"]', '[role="radio"]']],
  ["combobox", ["select", '[role="combobox"]']], ["listbox", ['[role="listbox"]', "select[multiple]"]],
  ["option", ["option", '[role="option"]']], ["heading", ["h1", "h2", "h3", "h4", "h5", "h6", '[role="heading"]']],
  ["navigation", ["nav", '[role="navigation"]']], ["main", ["main", '[role="main"]']], ["img", ["img[alt]", '[role="img"]']],
  ["dialog", ["dialog", '[role="dialog"]', '[role="alertdialog"]']], ["tab", ['[role="tab"]']], ["tabpanel", ['[role="tabpanel"]']],
  ["menu", ['[role="menu"]']], ["menuitem", ['[role="menuitem"]']],
]);

function roleMatches(role: string, name?: string): Element[] {
  const candidates: Element[] = [];
  for (const selector of roleSelectors.get(role) || [`[role="${role}"]`]) {
    try { candidates.push(...document.querySelectorAll(selector)); } catch {}
  }
  return candidates.filter((element) => {
    const style = getComputedStyle(element);
    if (!isVisible(element)) return false;
    if (!name) return true;
    const needle = name.toLowerCase(), input = element as HTMLInputElement;
    return [element.getAttribute("aria-label"), element.textContent?.trim(), element.getAttribute("title"), input.placeholder, input.value]
      .some((value) => value?.toLowerCase().includes(needle));
  });
}

function resolveTarget(target: Target): Resolution {
  let element: Element | null = null;
  if (target.ref) {
    element = resolveRef(target.ref);
    if (!element) return { element, bounds: null, reason: `Element ${target.ref} not found. Use page.inspect to get current elements.` };
    return resolved(element, { matches: [element] });
  } else if (target.selector !== undefined) {
    const found = Array.from(document.querySelectorAll(target.selector));
    const matches = target.visible ? found.filter((candidate) => {
      const style = getComputedStyle(candidate), node = candidate as HTMLElement;
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && node.offsetWidth > 0 && node.offsetHeight > 0;
    }) : found;
    element = matches[target.index ?? 0] || null;
    if (!element) return { element, bounds: null, reason: `No element matches selector ${target.selector} at index ${target.index ?? 0}` };
    return resolved(element, { matches });
  } else if (target.text) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), found: Element[] = [];
    while (walker.nextNode()) {
      const value = walker.currentNode.textContent || "";
      const match = target.exact ? value.trim() === target.text : value.toLowerCase().includes(target.text.toLowerCase());
      const parent = walker.currentNode.parentElement;
      if (match && parent && !found.includes(parent)) {
        const style = getComputedStyle(parent);
        if (style.display !== "none" && style.visibility !== "hidden") found.push(parent);
      }
    }
    element = found.sort((a, b) => (a.textContent?.length || 0) - (b.textContent?.length || 0))[0] || null;
    if (!element) return { element, bounds: null, reason: `No element found with text "${target.text}"` };
  } else if (target.role) {
    element = roleMatches(target.role, target.name)[0] || null;
    if (!element) return { element, bounds: null, reason: `No element found with role "${target.role}"${target.name ? ` and name "${target.name}"` : ""}` };
  } else if (target.label) {
    const needle = target.label.toLowerCase();
    const label = Array.from(document.querySelectorAll("label")).find((item) => item.textContent?.trim().toLowerCase().includes(needle));
    const id = label?.getAttribute("for");
    element = (id && document.getElementById(id)) || label?.querySelector("input, select, textarea") ||
      document.querySelector(`input[aria-label*="${target.label}" i], input[placeholder*="${target.label}" i], textarea[aria-label*="${target.label}" i], textarea[placeholder*="${target.label}" i], select[aria-label*="${target.label}" i]`);
    if (!element) return { element, bounds: null, reason: `No form field found with label "${target.label}"` };
  }
  return element ? resolved(element) : { element, bounds: null };
}

async function actuate<T>(target: Target, action: (element: Element) => T, options: { timeout?: number; scroll?: boolean; retries?: number } = {}): Promise<Actuation<T>> {
  const { timeout = 5000, scroll = true, retries = 3 } = options, deadline = Date.now() + timeout;
  let result: Resolution = { element: null, bounds: null };
  let attempts = 0;
  for (let attempt = 0; attempt < retries && Date.now() < deadline; attempt++) {
    attempts++;
    result = resolveTarget(target);
    if (result.element) {
      const element = result.element;
      const ready = await ensureActionable(element, Math.max(deadline - Date.now(), 500), { scroll });
      if (!ready.error) {
        try {
          result = { element, bounds: element.getBoundingClientRect() };
          const value = action(element);
          return { ...result, value, performed: true, attempts, reason: undefined };
        } catch (error) {
          result = { ...result, reason: error instanceof Error ? error.message : String(error) };
        }
      } else result = { ...result, reason: ready.error };
    }
    if (attempt + 1 < retries) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { ...result, attempts };
}

function click(element: Element, button?: string): void {
  if (button === "triple") element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, detail: 3 }));
  else if (button === "double") element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
  else if (button === "right") element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, view: window }));
  else (element as HTMLElement).click();
}

function route(fields: string[], handler: MessageHandler): MessageHandler {
  return guarded(requestHandler((message, sendResponse) => handler(validatePayload(message, fields), sendResponse)));
}

export const elementsHandlers: Record<string, MessageHandler> = {
  [ACCESSIBILITY_MESSAGE_TYPES.GET_ELEMENT_COORDINATES]: route(['ref', 'timeout', 'scroll'], (message, sendResponse) => {
    actuate({ ref: message.ref }, () => undefined, { timeout: message.timeout || 5000, scroll: message.scroll !== "off" }).then(({ bounds, reason, attempts }) => {
      if (!bounds) sendResponse({ x: 0, y: 0, error: attempts < 3 && reason?.includes("not found") ? `Element ${message.ref} not found after 3 retries.` : reason });
      else sendResponse({ x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) });
    });
    return true;
  }),
  ["lens.element.getBounds"]: route(['ref'], (message, sendResponse) => {
    const result = getElementBounds(message.ref);
    sendResponse(result);
    return false;
  }),
  ["lens.element.click"]: route(['ref', 'timeout', 'scroll', 'button'], (message, sendResponse) => {
    actuate({ ref: message.ref }, (element) => click(element, message.button), { timeout: message.timeout || 5000, scroll: message.scroll !== "off" }).then((result) => {
      if (result.performed) sendResponse({ success: true });
      else if (result.attempts < 3 && result.reason?.includes("not found")) sendResponse({ error: `Element ${message.ref} not found after 3 retries.` });
      else if (result.reason?.startsWith("Element ") && result.reason.includes("not found.")) sendResponse({ error: result.reason });
      else sendResponse({ success: false, error: result.reason || `Element ${message.ref} not found after 3 retries.` });
    });
    return true;
  }),
  ["lens.element.clickSelector"]: route(['selector', 'index', 'timeout', 'scroll', 'button'], (message, sendResponse) => {
    const selector = String(message.selector || "");
    const index = Number(message.index || 0);
    let count = 0;
    actuate({ selector, index }, (element) => { count = document.querySelectorAll(selector).length; click(element, message.button); }, { timeout: message.timeout || 5000, scroll: message.scroll !== "off" }).then((result) => {
      if (result.performed) sendResponse({ success: true, count });
      else sendResponse({ success: false, error: result.reason || `No element matches selector ${selector} at index ${index}` });
    });
    return true;
  }),
  ["lens.form.formInput"]: route(['ref', 'value'], (message, sendResponse) => {
    const result = setFormValue(message.ref, message.value);
    sendResponse(result);
    return false;
  }),
  [ACCESSIBILITY_MESSAGE_TYPES.GET_ELEMENT_INFO_FOR_FILL]: route(['ref', 'scroll'], (message, sendResponse) => {
    const fillRef = message.ref;
    const { element: fillTarget, descriptor } = resolveTarget({ ref: fillRef });
    const fillEl = fillTarget as HTMLElement | null;
    if (!fillEl) {
      sendResponse({ error: `Element ${fillRef} not found. Run page.inspect first.` });
      return false;
    }
    if (message.scroll !== "off") {
      fillEl.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    }
    const fillRect = fillEl.getBoundingClientRect();
    if (fillRect.width === 0 && fillRect.height === 0) {
      sendResponse({ error: `Element ${fillRef} has zero size` });
      return false;
    }
    const fillTag = descriptor!.tag;
    const fillType = (fillEl as HTMLInputElement).type
      ? (fillEl as HTMLInputElement).type.toLowerCase()
      : "";
    sendResponse({
      x: Math.round(fillRect.left + fillRect.width / 2),
      y: Math.round(fillRect.top + fillRect.height / 2),
      isCheckOrRadio: fillTag === "input" && (fillType === "checkbox" || fillType === "radio"),
      isSelect: fillTag === "select",
      isContentEditable: fillEl.isContentEditable || fillEl.getAttribute("contenteditable") === "true",
      tag: fillTag,
      type: fillType,
    });
    return false;
  }),
  [ACCESSIBILITY_MESSAGE_TYPES.SET_SELECT_VALUE]: route(['ref', 'value'], (message, sendResponse) => {
    const result = resolveTarget({ ref: message.ref });
    const selectEl = result.element as HTMLSelectElement | null;
    if (!selectEl || result.descriptor?.tag !== "select") {
      sendResponse({ error: `Element ${message.ref} is not a select element` });
      return false;
    }
    selectEl.value = String(message.value);
    selectEl.dispatchEvent(new Event("input", { bubbles: true }));
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
    sendResponse({ success: true });
    return false;
  }),
  ["locate.role"]: route(['role', 'name', 'all'], (message, sendResponse) => {
    const { role, name, all } = message, matches = roleMatches(role, name);
    if (!matches.length) {
      sendResponse({ error: `No element found with role "${role}"${name ? ` and name "${name}"` : ""}` });
      return false;
    }
    const results = matches.map((element) => ({
      ref: registerElement(element, role, name || ""),
      text: element.textContent?.trim().slice(0, 50),
    }));
    sendResponse(all ? { matches: results } : { ref: results[0].ref, text: results[0].text });
    return false;
  }),
  ["locate.text"]: route(['text', 'exact'], (message, sendResponse) => {
    const { text, exact } = message, { element, reason, descriptor } = resolveTarget({ text, exact });
    if (!element) {
      sendResponse({ error: reason });
      return false;
    }
    const role = descriptor!.role;
    sendResponse({ ref: registerElement(element, role, text), text: element.textContent?.trim().slice(0, 50) });
    return false;
  }),
  ["locate.label"]: route(['label'], (message, sendResponse) => {
    const { label } = message, { element, reason, descriptor } = resolveTarget({ label });
    if (!element) {
      sendResponse({ error: reason });
      return false;
    }
    sendResponse({ ref: registerElement(element, descriptor!.role, label), label });
    return false;
  }),
  ["element.styles"]: route(['selector'], (message, sendResponse) => {
    const { selector } = message, byRef = /^e\d+$/.test(selector);
    const result = resolveTarget(byRef ? { ref: selector } : { selector });
    const elements = byRef ? (result.element ? [result.element] : []) : result.matches || [];
    if (!elements.length) {
      sendResponse({ error: byRef ? `Element ${selector} not found` : `No elements found matching "${selector}"` });
      return false;
    }
    const styles = elements.map((element) => {
      const computed = getComputedStyle(element), rect = element.getBoundingClientRect(), descriptor = describeElement(element);
      return {
        tag: descriptor.tag, text: (element as HTMLElement).innerText?.trim().slice(0, 80) || null,
        box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        styles: {
          fontSize: computed.fontSize, fontWeight: computed.fontWeight,
          fontFamily: computed.fontFamily.split(",")[0].trim().replace(/"/g, ""), color: computed.color,
          backgroundColor: computed.backgroundColor, borderRadius: computed.borderRadius,
          border: computed.border !== "none" && computed.borderWidth !== "0px" ? computed.border : null,
          boxShadow: computed.boxShadow !== "none" ? computed.boxShadow : null, padding: computed.padding,
        },
      };
    });
    sendResponse({ styles });
    return false;
  }),
  ["select"]: route(['selector', 'values', 'by'], (message, sendResponse) => {
    const { selector, values, by } = message, byRef = /^e\d+$/.test(selector);
    const result = resolveTarget(byRef ? { ref: selector } : { selector });
    const element = result.element;
    if (!element) {
      sendResponse({ error: byRef ? `Element ${selector} not found` : `No element found matching "${selector}"` });
      return false;
    }
    if (element.tagName !== "SELECT") {
      sendResponse({ error: byRef ? `Element ${selector} is not a <select>` : `Element "${selector}" is not a <select>` });
      return false;
    }
    const select = element as HTMLSelectElement;
    if (select.multiple) for (const option of select.options) option.selected = false;
    const selected: string[] = [], missing: string[] = [];
    for (const value of select.multiple ? values : [values[0]]) {
      const option = Array.from(select.options).find((item) => by === "index"
        ? item.index === parseInt(value, 10)
        : by === "label" ? item.text.toLowerCase().includes(value.toLowerCase()) : item.value === value);
      if (option) { option.selected = true; selected.push(option.value); }
      else missing.push(value);
    }
    select.dispatchEvent(new Event("change", { bubbles: true }));
    sendResponse(missing.length ? { selected, warning: `Values not found: ${missing.join(", ")}` } : { selected });
    return false;
  }),
  ["lens.element.getText"]: route(['ref'], (message, sendResponse) => {
    const { ref } = message;
    const { element } = resolveTarget({ ref });
    if (!element) {
      sendResponse({ error: `Element ${ref} not found` });
      return false;
    }

    sendResponse({ text: element.textContent?.trim() || "" });
    return false;
  }),
  ["scroll.to"]: route(['ref'], (message, sendResponse) => {
    const result = scrollToElement(message.ref);
    sendResponse(result);
    return false;
  }),
  ["upload.image"]: route(['base64', 'ref', 'coordinate', 'filename'], (message, sendResponse) => {
    const result = uploadImage(message.base64, message.ref, message.coordinate, message.filename);
    sendResponse(result);
    return false;
  }),
  ["lens.element.getSelectorCoordinates"]: route(['selector', 'index'], (message, sendResponse) => {
    const { selector, index = 0 } = message;
    if (!selector) {
      sendResponse({ error: "No selector provided" });
      return true;
    }
    const matches = resolveTarget({ selector, visible: true }).matches || [];
    if (!matches.length) {
      sendResponse({ error: "No visible elements match selector" });
      return true;
    }
    if (index < 0 || index >= matches.length) {
      sendResponse({ error: `Index ${index} out of range (found ${matches.length} visible elements)` });
      return true;
    }
    const rect = matches[index].getBoundingClientRect();
    sendResponse({ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), count: matches.length });
    return true;
  }),
  ["form.fill"]: route(['data', 'scroll'], (message, sendResponse) => {
    if (!Array.isArray(message.data)) {
      sendResponse({ error: "data must be an array of {ref, value} pairs" });
      return true;
    }
    const fill = (element: Element, value: unknown) => {
      const nativeValue = (field: HTMLInputElement | HTMLTextAreaElement, text: string) => {
        const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (setter) setter.call(field, text); else field.value = text;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
      };
      if (element instanceof HTMLInputElement) {
        if (["checkbox", "radio"].includes(element.type.toLowerCase())) {
          element.checked = value === true || value === "true" || value === "1" || value === "checked";
          element.dispatchEvent(new Event("change", { bubbles: true }));
        } else { element.focus(); nativeValue(element, String(value)); }
      } else if (element instanceof HTMLTextAreaElement) {
        element.focus(); nativeValue(element, String(value));
      } else if (element instanceof HTMLSelectElement) {
        element.value = String(value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      } else if ((element as HTMLElement).isContentEditable) {
        (element as HTMLElement).focus();
        document.execCommand("selectAll", false);
        document.execCommand("insertText", false, String(value));
      } else return { success: false, error: "Element is not fillable" };
      return { success: true };
    };
    void (async () => {
      const results: { ref: string; success: boolean; error?: string }[] = [];
      for (const { ref, value } of message.data) {
        if (!ref) { results.push({ ref: ref || "unknown", success: false, error: "Missing ref" }); continue; }
        const result = await actuate({ ref }, (element) => fill(element, value), { timeout: 5000, scroll: message.scroll !== "off", retries: 1 });
        const outcome: { success: boolean; error?: string } =
          result.performed && result.value
            ? result.value
            : { success: false, error: result.reason?.includes("not found") ? "Element not found (run page.inspect first)" : result.reason };
        results.push({ ref, ...outcome });
      }
      const failed = results.filter((result) => !result.success);
      sendResponse({ success: !failed.length, filled: results.length - failed.length, failed: failed.length, results });
    })();
    return true;
  }),
  ["lens.element.getFileInputSelector"]: route(['ref'], (message, sendResponse) => {
    const { ref } = message;
    if (!ref) {
      sendResponse({ error: "No ref provided" });
      return true;
    }
    const elementMap = getElementMap();
    const elemRef = elementMap[ref];
    if (!elemRef) {
      sendResponse({ error: "Element not found (run page.inspect first)" });
      return true;
    }
    const el = elemRef.element.deref() as HTMLElement | null;
    if (!el) {
      delete elementMap[ref];
      sendResponse({ error: "Element no longer exists" });
      return true;
    }
    if (!(el instanceof HTMLInputElement) || el.type !== "file") {
      sendResponse({ error: "Element is not a file input" });
      return true;
    }
    const uniqueId = `__lens_file_${Date.now()}`;
    el.setAttribute("data-lens-file-id", uniqueId);
    sendResponse({ selector: `[data-lens-file-id="${uniqueId}"]` });
    return true;
  }),
  ["lens.element.getBoundsForAnnotation"]: route([], (message, sendResponse) => {
    const elementMap = getElementMap();
    const elements: Array<{
      ref: string;
      tag: string;
      bounds: { x: number; y: number; width: number; height: number };
    }> = [];

    for (const [ref, entry] of Object.entries(elementMap)) {
      const el = entry.element.deref();
      if (!el) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      if (rect.right < 0 || rect.left > window.innerWidth) continue;

      elements.push({
        ref,
        tag: el.tagName.toLowerCase(),
        bounds: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
      });
    }

    sendResponse({ elements });
    return false;
  }),
  ["lens.element.findSelectByLabel"]: route(['label'], (message, sendResponse) => {
    try {
      const { label } = message;
      if (!label) {
        sendResponse({ error: "Label text required" });
        return false;
      }

      const labels = Array.from(document.querySelectorAll("label"));
      const matchingLabel = labels.find((l) =>
        l.textContent?.toLowerCase().includes(label.toLowerCase()),
      );

      if (!matchingLabel) {
        sendResponse({ error: `Label not found: "${label}"` });
        return false;
      }

      let selectEl: HTMLSelectElement | null = null;

      const forAttr = matchingLabel.getAttribute("for");
      if (forAttr) {
        const targetEl = document.getElementById(forAttr);
        if (targetEl && targetEl.tagName === "SELECT") {
          selectEl = targetEl as HTMLSelectElement;
        }
        if (!selectEl) {
          const byName = document.querySelector(`select[name="${CSS.escape(forAttr)}"]`);
          if (byName) selectEl = byName as HTMLSelectElement;
        }
      }

      if (!selectEl) {
        selectEl = matchingLabel.querySelector("select");
      }

      if (!selectEl) {
        const sibling = matchingLabel.nextElementSibling;
        if (sibling && sibling.tagName === "SELECT") {
          selectEl = sibling as HTMLSelectElement;
        }
      }

      if (!selectEl) {
        sendResponse({ error: `No select found for label: "${label}"` });
        return false;
      }

      let selector: string;
      if (selectEl.id) {
        selector = `#${CSS.escape(selectEl.id)}`;
      } else if (selectEl.getAttribute("name")) {
        const name = selectEl.getAttribute("name")!;
        selector = `select[name="${CSS.escape(name)}"]`;
      } else {
        const tempId = `lens-select-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        selectEl.setAttribute("data-lens-select-id", tempId);
        selector = `select[data-lens-select-id="${tempId}"]`;
      }

      sendResponse({
        success: true,
        selector,
        label: matchingLabel.textContent?.trim(),
      });
    } catch (err) {
      sendResponse({
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  }),
  ["dropdown.choose"]: route(['selector', 'value', 'by'], (message, sendResponse) => {
    try {
      const { selector, value, by = "text" } = message;
      if (!selector) {
        sendResponse({ error: "Selector required" });
        return false;
      }
      if (!value) {
        sendResponse({ error: "Value required" });
        return false;
      }

      const selectEl = document.querySelector(selector) as HTMLSelectElement;
      if (!selectEl) {
        sendResponse({ error: `Select element not found: ${selector}` });
        return false;
      }
      if (selectEl.tagName !== "SELECT") {
        sendResponse({ error: `Element is not a select: ${selector}` });
        return false;
      }

      let option: HTMLOptionElement | null = null;
      const options = Array.from(selectEl.options);

      if (by === "value") {
        option = options.find((opt) => opt.value === value) || null;
      } else {
        const valueLower = value.toLowerCase().trim();
        option = options.find((opt) => opt.textContent?.trim().toLowerCase() === valueLower) || null;

        if (!option) {
          option = options.find((opt) => opt.textContent?.toLowerCase().includes(valueLower)) || null;
        }
      }

      if (!option) {
        sendResponse({
          error: `Option not found: "${value}"`,
          available: options.map((opt) => opt.textContent?.trim() || ""),
        });
        return false;
      }

      const previousValue = selectEl.value;
      selectEl.value = option.value;

      selectEl.dispatchEvent(new Event("input", { bubbles: true }));
      selectEl.dispatchEvent(new Event("change", { bubbles: true }));

      sendResponse({
        success: true,
        selected: option.textContent?.trim(),
        value: option.value,
        changed: previousValue !== option.value,
      });
    } catch (err) {
      sendResponse({
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  }),
};
