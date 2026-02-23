/**
 * Feedback Outbox Module for lens-cli
 *
 * Handles durable local storage of feedback records with:
 * - Atomic writes (write temp, rename, fsync)
 * - Records survive process crashes
 * - Successful sends move outbox -> sent after authoritative ack
 * - Failed sends stay queued with error metadata
 * - Ambiguous outcomes = ack_unknown retryable state
 * - Stable client-generated feedback IDs across retries
 * - Owner-only file permissions
 * - Path traversal protection
 * - Credential corruption backup
 * - Crash duplicate cleanup
 * - Bounded delivery attempts
 * - Atomic credential creation
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// Base paths
const LENS_DIR = path.join(os.homedir(), ".lens");
const FEEDBACK_DIR = path.join(LENS_DIR, "feedback");
const OUTBOX_DIR = path.join(FEEDBACK_DIR, "outbox");
const SENT_DIR = path.join(FEEDBACK_DIR, "sent");
const CLIENT_JSON_PATH = path.join(FEEDBACK_DIR, "client.json");

// File permissions (owner-only)
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

// Maximum delivery attempts to prevent unbounded growth
const MAX_DELIVERY_ATTEMPTS = 50;

// Valid feedback ID pattern: fb_<timestamp>_<random>
const VALID_FEEDBACK_ID_PATTERN = /^fb_[a-z0-9_]+$/;

// In-memory client credentials cache
let cachedClientCredentials = null;

/**
 * Cleanup duplicates caused by crash between write to sent and unlink from outbox.
 * Called on module init to ensure consistency after crashes.
 */
function cleanupDuplicates() {
  try {
    const sentFiles = fs.readdirSync(SENT_DIR);
    let cleaned = 0;

    for (const file of sentFiles) {
      if (!file.endsWith(".json") || file.endsWith(".tmp")) {
        continue;
      }

      // Extract feedback ID from filename (e.g., "fb_abc123.json" -> "fb_abc123")
      const feedbackId = file.slice(0, -5); // Remove ".json"
      const outboxPath = path.join(OUTBOX_DIR, file);

      // If this record exists in both sent and outbox, remove from outbox
      if (fs.existsSync(outboxPath)) {
        try {
          fs.unlinkSync(outboxPath);
          cleaned++;
        } catch (err) {
          // Log but don't throw - this is cleanup, not critical
          console.error(
            `[feedback-outbox] Failed to remove duplicate from outbox: ${feedbackId}. Error: ${err.message}`
          );
        }
      }
    }

    if (cleaned > 0) {
      console.log(
        `[feedback-outbox] Cleaned up ${cleaned} duplicate(s) from outbox (already in sent)`
      );
    }
  } catch (err) {
    // Don't fail module load if cleanup fails
    console.error(`[feedback-outbox] Duplicate cleanup failed: ${err.message}`);
  }
}

/**
 * Cleanup orphaned temp files from crashed atomic writes
 */
function cleanupOrphanedTempFiles() {
  try {
    const tempCutoffMs = Date.now() - 24 * 60 * 60 * 1000; // 24 hours ago
    let cleaned = 0;

    // Check both outbox and sent directories
    for (const dir of [OUTBOX_DIR, SENT_DIR]) {
      if (!fs.existsSync(dir)) continue;

      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith(".tmp")) continue;

        const filePath = path.join(dir, file);
        try {
          const stats = fs.statSync(filePath);
          // Clean temp files older than 24 hours
          if (stats.mtimeMs < tempCutoffMs) {
            fs.unlinkSync(filePath);
            cleaned++;
          }
        } catch {
          // Ignore errors for individual files
        }
      }
    }

    if (cleaned > 0) {
      console.log(`[feedback-outbox] Cleaned up ${cleaned} orphaned temp file(s)`);
    }
  } catch (err) {
    // Don't fail module load if cleanup fails
    console.error(`[feedback-outbox] Temp file cleanup failed: ${err.message}`);
  }
}

/**
 * Ensure all required directories exist with proper permissions
 */
function ensureDirectories() {
  for (const dir of [LENS_DIR, FEEDBACK_DIR, OUTBOX_DIR, SENT_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    } else {
      // Ensure proper permissions on existing directories
      try {
        fs.chmodSync(dir, DIR_MODE);
      } catch (err) {
        // Ignore permission errors on chmod - dir exists and is usable
      }
    }
  }
}

/**
 * Get the base feedback directory path
 */
function getFeedbackBasePath() {
  return FEEDBACK_DIR;
}

/**
 * Get the outbox directory path
 */
function getOutboxPath() {
  return OUTBOX_DIR;
}

/**
 * Get the sent directory path
 */
function getSentPath() {
  return SENT_DIR;
}

/**
 * Get the client credentials file path
 */
function getClientCredentialsPath() {
  return CLIENT_JSON_PATH;
}

/**
 * Generate a stable feedback ID
 * Format: fb_{timestamp}_{random}
 * The ID remains stable across retries of the same feedback
 */
function generateFeedbackId() {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(8).toString("hex");
  return `fb_${timestamp}_${random}`;
}

/**
 * Generate an install-scoped client ID (created once per install)
 */
function generateClientId() {
  const random = crypto.randomBytes(16).toString("hex");
  return `lens_${random}`;
}

/**
 * Generate a client secret for integrity proofs
 */
function generateClientSecret() {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Read client credentials, creating them if they don't exist
 * Uses atomic file creation to prevent race conditions
 */
function getOrCreateClientCredentials() {
  if (cachedClientCredentials) {
    return cachedClientCredentials;
  }

  ensureDirectories();

  // Try to read existing credentials
  try {
    if (fs.existsSync(CLIENT_JSON_PATH)) {
      const content = fs.readFileSync(CLIENT_JSON_PATH, "utf-8");
      cachedClientCredentials = JSON.parse(content);
      return cachedClientCredentials;
    }
  } catch (err) {
    // File exists but is corrupted - preserve it and regenerate
    const timestamp = Date.now();
    const corruptedPath = `${CLIENT_JSON_PATH}.corrupted.${timestamp}`;
    try {
      fs.copyFileSync(CLIENT_JSON_PATH, corruptedPath);
      console.error(
        `[feedback-outbox] Client credentials file corrupted. ` +
          `Preserved at ${corruptedPath}. ` +
          `Error: ${err.message}. ` +
          `Generating new client identity.`
      );
    } catch (copyErr) {
      console.error(
        `[feedback-outbox] Client credentials file corrupted but could not be preserved: ${copyErr.message}. ` +
          `Generating new client identity.`
      );
    }
  }

  // Create new client credentials atomically
  const credentials = {
    clientId: generateClientId(),
    clientSecret: generateClientSecret(),
    createdAt: Date.now(),
    version: 1,
  };

  // Use atomic creation to prevent race conditions
  try {
    const tempPath = `${CLIENT_JSON_PATH}.tmp.${credentials.clientId}`;
    fs.writeFileSync(tempPath, JSON.stringify(credentials, null, 2), {
      mode: FILE_MODE,
    });

    // Atomic rename with fsync for durability
    const fd = fs.openSync(tempPath, "r");
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    fs.renameSync(tempPath, CLIENT_JSON_PATH);
    fs.chmodSync(CLIENT_JSON_PATH, FILE_MODE);

    cachedClientCredentials = credentials;
    return credentials;
  } catch (err) {
    // If rename failed due to EEXIST, another process won the race
    // Read and return the winner's credentials
    if (err.code === "EEXIST" || err.message?.includes("EEXIST")) {
      try {
        const content = fs.readFileSync(CLIENT_JSON_PATH, "utf-8");
        cachedClientCredentials = JSON.parse(content);
        return cachedClientCredentials;
      } catch (readErr) {
        // Fall through to throw original error
      }
    }
    throw err;
  }
}

/**
 * Write client credentials atomically with proper permissions and durability
 */
function writeClientCredentials(credentials) {
  ensureDirectories();
  const tempPath = `${CLIENT_JSON_PATH}.tmp`;

  try {
    fs.writeFileSync(tempPath, JSON.stringify(credentials, null, 2), {
      mode: FILE_MODE,
    });

    // fsync before rename for durability
    const fd = fs.openSync(tempPath, "r");
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    fs.renameSync(tempPath, CLIENT_JSON_PATH);
    fs.chmodSync(CLIENT_JSON_PATH, FILE_MODE);
  } catch (err) {
    // Clean up temp file if it exists
    try {
      fs.unlinkSync(tempPath);
    } catch {}
    throw err;
  }
}

/**
 * Get existing client credentials without creating them
 */
function getClientCredentials() {
  if (cachedClientCredentials) {
    return cachedClientCredentials;
  }

  try {
    if (fs.existsSync(CLIENT_JSON_PATH)) {
      const content = fs.readFileSync(CLIENT_JSON_PATH, "utf-8");
      cachedClientCredentials = JSON.parse(content);
      return cachedClientCredentials;
    }
  } catch (err) {
    // Ignore read errors
  }

  return null;
}

/**
 * Clear the client credentials cache
 */
function clearClientCredentialsCache() {
  cachedClientCredentials = null;
}

/**
 * Validate a feedback ID to prevent path traversal attacks
 * @param {string} feedbackId - The ID to validate
 * @throws {Error} If the ID is invalid
 */
function validateFeedbackId(feedbackId) {
  if (!feedbackId || typeof feedbackId !== "string") {
    throw new Error("Invalid feedback ID: must be a non-empty string");
  }
  if (!VALID_FEEDBACK_ID_PATTERN.test(feedbackId)) {
    throw new Error(
      `Invalid feedback ID "${feedbackId}": must match pattern ${VALID_FEEDBACK_ID_PATTERN.toString()}`
    );
  }
}

/**
 * Create a feedback record object
 */
function createFeedbackRecord({
  id,
  note,
  context = null,
  commandSummary = null,
  clientVersion,
  platform,
}) {
  const recordId = id || generateFeedbackId();
  // Validate ID if provided by user (defense in depth)
  if (id) {
    validateFeedbackId(id);
  }
  return {
    id: recordId,
    createdAt: Date.now(),
    status: "queued",
    note,
    context,
    commandSummary,
    clientVersion,
    platform,
    deliveryAttempts: [],
    serverAck: null,
  };
}

/**
 * Get the file path for a feedback record in outbox
 */
function getOutboxRecordPath(feedbackId) {
  validateFeedbackId(feedbackId);
  return path.join(OUTBOX_DIR, `${feedbackId}.json`);
}

/**
 * Get the file path for a feedback record in sent
 */
function getSentRecordPath(feedbackId) {
  validateFeedbackId(feedbackId);
  return path.join(SENT_DIR, `${feedbackId}.json`);
}

/**
 * Write a feedback record atomically (write temp, fsync, rename)
 */
function writeRecordAtomic(recordPath, record) {
  const tempPath = `${recordPath}.tmp`;

  try {
    fs.writeFileSync(tempPath, JSON.stringify(record, null, 2), {
      mode: FILE_MODE,
    });

    // fsync before rename for durability
    const fd = fs.openSync(tempPath, "r");
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    fs.renameSync(tempPath, recordPath);
    fs.chmodSync(recordPath, FILE_MODE);
  } catch (err) {
    // Clean up temp file if it exists
    try {
      fs.unlinkSync(tempPath);
    } catch {}
    throw err;
  }
}

/**
 * Queue a new feedback record in the outbox
 */
function queueFeedback({
  id,
  note,
  context = null,
  commandSummary = null,
  clientVersion,
  platform,
}) {
  ensureDirectories();

  const record = createFeedbackRecord({
    id,
    note,
    context,
    commandSummary,
    clientVersion,
    platform,
  });

  const recordPath = getOutboxRecordPath(record.id);
  writeRecordAtomic(recordPath, record);

  return record;
}

/**
 * Read a feedback record from outbox or sent
 */
function readFeedback(feedbackId) {
  const outboxPath = getOutboxRecordPath(feedbackId);
  const sentPath = getSentRecordPath(feedbackId);

  try {
    if (fs.existsSync(outboxPath)) {
      const content = fs.readFileSync(outboxPath, "utf-8");
      return JSON.parse(content);
    }
  } catch (err) {
    // File read/parse error
  }

  try {
    if (fs.existsSync(sentPath)) {
      const content = fs.readFileSync(sentPath, "utf-8");
      return JSON.parse(content);
    }
  } catch (err) {
    // File read/parse error
  }

  return null;
}

/**
 * Cap delivery attempts array to prevent unbounded growth
 * Keeps first attempt (original) + last N-1 attempts for history
 */
function capDeliveryAttempts(attempts) {
  if (!Array.isArray(attempts)) return [];
  if (attempts.length <= MAX_DELIVERY_ATTEMPTS) return attempts;

  // Keep first + last (MAX-1) attempts
  const firstAttempt = attempts[0];
  const lastAttempts = attempts.slice(-(MAX_DELIVERY_ATTEMPTS - 1));
  return [firstAttempt, ...lastAttempts];
}

/**
 * Record a delivery attempt with result
 */
function recordDeliveryAttempt(feedbackId, attempt) {
  const record = readFeedback(feedbackId);
  if (!record) {
    throw new Error(`Feedback record not found: ${feedbackId}`);
  }

  const attemptEntry = {
    timestamp: Date.now(),
    ...attempt,
  };

  record.deliveryAttempts.push(attemptEntry);
  record.lastAttemptAt = attemptEntry.timestamp;

  // Cap delivery attempts to prevent unbounded growth
  record.deliveryAttempts = capDeliveryAttempts(record.deliveryAttempts);

  // Update status based on attempt result
  if (attempt.success) {
    record.status = "sent";
    if (attempt.serverFeedbackId) {
      record.serverAck = {
        feedbackId: attempt.serverFeedbackId,
        timestamp: attempt.serverTimestamp || attemptEntry.timestamp,
      };
    }
  } else if (attempt.ackUnknown) {
    // Ambiguous outcome - stays in outbox for retry
    record.status = "ack_unknown";
    record.lastError = attempt.error || "Ambiguous delivery outcome";
  } else {
    // Failed delivery - stays in outbox for retry
    record.status = "failed";
    record.lastError = attempt.error || "Delivery failed";
  }

  // Write updated record
  const outboxPath = getOutboxRecordPath(feedbackId);
  writeRecordAtomic(outboxPath, record);

  return record;
}

/**
 * Mark a feedback record as successfully sent (move outbox -> sent)
 * Only called after authoritative server ack is persisted locally
 */
function markAsSent(feedbackId) {
  const outboxPath = getOutboxRecordPath(feedbackId);
  const sentPath = getSentRecordPath(feedbackId);

  // Read from outbox
  if (!fs.existsSync(outboxPath)) {
    throw new Error(`Feedback record not found in outbox: ${feedbackId}`);
  }

  const content = fs.readFileSync(outboxPath, "utf-8");
  const record = JSON.parse(content);

  // Update status
  record.status = "sent";
  record.movedToSentAt = Date.now();

  // Write to sent directory atomically
  writeRecordAtomic(sentPath, record);

  // Remove from outbox (atomic operation - both files exist briefly)
  try {
    fs.unlinkSync(outboxPath);
  } catch (err) {
    // If we can't remove from outbox, we still have the record in sent
    // This is a recoverable inconsistency - cleanup can handle it
  }

  return record;
}

/**
 * List all feedback records in a directory
 */
function listRecords(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const records = [];
  const files = fs.readdirSync(dirPath);

  for (const file of files) {
    if (!file.endsWith(".json") || file.endsWith(".tmp")) {
      continue;
    }

    try {
      const filePath = path.join(dirPath, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const record = JSON.parse(content);
      records.push(record);
    } catch (err) {
      // Skip corrupted files
    }
  }

  // Sort by createdAt descending
  records.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return records;
}

/**
 * List all queued (outbox) feedback records
 */
function listOutbox() {
  return listRecords(OUTBOX_DIR);
}

/**
 * List all sent feedback records
 */
function listSent() {
  return listRecords(SENT_DIR);
}

/**
 * List all feedback records (both outbox and sent)
 */
function listAll() {
  return [...listOutbox(), ...listSent()];
}

/**
 * Get statistics about the outbox and sent stores
 */
function getStats() {
  const outbox = listOutbox();
  const sent = listSent();

  const outboxByStatus = outbox.reduce((acc, record) => {
    const status = record.status || "queued";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});

  return {
    outboxCount: outbox.length,
    sentCount: sent.length,
    totalCount: outbox.length + sent.length,
    outboxByStatus,
    lastSent: sent.length > 0 ? sent[0]?.serverAck?.timestamp || sent[0]?.movedToSentAt : null,
    lastError: outbox.length > 0
      ? outbox
          .filter(r => r.lastError)
          .sort((a, b) => (b.lastAttemptAt || 0) - (a.lastAttemptAt || 0))[0]?.lastError
      : null,
  };
}

/**
 * Retry a feedback record by ID
 * Returns the record ready for retry, or null if not found
 */
function prepareForRetry(feedbackId) {
  const record = readFeedback(feedbackId);
  if (!record) {
    return null;
  }

  // Reset status to queued for retry
  if (record.status === "failed" || record.status === "ack_unknown") {
    record.status = "queued";
    delete record.lastError;

    const outboxPath = getOutboxRecordPath(feedbackId);
    writeRecordAtomic(outboxPath, record);
  }

  return record;
}

/**
 * Clear all feedback records (for testing or user request)
 * Also clears temp files
 */
function clearAll() {
  ensureDirectories();

  let deletedOutbox = 0;
  let deletedSent = 0;
  let deletedTemp = 0;

  // Clear outbox
  const outboxFiles = fs.readdirSync(OUTBOX_DIR);
  for (const file of outboxFiles) {
    if (file.endsWith(".json")) {
      try {
        fs.unlinkSync(path.join(OUTBOX_DIR, file));
        deletedOutbox++;
      } catch {}
    } else if (file.endsWith(".tmp")) {
      try {
        fs.unlinkSync(path.join(OUTBOX_DIR, file));
        deletedTemp++;
      } catch {}
    }
  }

  // Clear sent
  const sentFiles = fs.readdirSync(SENT_DIR);
  for (const file of sentFiles) {
    if (file.endsWith(".json")) {
      try {
        fs.unlinkSync(path.join(SENT_DIR, file));
        deletedSent++;
      } catch {}
    } else if (file.endsWith(".tmp")) {
      try {
        fs.unlinkSync(path.join(SENT_DIR, file));
        deletedTemp++;
      } catch {}
    }
  }

  return { deletedOutbox, deletedSent, deletedTemp };
}

// Initialize directories on module load and cleanup any crash duplicates
ensureDirectories();
cleanupDuplicates();
cleanupOrphanedTempFiles();

module.exports = {
  // Paths
  getFeedbackBasePath,
  getOutboxPath,
  getSentPath,
  getClientCredentialsPath,

  // Client credentials
  getOrCreateClientCredentials,
  getClientCredentials,
  writeClientCredentials,
  clearClientCredentialsCache,

  // Record operations
  queueFeedback,
  readFeedback,
  recordDeliveryAttempt,
  markAsSent,
  prepareForRetry,

  // Listing
  listOutbox,
  listSent,
  listAll,

  // Stats
  getStats,

  // Utility
  generateFeedbackId,
  clearAll,
  cleanupDuplicates,
  validateFeedbackId,

  // Constants
  FILE_MODE,
  DIR_MODE,
  MAX_DELIVERY_ATTEMPTS,
};
