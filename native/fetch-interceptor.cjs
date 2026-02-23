/**
 * fetch-interceptor.cjs — CDP Fetch domain engine for lens serve + lens intercept
 *
 * Uses Chrome DevTools Protocol Fetch domain to intercept HTTP requests
 * at the protocol level. Works in both headless (WebSocket CDP) and
 * real browser (chrome.debugger) modes via injected sendToCDP function.
 *
 * Two capabilities:
 *   1. Serve: serve local directories as virtual HTTP origins
 *   2. Intercept: mock, block, delay, or modify HTTP requests
 */

const fs = require("fs");
const path = require("path");
const { getMimeType, matchesUrlPattern } = require("./runtime/fetch-policy.cjs");

// ── Directory Listing ─────────────────────────────────────────────────

function generateDirectoryListing(urlPath, entries) {
  const parentPath = urlPath === "/" ? null : path.posix.dirname(urlPath.replace(/\/$/, "")) + "/";
  const rows = entries
    .sort((a, b) => {
      // Directories first, then alphabetical
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name);
    })
    .map(e => {
      const href = urlPath + e.name + (e.isDir ? "/" : "");
      const display = e.name + (e.isDir ? "/" : "");
      const size = e.isDir ? "-" : formatSize(e.size);
      return `      <tr><td><a href="${href}">${display}</a></td><td>${size}</td></tr>`;
    })
    .join("\n");

  const parentLink = parentPath ? `      <tr><td><a href="${parentPath}">../</a></td><td>-</td></tr>\n` : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Index of ${urlPath}</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; }
    h1 { font-size: 1.2em; color: #333; border-bottom: 1px solid #ddd; padding-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 4px 12px; }
    a { text-decoration: none; color: #2563eb; }
    a:hover { text-decoration: underline; }
    tr:hover { background: #f5f5f5; }
    .size { text-align: right; color: #666; font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>Index of ${urlPath}</h1>
  <table>
    <thead><tr><th>Name</th><th class="size">Size</th></tr></thead>
    <tbody>
${parentLink}${rows}
    </tbody>
  </table>
  <p style="color:#999;font-size:0.8em;margin-top:20px;">Served by Lens CLI</p>
</body>
</html>`;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// ── Pattern Matching ──────────────────────────────────────────────────

// ── FetchInterceptor ──────────────────────────────────────────────────

class FetchInterceptor {
  constructor() {
    /** @type {Array<{urlPrefix: string, localDir: string}>} */
    this._serveRoutes = [];
    /** @type {Array<{pattern: string, type: string, response?: string, status?: number, delayMs?: number, fileContent?: string, contentType?: string}>} */
    this._interceptRules = [];
    this._enabled = false;
  }

  // ── Serve Routes ────────────────────────────────────────

  addServeRoute(urlPrefix, localDir) {
    const resolvedDir = path.resolve(localDir);
    if (!fs.existsSync(resolvedDir)) {
      throw new Error(`Directory not found: ${resolvedDir}`);
    }
    if (!fs.statSync(resolvedDir).isDirectory()) {
      throw new Error(`Not a directory: ${resolvedDir}`);
    }
    // Remove existing route for same prefix
    this._serveRoutes = this._serveRoutes.filter(r => r.urlPrefix !== urlPrefix);
    this._serveRoutes.push({ urlPrefix, localDir: resolvedDir });
  }

  removeServeRoute(urlPrefix) {
    const before = this._serveRoutes.length;
    this._serveRoutes = this._serveRoutes.filter(r => r.urlPrefix !== urlPrefix);
    return this._serveRoutes.length < before;
  }

  // ── Intercept Rules ─────────────────────────────────────

  addInterceptRule(pattern, options = {}) {
    // Remove existing rule for same pattern
    this._interceptRules = this._interceptRules.filter(r => r.pattern !== pattern);
    const rule = { pattern, ...options };
    // Pre-read file content if filePath specified
    if (options.filePath && !options.fileContent) {
      rule.fileContent = fs.readFileSync(path.resolve(options.filePath), "utf8");
    }
    this._interceptRules.push(rule);
  }

  removeInterceptRule(pattern) {
    const before = this._interceptRules.length;
    this._interceptRules = this._interceptRules.filter(r => r.pattern !== pattern);
    return this._interceptRules.length < before;
  }

  clearInterceptRules() {
    this._interceptRules = [];
  }

  clearAll() {
    this._serveRoutes = [];
    this._interceptRules = [];
  }

  getActiveRules() {
    return {
      serveRoutes: this._serveRoutes.map(r => ({ urlPrefix: r.urlPrefix, localDir: r.localDir })),
      interceptRules: this._interceptRules.map(r => ({
        pattern: r.pattern,
        type: r.type || "mock",
      })),
    };
  }

  hasRules() {
    return this._serveRoutes.length > 0 || this._interceptRules.length > 0;
  }

  // ── CDP Fetch Enable/Disable ────────────────────────────

  /**
   * Enable CDP Fetch domain with current patterns.
   * @param {(method: string, params: object) => Promise} sendToCDP
   */
  async enable(sendToCDP) {
    const patterns = [];
    for (const route of this._serveRoutes) {
      patterns.push({ urlPattern: route.urlPrefix + "*" });
    }
    for (const rule of this._interceptRules) {
      patterns.push({ urlPattern: rule.pattern });
    }
    if (patterns.length === 0) {
      if (this._enabled) {
        await sendToCDP("Fetch.disable", {});
        this._enabled = false;
      }
      return;
    }
    await sendToCDP("Fetch.enable", { patterns });
    this._enabled = true;
  }

  /**
   * Disable CDP Fetch domain.
   * @param {(method: string, params: object) => Promise} sendToCDP
   */
  async disable(sendToCDP) {
    if (this._enabled) {
      await sendToCDP("Fetch.disable", {});
      this._enabled = false;
    }
  }

  // ── Core Request Handler ────────────────────────────────

  /**
   * Handle a Fetch.requestPaused CDP event.
   * MUST call fulfillRequest, continueRequest, or failRequest — never leave hanging.
   *
   * @param {object} params - CDP Fetch.requestPaused event params
   * @param {(method: string, params: object) => Promise} sendToCDP
   */
  async handleRequestPaused(params, sendToCDP) {
    const { requestId, request } = params;
    const url = request.url;

    try {
      // 1. Check serve routes first
      for (const route of this._serveRoutes) {
        if (url.startsWith(route.urlPrefix)) {
          await this._handleServeRequest(requestId, url, route, sendToCDP);
          return;
        }
      }

      // 2. Check intercept rules
      for (const rule of this._interceptRules) {
        if (matchesUrlPattern(url, rule.pattern)) {
          await this._handleInterceptRule(requestId, request, rule, sendToCDP);
          return;
        }
      }

      // 3. No match — pass through
      await sendToCDP("Fetch.continueRequest", { requestId });
    } catch (e) {
      // Safety net — never leave a request hanging
      try {
        await sendToCDP("Fetch.continueRequest", { requestId });
      } catch {}
    }
  }

  // ── Serve Handler ───────────────────────────────────────

  async _handleServeRequest(requestId, url, route, sendToCDP) {
    try {
      const urlObj = new URL(url);
      let relPath = decodeURIComponent(urlObj.pathname);

      // Normalize: ensure starts with /
      if (!relPath.startsWith("/")) relPath = "/" + relPath;

      let filePath = path.join(route.localDir, relPath);

      // Security: prevent path traversal
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(route.localDir)) {
        await this._fulfillError(requestId, 403, "Forbidden", sendToCDP);
        return;
      }
      filePath = resolved;

      // Check existence
      if (!fs.existsSync(filePath)) {
        await this._fulfillError(requestId, 404, `Not Found: ${relPath}`, sendToCDP);
        return;
      }

      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        // Try index.html
        const indexPath = path.join(filePath, "index.html");
        if (fs.existsSync(indexPath)) {
          filePath = indexPath;
        } else {
          // Generate directory listing
          const entries = fs.readdirSync(filePath, { withFileTypes: true }).map(e => ({
            name: e.name,
            isDir: e.isDirectory(),
            size: e.isDirectory() ? 0 : fs.statSync(path.join(filePath, e.name)).size,
          }));
          const listingPath = relPath.endsWith("/") ? relPath : relPath + "/";
          const html = generateDirectoryListing(listingPath, entries);
          await sendToCDP("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: [
              { name: "Content-Type", value: "text/html; charset=utf-8" },
              { name: "Cache-Control", value: "no-cache" },
            ],
            body: Buffer.from(html).toString("base64"),
          });
          return;
        }
      }

      // Read and serve file
      const content = fs.readFileSync(filePath);
      const mimeType = getMimeType(filePath);

      await sendToCDP("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: "Content-Type", value: mimeType },
          { name: "Content-Length", value: String(content.length) },
          { name: "Cache-Control", value: "no-cache" },
          { name: "Access-Control-Allow-Origin", value: "*" },
        ],
        body: content.toString("base64"),
      });
    } catch (e) {
      await this._fulfillError(requestId, 500, `Server Error: ${e.message}`, sendToCDP);
    }
  }

  // ── Intercept Handler ───────────────────────────────────

  async _handleInterceptRule(requestId, request, rule, sendToCDP) {
    const ruleType = rule.type || "mock";

    switch (ruleType) {
      case "block": {
        await sendToCDP("Fetch.failRequest", {
          requestId,
          errorReason: "BlockedByClient",
        });
        break;
      }

      case "mock":
      case "file": {
        const body = rule.fileContent || rule.response || "";
        const bodyStr = typeof body === "object" ? JSON.stringify(body) : String(body);
        // Auto-detect content type if not specified
        const contentType = rule.contentType ||
          (typeof body === "object" ? "application/json" :
           bodyStr.trimStart().startsWith("<") ? "text/html" :
           "text/plain");

        await sendToCDP("Fetch.fulfillRequest", {
          requestId,
          responseCode: rule.status || 200,
          responseHeaders: [
            { name: "Content-Type", value: contentType },
            { name: "Content-Length", value: String(Buffer.byteLength(bodyStr)) },
            { name: "Access-Control-Allow-Origin", value: "*" },
            { name: "X-Lens-Intercepted", value: "true" },
          ],
          body: Buffer.from(bodyStr).toString("base64"),
        });
        break;
      }

      case "status": {
        const status = rule.status || 500;
        const statusText = HTTP_STATUS_TEXT[status] || "Error";
        await sendToCDP("Fetch.fulfillRequest", {
          requestId,
          responseCode: status,
          responseHeaders: [
            { name: "Content-Type", value: "text/plain" },
            { name: "X-Lens-Intercepted", value: "true" },
          ],
          body: Buffer.from(`${status} ${statusText}`).toString("base64"),
        });
        break;
      }

      case "delay": {
        const ms = rule.delayMs || 1000;
        await new Promise(r => setTimeout(r, ms));
        await sendToCDP("Fetch.continueRequest", { requestId });
        break;
      }

      default:
        await sendToCDP("Fetch.continueRequest", { requestId });
    }
  }

  // ── Helpers ─────────────────────────────────────────────

  async _fulfillError(requestId, code, message, sendToCDP) {
    const html = `<!DOCTYPE html><html><head><title>${code}</title></head>` +
      `<body><h1>${code}</h1><p>${message}</p><hr><p style="color:#999">Lens CLI</p></body></html>`;
    await sendToCDP("Fetch.fulfillRequest", {
      requestId,
      responseCode: code,
      responseHeaders: [
        { name: "Content-Type", value: "text/html; charset=utf-8" },
      ],
      body: Buffer.from(html).toString("base64"),
    });
  }
}

// ── HTTP Status Text Map ──────────────────────────────────────────────

const HTTP_STATUS_TEXT = {
  200: "OK",
  201: "Created",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

module.exports = { FetchInterceptor, getMimeType, matchesUrlPattern };
