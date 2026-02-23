const MIME_TYPES = Object.freeze({
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".cjs": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/opentype",
  ".eot": "application/vnd.ms-fontobject",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".ts": "application/typescript",
  ".tsx": "application/typescript",
  ".jsx": "application/javascript",
  ".md": "text/markdown",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".csv": "text/csv",
});

function getMimeType(filePath) {
  const normalizedPath = String(filePath).split(/[?#]/, 1)[0];
  const lastSlash = Math.max(normalizedPath.lastIndexOf("/"), normalizedPath.lastIndexOf("\\"));
  const ext = normalizedPath.slice(lastSlash + 1).includes(".")
    ? "." + normalizedPath.slice(normalizedPath.lastIndexOf(".") + 1).toLowerCase()
    : "";
  return MIME_TYPES[ext] || "application/octet-stream";
}

function matchesUrlPattern(url, pattern) {
  if (url === pattern) return true;

  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  try {
    return new RegExp(`^${escaped}$`).test(url);
  } catch {
    return url.includes(pattern.replace(/\*/g, ""));
  }
}

module.exports = {
  MIME_TYPES,
  getMimeType,
  matchesUrlPattern,
};
