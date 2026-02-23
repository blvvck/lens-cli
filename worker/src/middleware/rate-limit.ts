import type { Context, Next } from 'hono';

interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyGenerator: (c: Context) => string;
}

/** Simple in-memory rate limiter (for CF Workers, use KV in production) */
const requestCounts = new Map<string, { count: number; resetTime: number }>();

export function rateLimit(options: RateLimitOptions) {
  return async (c: Context, next: Next) => {
    const key = options.keyGenerator(c);
    const now = Date.now();

    // Clean up expired entries periodically
    if (requestCounts.size > 10000) {
      for (const [k, v] of requestCounts.entries()) {
        if (v.resetTime < now) {
          requestCounts.delete(k);
        }
      }
    }

    const record = requestCounts.get(key);
    if (!record || record.resetTime < now) {
      // New window
      requestCounts.set(key, {
        count: 1,
        resetTime: now + options.windowMs,
      });
    } else if (record.count >= options.maxRequests) {
      // Rate limit exceeded
      return c.json(
        {
          ok: false,
          error: 'Rate limit exceeded. Please try again later.',
          code: 429,
          retryAfter: Math.ceil((record.resetTime - now) / 1000),
        },
        429,
        { 'Retry-After': String(Math.ceil((record.resetTime - now) / 1000)) }
      );
    } else {
      // Increment count
      record.count++;
    }

    await next();
  };
}
