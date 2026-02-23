const traceFormat = require("../network/trace-format.cjs");
const networkJournal = require("../network/journal.cjs");

function formatToolContent(result, log = () => {}) {
  const text = (s) => [{ type: "text", text: s }];

  if (!result) return text("OK");

  if (result.aiResult) {
    if (result.mode === "find") {
      return text(result.ref || "NOT_FOUND");
    }
    return text(result.content);
  }

  if (result.styles && Array.isArray(result.styles)) {
    const output = result.styles
      .map((el) => {
        const lines = [
          `<${el.tag}>${el.text ? ` "${el.text.slice(0, 50)}${el.text.length > 50 ? "..." : ""}"` : ""}`,
        ];
        if (el.box)
          lines.push(
            `  box: ${el.box.x},${el.box.y} ${el.box.width}x${el.box.height}`,
          );
        const s = el.styles;
        if (s) {
          if (s.fontSize)
            lines.push(`  font: ${s.fontSize} ${s.fontWeight} ${s.fontFamily}`);
          if (s.color) lines.push(`  color: ${s.color}`);
          if (s.backgroundColor && s.backgroundColor !== "rgba(0, 0, 0, 0)")
            lines.push(`  bg: ${s.backgroundColor}`);
          if (s.borderRadius && s.borderRadius !== "0px")
            lines.push(`  radius: ${s.borderRadius}`);
          if (s.border) lines.push(`  border: ${s.border}`);
          if (s.boxShadow) lines.push(`  shadow: ${s.boxShadow}`);
          if (s.padding && s.padding !== "0px")
            lines.push(`  padding: ${s.padding}`);
        }
        return lines.join("\n");
      })
      .join("\n\n");
    return text(output || "No elements found");
  }

  if (result.selected !== undefined) {
    let output = Array.isArray(result.selected)
      ? `Selected: ${result.selected.join(", ")}`
      : `Selected: ${result.selected}`;
    if (result.warning) {
      output += `\n[Warning: ${result.warning}]`;
    }
    return text(output);
  }

  if (result.url && result.dir && result.success) {
    return text(`Serving ${result.dir}\nURL: ${result.url}`);
  }
  if (result.serveRoutes !== undefined || result.interceptRules !== undefined) {
    const lines = [];
    if (result.serveRoutes?.length > 0) {
      lines.push("Serving:");
      for (const r of result.serveRoutes) {
        lines.push(`  ${r.urlPrefix} → ${r.localDir}`);
      }
    }
    if (result.interceptRules?.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("Intercept rules:");
      for (const r of result.interceptRules) {
        lines.push(`  [${r.type}] ${r.pattern}`);
      }
    }
    if (lines.length === 0) {
      lines.push("No active serve routes or intercept rules");
    }
    return text(lines.join("\n"));
  }

  if (result.messages && Array.isArray(result.messages)) {
    const formatted = result.messages
      .map((m) => {
        let loc = "";
        if (m.url)
          loc = m.line !== undefined ? ` (${m.url}:${m.line})` : ` (${m.url})`;
        return `[${m.type}] ${m.text}${loc}`;
      })
      .join("\n");
    return text(formatted || "No console messages");
  }

  const items = result.requests || result.entries;
  if (items && Array.isArray(items)) {
    if (result.entries && items.length > 0) {
      (async () => {
        for (const entry of items) {
          try {
            await networkJournal.appendRequest(entry);
          } catch (err) {
            log(`Failed to persist network entry: ${err.message}`);
          }
        }
      })();
    }

    if (items.length === 0) {
      return text("No network requests captured");
    }
    let formatted;
    if (result.format === "curl") {
      formatted = traceFormat.curlAll(items);
    } else if (result.format === "urls") {
      formatted = traceFormat.urls(items);
    } else if (result.format === "raw") {
      formatted = traceFormat.raw(items);
    } else if (result.verbose > 0) {
      formatted = traceFormat.verbose(items, result.verbose);
    } else if (result.entries) {
      formatted = traceFormat.verbose(items, 1);
    } else {
      formatted = items
        .map((r) => {
          const status = String(r.status || "-").padStart(3);
          const method = (r.method || "GET").padEnd(7);
          const type = (r.type || "").padEnd(10);
          return `${status} ${method} ${type} ${r.url}`;
        })
        .join("\n");
    }
    return text(formatted);
  }

  if (result.output !== undefined) {
    return text(result.output);
  }

  if (result.path && result.message && !result.base64) {
    let msg = result.message;
    if (result.screenshotId) {
      msg += `\n[Screenshot ID: ${result.screenshotId} - use with upload.image]`;
    }
    return text(msg);
  }

  if (result.screenshotId && result.base64) {
    const dims =
      result.width && result.height
        ? `${result.width}x${result.height}`
        : "unknown dimensions";
    return [
      {
        type: "text",
        text: `Screenshot captured (${dims}) - ID: ${result.screenshotId}`,
      },
      { type: "image", data: result.base64, mimeType: "image/png" },
    ];
  }

  if (result.base64) {
    const dims =
      result.width && result.height
        ? `${result.width}x${result.height}`
        : "unknown dimensions";
    return [
      { type: "text", text: `Screenshot (${dims})` },
      { type: "image", data: result.base64, mimeType: "image/png" },
    ];
  }

  if (result.pageContent !== undefined) {
    const content = result.pageContent || "No content";
    let output = "";

    if (result.waited !== undefined) {
      output += `[Waited ${result.waited}ms]\n\n`;
    }

    output += content;

    if (result.isIncremental && result.diff) {
      output += `\n--- Diff from previous snapshot ---\n${result.diff}`;
    }

    if (result.modalStates && result.modalStates.length > 0) {
      output += `\n\n[ACTION REQUIRED] Modal blocking page - dismiss before proceeding:`;
      output += `\n  -> Press Escape key: computer(action="key", text="Escape")`;
      for (const modal of result.modalStates) {
        output += `\n  - ${modal.description}`;
      }
    }

    if (result.error) {
      return text(`Error: ${result.error}\n\n${output}`);
    }

    if (result.text) {
      output += `\n\n--- Page Text ---\n${result.text}`;
    }

    if (result.screenshot && result.screenshot.base64) {
      const dims =
        result.screenshot.width && result.screenshot.height
          ? `${result.screenshot.width}x${result.screenshot.height}`
          : "unknown";
      return [
        { type: "text", text: output },
        { type: "text", text: `\n[Screenshot included (${dims})]` },
        {
          type: "image",
          data: result.screenshot.base64,
          mimeType: "image/png",
        },
      ];
    }

    return text(output);
  }

  if (result.layoutContent !== undefined) {
    return text(result.layoutContent || "No layout content");
  }

  if (result.workspace !== undefined && result.success) {
    if (result.reused) {
      return text(`Stream "${result.workspace}" already targets tab ${result.tabId} (window ${result.windowId})`);
    }
    const where = result.raised ? `new window ${result.windowId}` : `background tab in window ${result.windowId}`;
    const lines = [`Stream "${result.workspace}" bound to tab ${result.tabId} (${where})`];
    if (result.hint) lines.push(result.hint);
    return text(lines.join("\n"));
  }

  if (result.windowId !== undefined && result.success) {
    let msg = `Window ${result.windowId}`;
    if (result.tabId) msg += ` (tab ${result.tabId})`;
    if (result.width && result.height)
      msg += ` ${result.width}x${result.height}`;
    if (result.hint) msg += `\n${result.hint}`;
    return text(msg);
  }

  if (result.windows) {
    return text(JSON.stringify({ windows: result.windows }, null, 2));
  }

  if (result.tabs) {
    return text(JSON.stringify(result.tabs, null, 2));
  }

  if (result.cookies && Array.isArray(result.cookies)) {
    return text(JSON.stringify(result.cookies, null, 2));
  }

  if (result.cookie) {
    return text(JSON.stringify(result.cookie, null, 2));
  }

  if (result.cleared !== undefined) {
    if (typeof result.cleared === "number") {
      return text(`Cleared ${result.cleared} cookies`);
    }
    return text(`Cleared cookie: ${result.cleared}`);
  }

  if (result.query !== undefined && result.matches) {
    const header = `Found ${result.count} matches for "${result.query}":`;
    if (result.matches.length === 0) return text(header);
    const matchList = result.matches
      .map(
        (m) =>
          `  ${m.ref}: "${m.text}" in "...${m.context}..."${m.elementRef ? ` [${m.elementRef}]` : ""}`,
      )
      .join("\n");
    return text(`${header}\n${matchList}`);
  }

  if (result.groupId !== undefined && result.name !== undefined) {
    return text(
      `Tab group "${result.name}" (id: ${result.groupId}) with tabs: ${(result.tabIds || []).join(", ")}`,
    );
  }

  if (result.ungrouped) {
    return text(`Ungrouped tabs: ${result.ungrouped.join(", ")}`);
  }

  if (result.groups && Array.isArray(result.groups)) {
    if (result.groups.length === 0) return text("No tab groups");
    const formatted = result.groups
      .map((g) => {
        const tabList = g.tabs.map((t) => `    ${t.id}: ${t.title}`).join("\n");
        return `${g.name} (${g.color}, ${g.tabs.length} tabs):\n${tabList}`;
      })
      .join("\n\n");
    return text(formatted);
  }

  if (
    result.completedActions !== undefined &&
    result.totalActions !== undefined
  ) {
    const status = result.success ? "SUCCESS" : "FAILED";
    const header = `Batch ${status}: ${result.completedActions}/${result.totalActions} actions completed`;
    if (result.results && result.results.length > 0) {
      const details = result.results
        .map(
          (r) =>
            `  [${r.index}] ${r.type}: ${r.success ? "OK" : "FAILED"}${r.error ? ` - ${r.error}` : ""}`,
        )
        .join("\n");
      return text(
        `${header}\n${details}${result.error ? `\n\nError: ${result.error}` : ""}`,
      );
    }
    return text(header);
  }

  if (result.zoom !== undefined) {
    return text(`Zoom: ${Math.round(result.zoom * 100)}%`);
  }

  if (result.bookmarks && Array.isArray(result.bookmarks)) {
    if (result.bookmarks.length === 0) return text("No bookmarks");
    const formatted = result.bookmarks
      .map((b) => `${b.title}\n  ${b.url}`)
      .join("\n\n");
    return text(formatted);
  }

  if (result.bookmark && result.bookmark.id) {
    return text(
      `Bookmarked: ${result.bookmark.title}\n  ${result.bookmark.url}`,
    );
  }

  if (result.history && Array.isArray(result.history)) {
    if (result.history.length === 0) return text("No history");
    const formatted = result.history
      .map((h) => {
        const date = h.lastVisitTime
          ? new Date(h.lastVisitTime).toLocaleString()
          : "unknown";
        return `${h.title || "(no title)"}\n  ${h.url}\n  Last visited: ${date}`;
      })
      .join("\n\n");
    return text(formatted);
  }

  if (result.text !== undefined) {
    const textContent = result.text || "No text content";
    let output = "";
    if (result.title) output += `Title: ${result.title}\n`;
    if (result.url) output += `URL: ${result.url}\n`;
    if (output) output += "\n";
    output += textContent;
    if (result.error) {
      return text(`Error: ${result.error}\n\n${output}`);
    }
    return text(output);
  }

  if (result.success && result.name && result.tabId !== undefined) {
    return text(`Registered tab ${result.tabId} as "${result.name}"`);
  }

  if (result.success && result.tabId && result.title !== undefined) {
    return text(`Switched to tab ${result.tabId}: ${result.title}`);
  }

  if (result.success && result.tabId && result.url) {
    const lines = [`Created tab ${result.tabId}: ${result.url}`];
    if (result.hint) lines.push(result.hint);
    return text(lines.join("\n"));
  }

  if (result.success && result.closed) {
    return text(
      `Closed ${result.closed.length} tabs: ${result.closed.join(", ")}`,
    );
  }

  if (result.success && result.tabId && !result.url) {
    return text(`Closed tab ${result.tabId}`);
  }

  if (result.success && result.width && result.height) {
    return text(`Resized window to ${result.width}x${result.height}`);
  }

  if (result.autoInspect) {
    return text(`OK\n${result.autoInspect}`);
  }

  if (result.success) {
    if (result.metrics) {
      return text(JSON.stringify(result.metrics, null, 2));
    }
    if (result.frames) {
      return text(JSON.stringify(result.frames, null, 2));
    }
    if (result.readyState) {
      return text(`Page loaded (readyState: ${result.readyState})`);
    }

    let msg = "OK";
    if (result._hint) msg += `\n[hint] ${result._hint}`;
    return text(msg);
  }

  if (result.value !== undefined) {
    return text(
      typeof result.value === "string"
        ? result.value
        : JSON.stringify(result.value, null, 2),
    );
  }

  const { _resolvedTabId, _hint, ...cleanResult } = result;
  if (_hint) {
    return text(JSON.stringify(cleanResult) + `\n[hint] ${_hint}`);
  }
  return text(JSON.stringify(cleanResult));
}

module.exports = formatToolContent;
