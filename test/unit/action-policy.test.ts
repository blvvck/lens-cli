import { describe, expect, it } from "vitest";

import * as actionPolicy from "../../native/runtime/action-policy.cjs";

describe("action policy", () => {
  describe("calculateBackoffDelay", () => {
    it("calculates exponential backoff: base × 2^attempt", () => {
      // With zero jitter for predictable math (override via direct call)
      const delay0 = actionPolicy.calculateBackoffDelay(0, 100, 0, 10000);
      const delay1 = actionPolicy.calculateBackoffDelay(1, 100, 0, 10000);
      const delay2 = actionPolicy.calculateBackoffDelay(2, 100, 0, 10000);

      expect(delay0).toBe(100); // 100 × 2^0
      expect(delay1).toBe(200); // 100 × 2^1
      expect(delay2).toBe(400); // 100 × 2^2
    });

    it("caps individual backoff at maxBackoffMs", () => {
      const delay = actionPolicy.calculateBackoffDelay(10, 100, 0, 500);
      expect(delay).toBe(500); // Capped at maxBackoffMs
    });

    it("applies bounded jitter within ±25%", () => {
      const baseDelay = 100;
      const samples = Array.from({ length: 50 }, () =>
        actionPolicy.calculateBackoffDelay(0, baseDelay),
      );

      // All samples should be within ±25% of base
      const min = Math.min(...samples);
      const max = Math.max(...samples);

      expect(min).toBeGreaterThanOrEqual(baseDelay * 0.74); // 75% - 1 for rounding
      expect(max).toBeLessThanOrEqual(baseDelay * 1.26); // 125% + 1 for rounding
    });

    it("never returns negative delay", () => {
      const delay = actionPolicy.calculateBackoffDelay(0, -100, 0, 10000);
      expect(delay).toBeGreaterThanOrEqual(0);
    });
  });

  describe("withRetry", () => {
    it("succeeds immediately on first attempt", async () => {
      const fn = () => Promise.resolve("success");
      const result = await actionPolicy.withRetry(fn, { retries: 3, backoffMs: 10 });
      expect(result).toBe("success");
    });

    it("retries on failure and eventually succeeds", async () => {
      let attempts = 0;
      const fn = () => {
        attempts++;
        if (attempts < 3) {
          return Promise.reject(new Error("transient error"));
        }
        return Promise.resolve("success after retries");
      };

      const result = await actionPolicy.withRetry(fn, {
        retries: 5,
        backoffMs: 5,
        timeout: 5000,
      });

      expect(result).toBe("success after retries");
      expect(attempts).toBe(3);
    });

    it("throws after exhausting all retries", async () => {
      let attempts = 0;
      const fn = () => {
        attempts++;
        return Promise.reject(new Error(`failure ${attempts}`));
      };

      await expect(actionPolicy.withRetry(fn, { retries: 2, backoffMs: 5 })).rejects.toThrow(
        "failed after 3 attempt",
      );

      expect(attempts).toBe(3); // Initial + 2 retries
    });

    it("throws on timeout even with retries remaining", async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        await new Promise((r) => setTimeout(r, 100)); // Slow operation
        return "should not reach";
      };

      await expect(
        actionPolicy.withRetry(fn, { retries: 10, backoffMs: 5, timeout: 50 }),
      ).rejects.toThrow("timed out");

      expect(attempts).toBeLessThanOrEqual(2); // Should timeout quickly
    });

    it("uses exponential backoff between retries", async () => {
      const delays: number[] = [];
      let lastAttemptTime = Date.now();

      const fn = () => {
        const now = Date.now();
        if (delays.length > 0) {
          delays.push(now - lastAttemptTime);
        }
        lastAttemptTime = now;

        // First call doesn't count as "delay"
        if (delays.length === 0) {
          delays.push(0);
        }

        return Promise.reject(new Error("always fails"));
      };

      await actionPolicy.withRetry(fn, { retries: 3, backoffMs: 50 }).catch(() => {
        // Expected to fail - we're measuring timing, not success
      });

      // Should have 4 attempts (initial + 3 retries)
      expect(delays.length).toBe(4);

      // Delays should generally increase (exponential), but jitter makes this statistical
      // Just verify we had reasonable delays between attempts
      expect(delays[1]).toBeGreaterThanOrEqual(25); // First retry delay
      expect(delays[2]).toBeGreaterThanOrEqual(25); // Second retry delay
    });
  });

  describe("isRetryableError", () => {
    it("returns true for generic errors", () => {
      expect(actionPolicy.isRetryableError(new Error("network timeout"))).toBe(true);
      expect(actionPolicy.isRetryableError(new Error("stale element"))).toBe(true);
      expect(actionPolicy.isRetryableError(new Error("overlay blocking"))).toBe(true);
    });

    it("returns false for permanent failures (not found)", () => {
      expect(actionPolicy.isRetryableError(new Error("element not found"))).toBe(false);
      expect(actionPolicy.isRetryableError(new Error("selector not found"))).toBe(false);
    });

    it("returns false for invalid selector errors", () => {
      expect(actionPolicy.isRetryableError(new Error("invalid selector syntax"))).toBe(false);
    });

    it("returns true for content script errors (retryable)", () => {
      // Content script not loaded is retryable (page might still be loading)
      expect(actionPolicy.isRetryableError(new Error("content script not loaded"))).toBe(true);
    });

    it("handles non-Error values", () => {
      expect(actionPolicy.isRetryableError("string error")).toBe(true);
      expect(actionPolicy.isRetryableError(null)).toBe(true);
      expect(actionPolicy.isRetryableError(42)).toBe(true);
    });
  });

  describe("createPolicyRunner", () => {
    it("executes simple action successfully", async () => {
      const runner = actionPolicy.createPolicyRunner({ retries: 2, backoffMs: 5 });
      const result = await runner.execute({
        action: () => Promise.resolve("done"),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toBe("done");
      }
    });

    it("executes with wait-for phase", async () => {
      const runner = actionPolicy.createPolicyRunner({
        retries: 2,
        backoffMs: 5,
        waitFor: true,
      });

      let readyChecks = 0;
      const result = await runner.execute({
        waitForReady: async () => {
          readyChecks++;
          return readyChecks >= 2; // Succeed on second check
        },
        action: () => Promise.resolve("action-result"),
      });

      expect(result.success).toBe(true);
      expect(readyChecks).toBeGreaterThanOrEqual(2);
    });

    it("executes with verify phase", async () => {
      const runner = actionPolicy.createPolicyRunner({
        retries: 2,
        backoffMs: 5,
        verify: true,
      });

      let verifyChecks = 0;
      const result = await runner.execute({
        action: () => Promise.resolve("action-result"),
        verify: async () => {
          verifyChecks++;
          return verifyChecks >= 1;
        },
      });

      expect(result.success).toBe(true);
      expect(verifyChecks).toBeGreaterThanOrEqual(1);
    });

    it("returns error on action failure", async () => {
      const runner = actionPolicy.createPolicyRunner({ retries: 1, backoffMs: 5 });
      const result = await runner.execute({
        action: () => Promise.reject(new Error("action failed")),
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("action failed");
      }
    });

    it("respects custom options per execution", async () => {
      const runner = actionPolicy.createPolicyRunner({ retries: 0, backoffMs: 1000 });

      let attempts = 0;
      const result = await runner.execute({
        action: () => {
          attempts++;
          if (attempts < 2) {
            return Promise.reject(new Error("retry"));
          }
          return Promise.resolve("success");
        },
        options: { retries: 3, backoffMs: 5 }, // Override defaults
      });

      expect(result.success).toBe(true);
      expect(attempts).toBe(2);
    });

    it("provides retry helper", async () => {
      const runner = actionPolicy.createPolicyRunner({ retries: 2, backoffMs: 5 });

      let attempts = 0;
      const result = await runner.retry(() => {
        attempts++;
        if (attempts < 2) {
          return Promise.reject(new Error("retry"));
        }
        return Promise.resolve("success");
      });

      expect(result).toBe("success");
      expect(attempts).toBe(2);
    });
  });

  describe("parsePolicyOptions", () => {
    it("parses retry option from string", () => {
      const opts = actionPolicy.parsePolicyOptions({ retry: "3" });
      expect(opts.retries).toBe(3);
    });

    it("parses backoffMs option", () => {
      const opts = actionPolicy.parsePolicyOptions({ backoffMs: "500" });
      expect(opts.backoffMs).toBe(500);
    });

    it("parses timeout option", () => {
      const opts = actionPolicy.parsePolicyOptions({ timeout: "10000" });
      expect(opts.timeout).toBe(10000);
    });

    it("parses wait-for flag", () => {
      expect(actionPolicy.parsePolicyOptions({ "wait-for": true }).waitFor).toBe(true);
      expect(actionPolicy.parsePolicyOptions({ waitFor: true }).waitFor).toBe(true);
    });

    it("parses verify flag", () => {
      expect(actionPolicy.parsePolicyOptions({ verify: true }).verify).toBe(true);
      expect(actionPolicy.parsePolicyOptions({ verify: "true" }).verify).toBe(true);
    });

    it("uses defaults for missing options", () => {
      const opts = actionPolicy.parsePolicyOptions({});
      expect(opts.retries).toBe(0);
      expect(opts.backoffMs).toBe(250);
      expect(opts.timeout).toBe(5000);
      expect(opts.waitFor).toBe(false);
      expect(opts.verify).toBe(false);
    });

    it("handles invalid values gracefully", () => {
      const opts = actionPolicy.parsePolicyOptions({
        retry: "invalid",
        backoffMs: -100,
        timeout: null,
      });
      expect(opts.retries).toBe(0); // Default
      expect(opts.backoffMs).toBe(250); // Default
      expect(opts.timeout).toBe(5000); // Default
    });
  });

  describe("parsePositiveInt", () => {
    it("parses valid positive integers", () => {
      expect(actionPolicy.parsePositiveInt("5", 0)).toBe(5);
      expect(actionPolicy.parsePositiveInt(10, 0)).toBe(10);
    });

    it("returns default for undefined/null", () => {
      expect(actionPolicy.parsePositiveInt(undefined, 42)).toBe(42);
      expect(actionPolicy.parsePositiveInt(null, 42)).toBe(42);
    });

    it("returns default for negative numbers", () => {
      expect(actionPolicy.parsePositiveInt(-5, 42)).toBe(42);
    });

    it("returns default for non-numeric strings", () => {
      expect(actionPolicy.parsePositiveInt("abc", 42)).toBe(42);
    });

    it("floors float values", () => {
      expect(actionPolicy.parsePositiveInt(5.7, 0)).toBe(5);
    });
  });

  describe("sleep", () => {
    it("resolves after specified duration", async () => {
      const start = Date.now();
      await actionPolicy.sleep(20);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(15); // Allow some scheduling variance
    });

    it("handles zero duration", async () => {
      const start = Date.now();
      await actionPolicy.sleep(0);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(50); // Should resolve quickly
    });

    it("clamps negative values to zero", async () => {
      const start = Date.now();
      await actionPolicy.sleep(-100);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe("DEFAULTS", () => {
    it("exports frozen default constants", () => {
      expect(actionPolicy.DEFAULTS.retries).toBe(0);
      expect(actionPolicy.DEFAULTS.backoffMs).toBe(250);
      expect(actionPolicy.DEFAULTS.timeout).toBe(5000);
      expect(actionPolicy.DEFAULTS.waitFor).toBe(false);
      expect(actionPolicy.DEFAULTS.verify).toBe(false);
      expect(actionPolicy.DEFAULTS.jitterFactor).toBe(0.25);
      expect(actionPolicy.DEFAULTS.maxBackoffMs).toBe(8000);
    });
  });
});
