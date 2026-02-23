const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { getNetworkBasePath } = require("../runtime-paths.cjs");

const STORAGE_ROOT = getNetworkBasePath();
const ENTRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const JOURNAL_MAX_BYTES = 200 * 1024 * 1024;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

let rootOverride = null;
let pendingAppend = Promise.resolve();

function setStorageRoot(root) {
  rootOverride = root;
}

function getStorageRoot() {
  return rootOverride || process.env.LENS_NETWORK_PATH || STORAGE_ROOT;
}

function getRequestLogPath() {
  return path.join(getStorageRoot(), "requests.jsonl");
}

function getBodyStorePath() {
  return path.join(getStorageRoot(), "bodies");
}

function getMetadataPath() {
  return path.join(getStorageRoot(), ".meta");
}

function ensureStore() {
  fs.mkdirSync(getBodyStorePath(), { recursive: true });
}

function loadMetadata() {
  try {
    return JSON.parse(fs.readFileSync(getMetadataPath(), "utf8"));
  } catch {
    return { lastCleanup: 0 };
  }
}

function saveMetadata(metadata) {
  ensureStore();
  fs.writeFileSync(getMetadataPath(), JSON.stringify(metadata, null, 2));
}

function newEntryId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function urlMatches(url, pattern) {
  if (!pattern) return true;

  if (pattern.startsWith("/") && pattern.endsWith("/")) {
    try {
      return new RegExp(pattern.slice(1, -1)).test(url);
    } catch {
      return false;
    }
  }

  if (pattern.includes("*")) {
    const expression = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp(expression).test(url);
  }

  return url.includes(pattern);
}

function acceptsEntry(entry, filters) {
  if (!filters) return true;

  const {
    origin,
    method,
    status,
    type,
    since,
    hasBody,
    excludeStatic,
    urlPattern,
  } = filters;

  if (origin && getOrigin(entry.url) !== origin) return false;
  if (method && entry.method !== method.toUpperCase()) return false;

  if (status !== undefined) {
    if (typeof status === "number" && entry.status !== status) return false;
    if (typeof status === "string") {
      const value = String(entry.status);
      if (status.endsWith("xx")) {
        if (!value.startsWith(status[0])) return false;
      } else if (entry.status !== parseInt(status, 10)) {
        return false;
      }
    }
  }

  if (type) {
    const contentType = entry.contentType || entry.responseHeaders?.["content-type"] || "";
    if (!contentType.includes(type)) return false;
  }

  if (since && entry.timestamp < since) return false;
  if (hasBody !== undefined && hasBody !== !!entry.responseBodyHash) return false;

  if (excludeStatic) {
    const extensions = [".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".woff", ".woff2", ".ttf", ".ico"];
    const urlPath = entry.url.split("?")[0].toLowerCase();
    if (extensions.some((extension) => urlPath.endsWith(extension))) return false;
  }

  return !urlPattern || urlMatches(entry.url, urlPattern);
}

function keepLast(entries, count) {
  return count && count > 0 ? entries.slice(-count) : entries;
}

function readMatchingEntry(line, filters) {
  if (!line.trim()) return null;

  try {
    const entry = JSON.parse(line);
    return acceptsEntry(entry, filters) ? { entry } : null;
  } catch {
    return null;
  }
}

function findRequestsSync(filters = {}) {
  const filePath = getRequestLogPath();
  if (!fs.existsSync(filePath)) return [];

  const matches = [];
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const result = readMatchingEntry(line, filters);
    if (result) matches.push(result.entry);
  }

  return keepLast(matches, filters.last);
}

async function findRequests(filters = {}) {
  const filePath = getRequestLogPath();
  if (!fs.existsSync(filePath)) return [];

  const matches = [];
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    const result = readMatchingEntry(line, filters);
    if (result) matches.push(result.entry);
  }

  return keepLast(matches, filters.last);
}

function findRequestSync(id) {
  return findRequestsSync().find((entry) => entry.id === id) || null;
}

async function findRequest(id) {
  return (await findRequests()).find((entry) => entry.id === id) || null;
}

function saveBody(content, requestBody = false) {
  ensureStore();
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const suffix = requestBody ? "req" : "res";
  const destination = path.join(getBodyStorePath(), `${digest}.${suffix}`);

  if (!fs.existsSync(destination)) fs.writeFileSync(destination, bytes);
  return digest;
}

function getBodyFilePath(digest, requestBody = false) {
  const suffix = requestBody ? "req" : "res";
  return path.join(getBodyStorePath(), `${digest}.${suffix}`);
}

function loadBody(digest, requestBody = false) {
  try {
    return fs.readFileSync(getBodyFilePath(digest, requestBody));
  } catch {
    return null;
  }
}

function makeEntry(entry) {
  return {
    id: entry.id || newEntryId(),
    timestamp: entry.timestamp || Date.now(),
    ...entry,
  };
}

async function appendRequest(entry) {
  const write = pendingAppend.then(() => {
    ensureStore();
    const saved = makeEntry(entry);
    fs.appendFileSync(getRequestLogPath(), `${JSON.stringify(saved)}\n`, { flag: "a" });
    return saved;
  });
  pendingAppend = write.then(
    () => undefined,
    () => undefined,
  );
  return write;
}

function appendRequestSync(entry) {
  ensureStore();
  const saved = makeEntry(entry);
  const line = `${JSON.stringify(saved)}\n`;
  const lockPath = path.join(getStorageRoot(), ".lock");
  let lockHandle;

  try {
    lockHandle = fs.openSync(lockPath, "wx");
  } catch {
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > 5000) {
        fs.unlinkSync(lockPath);
        try {
          lockHandle = fs.openSync(lockPath, "wx");
        } catch {}
      }
    } catch {}

    if (lockHandle === undefined) {
      fs.appendFileSync(getRequestLogPath(), line, { flag: "a" });
      return saved;
    }
  }

  try {
    fs.appendFileSync(getRequestLogPath(), line, { flag: "a" });
  } finally {
    if (lockHandle !== undefined) {
      fs.closeSync(lockHandle);
      try {
        fs.unlinkSync(lockPath);
      } catch {}
    }
  }

  return saved;
}

function countOriginsIn(entries) {
  const totals = {};
  for (const entry of entries) {
    const origin = getOrigin(entry.url);
    if (origin) totals[origin] = (totals[origin] || 0) + 1;
  }
  return totals;
}

function countOriginsSync() {
  return countOriginsIn(findRequestsSync());
}

async function countOrigins() {
  return countOriginsIn(await findRequests());
}

function collectStoreStats(entries) {
  const origins = countOriginsIn(entries);
  let oldestEntry = Infinity;
  let newestEntry = 0;

  for (const entry of entries) {
    if (entry.timestamp < oldestEntry) oldestEntry = entry.timestamp;
    if (entry.timestamp > newestEntry) newestEntry = entry.timestamp;
  }

  let totalBodySize = 0;
  const bodyDirectory = getBodyStorePath();
  if (fs.existsSync(bodyDirectory)) {
    for (const name of fs.readdirSync(bodyDirectory)) {
      try {
        totalBodySize += fs.statSync(path.join(bodyDirectory, name)).size;
      } catch {}
    }
  }

  const metadata = loadMetadata();
  return {
    totalRequests: entries.length,
    totalBodySize,
    oldestEntry: oldestEntry === Infinity ? null : oldestEntry,
    newestEntry: newestEntry === 0 ? null : newestEntry,
    lastCleanup: metadata.lastCleanup || null,
    origins,
  };
}

function getStoreStatsSync() {
  return collectStoreStats(findRequestsSync());
}

async function getStoreStats() {
  return collectStoreStats(await findRequests());
}

function referencedBodyFiles(entries) {
  const names = new Set();
  for (const entry of entries) {
    if (entry.requestBodyHash) names.add(`${entry.requestBodyHash}.req`);
    if (entry.responseBodyHash) names.add(`${entry.responseBodyHash}.res`);
  }
  return names;
}

function bodyFilesSize(directory) {
  let size = 0;
  if (fs.existsSync(directory)) {
    for (const name of fs.readdirSync(directory)) {
      try {
        size += fs.statSync(path.join(directory, name)).size;
      } catch {}
    }
  }
  return size;
}

function rewriteRequestLog(filePath, entries) {
  const temporaryPath = `${filePath}.tmp`;
  const data = entries.map((entry) => JSON.stringify(entry)).join("\n");
  fs.writeFileSync(temporaryPath, data + (entries.length ? "\n" : ""));
  fs.renameSync(temporaryPath, filePath);
}

async function pruneStore(options = {}) {
  const { ttl = ENTRY_MAX_AGE_MS, maxSize = JOURNAL_MAX_BYTES } = options;
  const now = Date.now();
  const cutoff = now - ttl;
  const requestLog = getRequestLogPath();
  const bodyDirectory = getBodyStorePath();

  if (!fs.existsSync(requestLog)) {
    saveMetadata({ lastCleanup: now });
    return { deletedEntries: 0, deletedBodies: 0, freedBytes: 0 };
  }

  let entries = findRequestsSync();
  const initialCount = entries.length;
  entries = entries.filter((entry) => entry.timestamp >= cutoff);

  let totalSize = fs.existsSync(requestLog) ? fs.statSync(requestLog).size : 0;
  totalSize += bodyFilesSize(bodyDirectory);

  if (totalSize > maxSize && entries.length > 0) {
    entries.sort((left, right) => left.timestamp - right.timestamp);
    while (entries.length > 0 && totalSize > maxSize) {
      entries.shift();
      totalSize *= entries.length / (entries.length + 1);
    }
  }

  const referenced = referencedBodyFiles(entries);
  let deletedBodies = 0;
  let freedBytes = 0;

  if (fs.existsSync(bodyDirectory)) {
    for (const name of fs.readdirSync(bodyDirectory)) {
      if (referenced.has(name)) continue;
      const filePath = path.join(bodyDirectory, name);
      try {
        freedBytes += fs.statSync(filePath).size;
        fs.unlinkSync(filePath);
        deletedBodies++;
      } catch {}
    }
  }

  const deletedEntries = initialCount - entries.length;
  if (deletedEntries > 0 || entries.length === 0) rewriteRequestLog(requestLog, entries);
  saveMetadata({ lastCleanup: now });

  return { deletedEntries, deletedBodies, freedBytes, remainingEntries: entries.length };
}

async function clearStore(options = {}) {
  const { before, origin: targetOrigin } = options;
  const requestLog = getRequestLogPath();
  const bodyDirectory = getBodyStorePath();

  if (!before && !targetOrigin) {
    let deletedEntries = 0;
    let deletedBodies = 0;

    if (fs.existsSync(requestLog)) {
      deletedEntries = findRequestsSync().length;
      fs.unlinkSync(requestLog);
    }

    if (fs.existsSync(bodyDirectory)) {
      for (const name of fs.readdirSync(bodyDirectory)) {
        try {
          fs.unlinkSync(path.join(bodyDirectory, name));
          deletedBodies++;
        } catch {}
      }
    }

    return { deletedEntries, deletedBodies };
  }

  if (!fs.existsSync(requestLog)) return { deletedEntries: 0, deletedBodies: 0 };

  const entries = findRequestsSync();
  const retained = entries.filter((entry) => {
    if (before && entry.timestamp >= before) return true;
    if (targetOrigin && getOrigin(entry.url) !== targetOrigin) return true;
    return false;
  });
  const deletedEntries = entries.length - retained.length;
  const retainedBodies = referencedBodyFiles(retained);
  let deletedBodies = 0;

  if (fs.existsSync(bodyDirectory)) {
    for (const name of fs.readdirSync(bodyDirectory)) {
      if (retainedBodies.has(name)) continue;
      try {
        fs.unlinkSync(path.join(bodyDirectory, name));
        deletedBodies++;
      } catch {}
    }
  }

  if (deletedEntries > 0) rewriteRequestLog(requestLog, retained);
  return { deletedEntries, deletedBodies };
}

function schedulePrune() {
  try {
    if (Date.now() - (loadMetadata().lastCleanup || 0) > PRUNE_INTERVAL_MS) {
      setImmediate(() => {
        pruneStore().catch(() => {});
      });
    }
  } catch {}
}

schedulePrune();

module.exports = {
  setStorageRoot,
  getStorageRoot,
  getRequestLogPath,
  getBodyStorePath,
  getMetadataPath,
  saveBody,
  loadBody,
  getBodyFilePath,
  appendRequest,
  appendRequestSync,
  findRequests,
  findRequestsSync,
  findRequest,
  findRequestSync,
  countOrigins,
  countOriginsSync,
  getStoreStats,
  getStoreStatsSync,
  pruneStore,
  clearStore,
  schedulePrune,
  STORAGE_ROOT,
  ENTRY_MAX_AGE_MS,
  JOURNAL_MAX_BYTES,
  PRUNE_INTERVAL_MS,
};
