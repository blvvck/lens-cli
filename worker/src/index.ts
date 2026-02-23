import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { rateLimit } from './middleware/rate-limit';
import { feedbackRouter } from './routes';

export type Env = {
  DB: D1Database;
  RATE_LIMIT_KV?: KVNamespace;
  FEEDBACK_SECRET?: string;
  FEEDBACK_FANOUT_WEBHOOK_URL?: string;
  FEEDBACK_FANOUT_TIMEOUT_MS?: string;
};

const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use(logger());

// Rate limiting middleware
app.use('/api/v1/feedback/*', rateLimit({
  windowMs: 60000, // 1 minute
  maxRequests: 10,
  keyGenerator: (c) => {
    const clientId = c.req.header('X-Client-ID') || 'unknown';
    // Combine client ID with IP for rate limiting
    return `${clientId}:${c.req.raw.headers.get('CF-Connecting-IP') || 'unknown'}`;
  },
}));

// Health check
app.get('/health', (c) => {
  return c.json({
    ok: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

// API routes
app.route('/api/v1/feedback', feedbackRouter);

// 404 handler
app.notFound((c) => {
  return c.json({ ok: false, error: 'Not found', code: 404 }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json(
    { ok: false, error: 'Internal server error', code: 500 },
    500
  );
});

export default app;
