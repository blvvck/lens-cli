/**
 * Feedback Recent Command Ring Buffer
 *
 * Maintains a rolling window of safe command summaries for `lens feedback --last`.
 * - Stores only allowlisted, non-sensitive fields
 * - Bounded by count (max 50) and age (max 7 days)
 * - Sensitive data (URLs, typed text, file contents, secrets) is excluded/redacted
 * - Written once at CLI/runtime boundary, shared across all command families
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// Paths
const LENS_DIR = path.join(os.homedir(), ".lens");
const FEEDBACK_DIR = path.join(LENS_DIR, "feedback");
const RECENT_PATH = path.join(FEEDBACK_DIR, "recent.jsonl");

// File permissions (owner-only)
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

// Retention limits
const MAX_ENTRIES = 50;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Sensitive field patterns (values to redact)
const SENSITIVE_FIELDS = new Set([
  "url",
  "text",
  "body",
  "bodyFile",
  "file",
  "files",
  "content",
  "data",
  "password",
  "secret",
  "token",
  "apiKey",
  "api-key",
  "key",
]);

// Sensitive command types (args always redacted)
const SENSITIVE_COMMANDS = new Set([
  "type",
]);

// Allowlisted safe fields
const SAFE_FIELDS = new Set([
  "command",
  "timestamp",
  "commandFamily",
  "status",
  "durationMs",
  "errorType",
]);

/**
 * Ensure directory exists with proper permissions
 */
function ensureDirectories() {
  if (!fs.existsSync(FEEDBACK_DIR)) {
    fs.mkdirSync(FEEDBACK_DIR, { recursive: true, mode: DIR_MODE });
  }
}

/**
 * Redact sensitive values from a string
 */
function redactValue(value, fieldName, commandName) {
  if (!value || typeof value !== "string") return value;

  // Always redact sensitive fields
  if (SENSITIVE_FIELDS.has(fieldName)) {
    return "[REDACTED]";
  }

  // Redact args for sensitive commands (e.g., type)
  if (SENSITIVE_COMMANDS.has(commandName) && fieldName === "args") {
    return "[REDACTED]";
  }

  // Redact URLs
  if (value.startsWith("http://") || value.startsWith("https://") || value.startsWith("file://")) {
    try {
      const url = new URL(value);
      return `[URL: ${url.hostname}]`;
    } catch {
      return "[URL]";
    }
  }

  // Redact file paths (absolute paths)
  if (value.startsWith("/") || value.startsWith("~")) {
    const basename = path.basename(value);
    return `[FILE: ${basename}]`;
  }

  // Redact obvious secrets/tokens
  if (/^[a-zA-Z0-9_\-]{20,}$/.test(value) || // API keys
      value.includes("secret") ||
      value.includes("token") ||
      value.includes("password") ||
      value.includes("private")) {
    return "[REDACTED]";
  }

  return value;
}

/**
 * Create a safe command summary from raw command data
 */
function createSafeSummary({
  command,
  args = [],
  options = {},
  commandFamily,
  status = "started",
  durationMs,
  errorType,
}) {
  const timestamp = Date.now();

  // Sanitize positional args
  const safeArgs = args.map((arg, idx) =>
    redactValue(arg, "args", command)
  );

  // Sanitize options (only include safe ones)
  const safeOptions = {};
  for (const [key, value] of Object.entries(options)) {
    if (!SENSITIVE_FIELDS.has(key)) {
      safeOptions[key] = redactValue(value, key, command);
    }
  }

  return {
    id: `cmd_${timestamp.toString(36)}_${crypto.randomBytes(4).toString("hex")}`,
    timestamp,
    command,
    commandFamily: commandFamily || inferCommandFamily(command),
    args: safeArgs,
    options: safeOptions,
    status,
    durationMs,
    errorType,
  };
}

/**
 * Infer command family from command name
 */
function inferCommandFamily(command) {
  if (command.startsWith("workflow")) return "workflow";
  if (command.startsWith("headless")) return "headless";
  if (command.startsWith("cdp")) return "headless";
  if (command.startsWith("tab") || command.startsWith("page") || command.startsWith("click") || command.startsWith("scroll")) return "browser";
  if (["open", "screenshot", "key"].includes(command)) return "browser";
  if (["config", "install", "uninstall", "profile"].includes(command)) return "meta";
  return "general";
}

/**
 * Read all entries from the recent buffer
 */
function readRecent() {
  if (!fs.existsSync(RECENT_PATH)) {
    return [];
  }

  const entries = [];
  const content = fs.readFileSync(RECENT_PATH, "utf-8");
  const lines = content.split("\n").filter(line => line.trim());

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      entries.push(entry);
    } catch {
      // Skip corrupted lines
    }
  }

  return entries;
}

/**
 * Write entries back to the buffer (with retention enforcement)
 */
function writeRecent(entries) {
  ensureDirectories();

  const now = Date.now();

  // Filter by age
  let filtered = entries.filter(e => (now - e.timestamp) < MAX_AGE_MS);

  // Sort by timestamp (newest first)
  filtered.sort((a, b) => b.timestamp - a.timestamp);

  // Keep only max entries
  filtered = filtered.slice(0, MAX_ENTRIES);

  // Write as JSONL
  const lines = filtered.map(e => JSON.stringify(e)).join("\n") + "\n";

  // Atomic write
  const tempPath = `${RECENT_PATH}.tmp`;
  try {
    fs.writeFileSync(tempPath, lines, { mode: FILE_MODE });
    fs.renameSync(tempPath, RECENT_PATH);
    fs.chmodSync(RECENT_PATH, FILE_MODE);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw err;
  }

  return filtered;
}

/**
 * Record a command execution to the recent buffer
 */
function recordCommand(summary) {
  const entries = readRecent();
  const safeSummary = createSafeSummary(summary);
  entries.push(safeSummary);
  writeRecent(entries);
  return safeSummary;
}

/**
 * Get the most recent command
 */
function getLastCommand() {
  const entries = readRecent();
  return entries.length > 0 ? entries[0] : null;
}

/**
 * Get recent commands (newest first)
 */
function getRecent(count = 10) {
  const entries = readRecent();
  return entries.slice(0, count);
}

/**
 * Get command history stats
 */
function getRecentStats() {
  const entries = readRecent();
  const now = Date.now();

  const byFamily = entries.reduce((acc, e) => {
    acc[e.commandFamily] = (acc[e.commandFamily] || 0) + 1;
    return acc;
  }, {});

  return {
    totalCount: entries.length,
    oldestTimestamp: entries.length > 0 ? entries[entries.length - 1]?.timestamp : null,
    newestTimestamp: entries.length > 0 ? entries[0]?.timestamp : null,
    byFamily,
  };
}

/**
 * Clear all recent entries
 */
function clearRecent() {
  if (fs.existsSync(RECENT_PATH)) {
    fs.unlinkSync(RECENT_PATH);
  }
}

/**
 * Preview what would be attached for --last
 */
function previewLastContext() {
  const last = getLastCommand();
  if (!last) {
    return null;
  }

  return {
    command: last.command,
    commandFamily: last.commandFamily,
    timestamp: last.timestamp,
    status: last.status,
    args: last.args,
    options: last.options,
  };
}

module.exports = {
  recordCommand,
  getLastCommand,
  getRecent,
  getRecentStats,
  clearRecent,
  previewLastContext,
  createSafeSummary,
  RECENT_PATH,
  MAX_ENTRIES,
  MAX_AGE_MS,
};
