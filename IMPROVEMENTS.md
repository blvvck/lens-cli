# Lens CLI — Reliability & Feature Improvements

These are the reliability and feature improvements made in Lens CLI.

---

## 1. Actionability Checks (Playwright-inspired)

**Problem:** Clicking elements that are hidden, animating, or covered by overlays silently fails.

**Solution:** Before any interaction, verify the element is actually actionable.

**File:** `src/content/tree/index.ts`

**Add this function:**

```typescript
async function ensureActionable(element: Element, timeoutMs = 5000): Promise<{ error?: string }> {
  const deadline = Date.now() + timeoutMs;

  // 1. Scroll into view
  element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });

  // 2. Wait for visible + stable position + hit-test
  let lastRect = element.getBoundingClientRect();
  let stableCount = 0;

  while (Date.now() < deadline) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);

    // Check visibility
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      stableCount = 0;
      await new Promise(r => setTimeout(r, 50));
      continue;
    }

    // Check has size
    if (rect.width === 0 && rect.height === 0) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, 50));
      continue;
    }

    // Check stable position (not animating)
    if (Math.abs(rect.x - lastRect.x) < 1 && Math.abs(rect.y - lastRect.y) < 1 &&
        Math.abs(rect.width - lastRect.width) < 1 && Math.abs(rect.height - lastRect.height) < 1) {
      stableCount++;
      if (stableCount >= 2) {
        // 3. Hit-test: verify element is not obscured by overlay/modal
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const topEl = document.elementFromPoint(cx, cy);
        if (topEl && (topEl === element || element.contains(topEl) || topEl.contains(element))) {
          return {}; // Element is visible and receivable
        }
        // Element is covered — wait for overlay to disappear
        stableCount = 0;
        await new Promise(r => setTimeout(r, 50));
        continue;
      }
    } else {
      stableCount = 0;
    }

    lastRect = rect;
    await new Promise(r => setTimeout(r, 50));
  }

  return { error: "Element not actionable within timeout (not visible, animating, or obscured by another element)" };
}
```

**How it works:**
1. **Scroll into view** — uses `scrollIntoView({ block: "center" })` so element is centered
2. **Wait visible** — checks `display`, `visibility`, `opacity`, and element dimensions
3. **Wait stable** — polls bounding rect every 50ms, requires 2 consecutive stable frames (no animation)
4. **Hit-test** — calls `document.elementFromPoint(cx, cy)` at the element's center to verify nothing covers it (modals, overlays, tooltips). Accepts if the top element is the target, contains it, or is contained by it

**Playwright equivalent:** This mirrors Playwright's `actionability checks` — the sequence of scroll → visible → stable → receivesEvents before any action.

---

## 2. Retry Loop with Ref Re-resolution

**Problem:** After a click triggers a framework re-render (React, Vue), element refs go stale. The next action fails with "element not found" even though the element is still visually there.

**Solution:** Wrap interactions in a retry loop that re-resolves the ref on each attempt.

**File:** `src/content/tree/index.ts` — `CLICK_ELEMENT` handler

**Replace the existing CLICK_ELEMENT case with:**

```typescript
case "CLICK_ELEMENT": {
  const timeoutMs = message.timeout || 5000;
  const deadline = Date.now() + timeoutMs;
  const maxRetries = 3;

  const attemptClick = async () => {
    for (let attempt = 0; attempt < maxRetries && Date.now() < deadline; attempt++) {
      // Re-resolve ref each attempt (handles framework re-renders)
      const element = resolveRef(message.ref);
      if (!element) {
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, 100));
          continue;
        }
        sendResponse({ error: `Element ${message.ref} not found. Use page.inspect to get current elements.` });
        return;
      }

      const remaining = Math.max(deadline - Date.now(), 500);
      const { error } = await ensureActionable(element, remaining);
      if (error) {
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, 100));
          continue;
        }
        sendResponse({ success: false, error });
        return;
      }

      try {
        if (message.button === "triple") {
          element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, detail: 3 }));
        } else if (message.button === "double") {
          element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
        } else if (message.button === "right") {
          element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, view: window }));
        } else {
          (element as HTMLElement).click();
        }
        sendResponse({ success: true });
        return;
      } catch (e) {
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, 100));
          continue;
        }
        sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) });
        return;
      }
    }
    sendResponse({ error: `Element ${message.ref} not found after ${maxRetries} retries.` });
  };

  attemptClick();
  return true; // async sendResponse
}
```

**Key details:**
- 3 retries within a 5s deadline (configurable via `message.timeout`)
- `resolveRef()` is called fresh each attempt — if React unmounts and remounts the element, the new DOM node is found
- Each attempt runs `ensureActionable()` before acting
- 100ms delay between retries
- Same pattern should be applied to `GET_ELEMENT_COORDINATES` handler

---

## 3. Navigation-Aware Network Settling

**Problem:** After a click that causes navigation (link click, form submit), the code tries to read the page before it's loaded. After a click that triggers XHR/fetch (SPA update), the code reads stale DOM.

**Solution:** Post-action network settle that distinguishes between full navigations and in-page requests.

**File:** `src/service-worker/main.ts`

**Add this function:**

```typescript
async function waitForNetworkSettle(tabId: number, baseDelay = 200, maxWait = 3000): Promise<void> {
  await new Promise(r => setTimeout(r, baseDelay));
  const deadline = Date.now() + maxWait;

  try {
    // Check if navigation happened (page is loading)
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "loading") {
      // Wait for navigation to complete
      await new Promise<void>((resolve) => {
        const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabUpdateInfo) => {
          if (updatedTabId === tabId && changeInfo.status === "complete") {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(onUpdated);
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }, Math.min(maxWait, 10000));
      });
      return;
    }

    // No navigation — poll for pending XHR/fetch requests
    while (Date.now() < deadline) {
      const result = await cdp.evaluateScript(tabId,
        `(() => { try { return performance.getEntriesByType('resource').filter(e => e.responseEnd === 0).length; } catch { return 0; } })()`
      );
      const pending = result?.result?.value || 0;
      if (pending === 0) return;
      await new Promise(r => setTimeout(r, 200));
    }
  } catch {
    // Debugger not attached or page navigated — that's fine
  }
}
```

**Call it after these handlers:**
- `CLICK_REF` — after the click succeeds
- `HOVER_REF` — after the hover (some sites load on hover)
- `FORM_FILL` — after form submission

**How it works:**
1. **Base delay** — 200ms to let the browser start any network activity
2. **Navigation check** — if `tab.status === "loading"`, a full navigation happened. Wait for the `status: "complete"` event via `chrome.tabs.onUpdated`
3. **Pending request check** — if no navigation, poll `performance.getEntriesByType('resource')` for entries where `responseEnd === 0` (still in-flight). Wait until zero pending
4. **Safety timeout** — never wait longer than `maxWait` (3s default)

---

## 4. React-Compatible Form Fill

**Problem:** Setting `input.value = "text"` directly doesn't trigger React's synthetic event system. React controls form state via its own event handlers — direct DOM manipulation is invisible to it.

**Solution:** Use the native prototype setter to bypass React's controlled component pattern, then fire synthetic events.

**File:** `src/content/tree/index.ts` — inside the `FORM_FILL` handler

**The key function:**

```typescript
const setNativeValue = (el: HTMLInputElement | HTMLTextAreaElement, val: string) => {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (nativeSetter) {
    nativeSetter.call(el, val);
  } else {
    el.value = val;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
};
```

**Why this works:**
- React overrides the `value` property on input elements with a custom getter/setter
- `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set` gets the **original** browser setter, bypassing React's override
- Calling the native setter updates the actual DOM value
- Dispatching `input` and `change` events with `bubbles: true` triggers React's synthetic event system, which picks up the new value

**Use `setNativeValue()` everywhere you set form values** — not just in FORM_FILL but also in any type/fill operation.

---

## 5. Visual Layout Tree (`page.layout`)

**Problem:** `page.read` (accessibility tree) shows semantic structure but not visual layout. When debugging CSS or understanding page structure, you need to know positions, sizes, flex/grid layouts, colors, and fonts.

**Solution:** New command that generates a visual layout tree with computed styles and positions.

**File:** `src/content/tree/index.ts` — add `GENERATE_LAYOUT_TREE` message handler
**File:** `src/service-worker/main.ts` — add `LAYOUT_PAGE` case to route the message

### Content script handler

Add a new case in the message listener:

```typescript
case "GENERATE_LAYOUT_TREE": {
  const options = message.options || {};
  const maxDepth = options.depth ?? 10;
  const layoutFilter = options.filter || "visual"; // "visual" | "all" | "interactive"

  const lines: string[] = [];

  const LAYOUT_STYLES = [
    'display', 'flexDirection', 'gap', 'gridTemplateColumns',
    'fontSize', 'fontWeight', 'color', 'backgroundColor',
    'padding', 'borderRadius',
  ] as const;

  function isLayoutVisible(element: Element): boolean {
    const style = window.getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      (element as HTMLElement).offsetWidth > 0 &&
      (element as HTMLElement).offsetHeight > 0
    );
  }

  function rgbToHex(rgb: string): string {
    if (!rgb || rgb === 'transparent' || rgb === 'rgba(0, 0, 0, 0)') return '';
    const match = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return rgb;
    const [, r, g, b] = match;
    return '#' + [r, g, b].map(x => parseInt(x).toString(16).padStart(2, '0')).join('');
  }

  function formatLayoutStyles(element: Element): string {
    const s = window.getComputedStyle(element);
    const parts: string[] = [];
    const rect = element.getBoundingClientRect();

    // Position and size
    parts.push(`${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`);

    // Layout mode
    if (['flex', 'inline-flex'].includes(s.display)) {
      const dir = s.flexDirection === 'row' ? 'row' : 'col';
      const gap = s.gap !== 'normal' && s.gap !== '0px' ? ` gap:${s.gap}` : '';
      parts.push(`flex:${dir}${gap}`);
    } else if (['grid', 'inline-grid'].includes(s.display)) {
      const cols = s.gridTemplateColumns;
      const colCount = cols.split(' ').filter(c => c && c !== 'none').length;
      const gap = s.gap !== 'normal' && s.gap !== '0px' ? ` gap:${s.gap}` : '';
      parts.push(`grid:${colCount}col${gap}`);
    }

    // Font (only for text-bearing elements)
    const hasDirectText = Array.from(element.childNodes).some(
      n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()
    );
    if (hasDirectText) {
      const weight = parseInt(s.fontWeight) >= 600 ? ' bold' : '';
      parts.push(`font:${s.fontSize}${weight}`);
      const color = rgbToHex(s.color);
      if (color) parts.push(color);
    }

    // Background
    const bg = rgbToHex(s.backgroundColor);
    if (bg) parts.push(`bg:${bg}`);

    // Padding
    if (s.padding && s.padding !== '0px') parts.push(`pad:${s.padding}`);

    // Border radius
    if (s.borderRadius && s.borderRadius !== '0px') parts.push(`r:${s.borderRadius}`);

    return parts.join(' ');
  }

  // Walk the DOM tree, building indented layout output
  function walk(node: Element, depth: number) {
    if (depth > maxDepth) return;
    if (!shouldIncludeForLayout(node)) return;

    const indent = "  ".repeat(depth);
    const tag = node.tagName.toLowerCase();
    const name = getName(node);
    const styles = formatLayoutStyles(node);
    const ref = node.getAttribute("data-lens-ref") || "";

    const nameStr = name ? ` "${name}"` : "";
    const refStr = ref ? ` [${ref}]` : "";
    lines.push(`${indent}${tag}${nameStr}${refStr} | ${styles}`);

    for (const child of node.children) {
      walk(child, depth + 1);
    }
  }

  const root = selector ? document.querySelector(selector) : document.body;
  if (root) walk(root, 0);

  sendResponse({ layoutTree: lines.join("\n") });
  break;
}
```

### Service worker routing

Add to the `handleMessage` switch:

```typescript
case "LAYOUT_PAGE": {
  if (!tabId) throw new Error("No tabId provided");

  // Hide our own indicators so they don't appear in the tree
  try {
    await chrome.tabs.sendMessage(tabId, { type: "HIDE_FOR_TOOL_USE" }, { frameId: 0 });
  } catch (e) {}
  await new Promise(resolve => setTimeout(resolve, 50));

  let layoutResult;
  try {
    layoutResult = await chrome.tabs.sendMessage(tabId, {
      type: "GENERATE_LAYOUT_TREE",
      options: message.options || {},
    }, { frameId: frameId });
  } catch (err) {
    return { error: "Content script not loaded. Try refreshing the page.", layoutTree: "" };
  } finally {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "SHOW_AFTER_TOOL_USE" });
    } catch (e) {}
  }
  return layoutResult;
}
```

### CLI mapping

In `native/routing/domains/page.cjs`, add the tool mapping:

```javascript
"page.layout": (args, context) => ({
  type: "LAYOUT_PAGE",
  options: {
    depth: args.depth ? parseInt(args.depth, 10) : undefined,
    filter: args.filter || "visual",
    selector: args.selector,
  },
  tabId: context.tabId,
}),
```

### Example output

```
body | 0,0 1440x3200 flex:col
  header | 0,0 1440x64 flex:row gap:16px bg:#ffffff pad:0px 16px
    a "Home" [e1] | 16,16 80x32 font:16px bold #1a1a1a
    nav | 200,16 800x32 flex:row gap:24px
      a "Products" [e2] | 200,16 72x32 font:14px #666666
      a "Pricing" [e3] | 296,16 56x32 font:14px #666666
  main | 0,64 1440x2800 flex:col
    section "Hero" | 0,64 1440x600 flex:col bg:#f0f4ff pad:80px
      h1 "Build faster" | 200,144 1040x48 font:48px bold #111111
```

**Why this matters:** This gives AI agents the same information a developer sees in Chrome DevTools — positions, sizes, layout modes, colors, fonts — without taking a screenshot. It's ~10x fewer tokens than a screenshot and directly actionable.

---

## Summary

| Improvement | What it fixes | Where |
|-------------|--------------|-------|
| `ensureActionable()` | Clicks on hidden/animating/covered elements | `tree/index.ts` |
| Retry loop + ref re-resolution | Stale refs after React re-renders | `tree/index.ts` CLICK_ELEMENT |
| `waitForNetworkSettle()` | Reading page before navigation/XHR completes | `service-worker/main.ts` |
| `setNativeValue()` | Form fill not working on React apps | `tree/index.ts` FORM_FILL |
| `page.layout` | No visual layout info for AI agents | Both files + `native/routing/domains/page.cjs` |

All improvements are modeled after Playwright's approach. The main insight: Playwright's reliability comes from **never assuming the page is ready** — it always waits for actionability before acting and settles after acting.
