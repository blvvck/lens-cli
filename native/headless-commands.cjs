/**
 * headless-commands.cjs — Command handler for headless mode
 *
 * Mirrors the service-worker handleMessage() switch but uses
 * HeadlessCDP + HeadlessAccessibility instead of chrome.* APIs.
 */

const MODIFIERS_META = 4; // macOS meta key

function validateSmartType(message) {
  const { selector, text, clear = true, submit = false } = message;
  if (!selector) return { success: false, error: "selector required" };
  if (text === undefined) return { success: false, error: "text required" };
  return { success: true, selector, text, clear, submit };
}

/**
 * Handle a command message in headless mode.
 * @param {object} message - Same format as extension messages (type, tabId, etc.)
 * @param {import('./headless-cdp.cjs').HeadlessCDP} cdp
 * @param {import('./headless-accessibility.cjs').HeadlessAccessibility} accessibility
 * @param {import('./fetch-interceptor.cjs').FetchInterceptor} [fetchInterceptor]
 * @returns {Promise<object>} Response object
 */
async function handleHeadlessCommand(message, cdp, accessibility, fetchInterceptor) {
  const type = message.type;

  switch (type) {
    // ── Navigation ─────────────────────────────────────────────

    case "open": {
      if (!message.url) throw new Error("No url provided");
      await cdp.navigate(message.url);
      const url = await cdp.getUrl();
      const title = await cdp.getTitle();
      return { success: true, url, title };
    }

    case "tab.reload": {
      await cdp.sendToPage("Page.reload");
      await cdp.waitForLoad(10000);
      return { success: true };
    }

    case "lens.page.navigateBack": {
      await cdp.evaluateScript("history.back()");
      await new Promise(r => setTimeout(r, 500));
      await cdp.waitForLoad(5000);
      return { success: true };
    }

    case "lens.page.navigateForward": {
      await cdp.evaluateScript("history.forward()");
      await new Promise(r => setTimeout(r, 500));
      await cdp.waitForLoad(5000);
      return { success: true };
    }

    // ── Page Reading ───────────────────────────────────────────

    case "page.inspect": {
      if (message.wait && message.wait > 0) {
        await new Promise(r => setTimeout(r, Math.min(message.wait, 5000)));
      }
      const options = message.options || {};
      const tree = await accessibility.getTree({
        filter: options.filter || "interactive",
        depth: options.depth,
        compact: options.compact || false,
        refId: options.refId,
        includeText: options.includeText !== false,
      });
      return tree;
    }

    case "page.text": {
      return await accessibility.getPageText();
    }

    case "page.state": {
      const state = await accessibility.getPageState();
      return state.error ? {
        hasModal: false,
        hasDropdown: false,
        hasDatePicker: false,
        hasOverlay: false,
        focusedElement: null,
        title: "",
        url: "",
      } : state;
    }

    case "wait.ready": {
      const timeout = Number(message.timeout ?? 5000);
      const selector = typeof message.selector === "string" ? message.selector : "";
      const stable = Number(message.stable ?? 100);
      const deadline = Date.now() + timeout;
      let lastState = null;

      while (Date.now() < deadline) {
        const remaining = Math.max(0, deadline - Date.now());
        await cdp.waitForLoad(Math.min(remaining, 1000)).catch(() => {});
        const stateResult = await cdp.evaluateScript(`(() => {
          const selector = ${JSON.stringify(selector)};
          const readyState = document.readyState;
          const selectorReady = !selector || !!document.querySelector(selector);
          return {
            readyState,
            selectorReady,
            title: document.title,
            url: window.location.href,
          };
        })()`);
        lastState = stateResult.result?.value || null;
        if (lastState && (lastState.readyState === "interactive" || lastState.readyState === "complete") && lastState.selectorReady) {
          const pageState = await accessibility.getPageState();
          if (pageState && !pageState.error) {
            lastState = pageState;
            if (pageState.hasOverlay) {
              return {
                error: "Page has active overlay/modal/dropdown. Use --dismiss or wait until UI is stable.",
                state: pageState,
              };
            }
          }
          if (stable > 0) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(stable, 1000)));
          }
          return { success: true, state: lastState };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      return {
        error: selector
          ? `Timed out waiting for selector "${selector}" in actionable page state`
          : "Timed out waiting for actionable page state",
        state: lastState,
      };
    }

    case "lens.dead.executeJs":
    case "lens.page.execute":
    case "run": {
      if (!message.code) throw new Error("No code provided");
      // Auto-return expressions (like DevTools console) — if no statements, wrap as return(expr)
      const hasStatements = /\b(return|var|let|const|if|for|while|do|switch|try|class|function|throw|import|export)\b/.test(message.code);
      const wrappedCode = hasStatements ? message.code : `return (${message.code})`;
      const evalCode = `(async () => { 'use strict'; ${wrappedCode} })()`;
      const jsResult = await cdp.evaluateScript(evalCode);
      if (jsResult.exceptionDetails) {
        const err = jsResult.exceptionDetails;
        throw new Error(err.exception?.description || err.text || "JS execution failed");
      }
      return { result: jsResult.result?.value };
    }

    // ── Click ──────────────────────────────────────────────────

    case "page.click": {
      const coords = await accessibility.getElementCoordinates(message.ref);
      if (coords.error) return { error: coords.error };

      const button = message.button || "left";
      if (button === "right") {
        await cdp.rightClick(coords.x, coords.y);
      } else if (button === "double") {
        await cdp.doubleClick(coords.x, coords.y);
      } else if (button === "triple") {
        await cdp.tripleClick(coords.x, coords.y);
      } else {
        await cdp.click(coords.x, coords.y, "left", 1, 0);
      }
      await new Promise(r => setTimeout(r, 150)); // Post-click delay for transitions
      return { success: true };
    }

    case "lens.page.executeClick": {
      if (message.x === undefined || message.y === undefined) throw new Error("x and y required");
      await cdp.click(message.x, message.y, "left", 1, message.modifiers || 0);
      return { success: true };
    }

    case "lens.page.executeRightClick": {
      if (message.x === undefined || message.y === undefined) throw new Error("x and y required");
      await cdp.rightClick(message.x, message.y, message.modifiers || 0);
      return { success: true };
    }

    case "lens.page.executeDoubleClick": {
      if (message.x === undefined || message.y === undefined) throw new Error("x and y required");
      await cdp.doubleClick(message.x, message.y, message.modifiers || 0);
      return { success: true };
    }

    // ── Type ───────────────────────────────────────────────────

    case "lens.page.executeType": {
      if (message.text === undefined) throw new Error("No text provided");
      await cdp.type(message.text);
      return { success: true };
    }

    case "form.fill": {
      if (!message.data || !Array.isArray(message.data)) throw new Error("data must be an array of {ref, value}");
      const results = [];
      for (const item of message.data) {
        const { ref, value } = item;
        if (!ref) { results.push({ ref: ref || "unknown", success: false, error: "Missing ref" }); continue; }
        try {
          const info = await accessibility.getElementFillInfo(ref);
          if (info.error) { results.push({ ref, success: false, error: info.error }); continue; }

          if (info.isCheckOrRadio) {
            await cdp.click(info.x, info.y, "left", 1, 0);
          } else if (info.isSelect) {
            await accessibility.setSelectValue(ref, String(value));
          } else {
            // Click to focus, select all, delete, type
            await cdp.click(info.x, info.y, "left", 1, 0);
            await new Promise(r => setTimeout(r, 50));
            await cdp.pressKey("a", MODIFIERS_META);
            await new Promise(r => setTimeout(r, 30));
            await cdp.pressKey("Backspace");
            await new Promise(r => setTimeout(r, 30));
            await cdp.type(String(value));
          }
          results.push({ ref, success: true });
        } catch (e) {
          results.push({ ref, success: false, error: e.message });
        }
      }
      const failed = results.filter(r => !r.success);
      return { success: failed.length === 0, filled: results.filter(r => r.success).length, failed: failed.length, results };
    }

    case "dropdown.choose": {
      const { target, value, by = "text", useLabel = false } = message;
      if (!target) throw new Error("target (label or selector) required");
      if (!value) throw new Error("value required");

      // Build selector for the select element
      let selectSelector;
      if (useLabel) {
        // Find by associated label text
        selectSelector = `select[data-lens-label="${target}"]`;
        // First, find and tag the select by label
        const labelResult = await cdp.evaluateScript(`(() => {
          const labelText = ${JSON.stringify(target)};
          const labels = Array.from(document.querySelectorAll('label'));
          const label = labels.find(l => l.textContent.toLowerCase().includes(labelText.toLowerCase()));
          if (!label) return { error: 'Label not found: ' + labelText };
          const forAttr = label.getAttribute('for');
          let select = null;
          if (forAttr) {
            select = document.querySelector('select#' + CSS.escape(forAttr) + ', select[name=' + CSS.escape(forAttr) + ']');
          }
          if (!select) {
            select = label.querySelector('select');
          }
          if (!select) return { error: 'No select found for label: ' + labelText };
          select.setAttribute('data-lens-label', labelText);
          return { success: true, tag: labelText };
        })()`);
        if (labelResult.result?.value?.error) {
          throw new Error(labelResult.result.value.error);
        }
      } else {
        // Direct selector or aria-label
        selectSelector = target.startsWith('#') || target.startsWith('.') || target.startsWith('[')
          ? target
          : `select[aria-label="${target}"], select[name="${target}"]`;
      }

      // Find and interact with the select element
      const result = await cdp.evaluateScript(`(() => {
        const selector = ${JSON.stringify(selectSelector)};
        const value = ${JSON.stringify(value)};
        const by = ${JSON.stringify(by)};

        const select = document.querySelector(selector);
        if (!select) return { error: 'Select element not found: ' + selector };
        if (select.tagName !== 'SELECT') return { error: 'Element is not a select: ' + selector };

        // Find the option
        let option = null;
        if (by === 'value') {
          option = Array.from(select.options).find(opt => opt.value === value);
        } else {
          // by text - case insensitive, trim whitespace
          option = Array.from(select.options).find(opt =>
            opt.textContent.trim().toLowerCase() === value.toLowerCase()
          );
          // Fallback: partial match
          if (!option) {
            option = Array.from(select.options).find(opt =>
              opt.textContent.toLowerCase().includes(value.toLowerCase())
            );
          }
        }

        if (!option) {
          return {
            error: 'Option not found: "' + value + '"',
            available: Array.from(select.options).map(opt => opt.textContent.trim())
          };
        }

        // Select the option
        const previousValue = select.value;
        select.value = option.value;
        // Trigger events
        select.dispatchEvent(new Event('change', { bubbles: true }));
        select.dispatchEvent(new Event('input', { bubbles: true }));

        return {
          success: true,
          selected: option.textContent.trim(),
          value: option.value,
          changed: previousValue !== option.value
        };
      })()`);

      const value_result = result.result?.value;
      if (value_result?.error) {
        const err = new Error(value_result.error);
        if (value_result.available) {
          err.availableOptions = value_result.available;
        }
        throw err;
      }

      return {
        success: true,
        selected: value_result?.selected,
        value: value_result?.value,
        changed: value_result?.changed
      };
    }

    case "form.smart": {
      const request = validateSmartType(message);
      if (!request.success) throw new Error(request.error);
      const { selector, text, clear, submit } = request;

      // Get element coordinates via evaluateScript
      const coordResult = await cdp.evaluateScript(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { error: 'Element not found: ' + ${JSON.stringify(selector)} };
        const hasContentEditableChild = el.querySelector('[contenteditable="true"]');
        const target = hasContentEditableChild || el;
        const r = target.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return { error: 'Element has zero size' };
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
      })()`);
      const coords = coordResult.result?.value;
      if (!coords || coords.error) return { error: coords?.error || "Failed to get coordinates" };

      await cdp.click(coords.x, coords.y, "left", 1, 0);
      await new Promise(r => setTimeout(r, 50));
      if (clear) {
        await cdp.pressKey("a", MODIFIERS_META);
        await new Promise(r => setTimeout(r, 30));
        await cdp.pressKey("Backspace");
        await new Promise(r => setTimeout(r, 30));
      }
      await cdp.type(text);
      if (submit) {
        await new Promise(r => setTimeout(r, 50));
        await cdp.pressKey("Enter");
      }
      return { success: true };
    }

    case "lens.input.paste": {
      if (message.text === undefined || message.text === null) throw new Error("No text provided");
      await cdp.sendToPage("Input.insertText", { text: message.text });
      return { success: true };
    }

    case "lens.input.typeSubmit": {
      if (!message.text) throw new Error("No text provided");
      await cdp.type(message.text);
      await new Promise(r => setTimeout(r, 50));
      await cdp.pressKey(message.submitKey || "Enter");
      return { success: true };
    }

    // ── Key ────────────────────────────────────────────────────

    case "lens.input.key": {
      if (!message.key) throw new Error("No key provided");
      if (message.key.includes("+")) {
        await cdp.pressKeyChord(message.key);
      } else {
        await cdp.pressKey(message.key);
      }
      return { success: true };
    }

    case "lens.input.repeatKey": {
      const { key, repeat, delayMs = 50 } = message;
      if (!key) throw new Error("No key provided");
      if (!repeat || repeat < 1) throw new Error("Invalid repeat count");

      for (let i = 0; i < repeat; i++) {
        if (key.includes("+")) {
          await cdp.pressKeyChord(key);
        } else {
          await cdp.pressKey(key);
        }
        // Delay between presses (skip after last press)
        if (i < repeat - 1) {
          await new Promise(r => setTimeout(r, delayMs));
        }
      }
      return { success: true, repeat, key };
    }

    // ── Hover / Drag / Scroll ──────────────────────────────────

    case "lens.page.executeHover": {
      if (message.ref) {
        const coords = await accessibility.getElementCoordinates(message.ref);
        if (coords.error) return { error: coords.error };
        await cdp.hover(coords.x, coords.y);
      } else {
        await cdp.hover(message.x, message.y);
      }
      return { success: true };
    }

    case "lens.page.executeDrag": {
      await cdp.drag(message.startX, message.startY, message.endX, message.endY, message.modifiers || 0);
      return { success: true };
    }

    case "lens.page.scroll": {
      const x = message.x || 0;
      const y = message.y || 0;
      const deltaX = message.deltaX || 0;
      const deltaY = message.deltaY || 0;
      await cdp.scroll(x, y, deltaX, deltaY);
      return { success: true };
    }

    case "lens.page.scrollTop": {
      await cdp.evaluateScript("window.scrollTo(0, 0)");
      return { success: true };
    }

    case "lens.page.scrollBottom": {
      await cdp.evaluateScript("window.scrollTo(0, document.body.scrollHeight)");
      return { success: true };
    }

    // ── Screenshot ─────────────────────────────────────────────

    case "screenshot": {
      const screenshot = await cdp.captureScreenshot({
        fullPage: message.fullPage || false,
      });
      return {
        base64: screenshot.base64,
        width: 0, // TODO: extract from image
        height: 0,
      };
    }

    // ── Dialog ─────────────────────────────────────────────────

    case "dialog.accept": {
      const dialog = cdp.getPendingDialog();
      if (!dialog) return { error: "No pending dialog" };
      await cdp.handleDialog(true, message.promptText);
      return { success: true };
    }

    case "dialog.dismiss": {
      const dialog2 = cdp.getPendingDialog();
      if (!dialog2) return { error: "No pending dialog" };
      await cdp.handleDialog(false);
      return { success: true };
    }

    case "lens.dialog.get": {
      const pending = cdp.getPendingDialog();
      return pending || { type: null, message: null };
    }

    // ── Console ────────────────────────────────────────────────

    case "lens.console.get": {
      return { messages: cdp.getConsoleMessages() };
    }

    // ── Tab management (virtual) ───────────────────────────────

    case "lens.tabs.getCurrentId": {
      return { tabId: 1 }; // Virtual tab ID
    }

    case "lens.tabs.getUrl": {
      const url = await cdp.getUrl();
      const title = await cdp.getTitle();
      return { url, title };
    }

    // ── Viewport ───────────────────────────────────────────────

    case "lens.viewport.set": {
      if (!message.width || !message.height) throw new Error("width and height required");
      await cdp.setViewport(message.width, message.height, message.deviceScaleFactor || 1);
      return { success: true };
    }

    // ── Serve & Intercept ────────────────────────────────────────

    case "lens.serve.start": {
      if (!fetchInterceptor) return { error: "Fetch interceptor not available" };
      if (!message.dir) throw new Error("dir required");
      const port = message.port || 8100;
      const urlPrefix = `http://lens.local:${port}/`;
      fetchInterceptor.addServeRoute(urlPrefix, message.dir);
      const sendFn = (m, p) => cdp.sendToPage(m, p);
      await fetchInterceptor.enable(sendFn);
      return { success: true, url: urlPrefix, dir: message.dir };
    }

    case "lens.serve.stop": {
      if (!fetchInterceptor) return { error: "Fetch interceptor not available" };
      const port = message.port || 8100;
      const urlPrefix = `http://lens.local:${port}/`;
      fetchInterceptor.removeServeRoute(urlPrefix);
      const sendFn = (m, p) => cdp.sendToPage(m, p);
      if (fetchInterceptor.hasRules()) {
        await fetchInterceptor.enable(sendFn);
      } else {
        await fetchInterceptor.disable(sendFn);
      }
      return { success: true };
    }

    case "lens.serve.status": {
      if (!fetchInterceptor) return { error: "Fetch interceptor not available" };
      return fetchInterceptor.getActiveRules();
    }

    case "lens.intercept.add": {
      if (!fetchInterceptor) return { error: "Fetch interceptor not available" };
      if (!message.pattern) throw new Error("pattern required");
      fetchInterceptor.addInterceptRule(message.pattern, {
        type: message.block ? "block" :
              message.filePath ? "file" :
              message.statusCode ? "status" :
              message.delayMs ? "delay" : "mock",
        response: message.response,
        filePath: message.filePath,
        fileContent: message.fileContent,
        status: message.statusCode,
        delayMs: message.delayMs,
        contentType: message.contentType,
      });
      const sendFn = (m, p) => cdp.sendToPage(m, p);
      await fetchInterceptor.enable(sendFn);
      return { success: true, pattern: message.pattern };
    }

    case "lens.intercept.remove": {
      if (!fetchInterceptor) return { error: "Fetch interceptor not available" };
      if (!message.pattern) throw new Error("pattern required");
      const removed = fetchInterceptor.removeInterceptRule(message.pattern);
      const sendFn = (m, p) => cdp.sendToPage(m, p);
      if (fetchInterceptor.hasRules()) {
        await fetchInterceptor.enable(sendFn);
      } else {
        await fetchInterceptor.disable(sendFn);
      }
      return { success: true, removed };
    }

    case "lens.intercept.list": {
      if (!fetchInterceptor) return { error: "Fetch interceptor not available" };
      return fetchInterceptor.getActiveRules();
    }

    case "lens.intercept.clear": {
      if (!fetchInterceptor) return { error: "Fetch interceptor not available" };
      fetchInterceptor.clearInterceptRules();
      const sendFn = (m, p) => cdp.sendToPage(m, p);
      if (fetchInterceptor.hasRules()) {
        await fetchInterceptor.enable(sendFn);
      } else {
        await fetchInterceptor.disable(sendFn);
      }
      return { success: true };
    }

    // ── Locate (via CDP DOM queries) ───────────────────────────

    case "locate.role": {
      const { role, name, all = false } = message;
      if (!role) throw new Error("role required");

      const result = await cdp.evaluateScript(`(() => {
        const role = ${JSON.stringify(role)};
        const nameFilter = ${JSON.stringify(name)};
        const all = ${JSON.stringify(all)};

        const selector = nameFilter
          ? '[role="' + role + '"][aria-label*="' + nameFilter + '"], [role="' + role + '"][title*="' + nameFilter + '"]'
          : '[role="' + role + '"]';

        const elements = Array.from(document.querySelectorAll(selector));
        if (elements.length === 0) {
          return { error: 'No elements with role "' + role + '"' + (nameFilter ? ' and name "' + nameFilter + '"' : '') + ' found' };
        }

        if (all) {
          return {
            count: elements.length,
            matches: elements.map((el, i) => ({
              tag: el.tagName.toLowerCase(),
              text: el.textContent?.slice(0, 50),
              ariaLabel: el.getAttribute('aria-label'),
            }))
          };
        }

        const el = elements[0];
        const rect = el.getBoundingClientRect();
        return {
          ref: 'found',
          tag: el.tagName.toLowerCase(),
          text: el.textContent?.slice(0, 50),
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      })()`);

      const value = result.result?.value;
      if (value?.error) return { error: value.error };
      return value;
    }

    case "locate.text": {
      const { text, exact = false } = message;
      if (!text) throw new Error("text required");

      const result = await cdp.evaluateScript(`(() => {
        const searchText = ${JSON.stringify(text)};
        const exact = ${JSON.stringify(exact)};

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        const matches = [];
        let node;
        while (node = walker.nextNode()) {
          const nodeText = node.textContent;
          const found = exact ? nodeText === searchText : nodeText.toLowerCase().includes(searchText.toLowerCase());
          if (found) {
            const el = node.parentElement;
            const rect = el.getBoundingClientRect();
            matches.push({
              tag: el.tagName.toLowerCase(),
              text: nodeText.slice(0, 100),
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
            });
          }
        }

        if (matches.length === 0) {
          return { error: 'Text "' + searchText + '" not found' };
        }

        return {
          ref: 'found',
          ...matches[0],
          count: matches.length,
        };
      })()`);

      const value = result.result?.value;
      if (value?.error) return { error: value.error };
      return value;
    }

    case "locate.label": {
      const { label } = message;
      if (!label) throw new Error("label required");

      const result = await cdp.evaluateScript(`(() => {
        const labelText = ${JSON.stringify(label)};

        // Find by label element
        const labels = Array.from(document.querySelectorAll('label'));
        const matchingLabel = labels.find(l => l.textContent.toLowerCase().includes(labelText.toLowerCase()));

        let targetEl = null;
        if (matchingLabel) {
          const forAttr = matchingLabel.getAttribute('for');
          if (forAttr) {
            targetEl = document.getElementById(forAttr);
          }
          if (!targetEl) {
            targetEl = matchingLabel.querySelector('input, select, textarea, button');
          }
        }

        // Fallback: find by aria-label or placeholder
        if (!targetEl) {
          targetEl = document.querySelector('[aria-label*="' + labelText + '"], [placeholder*="' + labelText + '"]');
        }

        if (!targetEl) {
          return { error: 'No element found for label "' + labelText + '"' };
        }

        const rect = targetEl.getBoundingClientRect();
        return {
          ref: 'found',
          tag: targetEl.tagName.toLowerCase(),
          text: targetEl.textContent?.slice(0, 50) || targetEl.value?.slice(0, 50),
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      })()`);

      const value = result.result?.value;
      if (value?.error) return { error: value.error };
      return value;
    }

    // ── Catch-all ──────────────────────────────────────────────

    default:
      return { error: `Unsupported command in headless mode: ${type}` };
  }
}

module.exports = { handleHeadlessCommand };
