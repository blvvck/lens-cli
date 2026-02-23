export function isVisible(element: Element): boolean {
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" &&
    (element as HTMLElement).offsetWidth > 0 && (element as HTMLElement).offsetHeight > 0;
}

export function dispatchEvents(element: Element, ...types: string[]): void {
  for (const type of types) element.dispatchEvent(new Event(type, { bubbles: true }));
}

export function errorMessage(error: unknown, fallback = "Unknown error"): string {
  return error instanceof Error ? error.message : fallback;
}
