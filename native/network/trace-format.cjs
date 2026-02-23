"use strict";

// Rendering for captured network traffic. Everything here is presentation only:
// callers hand in plain entry objects and get back strings for the terminal.

const NO_ENTRIES = "No network requests captured";
const NO_ORIGINS = "No origins captured";
const NO_STATS = "No stats available";

const DROPPED_REQUEST_HEADERS = new Set(["host", "content-length", "connection", "accept-encoding"]);

const SUMMARY_REQUEST_HEADERS = ["content-type", "authorization", "cookie", "user-agent", "accept"];
const SUMMARY_RESPONSE_HEADERS = ["content-type", "content-length", "set-cookie", "location", "cache-control"];

const CONTENT_KINDS = [
  ["json", "json"],
  ["html", "html"],
  ["javascript", "js"],
  ["css", "css"],
  ["image/", "img"],
  ["font", "font"],
  ["xml", "xml"],
  ["text/plain", "text"],
  ["protobuf", "proto"],
  ["proto", "proto"],
  ["octet-stream", "bin"],
  ["form", "form"],
];

function size(bytes) {
  if (bytes === undefined || bytes === null) return "-";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function ms(value) {
  if (value === undefined || value === null) return "-";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function clock(timestamp) {
  if (!timestamp) return "-";
  return new Date(timestamp).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function kind(contentType) {
  if (!contentType) return "-";
  const lowered = contentType.toLowerCase();
  for (const [needle, label] of CONTENT_KINDS) {
    if (lowered.includes(needle)) return label;
  }
  return lowered.split("/").pop()?.split(";")[0]?.slice(0, 6) || "-";
}

function status(code) {
  if (!code) return "...";
  if (code >= 200 && code < 300) return String(code);
  if (code >= 300 && code < 400) return `${code}→`;
  if (code >= 400 && code < 500) return `${code}!`;
  if (code >= 500) return `${code}!!`;
  return String(code);
}

function clipUrl(url, max = 60) {
  if (!url) return "-";
  if (url.length <= max) return url;
  try {
    const parsed = new URL(url);
    const room = max - parsed.origin.length - 3;
    if (room > 10) return `${parsed.origin}${parsed.pathname.slice(0, room)}...`;
  } catch {}
  return `${url.slice(0, max - 3)}...`;
}

function clipValue(value, max = 100) {
  const text = String(value);
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function pick(headers, wanted) {
  const chosen = {};
  const entries = Object.entries(headers || {});
  for (const name of wanted) {
    const target = name.toLowerCase();
    const found = entries.find(([key]) => key.toLowerCase() === target);
    if (found) chosen[found[0]] = found[1];
  }
  return chosen;
}

function renderBody(body, limit = 2048) {
  if (!body) return "  (empty)";

  let text = typeof body === "string" ? body : JSON.stringify(body);
  try {
    text = JSON.stringify(JSON.parse(text), null, 2);
  } catch {}

  const rows = text.split("\n");
  const shown = rows.slice(0, 50).map((line) => `  ${line}`);

  if (text.length > limit) {
    shown.push(`  ... (${size(text.length)} total, truncated)`);
  } else if (rows.length > 50) {
    shown.push(`  ... (${rows.length - 50} more lines)`);
  }

  return shown.join("\n");
}

function table(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index] ?? "").length)),
  );

  const line = (cells) => cells.map((cell, index) => String(cell ?? "").padEnd(widths[index])).join(" │ ");
  const rule = (char) => widths.map((width) => char.repeat(width)).join("─┼─");

  return [line(headers), rule("─"), ...rows.map(line)];
}

function originOf(entry) {
  if (entry.origin) return entry.origin;
  try {
    return new URL(entry.url).origin;
  } catch {
    return "-";
  }
}

function stampOf(entry) {
  return entry.timestamp || entry.startTime;
}

function list(entries, options = {}) {
  if (!entries || entries.length === 0) return NO_ENTRIES;

  const headers = ["ID", "Method", "Status", "Type", "Size", "Time", "URL"];
  const rows = [];
  let previousOrigin = null;
  let previousStamp = null;

  for (const entry of entries) {
    const origin = originOf(entry);
    const stamp = stampOf(entry);

    if (previousOrigin && origin !== previousOrigin) {
      rows.push(["", "", "", "", "", "", ""]);
    }

    if (previousStamp && stamp && stamp - previousStamp > 5000) {
      rows.push(["", "", "", "", "", `+${ms(stamp - previousStamp)}`, ""]);
    }

    rows.push([
      String(entry.requestId || entry.id || "-").slice(0, 8),
      entry.method || "GET",
      status(entry.status),
      kind(entry.contentType || entry.responseHeaders?.["content-type"]),
      size(entry.responseSize || entry.encodedDataLength),
      ms(entry.duration || entry.time),
      clipUrl(entry.url, 60),
    ]);

    previousOrigin = origin;
    previousStamp = stamp;
  }

  const total = entries.reduce((sum, entry) => sum + (entry.responseSize || entry.encodedDataLength || 0), 0);

  return `${table(headers, rows).join("\n")}\n\nTotal: ${entries.length} requests, ${size(total)}`;
}

function urls(entries) {
  if (!entries || entries.length === 0) return "";
  return entries.map((entry) => `${(entry.method || "GET").padEnd(6)} ${entry.url}`).join("\n");
}

function curl(entry) {
  if (!entry) return "";

  const parts = [`curl -X ${entry.method || "GET"} '${entry.url}'`];

  for (const [name, value] of Object.entries(entry.requestHeaders || {})) {
    if (DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    parts.push(`-H '${name}: ${String(value).replace(/'/g, "'\\''")}'`);
  }

  if (entry.requestBody) {
    parts.push(`-d '${entry.requestBody.replace(/'/g, "'\\''")}'`);
  }

  return parts.join(" \\\n  ");
}

function curlAll(entries) {
  if (!entries || entries.length === 0) return "";
  return entries.map(curl).join("\n\n");
}

function raw(entries) {
  return JSON.stringify({ entries, _format: "raw" }, null, 2);
}

function verbose(entries, level = 1) {
  if (!entries || entries.length === 0) return NO_ENTRIES;

  const bodyLimit = level >= 2 ? Infinity : 2048;
  const full = level >= 2;
  const blocks = [];

  for (const entry of entries) {
    const lines = [
      "═".repeat(80),
      `${entry.method || "GET"} ${entry.url}`,
      `ID: ${entry.requestId || entry.id || "-"}  Status: ${entry.status || "pending"}  Time: ${ms(entry.duration || entry.time)}`,
      "",
    ];

    if (entry.requestHeaders && Object.keys(entry.requestHeaders).length > 0) {
      lines.push("▶ Request Headers:");
      const headers = full ? entry.requestHeaders : pick(entry.requestHeaders, SUMMARY_REQUEST_HEADERS);
      for (const [name, value] of Object.entries(headers)) lines.push(`  ${name}: ${clipValue(value)}`);
      lines.push("");
    }

    if (entry.requestBody) {
      lines.push("▶ Request Body:", renderBody(entry.requestBody, bodyLimit), "");
    }

    if (entry.responseHeaders && Object.keys(entry.responseHeaders).length > 0) {
      lines.push("◀ Response Headers:");
      const headers = full ? entry.responseHeaders : pick(entry.responseHeaders, SUMMARY_RESPONSE_HEADERS);
      for (const [name, value] of Object.entries(headers)) lines.push(`  ${name}: ${clipValue(value)}`);
      lines.push("");
    }

    if (entry.responseBody) {
      lines.push("◀ Response Body:", renderBody(entry.responseBody, bodyLimit), "");
    }

    blocks.push(lines.join("\n"));
  }

  return blocks.join("\n");
}

function entry(record) {
  if (!record) return "Request not found";
  return verbose([record], 2);
}

function origins(input) {
  if (!input) return NO_ORIGINS;

  let items;
  if (Array.isArray(input)) {
    items = input;
  } else if (typeof input === "object") {
    items = Object.entries(input).map(([origin, data]) => ({
      origin,
      count: data.count || 0,
      totalSize: data.size || data.totalSize || 0,
      lastSeen: data.lastSeen || 0,
    }));
  } else {
    return NO_ORIGINS;
  }

  if (items.length === 0) return NO_ORIGINS;

  const rows = items.map((item) => [
    clipUrl(item.origin, 38),
    String(item.count || 0),
    size(item.totalSize || 0),
    clock(item.lastSeen),
  ]);

  return table(["Origin", "Requests", "Size", "Last Seen"], rows).join("\n");
}

function stats(input) {
  if (!input) return NO_STATS;

  const lines = [
    "Network Capture Statistics",
    "═".repeat(40),
    `Total Requests:    ${input.totalRequests || 0}`,
    `Total Size:        ${size(input.totalSize || 0)}`,
    `Unique Origins:    ${input.uniqueOrigins || 0}`,
    `Capture Start:     ${clock(input.startTime)}`,
    `Duration:          ${ms(input.duration)}`,
    "",
  ];

  if (input.byMethod) {
    lines.push("By Method:");
    for (const [method, count] of Object.entries(input.byMethod)) lines.push(`  ${method.padEnd(8)} ${count}`);
    lines.push("");
  }

  if (input.byStatus) {
    lines.push("By Status:");
    for (const [code, count] of Object.entries(input.byStatus)) lines.push(`  ${code.padEnd(8)} ${count}`);
  }

  return lines.join("\n");
}

module.exports = { list, urls, curl, curlAll, raw, verbose, entry, origins, stats, size, ms, clock, kind, status };
