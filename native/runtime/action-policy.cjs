/**
 * action-policy.cjs — Shared wait/retry/backoff policy for browser actions
 *
 * Pure runtime module with zero CLI/host-specific dependencies.
 * Used by both headless and extension paths for consistent action reliability.
 *
 * Policy contract:
 * - Exponential backoff: baseDelay × 2^attempt, capped by timeout
 * - Bounded jitter: ±25% randomization to prevent thundering herd
 * - Wait-for: Optional pre-action stabilization check
 * - Verify: Optional post-action state verification
 * - Timeout: Hard cap on total execution time
 * - Retries: Maximum retry attempts before giving up
 */

/** @typedef {Object} ActionPolicyOptions
 * @property {number} [retries=0] - Maximum retry attempts
 * @property {number} [backoffMs=250] - Base delay for exponential backoff in ms
 * @property {number} [timeout=5000] - Overall timeout in ms
 * @property {boolean} [waitFor=false] - Wait for element/page ready before action
 * @property {boolean} [verify=false] - Verify post-action state
 * @property {string} [verifySelector] - Selector that must appear after action
 * @property {string} [verifyText] - Text that must appear after action
 * @property {number} [verifyTimeout=5000] - Timeout for verification in ms
 * @property {number} [stabilityMs=100] - DOM stability window in ms for wait-for
 */

const DEFAULTS = Object.freeze({
  retries: 0,
  backoffMs: 250,
  timeout: 5000,
  waitFor: false,
  verify: false,
  verifyTimeout: 5000,
  stabilityMs: 100,
  jitterFactor: 0.25, // ±25% jitter
  maxBackoffMs: 8000, // Cap individual backoff at 8s
});

/**
 * Calculate exponential backoff delay with bounded jitter
 * @param {number} attempt - Current attempt number (0-indexed)
 * @param {number} baseDelayMs - Base delay in milliseconds
 * @param {number} jitterFactor - Jitter factor (0-1)
 * @param {number} maxBackoffMs - Maximum individual backoff cap
 * @returns {number} Delay in milliseconds
 */
function calculateBackoffDelay(
  attempt,
  baseDelayMs,
  jitterFactor = DEFAULTS.jitterFactor,
  maxBackoffMs = DEFAULTS.maxBackoffMs
) {
  // Exponential: base × 2^attempt
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);

  // Cap individual delay
  const cappedDelay = Math.min(exponentialDelay, maxBackoffMs);

  // Add bounded jitter: ±jitterFactor
  const jitter = 1 + (Math.random() * 2 - 1) * jitterFactor;

  return Math.max(0, Math.round(cappedDelay * jitter));
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Check if an error is retryable (not a permanent failure)
 * @param {unknown} error - The error to check
 * @returns {boolean} True if the error suggests a retry might succeed
 */
function isRetryableError(error) {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    // Non-retryable: element not found (likely bad selector/ref)
    if (message.includes("not found") && !message.includes("content script")) {
      return false;
    }
    if (message.includes("invalid") && message.includes("selector")) {
      return false;
    }
    // Retryable: network, timeout, stale element, overlay, etc.
    return true;
  }
  return true;
}

/**
 * Execute a function with exponential backoff retry
 * @template T
 * @param {() => Promise<T>} fn - Function to execute
 * @param {Object} options - Retry options
 * @param {number} [options.retries=0] - Maximum retry attempts
 * @param {number} [options.backoffMs=250] - Base delay in ms
 * @param {number} [options.timeout=5000] - Overall timeout in ms
 * @param {string} [options.operationName="action"] - Name for error messages
 * @returns {Promise<T>} Function result
 * @throws {Error} After all retries exhausted or timeout reached
 */
async function withRetry(
  fn,
  {
    retries = DEFAULTS.retries,
    backoffMs = DEFAULTS.backoffMs,
    timeout = DEFAULTS.timeout,
    operationName = "action",
  } = {}
) {
  const startTime = Date.now();
  const deadline = startTime + timeout;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Check timeout before attempting
    if (Date.now() >= deadline) {
      throw new Error(
        `${operationName} timed out after ${timeout}ms (attempt ${attempt + 1}/${retries + 1})`
      );
    }

    try {
      const remainingTime = deadline - Date.now();

      // If we don't have enough time left for this attempt, bail
      if (remainingTime < 50) {
        throw new Error(
          `${operationName} timed out after ${timeout}ms (insufficient time for attempt ${attempt + 1})`
        );
      }

      // Attempt the action with a timeout
      const result = await Promise.race([
        fn(),
        new Promise((_, reject) => {
          const t = setTimeout(() => {
            clearTimeout(t);
            reject(new Error(`${operationName} timed out after ${remainingTime}ms`));
          }, remainingTime);
        }),
      ]);

      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Don't retry permanent failures
      if (!isRetryableError(lastError)) {
        throw lastError;
      }

      // Check if we've exhausted retries
      if (attempt >= retries) {
        break;
      }

      // Check if we have time for another attempt
      const delay = calculateBackoffDelay(attempt, backoffMs);
      if (Date.now() + delay >= deadline) {
        // Try one more time immediately if we have any time left
        const microDelay = Math.max(0, deadline - Date.now() - 10);
        if (microDelay > 0) {
          await sleep(microDelay);
          try {
            return await fn();
          } catch (finalErr) {
            throw finalErr instanceof Error ? finalErr : new Error(String(finalErr));
          }
        }
        break;
      }

      // Wait before retrying
      await sleep(delay);
    }
  }

  throw new Error(
    `${operationName} failed after ${retries + 1} attempt(s): ${lastError?.message}`
  );
}

/**
 * Create an action policy runner with bound options
 * @param {Partial<import('./action-policy.cjs').ActionPolicyOptions>} defaultOptions - Default options for this runner
 * @returns {Object} Policy runner functions
 */
function createPolicyRunner(defaultOptions = {}) {
  const opts = { ...DEFAULTS, ...defaultOptions };

  return {
    /**
     * Execute an action with the full policy (wait → action → verify)
     * @template T
     * @param {Object} params - Execution parameters
     * @param {() => Promise<boolean>} params.waitForReady - Function to check if ready (returns true if ready)
     * @param {() => Promise<T>} params.action - The action to execute
     * @param {() => Promise<boolean>} [params.verify] - Optional verification function
     * @param {Partial<ActionPolicyOptions>} [params.options] - Override options for this execution
     * @returns {Promise<{ success: true; result: T } | { success: false; error: string }>}
     */
    async execute({ waitForReady, action, verify, options = {} }) {
      const execOpts = { ...opts, ...options };
      const startTime = Date.now();

      try {
        // Phase 1: Wait for ready state if requested
        if (execOpts.waitFor && waitForReady) {
          await withRetry(
            async () => {
              const isReady = await waitForReady();
              if (!isReady) {
                throw new Error("Element not ready for interaction");
              }
            },
            {
              retries: Math.min(execOpts.retries, 3), // Cap wait retries
              backoffMs: execOpts.backoffMs,
              timeout: Math.min(execOpts.timeout, 10000), // Cap wait timeout
              operationName: "wait-for-ready",
            }
          );
        }

        // Phase 2: Execute the action with retry
        const result = await withRetry(action, {
          retries: execOpts.retries,
          backoffMs: execOpts.backoffMs,
          timeout: execOpts.timeout - (Date.now() - startTime),
          operationName: "action",
        });

        // Phase 3: Verify result if requested
        if (execOpts.verify && verify) {
          await withRetry(
            async () => {
              const verified = await verify();
              if (!verified) {
                throw new Error("Verification failed");
              }
            },
            {
              retries: Math.min(execOpts.retries, 3),
              backoffMs: execOpts.backoffMs,
              timeout: execOpts.verifyTimeout,
              operationName: "verify",
            }
          );
        }

        return { success: true, result };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, error: errorMessage };
      }
    },

    /**
     * Simple retry wrapper using policy defaults
     * @template T
     * @param {() => Promise<T>} fn - Function to retry
     * @param {Partial<ActionPolicyOptions>} [options] - Override options
     * @returns {Promise<T>}
     */
    async retry(fn, options = {}) {
      const retryOpts = { ...opts, ...options };
      return withRetry(fn, {
        retries: retryOpts.retries,
        backoffMs: retryOpts.backoffMs,
        timeout: retryOpts.timeout,
        operationName: retryOpts.operationName || "action",
      });
    },
  };
}

/**
 * Parse retry/backoff options from command arguments
 * @param {Record<string, unknown>} args - Command arguments
 * @returns {Pick<ActionPolicyOptions, 'retries' | 'backoffMs' | 'timeout' | 'waitFor' | 'verify'>} Parsed options
 */
function parsePolicyOptions(args) {
  return {
    retries: parsePositiveInt(args.retry, DEFAULTS.retries),
    backoffMs: parsePositiveInt(args.backoffMs, DEFAULTS.backoffMs),
    timeout: parsePositiveInt(args.timeout, DEFAULTS.timeout),
    waitFor: Boolean(args.waitFor || args["wait-for"]),
    verify: Boolean(args.verify),
  };
}

/**
 * Parse a positive integer from a value
 * @param {unknown} value - Value to parse
 * @param {number} defaultValue - Default if parsing fails
 * @returns {number} Positive integer
 */
function parsePositiveInt(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultValue;
  return Math.floor(parsed);
}

module.exports = {
  DEFAULTS,
  calculateBackoffDelay,
  withRetry,
  createPolicyRunner,
  parsePolicyOptions,
  parsePositiveInt,
  isRetryableError,
  sleep,
};
