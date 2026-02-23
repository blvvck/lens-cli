export interface PageStateSnapshot {
  hasModal: boolean;
  hasDropdown: boolean;
  hasDatePicker: boolean;
  hasOverlay: boolean;
  focusedElement: { tag: string; type?: string } | null;
  url: string;
  title: string;
}

type DocumentLike = Pick<Document, "activeElement" | "location" | "querySelectorAll" | "title">;
type QueryRootLike = Pick<ParentNode, "querySelectorAll">;
type TextVisibleElement = HTMLElement & { innerText?: string };
export const VISIBLE_TEXT_OBSERVER_ATTRIBUTE_FILTER = ["style", "class", "hidden", "aria-hidden"] as const;

function isVisibleElement(element: Element | null): element is HTMLElement {
  if (!element) return false;
  const htmlElement = element as HTMLElement;
  const view = element.ownerDocument?.defaultView;
  const style = view?.getComputedStyle ? view.getComputedStyle(htmlElement) : null;
  if (style) {
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
  }
  return htmlElement.offsetWidth > 0 && htmlElement.offsetHeight > 0;
}

function hasVisibleMatch(doc: DocumentLike, selectors: string[]): boolean {
  for (const selector of selectors) {
    for (const element of Array.from(doc.querySelectorAll(selector))) {
      if (isVisibleElement(element)) return true;
    }
  }
  return false;
}

export function findVisibleTextMatch(root: QueryRootLike, text: string): Element | null {
  const candidates = Array.from(root.querySelectorAll("*"));
  if ("offsetWidth" in root && "offsetHeight" in root) {
    candidates.unshift(root as unknown as Element);
  }
  for (const element of candidates) {
    if (!isVisibleElement(element)) continue;
    const htmlElement = element as TextVisibleElement;
    const visibleText = typeof htmlElement.innerText === "string"
      ? htmlElement.innerText
      : (htmlElement.textContent || "");
    if (visibleText.includes(text)) {
      return element;
    }
  }
  return null;
}

export function getVisibleTextObserverOptions(): MutationObserverInit {
  return {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...VISIBLE_TEXT_OBSERVER_ATTRIBUTE_FILTER],
  };
}

export function getInteractivePageState(doc: DocumentLike = document): PageStateSnapshot {
  const hasModal = hasVisibleMatch(doc, [
    "dialog[open]",
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[aria-modal="true"]',
    ".modal.show",
    ".MuiModal-root",
    ".MuiDialog-root",
  ]);

  const hasDropdown = hasVisibleMatch(doc, [
    '[role="listbox"]',
    '[role="menu"]',
    ".dropdown-menu.show",
    '[data-state="open"][role="listbox"]',
    '[data-state="open"][role="menu"]',
  ]);

  const hasDatePicker = hasVisibleMatch(doc, [
    '[role="grid"][aria-label*="calendar" i]',
    ".react-datepicker",
    ".flatpickr-calendar.open",
    '[class*="DatePicker"]',
    '[data-testid*="datepicker" i]',
  ]);

  const focusedElement = doc.activeElement?.tagName
    ? {
        tag: doc.activeElement.tagName.toLowerCase(),
        type: doc.activeElement.getAttribute?.("type") || undefined,
      }
    : null;

  return {
    hasModal,
    hasDropdown,
    hasDatePicker,
    hasOverlay: hasModal || hasDropdown || hasDatePicker,
    focusedElement,
    url: doc.location?.href || "",
    title: doc.title || "",
  };
}
