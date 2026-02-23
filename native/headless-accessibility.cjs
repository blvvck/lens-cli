/**
 * headless-accessibility.cjs — Accessibility tree for headless mode
 *
 * Injects the compiled tree/index.ts into headless pages via CDP.
 * The content script normally uses chrome.runtime.onMessage — we wrap it
 * to expose callable functions instead.
 */

const fs = require("fs");
const path = require("path");
const {
  ACCESSIBILITY_BRIDGE_GLOBALS,
  ACCESSIBILITY_MESSAGE_TYPES,
  buildGenerateAccessibilityTreeMessage,
  normalizeAccessibilityTreeOptions,
} = require("./runtime/accessibility-contract.cjs");

function stripSourceMapComment(source) {
  return source.replace(/\n?\/\/# sourceMappingURL=.*$/m, "");
}

function buildInjectableAccessibilityScript(scriptSource, scriptPath, fsRef = fs, pathRef = path) {
  const importMatch = scriptSource.match(/^import\{[^}]+ as (\w+)\}from"([^"]+)";/);
  if (!importMatch) return stripSourceMapComment(scriptSource);

  const [, importName, relativeChunkPath] = importMatch;
  const chunkPath = pathRef.resolve(pathRef.dirname(scriptPath), relativeChunkPath);
  const rawChunkSource = stripSourceMapComment(fsRef.readFileSync(chunkPath, "utf8"));
  const exportMatch = rawChunkSource.match(/export\s*\{([^}]+)\};?/);
  const exportedContractAlias = exportMatch?.[1]
    ?.split(",")
    .map((entry) => entry.trim())
    .find((entry) => /\bas\s+a\b/.test(entry))
    ?.match(/^(\w+)\s+as\s+a$/)?.[1];
  if (!exportedContractAlias) {
    throw new Error(`Unable to resolve accessibility contract export from ${chunkPath}`);
  }
  const chunkSource = rawChunkSource.replace(/export\s*\{[^}]+\};?/, "");

  return stripSourceMapComment(
    scriptSource.replace(
      importMatch[0],
      `const ${importName} = (() => { ${chunkSource}\nreturn ${exportedContractAlias}; })();`
    )
  );
}

class HeadlessAccessibility {
  constructor(cdp) {
    this._cdp = cdp;
    this._injected = false;
  }

  async _ensureBridge() {
    if (!this._injected) {
      await this.inject();
      return;
    }

    const probe = await this._cdp.evaluateScript(
      `(() => ({
        getTreeType: typeof window[${JSON.stringify(ACCESSIBILITY_BRIDGE_GLOBALS.GET_TREE)}],
        hasHandlers:
          typeof window[${JSON.stringify(ACCESSIBILITY_BRIDGE_GLOBALS.HAS_HANDLERS)}] === "function"
            ? !!window[${JSON.stringify(ACCESSIBILITY_BRIDGE_GLOBALS.HAS_HANDLERS)}]()
            : false,
      }))()`
    );
    const probeValue = probe.result?.value || {};
    if (probe.exceptionDetails || probeValue.getTreeType !== "function" || !probeValue.hasHandlers) {
      this._injected = false;
      await this.inject();
    }
  }

  /**
   * Inject the accessibility tree script into the page.
   * Call this after connecting to a page target.
   * Uses Page.addScriptToEvaluateOnNewDocument so it survives navigation.
   */
  async inject() {
    // Read the compiled content script
    const scriptPath = path.join(__dirname, "..", "dist", "content", "tree", "index.js");
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Accessibility tree script not found at ${scriptPath}. Run 'npm run build' first.`);
    }
    const scriptSource = buildInjectableAccessibilityScript(
      fs.readFileSync(scriptPath, "utf-8"),
      scriptPath,
      fs,
      path
    );

    const bridgeGlobals = ACCESSIBILITY_BRIDGE_GLOBALS;
    const messageTypes = ACCESSIBILITY_MESSAGE_TYPES;
    const defaultTreeMessage = buildGenerateAccessibilityTreeMessage();

    // Wrap the script:
    // 1. Stub out chrome.runtime.onMessage so the script doesn't throw
    // 2. Capture the message handler so we can call it via __lensHandleMessage()
    // 3. Expose __lensGetTree() for direct tree generation
    const wrappedScript = `
(function() {
  // Stub chrome.runtime for content script compatibility
  if (typeof chrome === 'undefined') window.chrome = {};
  if (!chrome.runtime) chrome.runtime = {};

  // Capture the onMessage handler the content script registers
  const _lensHandlers = [];
  chrome.runtime.onMessage = {
    addListener: function(handler) { _lensHandlers.push(handler); }
  };

  // Inject the original content script
  try {
    ${scriptSource}
  } catch(e) {
    console.warn('[Lens] Content script injection warning:', e.message);
  }

  // Expose a function to simulate sending messages to the content script
  window[${JSON.stringify(bridgeGlobals.HANDLE_MESSAGE)}] = function(message) {
    return new Promise(function(resolve) {
      if (_lensHandlers.length === 0) {
        resolve({ error: 'No handlers registered' });
        return;
      }
      // Call the last registered handler (the main one)
      const handler = _lensHandlers[_lensHandlers.length - 1];
      try {
        handler(message, {}, resolve);
      } catch(e) {
        resolve({ error: e.message });
      }
    });
  };

  window[${JSON.stringify(bridgeGlobals.HAS_HANDLERS)}] = function() {
    return _lensHandlers.length > 0;
  };

  // Shortcut for generating the tree
  window[${JSON.stringify(bridgeGlobals.GET_TREE)}] = function(options) {
    return window[${JSON.stringify(bridgeGlobals.HANDLE_MESSAGE)}]({
      type: ${JSON.stringify(defaultTreeMessage.type)},
      options: options || ${JSON.stringify(defaultTreeMessage.options)}
    });
  };

  // Shortcut for getting page text
  window[${JSON.stringify(bridgeGlobals.GET_TEXT)}] = function() {
    return window[${JSON.stringify(bridgeGlobals.HANDLE_MESSAGE)}]({ type: ${JSON.stringify(messageTypes.GET_PAGE_TEXT)} });
  };

  // Shortcut for getting page state
  window[${JSON.stringify(bridgeGlobals.GET_STATE)}] = function() {
    return window[${JSON.stringify(bridgeGlobals.HANDLE_MESSAGE)}]({ type: ${JSON.stringify(messageTypes.GET_PAGE_STATE)} });
  };

  // Shortcut for getting element coordinates by ref
  window[${JSON.stringify(bridgeGlobals.GET_COORDS)}] = function(ref) {
    return window[${JSON.stringify(bridgeGlobals.HANDLE_MESSAGE)}]({ type: ${JSON.stringify(messageTypes.GET_ELEMENT_COORDINATES)}, ref: ref });
  };

  // Shortcut for getting element info for form fill
  window[${JSON.stringify(bridgeGlobals.GET_FILL_INFO)}] = function(ref) {
    return window[${JSON.stringify(bridgeGlobals.HANDLE_MESSAGE)}]({ type: ${JSON.stringify(messageTypes.GET_ELEMENT_INFO_FOR_FILL)}, ref: ref });
  };

  // Shortcut for setting select value
  window[${JSON.stringify(bridgeGlobals.SET_SELECT)}] = function(ref, value) {
    return window[${JSON.stringify(bridgeGlobals.HANDLE_MESSAGE)}]({ type: ${JSON.stringify(messageTypes.SET_SELECT_VALUE)}, ref: ref, value: value });
  };
})();
`;

    // Inject on every new document (survives navigation)
    await this._cdp.addScriptOnNewDocument(wrappedScript);

    // Also inject into the current page if one is already loaded
    const injectionResult = await this._cdp.evaluateScript(wrappedScript);
    if (injectionResult.exceptionDetails) {
      throw new Error(
        injectionResult.exceptionDetails.exception?.description ||
        injectionResult.exceptionDetails.text ||
        "Failed to inject accessibility bridge"
      );
    }

    this._injected = true;
  }

  /**
   * Get the accessibility tree from the current page.
   * @param {object} options - { filter, depth, compact, refId }
   * @returns {{ pageContent: string, viewport: object, error?: string }}
   */
  async getTree(options = {}) {
    await this._ensureBridge();

    const opts = normalizeAccessibilityTreeOptions(options);

    const result = await this._cdp.evaluateScript(
      `(async () => {
        try {
          return await window[${JSON.stringify(ACCESSIBILITY_BRIDGE_GLOBALS.GET_TREE)}](${JSON.stringify(opts)});
        } catch (error) {
          return { error: error?.message || String(error), pageContent: "", viewport: { width: 0, height: 0 } };
        }
      })()`
    );

    if (result.exceptionDetails) {
      return {
        error: result.exceptionDetails.text || result.exceptionDetails.exception?.description || "Tree generation failed",
        pageContent: "",
        viewport: { width: 0, height: 0 },
      };
    }

    const tree = result.result?.value;
    if (!tree) {
      return {
        error: "No tree returned. Page may not be ready.",
        pageContent: "",
        viewport: { width: 0, height: 0 },
      };
    }

    // Get page text if requested
    if (opts.includeText) {
      const textResult = await this._cdp.evaluateScript(`(async () => {
        try {
          return await window[${JSON.stringify(ACCESSIBILITY_BRIDGE_GLOBALS.GET_TEXT)}]();
        } catch (error) {
          return { error: error?.message || String(error), text: "" };
        }
      })()`);
      if (textResult.result?.value?.text) {
        tree.text = textResult.result.value.text;
      }
    }

    return tree;
  }

  /**
   * Get element coordinates by ref (e.g., "e1").
   * @returns {{ x: number, y: number, error?: string }}
   */
  async getElementCoordinates(ref) {
    await this._ensureBridge();

    const result = await this._cdp.evaluateScript(
      `window[${JSON.stringify(ACCESSIBILITY_BRIDGE_GLOBALS.GET_COORDS)}](${JSON.stringify(ref)})`
    );

    if (result.exceptionDetails) {
      return { error: result.exceptionDetails.text || "Failed to get coordinates" };
    }

    return result.result?.value || { error: "No coordinates returned" };
  }

  /**
   * Get element info for form fill (type, isCheckOrRadio, isSelect, etc.).
   * @returns {{ x, y, isCheckOrRadio, isSelect, isContentEditable, tag, type, error? }}
   */
  async getElementFillInfo(ref) {
    await this._ensureBridge();

    const result = await this._cdp.evaluateScript(
      `window[${JSON.stringify(ACCESSIBILITY_BRIDGE_GLOBALS.GET_FILL_INFO)}](${JSON.stringify(ref)})`
    );

    if (result.exceptionDetails) {
      return { error: result.exceptionDetails.text || "Failed to get element info" };
    }

    return result.result?.value || { error: "No element info returned" };
  }

  /**
   * Set a select element's value.
   */
  async setSelectValue(ref, value) {
    await this._ensureBridge();

    const result = await this._cdp.evaluateScript(
      `window[${JSON.stringify(ACCESSIBILITY_BRIDGE_GLOBALS.SET_SELECT)}](${JSON.stringify(ref)}, ${JSON.stringify(value)})`
    );

    if (result.exceptionDetails) {
      return { error: result.exceptionDetails.text || "Failed to set select value" };
    }

    return result.result?.value || { success: true };
  }

  async getPageText() {
    await this._ensureBridge();

    const result = await this._cdp.evaluateScript(`(async () => {
      try {
        return await window[${JSON.stringify(ACCESSIBILITY_BRIDGE_GLOBALS.GET_TEXT)}]();
      } catch (error) {
        return { error: error?.message || String(error), text: "" };
      }
    })()`);

    if (result.exceptionDetails) {
      return { text: "", error: result.exceptionDetails.text || "Failed to get page text" };
    }

    return result.result?.value || { text: "" };
  }

  /**
   * Get the current page interactive state.
   */
  async getPageState() {
    await this._ensureBridge();

    const result = await this._cdp.evaluateScript(`(async () => {
      try {
        return await window[${JSON.stringify(ACCESSIBILITY_BRIDGE_GLOBALS.GET_STATE)}]();
      } catch (error) {
        return { error: error?.message || String(error) };
      }
    })()`);

    if (result.exceptionDetails) {
      return {
        hasModal: false,
        hasDropdown: false,
        hasDatePicker: false,
        hasOverlay: false,
        focusedElement: null,
        url: "",
        title: "",
        error: result.exceptionDetails.text || "Failed to get page state",
      };
    }

    return result.result?.value || {
      hasModal: false,
      hasDropdown: false,
      hasDatePicker: false,
      hasOverlay: false,
      focusedElement: null,
      url: "",
      title: "",
    };
  }
}

module.exports = { HeadlessAccessibility, buildInjectableAccessibilityScript };
