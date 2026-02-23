export interface ElementRecord {
  element: WeakRef<Element>;
  role: string;
  name: string;
}

declare global {
  interface Window {
    __lensElementMap?: Record<string, ElementRecord>;
    __lensRefs?: Record<string, Element>;
  }
}

let serial = 0;

export function getElementMap(): Record<string, ElementRecord> {
  return (window.__lensElementMap ??= {});
}

export function resetReadRefs(): void {
  window.__lensRefs = {};
}

export function registerElement(element: Element, role: string, name: string): string {
  const previous = (element as Element & { _lensRef?: { role: string; name: string; ref: string } })._lensRef;
  const ref = previous?.role === role && previous.name === name ? previous.ref : `e${++serial}`;
  if (ref !== previous?.ref) {
    (element as Element & { _lensRef?: { role: string; name: string; ref: string } })._lensRef = {
      role,
      name,
      ref,
    };
  }
  getElementMap()[ref] = { element: new WeakRef(element), role, name };
  (window.__lensRefs ??= {})[ref] = element;
  return ref;
}

export function resolveRef(ref: string): Element | null {
  const record = getElementMap()[ref];
  const live = record?.element.deref();
  if (record && !live) delete getElementMap()[ref];
  return live ?? window.__lensRefs?.[ref] ?? null;
}
